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
 * Stop the server for real, and leave it stopped.
 *
 * The PID is published so a spec can restart it with {@link startServer}. Splitting stop from
 * start is deliberate: the assertions between them - that the peer did NOT receive the work -
 * are the whole point of the test, and a helper that restarted immediately would erase them.
 */
export async function stopServer(): Promise<void> {
  if (!existsSync(PID_FILE)) return;

  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());

  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  await waitForHealth(false, 20_000);
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

/** Called from a spec's afterAll, so the server does not outlive the run. */
export async function teardownServer(): Promise<void> {
  if (existsSync(PID_FILE)) {
    await stopServer();
    rmSync(PID_FILE, { force: true });
  }

  const file = join(tmpdir(), 'collab-e2e-datadir.txt');

  if (existsSync(file)) {
    rmSync(readFileSync(file, 'utf8').trim(), { recursive: true, force: true });
    rmSync(file, { force: true });
  }
}
