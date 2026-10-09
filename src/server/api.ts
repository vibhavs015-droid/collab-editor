/**
 * HTTP API for documents.
 *
 * Node's built-in `http` server, no framework. Phase 1 routes are simple enough
 * that Express would add a dependency and a layer of indirection to express one
 * function. If routing grows genuinely complex, this is the file to revisit Ã¢â‚¬â€
 * not before.
 *
 * Every handler is a plain `(req, res) => Promise<void>`, so each one is directly
 * testable against a real server without a mocking library.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Database } from './db.js';
import type { DocumentRecord } from './db.js';
import { AuthError, OpenAuthenticator, type Authenticator } from './auth.js';
import { DEFAULT_LIMITS, titleTooLong, type Limits } from './limits.js';
import { DOCUMENT_ID_PATTERN as SHARED_DOCUMENT_ID_PATTERN } from './documentIdPattern.js';
import {
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  decodeDocumentCursor,
  parsePageSize,
} from './documentCursor.js';
import { SUBJECT_RULE_MESSAGE, isValidSubject, newSubject } from '../shared/subject.js';
import { Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { M, declareMetrics } from './observability/index.js';
import { routeTemplate, statusClass } from './observability/routes.js';
import { serveStatic, type StaticOptions } from './static.js';

/**
 * Said whenever a document cannot be reached.
 *
 * Deliberately does not distinguish "does not exist" from "not yours". A 403 would
 * tell a caller which document ids are real, and a real document id is the first
 * half of everything an attacker needs. The cost is that a user following a link to
 * a document they cannot see is told it does not exist; the wording below is the
 * compromise, and it is honest rather than merely reassuring.
 */
const NOT_FOUND_MESSAGE = 'Document does not exist, or you do not have access to it.';

/**
 * Path only, with the query string removed.
 *
 * A query string carries a document id and, on an upgrade request, whatever else a caller
 * put there. It must never become a metric label.
 */
function templateFor(rawUrl: string | undefined): string {
  return routeTemplate((rawUrl ?? '/').split('?')[0] ?? '/');
}

/** Outcome of identifying the caller. */
type IdentifyResult =
  { ok: true; subject: string } | { ok: false; message: string; reason: string };

export interface ApiServerOptions {
  readonly db: Database;
  readonly host?: string;
  readonly port?: number;
  /**
   * Write quotas enforced by this server.
   *
   * Defaults to {@link DEFAULT_LIMITS} so every existing caller - which is every test - gets a
   * bounded server without having to know the option exists. The real server passes
   * {@link resolveLimits} of the process environment.
   */
  readonly limits?: Limits;
  /** Escape hatch for tests: called when the server is listening. */
  readonly onListen?: (address: { host: string; port: number }) => void;
  /**
   * Verifies session tokens on every document route.
   *
   * Defaults to open mode so the test suite and a fresh clone need no secret
   * configured. Open mode is not security; see ADR-0012. A production server gets
   * this from {@link resolveAuthenticator}, which refuses to hand back an open
   * authenticator when NODE_ENV=production.
   */
  readonly auth?: Authenticator;
  /**
   * Where request metrics and logs go.
   *
   * Defaults to a private registry and a silent logger, so a component constructed in
   * a test produces no output and shares nothing with another component's registry.
   * The real server passes one registry to the API, the relay and the store so a
   * single /metrics scrape sees all of them.
   */
  readonly observability?: Observability;
  /**
   * Built client to serve from this server.
   *
   * Optional, and omitted by every test: the suite exercises the API, not a build
   * artifact, and depending on `dist/client` existing would make `npm test` fail on a
   * clean checkout.
   *
   * A deployed server must provide it, or the browser gets a 401 for `/` and the
   * application never loads. See static.ts for why this is unauthenticated.
   */
  readonly static?: StaticOptions;
}

/** The two things a component needs to report what it is doing. */
export interface Observability {
  readonly metrics: Metrics;
  readonly logger: Logger;
}

