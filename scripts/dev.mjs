/**
 * `npm run dev`: the API and the client dev server, side by side.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS INSTEAD OF `concurrently`
 * ---------------------------------------------------------------------------
 * `concurrently` is a critical-severity dependency (CVE in `shell-quote`, reached through
 * `concurrently >= 9.2.3`), and it failed the repository's own audit gate. The options were to
 * pin it to 9.2.1, which npm calls a breaking change and which still leaves the vulnerable
 * package in the tree at a version that happens not to be affected, or to delete it.
 *
 * What it was actually doing here was running two processes with their output labelled. That is
 * about thirty lines, the labels are the entire value, and deleting the dependency removes four
 * transitive packages rather than merely downgrading one of them. A dev-only tool is not a
 * proportionate risk to keep for that.
 *
 * Behaviour deliberately preserved, because `npm run dev` is a workflow people rely on:
 *   - each child's output is prefixed with its name, so a stack trace says which process
 *   - Ctrl+C stops BOTH children, not just the one in the foreground
 *   - one child exiting takes the other down, rather than leaving a half-running dev server
 *   - colours, so the two streams stay tellable apart
 *
 * ASCII only, so the prefix is built from a colour code rather than from an ANSI-art label.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const RESET = '\u001B[0m';

const TARGETS = [
  { name: 'server', colour: '\u001B[34m', script: 'dev:server' },
  { name: 'client', colour: '\u001B[32m', script: 'dev:client' },
];

/** True on Windows, where a process tree needs taskkill rather than a signal to the group. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * How to run `npm run <script>` without a shell.
 *
 * A shell is avoidable, and avoiding it matters more than usual in a file whose existence is
 * about not depending on a shell-quoting library. Two routes, in order of preference:
 *
 *   1. `npm_execpath`, which npm sets to the `npm-cli.js` it is actually running. Invoking it
 *      with this same Node is exact: the children run under the same npm, on the same
 *      version, with no path resolution involved.
 *   2. `npm.cmd` directly. Windows can execute a `.cmd` without `cmd.exe` being interposed, so
 *      this needs no shell either.
 *
 * The first version used `shell: true`, which worked and emitted Node's DEP0190 warning about
 * passing arguments to a shell - the same class of hazard the dependency being removed had. The
 * warning was accurate about the technique and the technique is no longer needed.
 *
 * @returns the command and the arguments that lead to `npm run <script>`.
 */
function npmInvocation(script) {
  const cli = process.env['npm_execpath'];

  if (cli !== undefined && existsSync(cli)) {
    return { command: process.execPath, args: [cli, 'run', script] };
  }

  return { command: IS_WINDOWS ? 'npm.cmd' : 'npm', args: ['run', script] };
}

const children = [];
let shuttingDown = false;

function prefix(target, chunk) {
  const text = chunk.toString('utf8');

  // Prefixed line by line rather than by chunk. Chunk boundaries do not respect newlines, so a
  // chunk prefix would produce output like "[server] [client] ...", and the point of the label
  // is to survive interleaving.
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // The final element after a trailing newline is empty; emitting it would print a bare
    // prefix on its own line.
    if (i === lines.length - 1 && line === '') {
      continue;
    }

    process.stdout.write(`${target.colour}[${target.name}]${RESET} ${line}\n`);
  }
}

for (const target of TARGETS) {
  const { command, args } = npmInvocation(target.script);
  const child = spawn(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  children.push(child);

  child.stdout.on('data', (chunk) => prefix(target, chunk));
  child.stderr.on('data', (chunk) => prefix(target, chunk));

  child.on('error', (error) => {
    process.stderr.write(
      `${target.colour}[${target.name}]${RESET} failed to start: ${error.message}\n`,
    );
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    process.stdout.write(
      `${target.colour}[${target.name}]${RESET} exited (${String(code ?? signal)}); stopping the other\n`,
    );

    // One half of a dev environment is not a dev environment. Leaving the other running means a
    // port stays bound and the next `npm run dev` fails for a reason that looks unrelated.
    shutdown(code ?? 0);
  });
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    // SIGTERM is not delivered to a process group on Windows, and killing a shell leaves its
    // grandchild running. `taskkill /T` takes the tree; elsewhere a plain kill is enough.
    if (IS_WINDOWS) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // Already gone.
      }
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }

  // A beat for the kills to land, so the processes really are gone before this one exits.
  setTimeout(() => {
    process.exit(code);
  }, 200).unref?.();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`\nstopping ${String(children.length)} dev processes\n`);
    shutdown(0);
  });
}
