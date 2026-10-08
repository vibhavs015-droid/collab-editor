/**
 * Title length, over HTTP, on both routes that accept one.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH ROUTES ARE HERE AND NOT ONLY THE CREATE ROUTE
 * ---------------------------------------------------------------------------
 * A limit on create is no protection at all if rename is unbounded: the same client that could
 * not have created the long title can rename an existing document to it in one request. Any
 * quota enforced on one entry point and forgotten on the second is a quota with a hole in it,
 * and the hole is the whole length of the document list.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiServer } from './api.js';
import { Database } from './db.js';
import { DEFAULT_LIMITS, limitsWith, type Limits } from './limits.js';

const SUBJECT = 'title-limit-subject';
const SMILE = '\u{1F600}';

let db: Database;
let server: ApiServer;
let baseUrl: string;
let limits: Limits;

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(
    init.headers instanceof Headers ? init.headers : (init.headers ?? {}),
  );

  headers.set('Authorization', `Bearer ${SUBJECT}`);

  return fetch(baseUrl + path, { ...init, headers });
}

async function create(id: string, title: unknown): Promise<Response> {
  return authedFetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title }),
  });
}

async function rename(id: string, title: unknown): Promise<Response> {
  return authedFetch(`/api/documents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

async function errorCode(res: Response): Promise<string> {
  return String(((await res.json()) as { error?: { code?: string } }).error?.code ?? '');
}

beforeEach(async () => {
  limits = DEFAULT_LIMITS;
  db = await Database.open();
  server = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    limits,
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

/** Restart the server with a small cap, so the boundary is reachable in a test. */
async function withLimits(next: Limits): Promise<void> {
  await server.close();
  await db.close();

  limits = next;
  db = await Database.open();
  server = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    limits,
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${port}`;
    },
  });
  await server.listen();
}

describe('title length on create', () => {
  it('accepts a title of exactly the limit', async () => {
    const res = await create('at-limit', 'x'.repeat(limits.maxTitleLength));

    expect(res.status).toBe(201);
  });

  it('rejects one character past it, with TITLE_TOO_LONG', async () => {
    const res = await create('over-limit', 'x'.repeat(limits.maxTitleLength + 1));

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('TITLE_TOO_LONG');
  });

  it('counts code points, so an emoji title gets the full allowance', async () => {
    // 200 emoji is 400 UTF-16 units. A `String.length` check would refuse it, which halves the
    // allowance for exactly the users whose titles are short and non-Latin.
    const res = await create('emoji-title', SMILE.repeat(limits.maxTitleLength));

    expect(res.status).toBe(201);

    const stored = await authedFetch('/api/documents/emoji-title');
    const body = (await stored.json()) as { document: { title: string } };

    expect(body.document.title).toHaveLength(limits.maxTitleLength * 2);
  });

  it('rejects an emoji title one code point past the limit', async () => {
    const res = await create('emoji-over', SMILE.repeat(limits.maxTitleLength + 1));

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('TITLE_TOO_LONG');
  });

  it('leaves no document behind when it refuses', async () => {
    // A rejected create that still inserted a row would consume the id, and a client that
    // retried with a shorter title would then get ALREADY_EXISTS and have no idea why.
    await create('ghost', 'x'.repeat(limits.maxTitleLength + 1));

    const res = await authedFetch('/api/documents/ghost');

    expect(res.status).toBe(404);
  });

  it('still creates a document with no title at all', async () => {
    // The default title is used when the field is absent, and that must keep working.
    const res = await create('untitled', undefined);

    expect(res.status).toBe(201);
  });
});

describe('title length on rename', () => {
  it('accepts a rename to exactly the limit', async () => {
    await create('to-rename', 'short');
    const res = await rename('to-rename', 'y'.repeat(limits.maxTitleLength));

    expect(res.status).toBe(200);
  });

  it('rejects a rename past the limit, with TITLE_TOO_LONG', async () => {
    // The route that a create-only limit leaves wide open.
    await create('to-overrename', 'short');
    const res = await rename('to-overrename', 'y'.repeat(limits.maxTitleLength + 1));

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('TITLE_TOO_LONG');
  });

  it('leaves the old title in place after a refusal', async () => {
    // A rejected rename that still applied would show the user their new title in the tab and
    // someone else's old title in the list, and neither would be wrong-looking.
    await create('keep-old', 'original');

    await rename('keep-old', 'y'.repeat(limits.maxTitleLength + 1));

    const res = await authedFetch('/api/documents/keep-old');
    const body = (await res.json()) as { document: { title: string } };

    expect(body.document.title).toBe('original');
  });

  it('counts code points here too', async () => {
    await create('rename-emoji', 'short');
    const res = await rename('rename-emoji', SMILE.repeat(limits.maxTitleLength));

    expect(res.status).toBe(200);

    const over = await rename('rename-emoji', SMILE.repeat(limits.maxTitleLength + 1));

    expect(over.status).toBe(400);
    expect(await errorCode(over)).toBe('TITLE_TOO_LONG');
  });
});

describe('the limit is configurable, and a smaller one really bites', () => {
  it('uses MAX_TITLE_LENGTH when the environment sets one', async () => {
    await withLimits(limitsWith({ maxTitleLength: 10 }));

    expect((await create('small-ok', 'x'.repeat(10))).status).toBe(201);

    const tooLong = await create('small-over', 'x'.repeat(11));

    expect(tooLong.status).toBe(400);
    expect(await errorCode(tooLong)).toBe('TITLE_TOO_LONG');
  });

  it('does not apply the cap to content', async () => {
    // The cap is on a title, not on a document. A 100,000-character body is a paste, and
    // refusing it would be the quota breaking the feature it was added to protect.
    await create('big-body', 'short');

    const res = await authedFetch('/api/documents/big-body', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'z'.repeat(100_000) }),
    });

    expect(res.status).toBe(200);
  });
});
