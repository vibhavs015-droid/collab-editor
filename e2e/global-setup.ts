/**
 * Shared access to the e2e server process, so a spec can genuinely stop and restart it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS INSTEAD OF PLAYWRIGHT'S `webServer`
 * ---------------------------------------------------------------------------
 * Playwright's `webServer` starts a server the runner owns and does not expose. Scenario (b)
 * needs the server to actually GO AWAY, and (f) needs it to come back.
 *
 * That matters because of a measured fact: in Chromium, `context.setOffline(true)`, CDP
 * `Network.emulateNetworkConditions`, and `routeWebSocket` all leave an ESTABLISHED WebSocket
 * connected. Verified: with the network emulated offline, keystrokes still reached the server
 * and `GET /api/documents/<id>` came back with the text. A test written against those APIs
 * asserts nothing about offline behaviour - it would pass if offline handling were deleted.
 *
 * So the server is genuinely stopped and restarted here.
 *
 * ---------------------------------------------------------------------------
 * WHY A PID FILE AND NOT `globalThis`
 * ---------------------------------------------------------------------------
 * globalSetup runs in the Playwright runner's process; spec files run in worker processes.
 * They do not share a `globalThis`, so a handle stored there is invisible to the specs - which
 * is exactly the failure the first attempt produced ("the e2e server handle is missing; globalSetup
 * did not run", while the server logs proved globalSetup had run).
 *
 * A PID file is the smallest thing both sides can agree on.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { FullConfig } from '@playwright/test';

export const E2E_PORT = 3100;
export const E2E_URL = `http://127.0.0.1:${E2E_PORT}`;

/** Where the runner publishes the child PID, so workers can reach the same process. */
const PID_FILE = join(tmpdir(), 'collab-e2e-server.pid');

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = resolve(ROOT, 'dist', 'server', 'index.js');
const CLIENT = resolve(ROOT, 'dist', 'client');

function env(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(E2E_PORT),
    PGLITE_DATA_DIR: dataDir,
    CLIENT_DIST: CLIENT,
    // A real HS256 secret. Open auth is refused outright under NODE_ENV=production, which is
    // correct: it is the failure where the app looks healthy and every document is readable by
    // anyone. The first run of these tests failed to start for exactly that reason.
    //
    // So the tests run the way production does. Each browser context mints its own anonymous
    // subject through /api/auth/session and presents a token for it, so two contexts are still
    // strangers to each other and the ownership rules still apply.
    JWT_SECRET: 'e2e-test-secret-not-a-real-credential-0123456789',
    LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'info',
    // Passed through explicitly rather than relying on the ...process.env spread, so that
    // running CSP_MODE=report-only npx playwright test is a supported way to reproduce the
    // instructions' first rollout phase (report, confirm zero violations, then enforce).
    CSP_MODE: process.env['CSP_MODE'],
  };
}

/**
 * Pipe the server's output into the test log.
 *
 * Server logs are the only way to tell an application failure from a harness failure, and
 * without this a silent refusal appears as an unexplained test timeout.
 */
function tee(name: 'stdout' | 'stderr') {
  return (chunk: Buffer): void => {
    process.stdout.write(`[server ${name}] ${chunk.toString('utf8')}`);
  };
}

