/**
 * Operation-log tests.
 *
 * These run against real PostgreSQL via PGlite, not a mock. The behaviour under
 * test is mostly SQL the engine has to get right for us: unique indexes, `MAX`
 * under concurrency, cascading deletes, and the semantics of
 * `ON CONFLICT DO NOTHING`. A hand-written fake would only prove the fake works.
 *
 * The suite is slow because `Database.open` boots a WASM Postgres, so every test
 * shares one instance rather than opening its own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import { initialOperations, seedSiteFor } from '../core/crdt/seed.js';
import { Database } from './db.js';

let db: Database;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `doc-${counter}`;
}

async function freshDocument(content = ''): Promise<string> {
  const id = nextId();
  await db.createDocument({ id, title: 'Untitled', content });
  return id;
}

/** Element ID of the nth insert produced by seeding `documentId`. */
function seededId(documentId: string, index: number): { site: string; clock: number } {
  const op = initialOperations(documentId, 'x'.repeat(index + 1))[index];

  if (op === undefined || op.type !== 'insert') {
    throw new Error(`no insert at index ${index} for ${documentId}`);
  }

  return op.id;
}

beforeAll(async () => {
  db = await Database.open();
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('appendOps', () => {
  it('stores operations and reports the last sequence', async () => {
    const id = await freshDocument();
    const ops = initialOperations(id, 'hello');

    const seq = await db.appendOps(id, ops);

    expect(seq).toBe(ops.length);
    expect(await db.readAllOps(id)).toEqual(ops);
  });

  it('continues the sequence across calls', async () => {
    const id = await freshDocument();

    const first = await db.appendOps(id, initialOperations(id, 'ab'));
    const second = await db.appendOps(id, initialOperations(`${id}-b`, 'c'));

    expect(first).toBe(2);
    expect(second).toBe(3);
    expect(await db.readAllOps(id)).toHaveLength(3);
  });

  it('ignores a redelivered operation', async () => {
    const id = await freshDocument();
    const ops = initialOperations(id, 'hi');

    await db.appendOps(id, ops);
    const seq = await db.appendOps(id, ops);

    // Storing the same operation twice would make seq a lie and break every
    // later resume-from-cursor.
    expect(await db.readAllOps(id)).toHaveLength(2);
    expect(seq).toBe(2);
  });

  it('does not consume a sequence number for a redelivered operation', async () => {
    const id = await freshDocument();
    const ops = initialOperations(id, 'hi');

    await db.appendOps(id, ops);
    await db.appendOps(id, ops);

    // The returned cursor must point at what is actually stored. Running ahead of
    // the log would still be safe for a "since N" query, but it would no longer
    // mean what its name says.
    expect(await db.readOpsSince(id, 2)).toEqual({ ops: [], seq: 2 });
  });

  it('keeps an insert and a delete of the same element apart', async () => {
    const id = await freshDocument();
    const ops = initialOperations(id, 'abc');
    await db.appendOps(id, ops);

    // An insert and a delete of the same character share an element ID. If the
    // dedupe key were the element alone, the delete would look like a redelivered
    // insert, be dropped, and the character would survive a deletion the user had
    // already made.
    await db.appendOps(id, [{ type: 'delete', target: seededId(id, 1) }]);

    const stored = await db.readAllOps(id);
    expect(stored).toHaveLength(4);

    const doc = new RgaDocument(seedSiteFor(id));
    doc.applyInAnyOrder(stored);
    expect(doc.toText()).toBe('ac');
  });

  it('ignores a redelivered delete', async () => {
    const id = await freshDocument();
    await db.appendOps(id, initialOperations(id, 'abc'));

    const del: Operation = { type: 'delete', target: seededId(id, 0) };
    await db.appendOps(id, [del]);
    await db.appendOps(id, [del]);

    // Two clients deleting the same character must not tombstone it twice.
    expect(await db.readAllOps(id)).toHaveLength(4);
  });

  it('deduplicates across separate batches', async () => {
    const id = await freshDocument();

    await db.appendOps(id, initialOperations(id, 'ab'));
    await db.appendOps(id, initialOperations(`${id}-second`, 'c'));

    expect(await db.readAllOps(id)).toHaveLength(3);
  });

  it('writes the materialised text alongside the log', async () => {
    const id = await freshDocument();
    const ops = initialOperations(id, 'materialised');

    await db.appendOps(id, ops, { materializedText: 'materialised' });

    const record = await db.getDocument(id);
    expect(record?.content).toBe('materialised');
    expect(record?.clock).toBe(ops.length);
  });

  it('advances the document clock', async () => {
    const id = await freshDocument();
    await db.appendOps(id, initialOperations(id, 'abc'));

    expect((await db.getDocument(id))?.clock).toBe(3);
  });

  it('is a no-op for an empty batch', async () => {
    const id = await freshDocument();

    expect(await db.appendOps(id, [])).toBe(0);
    expect(await db.readAllOps(id)).toEqual([]);
  });

  it('assigns concurrent batches non-overlapping sequences', async () => {
    const id = await freshDocument();

    // Two clients flushing their outboxes at the same moment, which is the
    // ordinary case rather than an exotic one.
    const [first, second] = await Promise.all([
      db.appendOps(id, initialOperations(`${id}-a`, 'aaaa')),
      db.appendOps(id, initialOperations(`${id}-b`, 'bbbb')),
    ]);

    // Sequences must not overlap, or replay would double-apply or skip.
    expect(Math.max(first, second)).toBe(8);

    const stored = await db.readAllOps(id);
    expect(stored).toHaveLength(8);

    const doc = new RgaDocument(seedSiteFor(id));
    expect(doc.applyInAnyOrder(stored)).toBe(0);
    expect(doc.checkInvariants()).toEqual([]);
  });

  it('keeps working after a failed write', async () => {
    const id = await freshDocument();
    await db.appendOps(id, initialOperations(id, 'ok'));

    // A failing write must not poison the queue every later write sits behind.
    await expect(
      db.appendOps('no-such-document', initialOperations('ghost', 'x')),
    ).rejects.toBeDefined();

    const seq = await db.appendOps(id, initialOperations(`${id}-b`, '!'));

    expect(seq).toBe(3);
    expect(await db.readAllOps(id)).toHaveLength(3);
  });
});

describe('readOpsSince', () => {
  it('returns nothing when already current', async () => {
    const id = await freshDocument();
    const ops = initialOperations(id, 'abc');
    const seq = await db.appendOps(id, ops);

    expect(await db.readOpsSince(id, seq)).toEqual({ ops: [], seq });
  });

  it('returns only what follows the cursor', async () => {
    const id = await freshDocument();
    await db.appendOps(id, initialOperations(id, 'abc'));
    await db.appendOps(id, initialOperations(`${id}-b`, 'de'));

    const result = await db.readOpsSince(id, 3);

    expect(result.ops).toHaveLength(2);
    expect(result.seq).toBe(5);
  });

  it('reports the cursor unchanged when there is nothing to send', async () => {
    const id = await freshDocument();

    // A fresh client asking from 0 must get a cursor it can resume from even
    // when the document is empty, or it would loop forever.
    expect(await db.readOpsSince(id, 0)).toEqual({ ops: [], seq: 0 });
  });

  it('honours the batch limit', async () => {
    const id = await freshDocument();
    await db.appendOps(id, initialOperations(id, 'abcdefghij'));

    const result = await db.readOpsSince(id, 0, 4);

    expect(result.ops).toHaveLength(4);
    expect(result.seq).toBe(4);
  });

  it('replays fully when looping from the returned cursor', async () => {
    const id = await freshDocument();
    const all = initialOperations(id, 'abcdefghij');
    await db.appendOps(id, all);

    // This is the reconnect path: page through until the batch comes back short.
    const collected: Operation[] = [];
    let cursor = 0;

    for (let round = 0; round < 10; round += 1) {
      const page = await db.readOpsSince(id, cursor, 3);
      collected.push(...page.ops);
      cursor = page.seq;

      if (page.ops.length < 3) {
        break;
      }
    }

    expect(collected).toEqual(all);
  });
});

describe('materializeContent', () => {
  it('rebuilds the text from the log', async () => {
    const id = await freshDocument();
    await db.appendOps(id, initialOperations(id, 'hello'));

    // Deliberately corrupt the cache first: the whole point is that it is
    // derived and therefore repairable.
    await db.saveDocument(id, 'WRONG');
    expect((await db.getDocument(id))?.content).toBe('WRONG');

    expect(await db.materializeContent(id)).toBe('hello');
    expect((await db.getDocument(id))?.content).toBe('hello');
  });

  it('rebuilds text after deletions', async () => {
    const id = await freshDocument();
    const ops = initialOperations(id, 'hello');
    await db.appendOps(id, ops);
    await db.appendOps(id, [{ type: 'delete', target: seededId(id, 1) }]);

    expect(await db.materializeContent(id)).toBe('hllo');
  });

  it('handles a document with no operations', async () => {
    const id = await freshDocument();

    expect(await db.materializeContent(id)).toBe('');
  });

  it('returns null for a document that does not exist', async () => {
    expect(await db.materializeContent('no-such-document')).toBeNull();
  });

  it('rejects a log it cannot replay instead of writing a partial document', async () => {
    const id = await freshDocument();

    // An operation anchored to an element that was never stored. A partial write
    // here would turn a recoverable bug into permanent data loss.
    await db.appendOps(id, [
      {
        type: 'insert',
        id: { site: 'ghost', clock: 7 },
        origin: { site: 'ghost', clock: 6 },
        value: 'x',
      },
    ]);

    await expect(db.materializeContent(id)).rejects.toThrow(/could not be placed/i);
  });

  it('replays to a document that satisfies the CRDT invariants', async () => {
    const id = await freshDocument();
    const ops = [...initialOperations(id, 'hello '), ...initialOperations(`${id}-b`, 'world')];
    await db.appendOps(id, ops);

    const doc = new RgaDocument(seedSiteFor(id));
    doc.applyInAnyOrder(ops);

    expect(doc.checkInvariants()).toEqual([]);
  });
});

describe('cascading deletes', () => {
  it("removes a document's operations with the document", async () => {
    const id = await freshDocument();
    await db.appendOps(id, initialOperations(id, 'doomed'));

    await db.deleteDocument(id);

    // The foreign key is ON DELETE CASCADE. If it were not, an operation log
    // would outlive its document and every later insert of the same id would
    // inherit a ghost history.
    expect(await db.readAllOps(id)).toEqual([]);
  });
});

describe('createDocument', () => {
  it('seeds the operation log when created with content', async () => {
    const id = nextId();
    await db.createDocument({ id, title: 'Seeded', content: 'from the api' });

    // Left unlogged, a document with a body looks empty to every client, and the
    // first collaborator to connect would duplicate or lose the text.
    const ops = await db.readAllOps(id);
    expect(ops).toHaveLength('from the api'.length);

    const doc = new RgaDocument(seedSiteFor(id));
    doc.applyInAnyOrder(ops);
    expect(doc.toText()).toBe('from the api');
  });

  it('creates no operations for an empty document', async () => {
    const id = await freshDocument();

    expect(await db.readAllOps(id)).toEqual([]);
  });
});

describe('legacy backfill', () => {
  it('gives a pre-Phase-4 document an operation log', async () => {
    // A Phase 1 document is a row of plain text with no operations.
    // saveDocument writes exactly that, bypassing the log, which makes this a
    // faithful reproduction rather than a contrived one.
    const id = await freshDocument();
    await db.saveDocument(id, 'written in phase 1');
    expect(await db.readAllOps(id)).toEqual([]);

    await db.backfillOperationLogs();

    const ops = await db.readAllOps(id);
    expect(ops).toHaveLength('written in phase 1'.length);

    const doc = new RgaDocument(seedSiteFor(id));
    doc.applyInAnyOrder(ops);
    expect(doc.toText()).toBe('written in phase 1');
  });

  it('does not duplicate an already-seeded document', async () => {
    const id = await freshDocument('stable');

    // Running this on every boot has to be free.
    const before = await db.readAllOps(id);
    await db.backfillOperationLogs();
    await db.backfillOperationLogs();

    expect(await db.readAllOps(id)).toHaveLength(before.length);
  });

  it('produces the same element ids on every run', () => {
    const a = initialOperations('doc-x', 'deterministic');
    const b = initialOperations('doc-x', 'deterministic');

    // Two clients converting the same initial text must produce identical
    // element ids, or the text would appear twice after a merge.
    expect(a).toEqual(b);
  });

  it('gives different documents different seed sites', () => {
    expect(seedSiteFor('doc-a')).not.toBe(seedSiteFor('doc-b'));
  });

  it('gives identical documents in different places different seed sites', () => {
    // Keying the seed site on content would make two documents with the same
    // body share element IDs, and text would leak from one into the other.
    const a = initialOperations('doc-left', 'same text');
    const b = initialOperations('doc-right', 'same text');

    expect(a.map((op) => op.id.site)).not.toEqual(b.map((op) => op.id.site));
  });
});
