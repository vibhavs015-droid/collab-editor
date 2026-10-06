/**
 * Server entry point.
 *
 * Startup order matters: the database migrates before the port opens, so the
 * server never accepts a request against a schema that does not exist yet.
 */

import type { WebSocketServer } from 'ws';

import { createRelaySocketServer } from './socketServer.js';
import { ApiServer } from './api.js';
import { AuthError, resolveAuthenticator } from './auth.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay, type AuthorizeResult } from './relay.js';
import { Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { declareMetrics, M } from './observability/index.js';
import { openStatic, type StaticOptions } from './static.js';

/**
 * Open the built client, treating "not built yet" as normal.
 *
 * Returns undefined rather than throwing, because a missing `dist/client` is an expected
 * state during development and an error in production. The two are told apart by the
 * caller, which logs the difference: a developer sees why the page is blank, and a
 * deployed instance reports it as the warning it is.
 */
async function openClient(root: string, logger: Logger): Promise<StaticOptions | undefined> {
  try {
    return await openStatic(root);
  } catch {
    if (process.env['NODE_ENV'] === 'production') {
      // In production a missing bundle means a broken image, and serving nothing while
      // reporting healthy is the failure mode worth shouting about.
      logger.warn('client bundle missing: the API will answer, but no page will load', {
        clientDist: root,
      });
    } else {
      logger.info('no client bundle; API only. Run `npm run build` to serve the editor.', {
        clientDist: root,
      });
    }

    return undefined;
  }
}

/** Where PGlite persists. Relative to the repo root, and gitignored. */
const DATA_DIR = process.env['PGLITE_DATA_DIR'] ?? './.data/pgdata';

/**
 * Built client, served by the same process as the API.
 *
 * One origin for HTTP and WebSocket means no CORS and no second deployment unit, which
 * is the same reason the relay shares this port.
 *
 * Optional because the path does not exist until `npm run build` has run, and a
 * developer running `tsx src/server/index.ts` before building should get a clear
 * message rather than a stack trace. A deployed server has the directory and serves it;
 * `CLIENT_DIST` exists for the rare deployment where the bundle lives elsewhere.
 */
const CLIENT_DIST = process.env['CLIENT_DIST'] ?? './dist/client';

/** Path clients use for the sync socket. */
const WS_PATH = '/ws';

/**
 * The process logger.
 *
 * Module level, not inside `main`, for one reason: `main` can fail before it gets far
 * enough to build anything, and a startup failure reported as plain text is the one
 * line in an otherwise machine-readable stream. Every line this process writes is JSON,
 * including the last one.
 */
const logger = new Logger({
  level: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
  base: { service: 'collab-editor' },
});

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
  logger: Logger,
): Promise<void> {
  logger.info('shutting down', { signal });

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
    logger.info('closed cleanly');
    process.exit(0);
  } catch (error) {
    logger.error('shutdown failed', { error });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Resolved before anything else opens, because it can throw. A misconfigured
  // authentication setup must stop the process at startup rather than leave a server
  // running that looks fine and serves everyone's documents to anyone who asks.
  const { authenticator, summary } = resolveAuthenticator(process.env);

  // One registry for the whole process, shared by the API, the relay and the store. A
  // /metrics scrape therefore sees all three. Creating one per component would give
  // three registries, three of which a scraper could reach only by being told about
  // three URLs.
  const metrics = new Metrics();
  declareMetrics(metrics);

  logger.info('starting', {
    auth: summary,
    dataDir: DATA_DIR,
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
  });

  const db = await Database.openAt(DATA_DIR);
  logger.info('database ready', { dataDir: DATA_DIR });

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
      metrics.increment(M.authFailures, { reason });
      logger.warn('rejected session', { document: documentId, reason, transport: 'websocket' });

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
  const store = new DocumentStore({ db, metrics, logger: logger.child('store') });

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
    metrics,
    logger: logger.child('relay'),

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
  const wss = createRelaySocketServer();

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const documentId = url.searchParams.get('doc') ?? 'default';

    relay.attach(
      socket,
      documentId,
      (ops) => {
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
            logger.error('could not persist', { document: documentId, error });
          });
      },
      // Encrypted frames. Separate callback rather than a branch inside the one above,
      // because the two paths differ in a way that matters: this one stores frames it
      // cannot read, applies no replica, and produces no text. Folding it into the
      // plaintext callback would put that difference somewhere invisible.
      (frameDocumentId, frames) => {
        void store.applyEncrypted(frameDocumentId, frames).catch((error: unknown) => {
          // Named explicitly, because "could not persist" on an encrypted document almost
          // always means the mode guard fired, and the log line should say so.
          logger.error('could not persist encrypted frames', {
            document: frameDocumentId,
            frames: frames.length,
            error,
          });
        });
      },
    );
  });

  // Resolve the client bundle before opening the port, for the same reason the database
  // migrates first: a server that accepts requests and then cannot serve `/` looks
  // healthy to every health check while being useless to every user.
  const staticFiles = await openClient(CLIENT_DIST, logger);

  const server = new ApiServer({
    db,
    auth: authenticator,
    observability: { metrics, logger: logger.child('api') },
    // Spread rather than `static: staticFiles`, because `exactOptionalPropertyTypes` is
    // on and a property present with value `undefined` is not the same as an absent one.
    // Spreading omits the key entirely when there is no bundle, which is what the option
    // actually means.
    ...(staticFiles === undefined ? {} : { static: staticFiles }),
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

  logger.info('listening', {
    url: `http://${address.host}:${address.port}`,
    websocket: `ws://${address.host}:${address.port}${WS_PATH}?doc=<id>`,
    auth: authenticator.isOpen ? 'open' : 'required',
  });

  // Stated plainly rather than left for whoever deploys this to discover. Loud, because
  // this is the state nobody should ship by accident.
  if (authenticator.isOpen) {
    logger.warn(
      'authentication is OPEN: anyone who can reach this port can read and write every document',
      {
        remediation: 'set JWT_SECRET before exposing this',
      },
    );
  }

  logger.info('ready', { hint: 'Ctrl+C to stop' });

  process.on('SIGINT', () => {
    void shutdown('SIGINT', server, relay, wss, db, logger);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', server, relay, wss, db, logger);
  });
}

main().catch((error: unknown) => {
  // Every line this process writes is JSON, including this one. A startup failure is
  // exactly when a machine-readable line matters most, because it is what a supervisor
  // or a deploy script reads.
  logger.error('failed to start', { error });
  process.exit(1);
});