function spawnServer(dataDir: string): ChildProcess {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: env(dataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', tee('stdout'));
  child.stderr?.on('data', tee('stderr'));

  return child;
}

/** True when something is answering on the test port. */
async function portOpen(): Promise<boolean> {
  try {
    const res = await fetch(`${E2E_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(up: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await portOpen()) === up) return;
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`the e2e server did not go ${up ? 'up' : 'down'} within ${timeoutMs} ms`);
}

/**
 * True while a process with this pid still exists.
 *
 * Signal 0 performs the permission and existence check without delivering anything, which is the
 * only portable way to ask "is it alive" from Node.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * How long a server gets to honour SIGTERM before it is killed outright.
 *
 * 30 seconds, and it must stay well under Playwright's 90 second per-test timeout. Getting that
 * wrong is not hypothetical: an earlier version of this file used 120 seconds, and because
 * `stopServer()` correctly blocks until the process is gone, a slow shutdown ate the whole test
 * budget and the scenario failed at 90 seconds on an unrelated `locator.click`. One test's teardown
 * must never be able to starve the test it is tearing down.
 *
 * 30s is generous for what shutdown now does: the WebSocket drain is bounded at 5s by
 * `drainRelaySocketServer`, so the remaining work is `db.close()` on PGlite.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS NUMBER WAS, AND WHY IT CHANGED
 * ---------------------------------------------------------------------------
 * It was 120s, set from the only measurement available: the server logged `shutting down` at
 * 16:50:14 and was still alive at 16:50:59. That drain was slow because `wss.close()` was waiting
 * for a WebSocket close handshake a browser never completed - since found, bounded and tested in
 * src/server/socketServer.test.ts. The original slowness is fixed, so keeping a grace sized for the
 * bug would be wrong twice over.
 *
 * ---------------------------------------------------------------------------
 * THE FINDING THAT MATTERED MORE THAN ANY OF THIS
 * ---------------------------------------------------------------------------
 * On Windows `process.kill(pid, 'SIGTERM')` calls `TerminateProcess`: the process dies at once and
 * cannot run its shutdown handler at all. So the graceful shutdown path in `src/server/index.ts`
 * has NEVER executed on a developer machine, including the one that wrote these tests. Verified by
 * making `shutdown()` hang and confirming the sabotage never appeared in a log, because no handler
 * ran. Linux is the only place that code has ever run, which is why a defect in it survived every
 * local run of a suite that was otherwise thorough.
 */
const SHUTDOWN_GRACE_MS = 30_000;

/**
 * Stop the server for real, and leave it stopped.
 *
 * The PID is published so a spec can restart it with {@link startServer}. Splitting stop from
 * start is deliberate: the assertions between them - that the peer did NOT receive the work -
 * are the whole point of the test, and a helper that restarted immediately would erase them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WAITS FOR THE PROCESS AND NOT FOR THE PORT
 * ---------------------------------------------------------------------------
 * This used to wait only for `/api/health` to stop answering, and that was wrong in a way that
 * made a failure unreadable. A server that has closed its listening socket but is still running
 * satisfies that check - `server.close()` stops accepting long before the process ends - and the
 * relay, its WebSockets and its peer list are all still fully alive.
 *
 * So "the port stopped answering" was being reported as "the server is gone" while the server was
 * still there, holding every connection. The outage scenarios then asserted against a server that
 * had not gone anywhere: the browser stayed connected, the indicator kept reading `Synced` and
 * the peer count kept reading 2 collaborators, and the failure said nothing about why.
 *
 * That is what happened on the first CI run, and it is the whole explanation for the failure.
 * `stopServer()` returned as soon as the health endpoint stopped answering, which `server.close()`
 * makes true the moment it stops accepting - long before the process ends. The scenarios then
 * typed into a server that was still very much alive, which accepted and acknowledged the
 * operations, so the indicator correctly read `Synced` and the peer count correctly read 2
 * collaborators. The test's premise - that the server was gone - was false, and the failure said
 * nothing about why.
 *
 * That also explains why it never reproduced locally: on a fast machine the process is genuinely
 * gone before the test types, so the old check and the real condition happen to agree.
 *
 * If the server does not honour SIGTERM, that is a real defect in the server, so this escalates to
 * SIGKILL to free the port for the remaining tests and then throws with the pid and the elapsed
 * time. One loud, accurate failure beats one silent wrong success that poisons every test after it.
 */
export async function stopServer(): Promise<void> {
  if (!existsSync(PID_FILE)) return;

  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());

  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  const started = Date.now();

  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* raced with exit */
    }
  }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;

  while (alive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (alive(pid)) {
    const elapsed = Date.now() - started;

    // Free the port before reporting, so one bad shutdown cannot cascade into every later test
    // as ERR_CONNECTION_REFUSED and bury the actual cause under three unrelated failures.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }

    const killBy = Date.now() + 5_000;

    while (alive(pid) && Date.now() < killBy) {
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error(
      `the e2e server (pid ${String(pid)}) was still alive ${String(elapsed)} ms after SIGTERM ` +
        `(grace ${String(SHUTDOWN_GRACE_MS)} ms). It was killed so the rest of the run could continue. ` +
        `A server that ignores SIGTERM is a defect in shutdown(), not in this harness - check the ` +
        `server log above for how far it got.`,
    );
  }

  // Belt and braces: the process is gone, so the port must be free too. If it is not, something
  // else owns it and every later test would fail with a connection error that names neither.
  await waitForHealth(false, 10_000);
}

/**
 * Make sure a server is running before a test that assumes one.
 *
 * The outage scenarios stop the server mid-test. If one of them fails before its
 * `startServer()`, the server stays down and every later scenario fails at `page.goto` with
 * ERR_CONNECTION_REFUSED - three failures, one cause, and the real one buried at the bottom.
 * That is exactly what the first CI run produced.
 */
export async function ensureServerUp(): Promise<void> {
  if (await portOpen()) {
    return;
  }

  await startServer();
}

/** Start the server again, on the same data directory, and wait until it is healthy. */
export async function startServer(): Promise<void> {
  const dataDir = readDataDir();
  const child = spawnServer(dataDir);

  writeFileSync(PID_FILE, String(child.pid), 'utf8');
  await waitForHealth(true, 120_000);
}

function readDataDir(): string {
  const file = join(tmpdir(), 'collab-e2e-datadir.txt');

  if (!existsSync(file)) {
    throw new Error('the e2e data directory was not recorded; globalSetup did not run');
  }

  return readFileSync(file, 'utf8').trim();
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (!existsSync(ENTRY) || !existsSync(resolve(CLIENT, 'index.html'))) {
    throw new Error('dist/ is missing. `npm run test:e2e` builds first.');
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'collab-e2e-'));
  writeFileSync(join(tmpdir(), 'collab-e2e-datadir.txt'), dataDir, 'utf8');

  const child = spawnServer(dataDir);
  writeFileSync(PID_FILE, String(child.pid), 'utf8');

  await waitForHealth(true, 120_000);

  process.on('exit', () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(PID_FILE, { force: true });
    rmSync(join(tmpdir(), 'collab-e2e-datadir.txt'), { force: true });
  });
}

/**
 * Called from a spec's afterAll, so the server does not outlive the run.
 *
 * It stops the server and leaves the DATA DIRECTORY RECORD ALONE. That record was written by
 * {@link globalSetup}, which also has an `exit` handler that removes both it and the directory.
 * Deleting it here broke every spec that sorts after the one calling this: `startServer()` has
 * nowhere to point the new process, so it failed with "the e2e data directory was not recorded;
 * globalSetup did not run" - which is both untrue and unactionable at the point it is read.
 *
 * Ownership is the whole fix here. Whoever creates shared state deletes it; a spec that borrows it
 * stops borrowing it on the way out.
 */
export async function teardownServer(): Promise<void> {
  await stopServer();

  if (existsSync(PID_FILE)) {
    rmSync(PID_FILE, { force: true });
  }
}