/** Build an observability pair, filling in the quiet defaults. */
export function observability(overrides: Partial<Observability> = {}): Observability {
  return {
    metrics: overrides.metrics ?? new Metrics(),
    logger: overrides.logger ?? Logger.silent(),
  };
}

/**
 * Documents are addressed by a URL-safe id.
 *
 * The pattern itself lives in its own module so the pagination cursor can validate the id it
 * carries without importing this file. See documentIdPattern.ts.
 */
const DOCUMENT_ID_PATTERN = SHARED_DOCUMENT_ID_PATTERN;

/**
 * Hard ceiling on request body size.
 *
 * Not optional. Without a limit, a single request can exhaust memory, and an
 * editor's autosave is an endpoint that accepts arbitrary-length text by design.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Documents a single caller may create before being rejected.
 *
 * Deliberately NOT in {@link Limits}: this one is keyed to the CALLER rather than to the
 * server, and it is a sliding window over a list of timestamps rather than a token bucket. 60
 * events per hour is a counting problem, and a bucket smooths away the very thing being
 * counted. The per-connection and per-document limits are different shapes of problem and are
 * configured together in limits.ts.
 */
const MAX_CREATE_PER_HOUR = 60;

/**
 * Handles an HTTP `upgrade` request by handing the socket to the WebSocket
 * server, scoped to the document named in the query string.
 */
export interface UpgradeHandler {
  readonly path: string;
  /**
   * @param request the HTTP upgrade request, carrying the document id.
   * @param socket the raw socket, already validated.
   * @param upgradeHead bytes already read from the socket before the listener
   *   ran. Must be forwarded to `handleUpgrade`, or the first WebSocket frame is
   *   silently truncated.
   */
  readonly handle: (request: IncomingMessage, socket: Duplex, upgradeHead: Buffer) => void;
}

export class ApiServer {
  readonly #db: Database;
  readonly #host: string;
  readonly #port: number;
  readonly #onListen: ((address: { host: string; port: number }) => void) | undefined;
  readonly #auth: Authenticator;
  readonly #obs: Observability;
  readonly #server: Server;
  /** Built client to serve, when one was provided. Undefined disables static serving. */
  readonly #static: StaticOptions | undefined;
  readonly #limits: Limits;
  /** Registered upgrade routes, checked before any request is handled. */
  readonly #upgrades: UpgradeHandler[] = [];
  #createTimestamps: number[] = [];

  constructor(options: ApiServerOptions) {
    this.#db = options.db;
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 3001;
    this.#onListen = options.onListen;
    this.#auth = options.auth ?? new OpenAuthenticator();
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#static = options.static;
    this.#obs = observability(options.observability);
    declareMetrics(this.#obs.metrics);
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });

    // Upgrade requests bypass the request handler entirely, so they need their
    // own listener. Handling them here rather than on a second port keeps the
    // client on one origin, which means no CORS and no second deployment unit.
    this.#server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      for (const upgrade of this.#upgrades) {
        if (url.pathname !== upgrade.path) {
          continue;
        }

        const documentId = url.searchParams.get('doc') ?? 'default';

