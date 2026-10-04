/**
 * Run the load suite: start a server, run k6 against it, stop the server, report.
 *
 * Exists because the interesting failure mode of a load test is not a slow number, it
 * is a number produced by a server that was already in a strange state. Pinning the
 * server's configuration and capturing its own metrics alongside k6's is what makes a
 * result mean something.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 *
 * Usage:
 *   node scripts/load/run.mjs [scenario] [--vus N] [--duration D]
 *
 * Examples:
 *   node scripts/load/run.mjs connect
 *   node scripts/load/run.mjs edit --vus 50 --duration 30s
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'docs', 'benchmarks');

/**
 * A fixed secret, so a run is reproducible and so the suite can prove the server is
 * really verifying tokens rather than trusting them.
 *
 * Not a secret in any meaningful sense: it is committed, and it only ever signs tokens
 * for a local load server. Stated here so nobody mistakes it for a deployment value.
 */
const LOAD_SECRET = 'load-test-secret-long-enough-for-hs256';
const LOAD_SUBJECT = 'load-subject';

const SCENARIOS = ['connect', 'edit', 'reconnect', 'divergence'];

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      flags[name] = argv[index + 1];
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  return { scenario: positional[0] ?? 'connect', flags };
}

/**
 * Locate the k6 binary.
 *
 * Prefers a copy unpacked under `.tools/` (gitignored) over whatever is on PATH, so a
 * recorded benchmark names the exact version that produced it. A result from "whatever
 * k6 happens to be installed" is not reproducible.
 */
