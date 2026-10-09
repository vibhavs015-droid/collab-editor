/**
 * The document list over HTTP: pagination parameters and the response shape.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHAPE MATTERS AS MUCH AS THE PAGEING
 * ---------------------------------------------------------------------------
 * T6 requires the OLD response to stay valid, because a client deployed against the previous
 * server must not break when the server is upgraded underneath it. That is checked here against a
 * request that sends neither `limit` nor `cursor` - the exact shape an old client sends - and the
 * assertions are about the response, not about the new fields being present.
 *
 * A test that only checked `documents` was an array would pass even if `nextCursor` were
 * meaningless, so the paging itself is covered in documentCursor.test.ts and this file covers the
 * HTTP contract: what is accepted, what is refused, and what is disclosed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiServer } from './api.js';
import { Database } from './db.js';
import { encodeDocumentCursor } from './documentCursor.js';

const SUBJECT = 'list-subject';

let db: Database;
let server: ApiServer;
let baseUrl: string;

/**
 * One database and one server for the whole file, truncated between tests.
 *
 * Booting PGlite costs about two seconds and binding a socket costs a little more, so doing both
 * per test made this file slow enough to add resource pressure to the suite. The database is
 * truncated rather than replaced, which `truncateAll` documents as safe: `documents` cascades to
 * operations, collaborators and snapshots.
 *
 * The server is shared, so `baseUrl` is fixed for the file. Nothing here depends on a fresh port.
 */
beforeAll(async () => {
  db = await Database.open();
  server = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${String(port)}`;
    },
  });

  await server.listen();
});

beforeEach(async () => {
  await db.truncateAll();
});

afterAll(async () => {
  try {
    await server.close();
  } catch {
    /* already closed */
  }

  await db.close();
});

function authedFetch(path: string): Promise<Response> {
  return fetch(baseUrl + path, { headers: { Authorization: `Bearer ${SUBJECT}` } });
}

let counter = 0;
async function createDocument(owner: string, updatedAt?: Date): Promise<string> {
  counter += 1;
  const id = `list-doc-${String(counter)}`;
  await db.createDocument({
    id,
    owner,
    title: id,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });
  return id;
}

/** Create `count` documents for SUBJECT, newest last, one minute apart. */
async function createMany(count: number, owner = SUBJECT): Promise<string[]> {
  const ids: string[] = [];
  const base = Date.UTC(2026, 0, 1);

  for (let i = 0; i < count; i += 1) {
    ids.push(await createDocument(owner, new Date(base + i * 60_000)));
  }

  return ids;
}

interface ListBody {
  documents?: { id: string }[];
  nextCursor?: string;
}

describe('GET /api/documents', () => {
  it('keeps the old response shape valid for a client that sends no parameters', async () => {
    // THE COMPATIBILITY CLAIM. This is the request an already-deployed client makes.
    await createMany(2);

    const res = await authedFetch('/api/documents');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as ListBody;

    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents).toHaveLength(2);
    // Absent, not null: a client testing `if (body.nextCursor)` works either way, but a client
    // testing `'nextCursor' in body` does not.
    expect('nextCursor' in body).toBe(false);
  });

  it('honours limit', async () => {
    await createMany(5);

    const body = (await (await authedFetch('/api/documents?limit=2')).json()) as ListBody;

    expect(body.documents).toHaveLength(2);
    expect(typeof body.nextCursor).toBe('string');
  });

  it('walks pages to the end', async () => {
    const ids = await createMany(5);

    const seen: string[] = [];
    let url = '/api/documents?limit=2';

    for (let page = 0; page < 10; page += 1) {
      const body = (await (await authedFetch(url)).json()) as ListBody;
      seen.push(...(body.documents ?? []).map((d) => d.id));

      if (typeof body.nextCursor !== 'string') {
        break;
      }

      url = `/api/documents?limit=2&cursor=${encodeURIComponent(body.nextCursor)}`;
    }

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it.each(['0', '101', '-1', '1.5', 'abc', '1e2'])('refuses limit=%s with 400', async (raw) => {
    await createMany(1);

    const res = await authedFetch(`/api/documents?limit=${encodeURIComponent(raw)}`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INVALID_LIMIT');
  });

  it.each([
    ['not-base64!!', 'rubbish'],
    ['', 'empty'],
    ['e30', 'base64 of an empty object'],
    [encodeDocumentCursor({ at: 'nope', id: 'a' }), 'a cursor with a bad timestamp'],
    [
      encodeDocumentCursor({ at: '2026-01-01 00:00:00.000000Z', id: '../etc' }),
      'a cursor whose id is not an id',
    ],
  ])('refuses a cursor that is not one this server issued (%s) with 400', async (raw) => {
    await createMany(1);

    const res = await authedFetch(`/api/documents?cursor=${encodeURIComponent(raw)}`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('INVALID_CURSOR');
  });

  it("does not disclose another subject's documents through a cursor", async () => {
    // The security property, over HTTP. Mallory builds a cursor from HER list and sends it to
    // alice's endpoint; the WHERE clause must still exclude mallory's rows.
    await createMany(3, SUBJECT);
    const mallory = await createMany(2, 'mallory');

    const malloryView = (await (await authedFetch('/api/documents?limit=1')).json()) as ListBody;
    void malloryView;

    // Build mallory's cursor by asking as mallory.
    const asMallory = await fetch(baseUrl + '/api/documents?limit=1', {
      headers: { Authorization: 'Bearer mallory' },
    });
    const malloryBody = (await asMallory.json()) as ListBody;
    expect(typeof malloryBody.nextCursor).toBe('string');

    const asAlice = (await (
      await authedFetch(
        `/api/documents?limit=100&cursor=${encodeURIComponent(malloryBody.nextCursor ?? '')}`,
      )
    ).json()) as ListBody;

    const returned = (asAlice.documents ?? []).map((d) => d.id);

    for (const id of mallory) {
      expect(returned, `${id} leaked`).not.toContain(id);
    }
  });

  it('still requires authentication', async () => {
    const res = await fetch(baseUrl + '/api/documents?limit=2&cursor=whatever');

    // Whether this is 401 or 403 depends on the authenticator; what matters is that a cursor does
    // not become a way in.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
