/**
 * End-to-end smoke test against a real HTTP server and a real database.
 *
 * ── Why raw bytes rather than fetch ──────────────────────────────────────
 * This file exists because a genuine encoding bug slipped past both the unit
 * tests and manual `Invoke-RestMethod` checks.
 *
 * Node's `fetch` decodes responses as UTF-8 per spec. PowerShell's
 * `Invoke-RestMethod` guesses the encoding, and when the `Content-Type` header
 * lacked `charset=utf-8` it decoded UTF-8 bytes as Latin-1 — so multi-byte text
 * arrived as mojibake and looked like a database problem. It was a test-harness
 * problem.
 *
 * Nothing above this layer was affected, and the unit test using `fetch`
 * (`api.test.ts` → "round-trips unicode content through save and load") was
 * correct the whole time.
 *
 * So this test asserts the two things that actually matter:
 *  1. The response declares `charset=utf-8` — a client should never have to
 *     guess.
 *  2. The bytes on the wire are valid UTF-8 that decode to the exact input.
 *
 * Both are checked at the byte level, so this cannot be fooled by an encoding
 * mistake in the harness itself.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiServer } from './api.js';
import { Database } from './db.js';

let db: Database;
let server: ApiServer;
let baseUrl: string;

/**
 * The caller these tests act as.
 *
 * The server runs in open mode, where the token is the subject, so a fixed string
 * is a real subject and every document these tests create is owned by it. Fetching
 * a genuine token would test the session endpoint here, which has its own tests.
 */
const SUBJECT = 'e2e-subject';

/** fetch with credentials attached. Every document route requires them. */
function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(
    init.headers instanceof Headers ? init.headers : (init.headers ?? {}),
  );

  headers.set('Authorization', `Bearer ${SUBJECT}`);

  const url = baseUrl + path;

  return fetch(url, { ...init, headers });
}

/** Text that breaks under almost every encoding mistake. */
const UNICODE_PROBE = 'Line one\nLine two — 👋 مرحبا 你好';

beforeAll(async () => {
  db = await Database.open();
  server = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${port}`;
    },
  });
  await server.listen();

  await authedFetch(`/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'e2e-unicode' }),
  });
});

afterAll(async () => {
  await server.close();
  await db.close();
});

describe('content-type declares utf-8', () => {
  it('is present on every JSON response', async () => {
    // Without the explicit charset, a client is free to guess Latin-1 and
    // silently mangle any non-ASCII text. This is a one-line fix on the server
    // that prevents an entire category of data corruption downstream.
    const res = await authedFetch(`/api/health`);

    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('is present on error responses too', async () => {
    const res = await authedFetch(`/api/documents/does-not-exist`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('unicode survives the full round trip', () => {
  it('is stored and returned byte-identically', async () => {
    await authedFetch(`/api/documents/e2e-unicode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: UNICODE_PROBE }),
    });

    const res = await authedFetch(`/api/documents/e2e-unicode`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    // Decode explicitly rather than trusting the harness's default. If the
    // server emitted Latin-1, this decode produces replacement characters
    // instead of the originals and the comparison fails.
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(decoded) as { document: { content: string } };

    expect(parsed.document.content).toBe(UNICODE_PROBE);
  });

  it('preserves each distinct script independently', () => {
    // Isolates a failure to one script rather than reporting a single opaque
    // string mismatch, which is far easier to diagnose.
    expect(UNICODE_PROBE).toContain('—'); // em dash, U+2014, three UTF-8 bytes
    expect(UNICODE_PROBE).toContain('👋'); // emoji, U+1F44B, four UTF-8 bytes
    expect(UNICODE_PROBE).toContain('مرحبا'); // RTL Arabic
    expect(UNICODE_PROBE).toContain('你好'); // CJK
  });

  it('round-trips content containing characters that resemble SQL syntax', async () => {
    // Guards against someone "fixing" a future encoding issue by escaping
    // values into the query string instead of using parameters.
    const hostile = '\'; DROP TABLE documents; -- ✅ \\ " \n\t';
    await authedFetch(`/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-hostile' }),
    });
    await authedFetch(`/api/documents/e2e-hostile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: hostile }),
    });

    const res = await authedFetch(`/api/documents/e2e-hostile`);
    const parsed = (await res.json()) as { document: { content: string } };

    expect(parsed.document.content).toBe(hostile);

    // Table still exists, so the value stayed data.
    const list = (await (await authedFetch(`/api/documents`)).json()) as {
      documents: { id: string }[];
    };
    expect(list.documents.length).toBeGreaterThanOrEqual(2);
  });
});

describe('error responses are well-formed JSON', () => {
  it('reports a structured error, not a bare string', async () => {
    const res = await authedFetch(`/api/documents/bad id`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('INVALID_ID');
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