function findK6() {
  const toolsDir = join(ROOT, '.tools', 'k6');

  if (existsSync(toolsDir)) {
    for (const entry of readdirSync(toolsDir)) {
      for (const name of ['k6.exe', 'k6']) {
        const candidate = join(toolsDir, entry, name);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  return 'k6';
}

function findServer() {
  const distServer = join(ROOT, 'dist', 'server', 'index.js');

  if (existsSync(distServer)) {
    return { command: process.execPath, args: [distServer] };
  }

  return { command: 'npx', args: ['tsx', join(ROOT, 'src', 'server', 'index.ts')] };
}

/**
 * Wait for the server to answer /api/health.
 *
 * @param hasExited reports whether the server process has already died. Without it a
 *   crash costs the full timeout and then a misleading "did not become healthy".
 */
async function waitForHealth(baseUrl, timeoutMs = 60_000, hasExited = () => null) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const exitCode = hasExited();

    if (exitCode !== null && exitCode !== undefined) {
      throw new Error(`the load server exited with code ${exitCode} before becoming healthy`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return response.json();
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((done) => {
      setTimeout(done, 300);
    });
  }

  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

/**
 * Environment for k6, with unset flags omitted.
 *
 * An `undefined` value reaches the child as the string "undefined", so a flag nobody
 * passed becomes a LOAD_VUS of literally "undefined" and Number() gives NaN. Worse, k6
 * reads anything under its own configuration namespace and will warn about having had
 * its scenario block overridden.
 */
function k6Env(flags, scenario) {
  const env = {
    LOAD_BASE_URL: `http://127.0.0.1:${Number(flags.port ?? 3401)}`,
    JWT_SECRET: LOAD_SECRET,
    LOAD_SUBJECT: LOAD_SUBJECT,
    LOAD_DOCUMENT_ID: `load-${scenario}`,
  };

  if (flags.vus !== undefined) {
    env.LOAD_VUS = String(flags.vus);
  }

  if (flags.duration !== undefined) {
    env.LOAD_DURATION = String(flags.duration);
  }

  return env;
}

/**
 * Whether a command has to go through a shell on this platform.
 *
 * Only .cmd/.bat shims do, because Windows cannot execute them directly. Using a
 * shell for everything else is what breaks on a repo path containing a space: the
 * arguments are concatenated rather than passed, and C:\Users\...\Default Project
 * becomes two arguments. It also emits a Node deprecation warning about exactly that.
 */
function needsShell(command) {
  if (process.platform !== 'win32') {
    return false;
  }

  return /\.(cmd|bat)$/i.test(command) || command === 'npm' || command === 'npx';
}

/**
 * Did the run actually measure anything?
 *
 * A k6 script whose default function throws on every iteration records zero samples
 * and still exits 0, because thresholds on an absent metric are silently ignored. That
 * is the failure this exists for: an earlier version of this harness reported a clean
 * run for a script that had never once connected to anything.
 *
 * k6's `--summary-export` puts values directly on each metric entry rather than under a
 * `values` key, so the shape is `metric.count` / `metric.passes`. Reading
 * `metric.values.count` finds nothing and reports zero for a perfectly good run, which
 * is the mirror-image mistake.
 *
 * Counters and checks carry the evidence because every scenario records at least one of
 * them. Trends appear in the export without a `count`, so they cannot do this alone.
 */
function measuredSamples(summary) {
  let total = 0;

  for (const metric of Object.values(summary.metrics ?? {})) {
    if (!metric || typeof metric !== 'object') {
      continue;
    }

    total += Number(metric.count ?? 0);
    total += Number(metric.passes ?? 0);
  }

  return total;
}

/**
 * Completed iterations, counted separately.
 *
 * `measuredSamples` alone is not enough: k6's `setup()` runs its own checks, and two of
 * those are enough to satisfy it. A run where every scenario iteration hung produced a
 * summary with samples and a clean exit, which is the exact failure the guard exists to
 * catch. An iteration that never completes means the scenario measured nothing, whatever
 * setup did.
 */
function completedIterations(summary) {
  return Number(summary.metrics?.iterations?.count ?? 0);
}

/**
 * Run a command, with a ceiling.
 *
 * A load run must be able to outlive its own plan. An earlier version hung for eleven
 * minutes because a socket never closed, and nothing in the harness noticed. The
 * timeout is not a nicety; without it "the benchmark is slow" and "the benchmark is
 * wedged" are indistinguishable.
 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env },
      shell: needsShell(command),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : null;

    if (options.capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }

      resolvePromise({
        // Distinct from any exit code k6 itself produces, so "we killed it" is never
        // mistaken for "k6 failed".
        code: timedOut ? 124 : code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function main() {
  const { scenario, flags } = parseArgs(process.argv.slice(2));

  if (!SCENARIOS.includes(scenario)) {
    process.stderr.write(
      `unknown scenario "${scenario}"; expected one of ${SCENARIOS.join(', ')}\n`,
    );
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const port = Number(flags.port ?? 3401);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = join(ROOT, '.data', 'load');

  const server = findServer();
  const k6 = findK6();

  // Build only when there is nothing built to run.
  //
  // `tsc` plus `vite build` is the most memory-hungry thing in this project, and
  // repeating it before every load run is both slow and pointless once a bundle exists.
  // It also makes the harness fail on a busy machine for a reason that has nothing to do
  // with the measurement. Pass --build to force a rebuild.
  if (flags.build !== undefined || !existsSync(join(ROOT, 'dist', 'server', 'index.js'))) {
    process.stdout.write(`[load] building the server bundle...\n`);
    const build = await run('npm', ['run', 'build'], { timeoutMs: 600_000 });

    if (build.code !== 0) {
      process.stderr.write('[load] build failed; nothing can be measured without a server\n');
      process.exit(build.code ?? 1);
    }
  } else {
    process.stdout.write(`[load] using the existing build in dist/\n`);
  }

  process.stdout.write(`[load] starting the load server on ${baseUrl}\n`);

  const serverProcess = spawn(server.command, server.args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      JWT_SECRET: LOAD_SECRET,
      AUTH_MODE: 'required',
      PGLITE_DATA_DIR: dataDir,
      LOG_LEVEL: 'info',
    },
    // `shell` only when the command needs it. `npx` on Windows does; a direct
    // `node dist/server/index.js` does not, and going through a shell there means the
    // environment is concatenated rather than passed, which is both a deprecation
    // warning and a class of bug worth not having.
    shell: needsShell(server.command),
  });

  let serverLog = '';
  serverProcess.stdout.on('data', (chunk) => {
    serverLog += chunk;
  });
  serverProcess.stderr.on('data', (chunk) => {
    serverLog += chunk;
  });

  let serverExited = null;
  serverProcess.on('exit', (code) => {
    serverExited = code;
  });

  /**
   * Process exit code. Every path assigns it before use, so it is not pre-seeded:
   * a default of 1 would hide a path that reaches the end without deciding.
   */
  let exitCode;

  try {
    const health = await waitForHealth(baseUrl, 60_000, () => serverExited);
    process.stdout.write(`[load] server healthy, auth=${health.auth}\n`);

    if (health.auth !== 'required') {
      process.stderr.write(
        '[load] REFUSING: the load server is not authenticating. A benchmark against an\n' +
          '[load]           open server measures a different system than the one deployed.\n',
      );
      exitCode = 3;
    } else {
      process.stdout.write(`[load] running ${scenario}\n`);

      const k6Result = await run(
        k6,
        [
          'run',
          // Deliberately NOT --quiet. An earlier version used it, and it hid a total
          // failure: every iteration threw, zero samples were recorded, and k6 still
          // exited 0. A load test that cannot report failure is worse than no load test,
          // because it produces a number.
          '--summary-export',
          join(OUT_DIR, `${scenario}-summary.json`),
          join(HERE, `${scenario}.js`),
        ],
        {
          env: k6Env(flags, scenario),
          // Generous relative to the ramp, so a legitimate long run is not cut off, and
          // finite so a wedged one cannot hang the harness.
          timeoutMs: Number(flags.timeout ?? 600_000),
        },
      );

      exitCode = k6Result.code ?? 1;

      // Assert the run actually measured something.
      const summaryPath = join(OUT_DIR, `${scenario}-summary.json`);
      let sampleCount = 0;
      const summaryRef = { current: {} };

      try {
        summaryRef.current = JSON.parse(readFileSync(summaryPath, 'utf8'));
        sampleCount = measuredSamples(summaryRef.current);
      } catch {
        // Reported as zero below, which is the correct answer for an unreadable file.
      }

      const iterations = completedIterations(summaryRef.current);

      if (sampleCount === 0 || iterations === 0) {
        process.stderr.write(
          `[load] ABORTING: samples=${sampleCount} iterations=${iterations}.\n` +
            '[load]           Zero means every iteration either threw or never finished.\n' +
            '[load]           A run that measures nothing and exits 0 is the failure mode\n' +
            '[load]           these checks exist for.\n',
        );
        exitCode = 4;
      }

      // The server's own view of the run, captured after the load stops. These are the
      // numbers that say whether the relay kept up, as opposed to whether the clients
      // felt fast.
      let metrics = null;
      try {
        const response = await fetch(`${baseUrl}/api/metrics`);
        metrics = await response.text();
      } catch {
        // Recorded as missing below rather than silently omitted.
      }

      const resultPath = join(OUT_DIR, `${scenario}-result.json`);
      writeFileSync(
        resultPath,
        JSON.stringify(
          {
            scenario,
            ranAt: new Date().toISOString(),
            vus: flags.vus ?? null,
            duration: flags.duration ?? null,
            authMode: health.auth,
            k6ExitCode: k6Result.code,
            // The metrics live in their own file rather than inline. Embedding them here
            // duplicated every sample in the repository for no gain.
            metricsFile: `${scenario}-metrics.txt`,
            serverLogTail: serverLog.split('\n').slice(-20).join('\n'),
          },
          null,
          2,
        ),
        'utf8',
      );

      writeFileSync(join(OUT_DIR, `${scenario}-metrics.txt`), metrics ?? '', 'utf8');

      process.stdout.write(`[load] wrote ${resultPath}\n`);
      process.stdout.write(`[load] k6 exit code ${k6Result.code}\n`);
    }
  } catch (error) {
    process.stderr.write(`[load] failed: ${String(error)}\n\n`);
    // The server's own output is the only thing that explains a startup failure, and
    // swallowing it means "it did not come up" with no clue why.
    process.stderr.write(`[load] server output:\n${serverLog.trim() || '(none)'}\n`);
    exitCode = 1;
  } finally {
    serverProcess.kill();
    await new Promise((done) => {
      setTimeout(done, 500);
    });
  }

  process.exit(exitCode);
}

void main();
