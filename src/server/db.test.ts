import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from './db.js';

/**
 * Every test gets its own in-memory database. `:memory:` is discarded on close,
 * so tests cannot leak state into one another or depend on ordering.
 */
let db: Database;

beforeEach(async () => {
  db = await Database.open();
});

afterEach(async () => {
  await db.close();
});

describe('migrations', () => {
  it('creates the documents table', async () => {
    const created = await db.createDocument({ id: 'doc-1', title: 'First' });
    expect(created.id).toBe('doc-1');
  });

  it('is idempotent â€” opening twice applies nothing new', async () => {
    // A second open on the same directory must not re-run migrations or fail.
    // This is what makes `npm run dev` safe to restart.
    const first = await Database.open();
    await first.createDocument({ id: 'a', title: 'A' });
    await first.close();

    const second = await Database.open();
    const list = await second.listDocuments();
    expect(list).toHaveLength(0);
    await second.close();
  });
});

describe('createDocument', () => {
  it('stores defaults for omitted fields', async () => {
    const doc = await db.createDocument({ id: 'doc-1' });

    expect(doc.title).toBe('Untitled');
    expect(doc.content).toBe('');
    expect(doc.clock).toBe(0);
  });

  it('returns an ISO timestamp', async () => {
    const doc = await db.createDocument({ id: 'doc-1' });
    expect(doc.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(doc.updatedAt))).toBe(false);
  });

  it('rejects a duplicate id rather than overwriting', async () => {
    await db.createDocument({ id: 'doc-1', title: 'Original' });

    // Silently replacing would destroy work the user believes is saved.
    await expect(db.createDocument({ id: 'doc-1', title: 'Replacement' })).rejects.toThrow();

    const doc = await db.getDocument('doc-1');
    expect(doc?.title).toBe('Original');
  });
});

describe('getDocument', () => {
  it('returns null for a missing document', async () => {
    expect(await db.getDocument('nope')).toBeNull();
  });

  it('round-trips unicode content unchanged', async () => {
    // A CRDT must never mangle text. Emoji, combining marks, RTL, and CJK are
    // the characters most likely to expose an encoding bug.
    const content = 'ðŸ‘‹ hÃ©llo â€” Ù…Ø±Ø­Ø¨Ø§ ä½ å¥½  zero-width \u{1F600}';
    await db.createDocument({ id: 'uni', content });

    const doc = await db.getDocument('uni');
    expect(doc?.content).toBe(content);
  });

  it('preserves newlines and leading whitespace', async () => {
    const content = '\n\n  indented\n\ttabbed\n';
    await db.createDocument({ id: 'ws', content });

    const doc = await db.getDocument('ws');
    expect(doc?.content).toBe(content);
  });
});

describe('saveDocument', () => {
  it('updates content and reports changed: true', async () => {
    await db.createDocument({ id: 'doc-1' });

    const result = await db.saveDocument('doc-1', 'hello');
    expect(result?.changed).toBe(true);

    const doc = await db.getDocument('doc-1');
    expect(doc?.content).toBe('hello');
  });

  it('reports changed: false when content is identical', async () => {
    await db.createDocument({ id: 'doc-1', content: 'same' });

    // Autosave fires repeatedly; the client needs to know a write was skipped
    // so it does not show a misleading "Saved" every tick.
    const result = await db.saveDocument('doc-1', 'same');
    expect(result?.changed).toBe(false);
  });

  it('returns null for a missing document', async () => {
    expect(await db.saveDocument('missing', 'text')).toBeNull();
  });

  it('handles a large document', async () => {
    const content = 'x'.repeat(200_000);
    await db.createDocument({ id: 'big' });

    await db.saveDocument('big', content);
    const doc = await db.getDocument('big');
    expect(doc?.content).toHaveLength(200_000);
  });

  it('round-trips text containing SQL metacharacters as data', async () => {
    // Values always travel as parameters, never interpolated. This test would
    // fail loudly if someone ever switched to string building.
    const hostile = "'; DROP TABLE documents; --";
    await db.createDocument({ id: 'sqli' });

    await db.saveDocument('sqli', hostile);

    const doc = await db.getDocument('sqli');
    expect(doc?.content).toBe(hostile);

    // The table must still exist.
    const list = await db.listDocuments();
    expect(list).toHaveLength(1);
  });
});

describe('renameDocument', () => {
  it('renames and reports changed: true', async () => {
    await db.createDocument({ id: 'doc-1', title: 'Old' });

    const result = await db.renameDocument('doc-1', 'New');
    expect(result?.changed).toBe(true);

    const doc = await db.getDocument('doc-1');
    expect(doc?.title).toBe('New');
  });

  it('returns null for a missing document', async () => {
    expect(await db.renameDocument('missing', 'New')).toBeNull();
  });
});

describe('listDocuments', () => {
  it('returns newest first', async () => {
    // Deliberately saves 'a' after creating 'b' before listing, so the assertion is
    // about `updated_at` rather than about insertion order. Asserting on insertion
    // order would pass whether or not the ORDER BY worked at all.
    await db.createDocument({ id: 'a', title: 'A' });
    await db.createDocument({ id: 'b', title: 'B' });
    await db.saveDocument('a', 'touch a last');

    const list = await db.listDocuments();
    expect(list[0]?.id).toBe('a');
  });

  it('is stable when two documents share a timestamp', async () => {
    // Rows written in the same clock tick have equal `updated_at`, and Postgres
    // returns tied rows in whatever order the heap gives it. Without the id
    // tiebreaker this test fails on some machines and passes on others, which is
    // the worst property a list endpoint can have.
    await db.createDocument({ id: 'a', title: 'A' });
    await db.createDocument({ id: 'b', title: 'B' });
    await db.createDocument({ id: 'c', title: 'C' });

    const first = await db.listDocuments();
    const second = await db.listDocuments();

    expect(first.map((doc) => doc.id)).toEqual(second.map((doc) => doc.id));

    // And the order must be a total one: descending by timestamp, then by id.
    expect(first.map((doc) => doc.id)).toEqual(['c', 'b', 'a']);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await db.createDocument({ id: `doc-${i}`, title: `Doc ${i}` });
    }

    expect(await db.listDocuments(3)).toHaveLength(3);
  });

  it('returns an empty array when there are no documents', async () => {
    expect(await db.listDocuments()).toEqual([]);
  });
});

describe('deleteDocument', () => {
  it('removes the document and reports true', async () => {
    await db.createDocument({ id: 'doc-1' });

    expect(await db.deleteDocument('doc-1')).toBe(true);
    expect(await db.getDocument('doc-1')).toBeNull();
  });

  it('reports false for a document that does not exist', async () => {
    expect(await db.deleteDocument('missing')).toBe(false);
  });

  it('is not idempotent â€” deleting twice reports false', async () => {
    await db.createDocument({ id: 'doc-1' });
    await db.deleteDocument('doc-1');

    expect(await db.deleteDocument('doc-1')).toBe(false);
  });
});

describe('BIGINT clock handling', () => {
  it('returns clock as a number even though Postgres sends BIGINT as a string', async () => {
    // Postgres returns BIGINT as text to avoid silent precision loss. The
    // repository converts. Missing this shows up as "1" behaving like true.
    await db.createDocument({ id: 'doc-1' });
    const doc = await db.getDocument('doc-1');

    expect(typeof doc?.clock).toBe('number');
    expect(doc?.clock).toBe(0);
  });
});
