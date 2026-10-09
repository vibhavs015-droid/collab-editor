/**
 * Cursor pagination for the document list (T6).
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AIMED AT
 * ---------------------------------------------------------------------------
 * Four properties, in descending order of how badly they break if they are wrong:
 *
 *   1. No document is skipped or repeated across pages. A pagination bug that drops one is
 *      invisible until a user reports a missing document.
 *   2. Ties on `updated_at` do not drop or repeat anything either. They are not hypothetical: the
 *      column's own comment records that three sequential writes CAN share a timestamp on PGlite,
 *      and creating 7 documents here produced only 4 distinct timestamps.
 *   3. A cursor is not an access control. Authorisation lives in the SQL WHERE clause and must hold
 *      whatever a caller puts in the cursor.
 *   4. A malformed cursor is refused, not coerced.
 *
 * Property 2 gets the most attention because it is the one an implementation gets wrong quietly:
 * `WHERE updated_at < $at` alone is correct until two rows share a timestamp, at which point it
 * skips the rest of that timestamp's rows without any error. It also found a real bug during
 * development - see the `Z` note on the timestamp pattern.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  decodeDocumentCursor,
  encodeDocumentCursor,
  parsePageSize,
  type DocumentCursor,
} from './documentCursor.js';
import { Database } from './db.js';

let db: Database;

/**
 * ONE database for the whole file, truncated between tests.
 *
 * Booting PGlite costs about two seconds, and this file has 44 tests. Opening one per test made the
 * suite slow enough that it began failing intermittently with `TypeError: fetch failed` in a
 * neighbouring server test - the resource churn was enough to starve it. `truncateAll` keeps real
 * isolation, because `documents` cascades to the operations, collaborators and snapshots.
 */
beforeAll(async () => {
  db = await Database.open();
});

beforeEach(async () => {
  await db.truncateAll();
});

afterAll(async () => {
  await db.close();
});

/** Unique ids, because every test in the file shares one database. */
let counter = 0;
function nextId(prefix = 'doc'): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

/** Decode a token, asserting it decodes. A cursor this code produced must always round-trip. */
function cursorOf(token: string): DocumentCursor {
  const decoded = decodeDocumentCursor(token);

  if (decoded === null) {
    throw new Error(`this server issued an unreadable cursor: ${token}`);
  }

  return decoded;
}

/**
 * Create documents with DISTINCT, explicit timestamps.
 *
 * Explicit rather than relying on `now()` differing per write. That is not a shortcut: measured
 * here, creating 7 documents in a row produced only 4 distinct timestamps, because PGlite batches
 * writes into shared transactions. An ordering test written on top of that is a test that passes
 * or fails depending on the runner's mood.
 *
 * The base advances per CALL as well as per document, so two calls in one test cannot produce
 * overlapping timestamps. They did at first, which made the cursor land in the middle of the other
 * subject's range and produced a failure that looked exactly like a leak.
 *
 * `updatedAt` is a `Date`, so these are millisecond-precision - enough for ordering here, and the
 * microsecond path is covered by the cursor round-trip tests and the tie test below.
 */
let stampCursor = 0;

async function createDistinct(count: number, owner = 'alice'): Promise<string[]> {
  const ids: string[] = [];
  const base = Date.UTC(2026, 0, 1) + stampCursor * 60_000;
  stampCursor += 1;

  for (let i = 0; i < count; i += 1) {
    const id = nextId();
    await db.createDocument({ id, owner, title: id, updatedAt: new Date(base + i * 1000) });
    ids.push(id);
  }

  const stamps = await Promise.all(ids.map(async (id) => (await db.getDocument(id))?.updatedAt));

  expect(new Set(stamps).size, 'timestamps tied, so the ordering tests would be vacuous').toBe(
    stamps.length,
  );

  return ids;
}

/** Walk every page, returning the ids seen and the number of pages read. */
async function pageThrough(
  subject: string,
  limit: number,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: DocumentCursor | undefined;

  // Bounded, so a cursor that fails to advance fails the test instead of hanging the suite.
  for (let page = 1; page <= 40; page += 1) {
    const result = await db.listDocumentsFor(subject, limit, cursor);

    ids.push(...result.documents.map((d) => d.id));

    if (result.nextCursor === null) {
      return { ids, pages: page };
    }

    cursor = cursorOf(result.nextCursor);
  }

  throw new Error(`paging did not terminate for subject ${subject} at limit ${String(limit)}`);
}

