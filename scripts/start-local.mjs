/**
 * Start the BUILT server locally, the way a deployed instance runs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Running the production build by hand needs six environment variables set correctly, and
 * two of them are traps:
 *
 *   - `JWT_SECRET` must be at least 32 bytes, and production REFUSES to start without it.
 *     That refusal is correct (open auth in production is the failure where the app looks
 *     healthy and every document is readable by anyone) but it means the obvious command
 *     just exits.
 *   - `HOST` defaults to `127.0.0.1`, which is right on a laptop and wrong in a container.
 *     Set here explicitly so the value is never a guess.
 *
 * So this generates a secret if you have not set one, prints which mode it chose, and starts
 * `dist/server/index.js`. It is deliberately thin: it sets no defaults that could surprise
 * you in production, and it changes nothing about how the server behaves.
 *
 * Requires `npm run build` first. Run `npm run start:local:build` to do both.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = resolve(ROOT, 'dist', 'server', 'index.js');
const CLIENT_DIST = resolve(ROOT, 'dist', 'client');

if (!existsSync(ENTRY)) {
  process.stderr.write(
    'dist/server/index.js does not exist. Run `npm run build` first, or use ' +
      '`npm run start:local:build`.\n',
  );
  process.exit(1);
}

if (!existsSync(resolve(CLIENT_DIST, 'index.html'))) {
  process.stderr.write(
    `dist/client/index.html does not exist, so the server would serve no page. Run ` +
      '`npm run build` first.\n',
  );
  process.exit(1);
}

// Reuse your own secret if you have one, so a restart keeps existing documents readable to
// the same tokens. Otherwise mint one for this run and say so, because a generated secret
// means every restart invalidates old sessions.
const provided = process.env['JWT_SECRET'] ?? '';
const secret = provided === '' ? randomBytes(48).toString('base64') : provided;

const child = spawn(process.execPath, [ENTRY], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: process.env['HOST'] ?? '127.0.0.1',
    PORT: process.env['PORT'] ?? '3001',
    PGLITE_DATA_DIR: process.env['PGLITE_DATA_DIR'] ?? './.data/pgdata',
    CLIENT_DIST,
    JWT_SECRET: secret,
    LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'info',
  },
});

// Ctrl+C should stop the server, not just this wrapper. Without this the wrapper dies and
// leaves the server running with no way to reach it, which is confusing on a laptop.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.exitCode = 0;
  } else {
    process.exitCode = code ?? 0;
  }
});

process.stdout.write(
  [
    '',
    'starting the built server',
    `  url      http://${process.env['HOST'] ?? '127.0.0.1'}:${process.env['PORT'] ?? '3001'}`,
    `  data     ${process.env['PGLITE_DATA_DIR'] ?? './.data/pgdata'}`,
    `  auth     ${provided === '' ? 'generated a JWT secret for this run only' : 'using your JWT_SECRET'}`,
    '',
    provided === '' ? '  Sessions will not survive a restart. Set JWT_SECRET to keep them.\n' : '',
    '  Open the URL, then follow docs/TESTING.md to verify each feature.',
    '  Press Ctrl+C to stop.',
    '',
  ].join('\n'),
);
