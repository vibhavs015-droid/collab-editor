/**
 * HTTP API for documents.
 *
 * Node's built-in `http` server, no framework. Phase 1 routes are simple enough
 * that Express would add a dependency and a layer of indirection to express one
 * function. If routing grows genuinely complex, this is the file to revisit â€”
 * not before.
 *
 * Every handler is a plain `(req, res) => Promise<void>`, so each one is directly
 * testable against a real server without a mocking library.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Database } from './db.js';
import type { DocumentRecord } from './db.js';
import { AuthError, OpenAuthenticator, newSubject, type Authenticator } from './auth.js';

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

/** Outcome of identifying the caller. */
type IdentifyResult = { ok: true; subject: string } | { ok: false; message: string };

export interface ApiServerOptions {
  readonly db: Database;
  readonly host?: string;
  readonly port?: number;
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
}

/** Documents are addressed by a URL-safe id. */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Hard ceiling on request body size.
 *
 * Not optional. Without a limit, a single request can exhaust memory, and an
 * editor's autosave is an endpoint that accepts arbitrary-length text by design.
 */
const MAX_BODY_BYTES = 1_000_000;

/** Documents a single client may create before being rejected. */
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
  readonly #server: Server;
  /** Registered upgrade routes, checked before any request is handled. */
  readonly #upgrades: UpgradeHandler[] = [];
  #createTimestamps: number[] = [];

  constructor(options: ApiServerOptions) {
    this.#db = options.db;
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 3001;
    this.#onListen = options.onListen;
    this.#auth = options.auth ?? new OpenAuthenticator();
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

  async close(): Promise<void> {
    // Drain in-flight requests before closing, otherwise a test can finish with
    // a half-written response and a hanging socket.
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

      // The one unauthenticated document-adjacent route, because it is how a client
      // obtains the token every other route requires. It hands out a random subject
      // and nothing else: no document is read, and no existing subject is disclosed.
      if (path === '/api/auth/session' && req.method === 'POST') {
        await this.#issueSession(res);
        return;
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
        const documents = await this.#db.listDocumentsFor(identity.subject, 50);
        sendJson(res, 200, { documents });
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
      process.stderr.write(`[api] unhandled error: ${String(error)}\n`);
      sendError(res, 500, 'INTERNAL', 'Something went wrong on the server.');
    }
  }

  /**
   * Mint an anonymous session.
   *
   * No rate limit, deliberately. Signing HS256 costs microseconds, so a limit here
   * would be overhead pretending to be protection. The endpoints worth limiting are
   * the ones that touch the database, and `helloTimeout` already bounds how often a
   * socket can make the server do that.
   */
  async #issueSession(res: ServerResponse): Promise<void> {
    const issued = await this.#auth.issue(newSubject());

    sendJson(res, 200, {
      token: issued.token,
      subject: issued.subject,
      expiresAt: issued.expiresAt,
    });
  }

  /** Resolve the caller, or explain why it could not. */
  async #identify(req: IncomingMessage): Promise<IdentifyResult> {
    const header = req.headers.authorization;

    if (typeof header !== 'string' || header.trim() === '') {
      return { ok: false, message: 'Provide a session token in the Authorization header.' };
    }

    // Case-insensitive scheme, per RFC 7235. `startsWith('Bearer ')` would reject a
    // legitimate `bearer` and is the kind of strictness that becomes a support
    // question with no security benefit.
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());

    if (!match) {
      return { ok: false, message: 'Authorization header must be "Bearer <token>".' };
    }

    try {
      const identity = await this.#auth.verify(match[1] ?? '');
      return { ok: true, subject: identity.subject };
    } catch (error) {
      const message =
        error instanceof AuthError ? error.message : 'Session token could not be verified.';

      return { ok: false, message };
    }
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

      if (!granted) {
        sendError(res, 400, 'INVALID_BODY', 'That subject cannot be stored.');
        return;
      }

      sendJson(res, 200, { granted: true, subject: target });
      return;
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
 * Synchronous by design â€” `res.end()` on an in-memory payload returns
 * immediately. Returning a promise anyway would let handlers `await` it and keep
 * one uniform shape, but it would also imply a real async boundary that does not
 * exist, which is how `async` functions with no `await` end up hiding errors.
 *
 * `charset=utf-8` is not optional. Without it, HTTP clients are free to guess the
 * encoding, and several guess Latin-1 â€” silently corrupting any non-ASCII
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