describe('document cursors', () => {
  it('round-trips a boundary', () => {
    const cursor = { at: '2026-01-02 03:04:05.123456Z', id: 'abc-123' };
    expect(decodeDocumentCursor(encodeDocumentCursor(cursor))).toEqual(cursor);
  });

  it('keeps microseconds, which a JavaScript Date would throw away', () => {
    // The reason the cursor is text and not a Date. Two boundaries one microsecond apart must not
    // decode to the same value, or a page boundary computed from them drops a row.
    const a = { at: '2026-01-02 03:04:05.123456Z', id: 'a' };
    const b = { at: '2026-01-02 03:04:05.123457Z', id: 'a' };

    expect(decodeDocumentCursor(encodeDocumentCursor(a))).not.toEqual(
      decodeDocumentCursor(encodeDocumentCursor(b)),
    );
  });

  it('is URL-safe', () => {
    const token = encodeDocumentCursor({ at: '2026-01-02 03:04:05.123456Z', id: 'abc-123' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('refuses a timestamp with no timezone, which would be read in the server timezone', () => {
    // This is the bug the tie test found. `to_char(updated_at AT TIME ZONE 'UTC', ...)` emits a
    // NAIVE wall time; casting it back with `::timestamptz` reinterprets it in the session
    // timezone, so the cursor pointed at a different instant than the row it came from.
    const naive = Buffer.from(
      JSON.stringify({ at: '2026-01-02 03:04:05.123456', id: 'a' }),
      'utf8',
    ).toString('base64url');

    expect(decodeDocumentCursor(naive)).toBeNull();
  });

  it.each([
    ['not base64 at all!!', 'not base64'],
    ['', 'empty'],
    ['e30', 'valid base64 of an empty object'],
    [Buffer.from('{"at":"nope","id":"a"}', 'utf8').toString('base64url'), 'bad timestamp'],
    [Buffer.from('{"at":"2026-01-02 03:04:05.123456Z"}', 'utf8').toString('base64url'), 'no id'],
    [
      Buffer.from('{"at":"2026-01-02 03:04:05.123456Z","id":"../etc"}', 'utf8').toString(
        'base64url',
      ),
      'id that is not a valid document id',
    ],
    [
      Buffer.from('{"at":"2026-01-02 03:04:05.123456Z","id":"a","extra":1}', 'utf8').toString(
        'base64url',
      ),
      'an unexpected extra field',
    ],
    [Buffer.from('[1,2,3]', 'utf8').toString('base64url'), 'an array'],
    ['a'.repeat(600), 'absurdly long'],
  ])('refuses %s (%s)', (raw) => {
    expect(decodeDocumentCursor(raw)).toBeNull();
  });
});

describe('parsePageSize', () => {
  it('defaults when absent', () => {
    expect(parsePageSize(null)).toBe(DEFAULT_PAGE_SIZE);
  });

  it.each(['1', '50', '100'])('accepts %s', (raw) => {
    expect(parsePageSize(raw)).toBe(Number(raw));
  });

  it.each(['0', '101', '-1', '1.5', ' 5', '5 ', '1e2', '0x10', 'Infinity', 'NaN', '', 'abc', '+5'])(
    'refuses %s rather than clamping it',
    (raw) => {
      // Refused rather than clamped on purpose: a client that asked for 500 and silently got 100
      // cannot tell that its pagination is wrong.
      expect(parsePageSize(raw)).toBeNull();
    },
  );
});

describe('paging the document list', () => {
  it('walks every document exactly once', async () => {
    const ids = await createDistinct(7);

    const { ids: seen } = await pageThrough('alice', 3);

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size, 'a document appeared on two pages').toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('reports no next cursor on the last page', async () => {
    await createDistinct(3);

    const page = await db.listDocumentsFor('alice', 10);
    expect(page.nextCursor).toBeNull();
  });

  it('reports a next cursor when more documents remain', async () => {
    await createDistinct(5);

    const page = await db.listDocumentsFor('alice', 2);
    expect(page.documents).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('never returns more than the requested page size', async () => {
    await createDistinct(9);

    for (const size of [1, 2, 4, 8, 9, 10]) {
      const page = await db.listDocumentsFor('alice', size);
      expect(page.documents.length, `limit ${String(size)} returned too many`).toBeLessThanOrEqual(
        size,
      );
    }
  });

  it.each([1, 2, 3, 5, 7])('pages correctly at limit %i', async (limit) => {
    const ids = await createDistinct(7);

    const { ids: seen } = await pageThrough('alice', limit);

    expect(new Set(seen).size, `a document repeated at limit ${String(limit)}`).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('paginates correctly when several documents share a timestamp', async () => {
    // THE TEST THAT MATTERS MOST, and the one that found the timezone bug.
    //
    // Every row is given ONE identical `updated_at`, so the only thing separating them is the id
    // tiebreaker. `WHERE updated_at < $at` alone would return nothing after the first page, because
    // no row is strictly older than the cursor - which is exactly what happened before the `Z` fix.
    const ids = ['tie-a', 'tie-b', 'tie-c', 'tie-d', 'tie-e'];
    const stamp = new Date('2026-03-04T05:06:07.891011Z');

    for (const id of ids) {
      await db.createDocument({ id, owner: 'alice', title: id, updatedAt: stamp });
    }

    const all = await db.listDocumentsFor('alice', 100);
    expect(all.documents).toHaveLength(ids.length);

    const { ids: seen } = await pageThrough('alice', 2);

    expect(new Set(seen).size, 'a tied document appeared twice').toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('orders by id when timestamps tie', async () => {
    // Pinning the documented order, so a future change to the tiebreaker direction is visible.
    const ids = ['tie-a', 'tie-b', 'tie-c'];
    const stamp = new Date('2026-03-04T05:06:07.891011Z');

    for (const id of ids) {
      await db.createDocument({ id, owner: 'alice', title: id, updatedAt: stamp });
    }

    const page = await db.listDocumentsFor('alice', 10);
    expect(page.documents.map((d) => d.id)).toEqual(['tie-c', 'tie-b', 'tie-a']);
  });

  it('does not let a cursor widen what a caller may see', async () => {
    // A cursor is a position in the ORDER. Its contents are attacker-controlled and must not be
    // able to reach a document the subject could not otherwise list.
    const alice = await createDistinct(3, 'alice');
    const mallory = await createDistinct(2, 'mallory');

    const malloryPage = await db.listDocumentsFor('mallory', 1);
    expect(malloryPage.nextCursor).not.toBeNull();

    // Mallory hands her own cursor to alice.
    const alicePage = await db.listDocumentsFor(
      'alice',
      100,
      cursorOf(malloryPage.nextCursor ?? ''),
    );

    const returned = alicePage.documents.map((d) => d.id);

    for (const id of mallory) {
      expect(returned, `mallory's ${id} leaked through a cursor`).not.toContain(id);
    }

    for (const id of alice) {
      expect(returned).toContain(id);
    }
  });

  it('accepts a hand-built cursor without granting anything extra', async () => {
    // Forged from a plausible timestamp and an id belonging to someone else. The WHERE clause still
    // filters, so this returns only what alice may see.
    const forged = cursorOf(
      encodeDocumentCursor({ at: '2026-01-01 00:00:00.000000Z', id: 'doc-1' }),
    );

    const page = await db.listDocumentsFor('alice', 100, forged);

    for (const document of page.documents) {
      expect(document.owner === null || document.owner === 'alice').toBe(true);
    }
  });

  it('is unaffected by a document appearing before the cursor', async () => {
    // The reason this is a cursor and not an offset. A document created after page one sorts
    // BEFORE the cursor and must not shift the second page's contents.
    const ids = await createDistinct(4);

    // Newest first, so page one takes the LAST two ids.
    const first = await db.listDocumentsFor('alice', 2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.documents.map((d) => d.id)).toEqual([ids[3], ids[2]]);

    // Something newer than everything, so it sorts to the front of the whole list.
    await db.createDocument({
      id: nextId('newest'),
      owner: 'alice',
      title: 'newest',
      updatedAt: new Date(Date.UTC(2030, 0, 1)),
    });

    const second = await db.listDocumentsFor('alice', 2, cursorOf(first.nextCursor ?? ''));

    // The two that were NOT on page one, in the same order they would have had. An OFFSET-based
    // implementation returns [ids[2], ids[1]] here, because the new document pushed everything
    // down one position.
    expect(second.documents.map((d) => d.id)).toEqual([ids[1], ids[0]]);
  });
});
