/**
 * Server entry point.
 *
 * Startup order matters: the database migrates before the port opens, so the
 * server never accepts a request against a schema that does not exist yet.
 */

import { WebSocketServer } from 'ws';

import { ApiServer } from './api.js';
import { AuthError, resolveAuthenticator } from './auth.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay, type AuthorizeResult } from './relay.js';

/** Where PGlite persists. Relative to the repo root, and gitignored. */
const DATA_DIR = process.env['PGLITE_DATA_DIR'] ?? './.data/pgdata';

/** Path clients use for the sync socket. */
const WS_PATH = '/ws';

/**
 * Graceful shutdown.
 *
 * `SIGINT` is Ctrl+C; `SIGTERM` is what a container orchestrator or a deploy
 * script sends. Without handling them, Postgres is killed mid-write and the data
 * directory can be left needing recovery.
 *
 * Order is deliberate: stop accepting work, drain the relay, then close the
 * database. Closing the database first would fail writes from clients that are
 * still mid-relay.
 */
async function shutdown(
  signal: string,
  server: ApiServer,
  relay: Relay,
  wss: WebSocketServer,
  db: Database,
): Promise<void> {
  process.stdout.write(`\n[server] ${signal} received, shutting down...\n`);

  try {
    await server.close();
    relay.close();

    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }

    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });

    await db.close();
    process.stdout.write('[server] closed cleanly.\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[server] shutdown failed: ${String(error)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Resolved before anything else opens, because it can throw. A misconfigured
  // authentication setup must stop the process at startup rather than leave a server
  // running that looks fine and serves everyone's documents to anyone who asks.
  const { authenticator, summary } = resolveAuthenticator(process.env);

  if (authenticator.isOpen) {
    // Loud, because this is the state nobody should ship by accident.
    process.stderr.write('[server] WARNING: authentication is OPEN. Anyone who can reach\n');
    process.stderr.write('[server]          this port can read and write every document.\n');
    process.stderr.write('[server]          Set JWT_SECRET before exposing it.\n');
  }

  process.stdout.write(`[server] ${summary}\n`);

  const db = await Database.openAt(DATA_DIR);
  process.stdout.write(`[server] database ready at ${DATA_DIR}\n`);

  /**
   * The one authorisation decision, shared by HTTP and WebSocket.
   *
   * Both surfaces call this. Two implementations of "may I touch this document" would
   * eventually disagree, and the disagreement nobody notices is the permissive one.
   */
  const authorize = async (documentId: string, token: string): Promise<AuthorizeResult> => {
    let subject: string;

    try {
      subject = (await authenticator.verify(token)).subject;
    } catch (error) {
      // The reason goes to the server log and NOT to the client: "expired" and
      // "bad-signature" need different responses from whoever operates this, and a
      // log line costs nothing. Telling the client which one it was tells an
      // attacker too.
      const reason = error instanceof AuthError ? error.reason : 'unknown';
      process.stderr.write(`[server] rejected session for ${documentId}: ${reason}\n`);

      return { ok: false, code: 'UNAUTHORIZED', message: 'Session is not valid.' };
    }

    // canAccess returns false both for a document that does not exist and one this
    // subject may not touch, so this cannot be used to enumerate document ids.
    const allowed = await db.canAccess(documentId, subject);

    if (!allowed) {
      return {
        ok: false,
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document does not exist, or you do not have access to it.',
      };
    }

    return { ok: true, subject };
  };

  // One store per process, shared by the relay and the API. The relay writes
  // through it; the API reads the text it materialises.
  const store = new DocumentStore({ db });

  const relay = new Relay({
    log: {
      // Replay for a reconnecting client. This is the read side of the durable
      // log, and it is what makes "kill the server, keep typing, reconnect"
      // recover instead of losing the gap.
      readSince: (documentId, sinceSeq, limit) => store.readSince(documentId, sinceSeq, limit),
    },

    // The token arrives in `hello`, not in the URL. Query strings end up in proxy
    // logs, browser history and Referer headers, and a bearer token in any of those
    // is a credential that has already leaked.
    authorize,

    // Feeds the causal-stability floor. Compaction prunes only below the lowest
    // cursor reported here, so a peer that has not caught up keeps the history it
    // still needs.
    onCursor: (documentId, site, seq) => {
      store.reportPeerCursor(documentId, site, seq);
    },

    // A departed peer must stop holding the floor, or one closed tab would block
    // compaction for its document indefinitely.
    onLeave: (documentId, site) => {
      store.forgetPeer(documentId, site);
    },
  });

  // noServer: the socket is handed over by the ApiServer's upgrade handler,
  // so WebSocket and HTTP share one port and the browser sees a single origin.
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const documentId = url.searchParams.get('doc') ?? 'default';

    relay.attach(socket, documentId, (ops) => {
      // Fire and forget on purpose. Awaiting here would make one slow database
      // write delay the broadcast of a keystroke to everyone else in the room,
      // which is the opposite of what a relay is for. The write is queued and
      // ordered per document, so correctness does not depend on the await.
      void store
        .apply(documentId, ops)
        .then(() => {
          // Compaction is opportunistic and off the critical path. It runs on a
          // write counter rather than a timer, so a quiet document costs nothing
          // and a busy one does not wait.
          store.maybeCompact(documentId);
        })
        .catch((error: unknown) => {
          process.stderr.write(`[server] could not persist ${documentId}: ${String(error)}\n`);
        });
    });
  });

  const server = new ApiServer({
    db,
    auth: authenticator,
    host: process.env['HOST'] ?? '127.0.0.1',
    port: Number(process.env['PORT'] ?? 3001),
  });

  server.onUpgrade(WS_PATH, (request, socket, head) => {
    // `noServer` mode means ws does not see the HTTP request at all, so the
    // handshake has to be completed here and the connection event re-emitted by
    // hand. Doing it this way keeps HTTP and WebSocket on a single port, so the
    // browser sees one origin and there is no CORS to configure.
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  const address = await server.listen();
  process.stdout.write(`[server] listening on http://${address.host}:${address.port}\n`);
  process.stdout.write(
    `[server] websocket at ws://${address.host}:${address.port}${WS_PATH}?doc=<id>\n`,
  );
  process.stdout.write('[server] press Ctrl+C to stop\n');

  process.on('SIGINT', () => {
    void shutdown('SIGINT', server, relay, wss, db);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', server, relay, wss, db);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`[server] failed to start: ${String(error)}\n`);
  process.exit(1);
});