        // Validate before handing over the socket. An upgrade naming an
        // unusable document is a client bug; destroying the socket is the
        // correct response, because leaving it open leaks a connection per bad
        // request and the client waits forever for a reply it will never get.
        if (!DOCUMENT_ID_PATTERN.test(documentId)) {
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        // The request travels with the socket: `ws.handleUpgrade` needs it to
        // complete the handshake, and it is where the document id already lives.
        upgrade.handle(req, socket, head);
        return;
      }

      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
  }

  /**
   * Register an upgrade route.
   *
   * @param path e.g. `/ws`.
   * @param handle receives the raw socket, which the caller hands to its own
   *   WebSocket server via `handleUpgrade`.
   */
  onUpgrade(path: string, handle: UpgradeHandler['handle']): void {
    this.#upgrades.push({ path, handle });
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve) => {
      this.#server.listen(this.#port, this.#host, () => {
        resolve();
      });
    });

    const address = this.#server.address();
    const bound =
      address && typeof address === 'object'
        ? { host: address.address, port: address.port }
        : { host: this.#host, port: this.#port };

    this.#onListen?.(bound);
    return bound;
  }

  /**
   * How long an HTTP connection is given to end before its socket is destroyed.
   *
   * Not a keep-alive problem: Node has closed idle keep-alive sockets on `server.close()` since
   * v19, and that was measured rather than assumed. What does block is a connection that never sent
   * a request at all - Chromium's speculative preconnect does exactly that - which is not idle by
   * Node's definition, so it is waited on forever. See src/server/apiClose.test.ts.
   *
   * Five seconds sits well inside the 10 seconds Docker allows before SIGKILL, so the rest of the
   * shutdown, including db.close(), still gets to run.
   */
  static readonly CLOSE_GRACE_MS = 5_000;

  async close(): Promise<void> {
    // Drain in-flight requests before closing, otherwise a test can finish with
    // a half-written response and a hanging socket.
    //
    // The bound is the point. `server.close(callback)` does not fire until every connection has
    // ended, and a peer that never ends one holds this open indefinitely - which blocks every
    // step after it, including `db.close()`. Measured on CI: the server logged `shutting down`
    // and was still alive 45 seconds later.
    //
    // Being patient first and forceful second, so a well-behaved client still gets a clean
    // shutdown and only a socket that will not finish is destroyed. Any request genuinely in
    // flight has already had 5 seconds; anything slower than that is not going to arrive.
    const closed = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const grace = new Promise<void>((resolve) => {
      graceTimer = setTimeout(() => {
        // Destroys idle keep-alive sockets and sockets that never sent a request. Already-closed
        // connections are not in the set, so this cannot throw.
        this.#server.closeAllConnections();
        resolve();
      }, ApiServer.CLOSE_GRACE_MS);

      graceTimer.unref?.();
    });

    await Promise.race([closed, grace]);

    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = process.hrtime.bigint();
    const template = templateFor(req.url);
    const { metrics, logger } = this.#obs;

    // add, not increment: this is a gauge that goes back down. A cumulative
    // representation of it would report every request ever handled as still in flight.
    metrics.add(M.httpInFlight, {}, 1);

    // One finish listener, registered once, which is why the status is read off the
    // response rather than returned by each handler. Handlers return void, so there is
    // nothing else to wrap.
    res.once('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      metrics.add(M.httpInFlight, {}, -1);
      metrics.increment(M.httpRequests, { route: template, status: statusClass(res.statusCode) });
      metrics.observe(M.httpDuration, { route: template }, seconds);
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (path === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', auth: this.#auth.isOpen ? 'open' : 'required' });
        return;
      }

      // Prometheus exposition format. Unauthenticated on purpose: a scraper has no
      // session, and requiring one would mean this endpoint is never the first thing
      // anyone checks. It exposes counters, not content, so there is nothing in it that
      // a document's existence would reveal.
      if (path === '/api/metrics' && req.method === 'GET') {
        this.#refreshProcessMetrics();
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Length': Buffer.byteLength(metrics.render()),
        });
        res.end(metrics.render());
        return;
      }

      // The one unauthenticated document-adjacent route, because it is how a client
      // obtains the token every other route requires. It hands out a random subject
      // and nothing else: no document is read, and no existing subject is disclosed.
      if (path === '/api/auth/session' && req.method === 'POST') {
        await this.#issueSession(req, res);
        return;
      }

      // Static assets, BEFORE authentication and before the API routes.
      //
      // Before auth, because a browser cannot send a bearer token when fetching the HTML
      // shell, and the shell is what obtains the token. After the `/api/` routes above,
      // so a file can never shadow a real endpoint.
      if (this.#static !== undefined) {
        const served = await serveStatic(this.#static, req, res, path);

        if (served !== null) {
          return;
        }
      }

      // Everything below is about a specific document and needs a caller. Resolved
      // once, here, so no handler can forget.
      const identity = await this.#identify(req);

      if (!identity.ok) {
        // RFC 6750: the challenge tells a client how to authenticate rather than
        // leaving it to guess.
        res.setHeader('WWW-Authenticate', 'Bearer realm="collab-editor"');
        sendError(res, 401, 'UNAUTHORIZED', identity.message);
        return;
      }

      if (path === '/api/documents' && req.method === 'GET') {
        // Scoped to the caller. The global list would disclose every title in the
        // database to anyone who asked, which is a leak created by adding
        // authentication rather than closed by it.
        await this.#listDocuments(req, res, identity.subject, url);
        return;
      }

      if (path === '/api/documents' && req.method === 'POST') {
        await this.#createDocument(req, res, identity.subject);
        return;
      }

      const collaboratorMatch = /^\/api\/documents\/([^/]+)\/collaborators(?:\/([^/]+))?$/.exec(
        path,
      );
      if (collaboratorMatch) {
        await this.#handleCollaborators(
          req,
          res,
          collaboratorMatch[1] ?? '',
          collaboratorMatch[2],
          identity.subject,
        );
        return;
      }

      const claimMatch = /^\/api\/documents\/([^/]+)\/claim$/.exec(path);
      if (claimMatch && req.method === 'POST') {
        await this.#handleClaim(res, claimMatch[1] ?? '', identity.subject);
        return;
      }

      const match = /^\/api\/documents\/([^/]+)$/.exec(path);
      if (match) {
        const id = match[1];
        if (!id) {
          sendError(res, 400, 'MISSING_ID', 'Document id is required.');
          return;
        }

        if (!DOCUMENT_ID_PATTERN.test(id)) {
          sendError(
            res,
            400,
            'INVALID_ID',
            'Document id must be 1-64 characters of A-Z, a-z, 0-9, hyphen or underscore.',
          );
          return;
        }

        // The single authorisation gate for a document, and the same decision the
        // WebSocket path makes. Two implementations of "may I touch this" would
        // eventually disagree, and the disagreement nobody notices is the permissive
        // one.
        if (!(await this.#db.canAccess(id, identity.subject))) {
          sendError(res, 404, 'DOCUMENT_NOT_FOUND', NOT_FOUND_MESSAGE);
          return;
        }

        if (req.method === 'GET') {
          await this.#getDocument(id, res);
          return;
        }

        if (req.method === 'PATCH') {
          await this.#patchDocument(id, req, res);
          return;
        }

        if (req.method === 'DELETE') {
          const deleted = await this.#deleteDocument(id, res, identity.subject);
          if (deleted) {
            return;
          }
          return;
        }
      }

      sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${path}`);
    } catch (error) {
      // Never leak internals to the client: a stack trace can disclose schema
      // details and file paths.
      logger.error('unhandled request error', { route: template, error });
      sendError(res, 500, 'INTERNAL', 'Something went wrong on the server.');
    }
  }

  /**
   * Sample process memory at scrape time.
   *
   * Deliberately not a background timer: a gauge nobody reads should not cost anything
   * to maintain, and the only moment the number is needed is the moment it is scraped.
   */
  #refreshProcessMetrics(): void {
    const usage = process.memoryUsage();
    this.#obs.metrics.set(M.processMemory, {}, usage.rss);
  }

  /**
   * Issue a session token.
   *
   * ---------------------------------------------------------------------------
   * WHY THE CALLER MAY CHOOSE ITS OWN SUBJECT
   * ---------------------------------------------------------------------------
   * This always minted a fresh random subject, and the client kept the resulting token in
   * memory only. The reasoning was that persisting a token to localStorage exposes it to any
   * script on the origin, and that "the cost of that is a user having to obtain a new session
   * after a reload."
   *
   * With ACCOUNTS that framing is right: reload, log in again. With ANONYMOUS identities it
   * is badly wrong, because there is no logging in. A new subject is a new person, so after
   * one reload the browser permanently loses server-side access to every document it had
   * opened. The local copy still renders from IndexedDB, so the failure looks like a flaky
   * network rather than a lost identity - and it never recovers.
   *
   * Observed in a real browser rather than in a test: the page reported "Offline" forever
   * while the server logged DOCUMENT_NOT_FOUND rejections about twice a second, indefinitely.
   *
   * So the SUBJECT becomes the durable thing and the token stays disposable. The client keeps
   * one random 128-bit subject in localStorage and presents it here; a fresh short-lived
   * token is minted from it on every load.
   *
   * SECURITY, stated plainly, because "anyone may claim any subject" sounds alarming:
   *
   *   - A subject is 16 random bytes. Guessing one is not an attack, so this is possession of
   *     a secret rather than an assertion of identity.
   *   - The threat model is unchanged in kind. Before, script on the origin could read a
   *     bearer token from memory and nothing more; now it can read the subject and mint
   *     tokens freely. Both amount to "script on this origin can act as this user".
   *   - What improves is that there is no long-lived token to steal and reuse until it
   *     expires, because the token is disposable and the subject is the only durable thing.
   *
   * A client with no stored subject still gets one minted, so this is additive and breaks
   * nothing that previously worked.
   */
  async #issueSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let subject = newSubject();
    let resumed = false;

    const body = await readJsonBody(req);

    if (!('error' in body)) {
      const requested: unknown = body.value['subject'];

      if (requested !== undefined) {
        if (!isValidSubject(requested)) {
          // Refused rather than ignored. Silently minting a different subject would leave
          // the client believing it had kept its identity while holding a new one, which is
          // the exact failure this endpoint exists to make impossible.
          sendError(res, 400, 'INVALID_BODY', SUBJECT_RULE_MESSAGE);

          return;
        }

        subject = requested;
        resumed = true;
      }
    }

    const issued = await this.#auth.issue(subject);

    this.#obs.metrics.increment(M.sessionsIssued, { resumed: String(resumed) });

    sendJson(res, 200, {
      token: issued.token,
      subject: issued.subject,
      expiresAt: issued.expiresAt,
      /** True when this was the caller's own subject rather than a freshly minted one. */
      resumed,
    });
  }

  /** Resolve the caller, or explain why it could not. */
  async #identify(req: IncomingMessage): Promise<IdentifyResult> {
    const header = req.headers.authorization;

    if (typeof header !== 'string' || header.trim() === '') {
      this.#rejectSession(templateFor(req.url), 'missing');
      return {
        ok: false,
        reason: 'missing',
        message: 'Provide a session token in the Authorization header.',
      };
    }

    // Case-insensitive scheme, per RFC 7235. `startsWith('Bearer ')` would reject a
    // legitimate `bearer` and is the kind of strictness that becomes a support
    // question with no security benefit.
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

    if (!match) {
      this.#rejectSession(templateFor(req.url), 'malformed-header');
      return {
        ok: false,
        reason: 'malformed-header',
        message: 'Authorization header must be "Bearer <token>".',
      };
    }

    try {
      const identity = await this.#auth.verify(match[1] ?? '');
      return { ok: true, subject: identity.subject };
    } catch (error) {
      const reason = error instanceof AuthError ? error.reason : 'unknown';
      const message =
        error instanceof AuthError ? error.message : 'Session token could not be verified.';

      this.#rejectSession(templateFor(req.url), reason);

      return { ok: false, reason, message };
    }
  }

  /**
   * Record a refused token.
   *
   * Split in two on purpose. The metric is keyed by a bounded set of reasons, so it is
   * safe to chart and shows the shape of the problem. The log gets the route, for the
   * one person investigating. The message itself never leaves the process: which of
   * "expired" and "bad-signature" applies is exactly what an attacker probing a
   * verifier wants to learn.
   */
  #rejectSession(route: string, reason: string): void {
    this.#obs.metrics.increment(M.authFailures, { reason });
    this.#obs.logger.warn('rejected session', { route, reason });
  }

  /**
   * Delete a document, which only its owner may do.
   *
   * Distinct from `canAccess`, because a collaborator may write a document but must
   * not be able to delete it. Delete is not a write; it is disposal.
   */
  async #deleteDocument(id: string, res: ServerResponse, subject: string): Promise<boolean> {
    const document = await this.#db.getDocument(id);

    // Unowned documents can be deleted by anyone who can reach them, which keeps
    // them from becoming undeletable clutter nobody owns.
    if (document !== null && document.owner !== null && document.owner !== subject) {
      sendError(res, 403, 'FORBIDDEN', 'Only the owner may delete a document.');
      return true;
    }

    const deleted = await this.#db.deleteDocument(id);

    if (!deleted) {
      sendError(res, 404, 'DOCUMENT_NOT_FOUND', NOT_FOUND_MESSAGE);
    } else {
      sendJson(res, 200, { deleted: true });
    }

    return true;
  }

  /** Grant, revoke or list access. */
  async #handleCollaborators(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    subject: string | undefined,
    caller: string,
  ): Promise<void> {
    if (!DOCUMENT_ID_PATTERN.test(id)) {
      sendError(res, 400, 'INVALID_ID', 'Document id contains unsupported characters.');
      return;
    }

    const existing = await this.#db.getDocument(id);

    if (existing === null) {
      sendError(res, 404, 'DOCUMENT_NOT_FOUND', NOT_FOUND_MESSAGE);
      return;
    }

    // Owner-only, for both granting and revoking. A collaborator handing out access
    // is how a document leaks past its owner without anyone noticing.
    if (existing.owner !== null && existing.owner !== caller) {
      sendError(res, 403, 'FORBIDDEN', 'Only the owner may change who has access.');
      return;
    }

    if (req.method === 'GET' && subject === undefined) {
      sendJson(res, 200, { collaborators: await this.#db.listCollaborators(id) });
      return;
    }

    if (req.method === 'POST' && subject === undefined) {
      const body = await readJsonBody(req);

      if ('error' in body) {
        sendError(res, 400, 'INVALID_BODY', body.error);
        return;
      }

      const target = body.value['subject'];

      if (typeof target !== 'string') {
        sendError(res, 400, 'INVALID_BODY', 'Provide a subject to grant access to.');
        return;
      }

      const granted = await this.#db.grantAccess(id, target, caller);

      // Idempotent on purpose. A client that retries a grant because it never saw the
      // response gets 200 and the same access, not an error for something that had
      // already succeeded. The benchmark harness re-runs `setup()` against a warm
      // database and hit exactly that, which is how the bug was found.
      //
      // The ownership check above already rejected a stranger, so `not-owner` here can
      // only mean the document changed hands between the two queries. That race is
      // narrow, but it is why this handler re-checks instead of trusting the first answer.
      switch (granted.outcome) {
        case 'granted':
          sendJson(res, 200, { granted: true, subject: target, alreadyGranted: false });
          return;

        case 'already-granted':
          sendJson(res, 200, { granted: true, subject: target, alreadyGranted: true });
          return;

        case 'not-owner':
          sendError(res, 403, 'FORBIDDEN', 'Only the owner may change who has access.');
          return;

        case 'no-document':
          // Also only reachable through that race: the document existed a moment ago.
          // 404 rather than 400 because this is the more useful answer, and the
          // existence-oracle argument does not apply to a caller who just saw it.
          sendError(res, 404, 'DOCUMENT_NOT_FOUND', NOT_FOUND_MESSAGE);
          return;

        case 'invalid-subject':
          // 400, not 404, because the caller demonstrably knows this document exists:
          // they created it or were already granted access. Reporting "not found" here
          // would be the existence-oracle protection applied to somebody it cannot help.
          sendError(res, 400, 'INVALID_BODY', 'That subject cannot be stored.');
          return;
      }
    }

    if (req.method === 'DELETE' && subject !== undefined) {
      const revoked = await this.#db.revokeAccess(id, subject, caller);

      if (!revoked) {
        sendError(res, 403, 'FORBIDDEN', 'Only the owner may change who has access.');
        return;
      }

      sendJson(res, 200, { revoked: true, subject });
      return;
    }

    sendError(res, 405, 'BAD_MESSAGE', `${req.method} is not supported on collaborators.`);
  }

  /** Take ownership of an unowned document. */
  async #handleClaim(res: ServerResponse, id: string, caller: string): Promise<void> {
    if (!DOCUMENT_ID_PATTERN.test(id)) {
      sendError(res, 400, 'INVALID_ID', 'Document id contains unsupported characters.');
      return;
    }

    const claimed = await this.#db.claimOwnership(id, caller);

    if (!claimed) {
      // Either it does not exist or somebody already owns it. Saying which would
      // tell a caller who owns a document they cannot otherwise see.
      sendError(res, 409, 'DOCUMENT_NOT_FOUND', 'Document is missing or already owned.');
      return;
    }

    sendJson(res, 200, { claimed: true, documentId: id });
  }

  /**
   * One page of the caller's documents.
   *
   * `limit` (1..100, default 50) and `cursor` are optional, and the response shape is unchanged for
   * a client that sends neither: `documents` is still an array of the same records. `nextCursor` is
   * added alongside it and is absent on the last page, so an old client reading `.documents` is
   * unaffected and a new one can page.
   *
   * Both parameters are refused rather than clamped when out of range. A client that asked for 500
   * and silently received 100 cannot tell that its pagination is wrong, and would carry on
   * believing it had seen everything.
   */
  async #listDocuments(
    req: IncomingMessage,
    res: ServerResponse,
    subject: string,
    url: URL,
  ): Promise<void> {
    const requestedLimit = url.searchParams.get('limit');
    const limit = parsePageSize(requestedLimit);

    if (limit === null) {
      sendError(
        res,
        400,
        'INVALID_LIMIT',
        `limit must be an integer between ${String(MIN_PAGE_SIZE)} and ${String(MAX_PAGE_SIZE)}.`,
      );
      return;
    }

    const rawCursor = url.searchParams.get('cursor');
    // Absent means "start at the beginning". Present but unparseable is an error, because a client
    // holding a cursor this server cannot read has a bug or a stale value, and quietly treating it
    // as page one would show the user a list they have already seen with no indication of it.
    const decoded = rawCursor === null ? null : decodeDocumentCursor(rawCursor);

    if (rawCursor !== null && decoded === null) {
      sendError(res, 400, 'INVALID_CURSOR', 'cursor is not a cursor this server issued.');
      return;
    }

    const cursor = decoded ?? undefined;

    const page = await this.#db.listDocumentsFor(subject, limit, cursor);

    // `nextCursor` is omitted rather than null on the last page, so a client can test for it.
    if (page.nextCursor === null) {
      sendJson(res, 200, { documents: page.documents });
    } else {
      sendJson(res, 200, { documents: page.documents, nextCursor: page.nextCursor });
    }

    void req;
  }

  async #createDocument(req: IncomingMessage, res: ServerResponse, subject: string): Promise<void> {
    if (!this.#allowCreate()) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many documents created. Try again later.');
      return;
    }

    const body = await readJsonBody(req);

    if ('error' in body) {
      sendError(res, 400, 'INVALID_BODY', body.error);
      return;
    }

    const id = typeof body.value['id'] === 'string' ? body.value['id'] : undefined;
    const title = typeof body.value['title'] === 'string' ? body.value['title'] : undefined;

    if (!id) {
      sendError(res, 400, 'MISSING_ID', 'An id is required.');
      return;
    }

    if (!DOCUMENT_ID_PATTERN.test(id)) {
      sendError(res, 400, 'INVALID_ID', 'Document id contains unsupported characters.');
      return;
    }

    if (title !== undefined && titleTooLong(title, this.#limits.maxTitleLength)) {
      sendError(
        res,
        400,
        'TITLE_TOO_LONG',
        `Title exceeds ${this.#limits.maxTitleLength} characters.`,
      );
      return;
    }

    const existing = await this.#db.getDocument(id);
    if (existing) {
      // 409 rather than an overwrite: silently replacing a document would
      // destroy work the user believes is saved.
      sendError(res, 409, 'ALREADY_EXISTS', 'A document with that id already exists.');
      return;
    }

    const document = await this.#db.createDocument({
      id,
      title: title ?? 'Untitled',
      // The caller becomes the owner, so the document stops being world-writable the
      // moment it is created. Creating it unowned would mean every document anyone
      // ever makes is readable by anyone who learns its id.
      owner: subject,
    });

    sendJson(res, 201, { document });
  }

  async #getDocument(id: string, res: ServerResponse): Promise<void> {
    const document = await this.#db.getDocument(id);

    if (!document) {
      sendError(res, 404, 'NOT_FOUND', 'Document does not exist.');
      return;
    }

    sendJson(res, 200, { document });
  }

  async #patchDocument(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);

    if ('error' in body) {
      sendError(res, 400, 'INVALID_BODY', body.error);
      return;
    }

    const payload = body.value;

    // Reject unknown fields rather than ignoring them: a client sending
    // `{contents: ...}` with a typo should be told, not silently dropped.
    const allowed = new Set(['content', 'title']);
    const unexpected = Object.keys(payload).filter((key) => !allowed.has(key));

    if (unexpected.length > 0) {
      sendError(
        res,
        400,
        'UNEXPECTED_FIELDS',
        `Unsupported field(s): ${unexpected.join(', ')}. Expected ${[...allowed].join(', ')}.`,
      );
      return;
    }

    if (typeof payload['content'] === 'string') {
      const result = await this.#db.saveDocument(id, payload['content']);

      if (!result) {
        sendError(res, 404, 'NOT_FOUND', 'Document does not exist.');
        return;
      }

      sendJson(res, 200, { updatedAt: result.updatedAt, changed: result.changed });
      return;
    }

    if (typeof payload['title'] === 'string') {
      // Same limit as create, and for the same reason: a title is one column on one row, but it
      // is also what a user sees in a document list, and the create route being bounded is no
      // help if the rename route is not.
      if (titleTooLong(payload['title'], this.#limits.maxTitleLength)) {
        sendError(
          res,
          400,
          'TITLE_TOO_LONG',
          `Title exceeds ${this.#limits.maxTitleLength} characters.`,
        );
        return;
      }

      const result = await this.#db.renameDocument(id, payload['title']);

      if (!result) {
        sendError(res, 404, 'NOT_FOUND', 'Document does not exist.');
        return;
      }

      sendJson(res, 200, { updatedAt: result.updatedAt, changed: result.changed });
      return;
    }

    sendError(res, 400, 'INVALID_BODY', 'Provide either content or title.');
  }

  /** Sliding one-hour window. In-memory: Phase 5 moves this behind Redis. */
  #allowCreate(): boolean {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    this.#createTimestamps = this.#createTimestamps.filter((time) => time > hourAgo);

    if (this.#createTimestamps.length >= MAX_CREATE_PER_HOUR) {
      return false;
    }

    this.#createTimestamps.push(Date.now());
    return true;
  }
}

type BodyResult = { value: Record<string, unknown> } | { error: string };

async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;

    if (total > MAX_BODY_BYTES) {
      return { error: `Request body exceeds ${MAX_BODY_BYTES} bytes.` };
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  if (raw.trim() === '') {
    return { value: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'Request body must be a JSON object.' };
    }

    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: 'Request body is not valid JSON.' };
  }
}

/**
 * Write a JSON response.
 *
 * Synchronous by design Ã¢â‚¬â€ `res.end()` on an in-memory payload returns
 * immediately. Returning a promise anyway would let handlers `await` it and keep
 * one uniform shape, but it would also imply a real async boundary that does not
 * exist, which is how `async` functions with no `await` end up hiding errors.
 *
 * `charset=utf-8` is not optional. Without it, HTTP clients are free to guess the
 * encoding, and several guess Latin-1 Ã¢â‚¬â€ silently corrupting any non-ASCII
 * document text. Caught by the byte-level assertions in `e2e.test.ts`.
 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export type { DocumentRecord };
