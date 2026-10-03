/**
 * Server entry point.
 *
 * Startup order matters: the database migrates before the port opens, so the
 * server never accepts a request against a schema that does not exist yet.
 */

import { ApiServer } from './api.js';
import { Database } from './db.js';

/** Where PGlite persists. Relative to the repo root, and gitignored. */
const DATA_DIR = process.env['PGLITE_DATA_DIR'] ?? './.data/pgdata';

/**
 * Graceful shutdown.
 *
 * `SIGINT` is Ctrl+C; `SIGTERM` is what a container orchestrator or a deploy
 * script sends. Without handling them, Postgres is killed mid-write and the data
 * directory can be left needing recovery.
 */
async function shutdown(signal: string, server: ApiServer, db: Database): Promise<void> {
  process.stdout.write(`\n[server] ${signal} received, shutting down...\n`);

  try {
    await server.close();
    await db.close();
    process.stdout.write('[server] closed cleanly.\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[server] shutdown failed: ${String(error)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const db = await Database.openAt(DATA_DIR);
  process.stdout.write(`[server] database ready at ${DATA_DIR}\n`);

  const server = new ApiServer({
    db,
    host: process.env['HOST'] ?? '127.0.0.1',
    port: Number(process.env['PORT'] ?? 3001),
  });

  const address = await server.listen();
  process.stdout.write(`[server] listening on http://${address.host}:${address.port}\n`);
  process.stdout.write('[server] press Ctrl+C to stop\n');

  process.on('SIGINT', () => {
    void shutdown('SIGINT', server, db);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', server, db);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`[server] failed to start: ${String(error)}\n`);
  process.exit(1);
});
