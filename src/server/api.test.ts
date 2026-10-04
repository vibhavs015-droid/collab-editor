import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiServer } from './api.js';
import { Database } from './db.js';

let db: Database;
let server: ApiServer;
let baseUrl: string;

/**
 * The caller these tests act as.
 *
 * A fixed string rather than a fetched token, because the server under test runs in
 * open mode where the token IS the subject. A real subject would add a dependency
 * on the session endpoint without testing anything the other tests do not.
 */
const SUBJECT = 'test-subject';

/** fetch with credentials attached. Every document route requires them. */
function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const existing = init.headers;

  const headers = existing instanceof Headers ? new Headers(existing) : new Headers(existing ?? {});

  headers.set('Authorization', `Bearer ${SUBJECT}`);

  // Concatenated rather than templated with `${baseUrl}` inline, because a
  // whole-file replacement of `fetch(\`${baseUrl}` to `authedFetch(\`` rewrites this
  // line into a call to itself. Worth a comment so the next person does the same.
  const url = baseUrl + path;

  return fetch(url, { ...init, headers });
}

beforeEach(async () => {
  // Port 0 lets the OS assign a free port, so tests never collide with a
  // running dev server or each other.
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
});

afterEach(async () => {
  await server.close();
  await db.close();
});

async function createDocument(id: string, title = 'Untitled'): Promise<Response> {
  return authedFetch(`/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title }),
  });
}

describe('GET /api/health', () => {
  it('reports ok, and says whether authentication is actually on', async () => {
    const res = await authedFetch(`/api/health`);

    expect(res.status).toBe(200);
    // `auth` is on this endpoint so an operator can tell at a glance whether a
    // deployment is running unauthenticated. A health check that only says "ok"
    // cannot distinguish a secured server from an open one.
    expect(await res.json()).toEqual({ status: 'ok', auth: 'open' });
  });
});

describe('POST /api/documents', () => {
  it('creates a document and returns 201', async () => {
    const res = await createDocument('doc-1', 'My Doc');

    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: { id: string; title: string } };
    expect(body.document.id).toBe('doc-1');
    expect(body.document.title).toBe('My Doc');
  });

  it('rejects a duplicate id with 409, not a silent overwrite', async () => {
    await createDocument('doc-1', 'Original');

    const res = await createDocument('doc-1', 'Replacement');
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ALREADY_EXISTS');
  });

  it('rejects a missing id with 400', async () => {
    const res = await authedFetch(`/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No id' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects a traversal-shaped id with 400', async () => {
    // Path traversal in an id is the classic way to escape a table lookup.
    const res = await createDocument('../etc/passwd');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('rejects malformed JSON with 400 and does not crash', async () => {
    const res = await authedFetch(`/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_BODY');
  });

  it('rejects a JSON array body with 400', async () => {
    const res = await authedFetch(`/api/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/documents/:id', () => {
  it('returns the document', async () => {
    await createDocument('doc-1', 'My Doc');

    const res = await authedFetch(`/api/documents/doc-1`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { document: { id: string } };
    expect(body.document.id).toBe('doc-1');
  });

  it('returns 404 for a missing document', async () => {
    const res = await authedFetch(`/api/documents/nope`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    // DOCUMENT_NOT_FOUND, not NOT_FOUND: this code covers both "no such document"
    // and "not yours", on purpose, so a caller cannot use the API to discover which
    // ids are real.
    expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('PATCH /api/documents/:id', () => {
  it('saves content and reports changed: true', async () => {
    await createDocument('doc-1');

    const res = await authedFetch(`/api/documents/doc-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello world' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(true);
  });

  it('reports changed: false when content is identical', async () => {
    // Autosave fires on a timer; the client needs to distinguish a real write
    // from a no-op so it does not claim "Saved" on every tick.
    await createDocument('doc-1');
    await authedFetch(`/api/documents/doc-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'same' }),
    });

    const res = await authedFetch(`/api/documents/doc-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'same' }),
    });

    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
  });

  it('renames via title', async () => {
    await createDocument('doc-1', 'Old');

    const res = await authedFetch(`/api/documents/doc-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { document?: unknown };
    expect(body).toBeDefined();

    const fetched = await authedFetch(`/api/documents/doc-1`);
    const doc = (await fetched.json()) as { document: { title: string } };
    expect(doc.document.title).toBe('New');
  });

  it('rejects an unknown field rather than ignoring a typo', async () => {
    // Silently dropping `{contents: ...}` would leave the user believing their
    // edits were saved when they were not.
    await createDocument('doc-1');

    const res = await authedFetch(`/api/documents/doc-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: 'typo' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNEXPECTED_FIELDS');
  });

  it('returns 404 when saving a document that does not exist', async () => {
    const res = await authedFetch(`/api/documents/ghost`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'text' }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects an empty patch with a clear message', async () => {
    await createDocument('doc-1');

    const res = await authedFetch(`/api/documents/doc-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/documents', () => {
  it('lists documents newest first', async () => {
    // Touches 'a' after creating 'b', so this asserts `updated_at` ordering rather
    // than insertion order. Insertion order would pass either way.
    await createDocument('a', 'A');
    await createDocument('b', 'B');
    await authedFetch(`/api/documents/a`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'touched last' }),
    });

    const res = await authedFetch(`/api/documents`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { documents: { id: string }[] };
    expect(body.documents[0]?.id).toBe('a');
  });

  it('returns a stable order for documents sharing a timestamp', async () => {
    await createDocument('x', 'X');
    await createDocument('y', 'Y');
    await createDocument('z', 'Z');

    const read = async (): Promise<string[]> => {
      const res = await authedFetch(`/api/documents`);
      const body = (await res.json()) as { documents: { id: string }[] };
      return body.documents.map((doc) => doc.id);
    };

    // Two identical requests must produce two identical orders. Anything else means
    // the endpoint cannot be paginated against.
    expect(await read()).toEqual(await read());
  });

  it('returns an empty list rather than an error when there is nothing stored', async () => {
    const res = await authedFetch(`/api/documents`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: unknown[] };
    expect(body.documents).toEqual([]);
  });
});

describe('DELETE /api/documents/:id', () => {
  it('deletes an existing document', async () => {
    await createDocument('doc-1');

    const res = await authedFetch(`/api/documents/doc-1`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const after = await authedFetch(`/api/documents/doc-1`);
    expect(after.status).toBe(404);
  });

  it('returns 404 for a document that does not exist', async () => {
    const res = await authedFetch(`/api/documents/ghost`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('unknown routes', () => {
  it('returns 404 JSON rather than an HTML error page', async () => {
    const res = await authedFetch(`/nonsense`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('rejects an unsupported method on a known path', async () => {
    const res = await authedFetch(`/api/health`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('CORS preflight', () => {
  it('answers OPTIONS with 204 and no body', async () => {
    const res = await authedFetch(`/api/documents`, { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
  });
});

describe('unicode and large payloads', () => {
  it('round-trips unicode content through save and load', async () => {
    await createDocument('uni');
    const content = '👋 héllo — مرحبا 你好';

    await authedFetch(`/api/documents/uni`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    const res = await authedFetch(`/api/documents/uni`);
    const body = (await res.json()) as { document: { content: string } };
    expect(body.document.content).toBe(content);
  });

  it('accepts a large document body', async () => {
    await createDocument('big');
    const content = 'y'.repeat(500_000);

    const res = await authedFetch(`/api/documents/big`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    expect(res.status).toBe(200);
  });
});
