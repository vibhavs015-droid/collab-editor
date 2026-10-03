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

import type { Database } from './db.js';
import type { DocumentRecord } from './db.js';

export interface ApiServerOptions {
  readonly db: Database;
  readonly host?: string;
  readonly port?: number;
  /** Escape hatch for tests: called when the server is listening. */
  readonly onListen?: (address: { host: string; port: number }) => void;
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

export class ApiServer {
  readonly #db: Database;
  readonly #host: string;
  readonly #port: number;
  readonly #onListen: ((address: { host: string; port: number }) => void) | undefined;
  readonly #server: Server;
  #createTimestamps: number[] = [];

  constructor(options: ApiServerOptions) {
    this.#db = options.db;
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 3001;
    this.#onListen = options.onListen;
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    try {
      if (path === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (path === '/api/documents' && req.method === 'GET') {
        const documents = await this.#db.listDocuments(50);
        sendJson(res, 200, { documents });
        return;
      }

      if (path === '/api/documents' && req.method === 'POST') {
        await this.#createDocument(req, res);
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

        if (req.method === 'GET') {
          await this.#getDocument(id, res);
          return;
        }

        if (req.method === 'PATCH') {
          await this.#patchDocument(id, req, res);
          return;
        }

        if (req.method === 'DELETE') {
          const deleted = await this.#db.deleteDocument(id);
          if (!deleted) {
            sendError(res, 404, 'NOT_FOUND', 'Document does not exist.');
            return;
          }
          sendJson(res, 200, { deleted: true });
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

  async #createDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
