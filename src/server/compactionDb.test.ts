/**
 * Compaction against a real database.
 *
 * The unit tests prove the decision is safe. This proves it is *effective*: that
 * a document edited a thousand times stores roughly its current size afterwards,
 * and that a peer can still rebuild the exact document from what is left.
 *
 * Runs against real PostgreSQL via PGlite, because the claims involve row counts
 * and transactions, which a stub would only assert about itself.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import {
  replayFromSnapshot,
  snapshotToOperations,
  type DocumentSnapshot,
} from '../core/crdt/snapshot.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';

let db: Database;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `compact-${counter}`;
}

/**
 * A store with permissive thresholds.
 *
 * `minTombstoneRatio: 0` deliberately, because most of these tests churn
 * tombstones and want compaction to engage. Tests that assert compaction DECLINES
 * pass their own ratio.
 */
async function freshStore(
  policy: { minOpsBelowFloor?: number; minTombstoneRatio?: number } = {},
): Promise<{ store: DocumentStore; id: string }> {
  const id = nextId();
  await db.createDocument({ id, title: 'Untitled', content: '' });

  return {
    store: new DocumentStore({
      db,
      compactionPolicy: {
        minOpsBelowFloor: policy.minOpsBelowFloor ?? 8,
        minTombstoneRatio: policy.minTombstoneRatio ?? 0,
      },
    }),
    id,
  };
}

/**
 * Type a character, then delete it again. Pure tombstone churn, which is exactly
 * the shape a heavily-edited document has and exactly what compaction reclaims.
 *
 * Driven through the store so persistence is exercised rather than faked.
 *
 * @returns the document text afterwards, which is unchanged by construction.
 */
async function churn(store: DocumentStore, id: string, rounds: number): Promise<string> {
  const text = '';

  for (let round = 0; round < rounds; round += 1) {
    const writer = new RgaDocument(`writer-${round}`);
    const character = String.fromCharCode(97 + (round % 26));

    const typed = writer.insertAt(text.length, character);
    await store.apply(id, typed);

    const created = writer.inspect().at(-1);
    if (!created) {
      throw new Error('expected an element');
    }

    // Delete exactly what was just typed, so the visible text never changes.
    await store.apply(id, [{ type: 'delete', target: created.id }]);
  }

  return text;
}

/** Rebuild the document from the snapshot plus whatever the log still holds. */
async function rebuild(dbRef: Database, id: string): Promise<string> {
  const snapshotRow = await dbRef.readSnapshot(id);
  const ops = await dbRef.readAllOps(id);

  if (!snapshotRow) {
    const doc = new RgaDocument(id);
    doc.applyInAnyOrder(ops);
    return doc.toText();
  }

  const snapshot: DocumentSnapshot = {
    seq: snapshotRow.seq,
    elements: snapshotRow.elements,
  };

  const { doc, unplaced } = replayFromSnapshot(snapshot, ops, id);

  expect(unplaced).toBe(0);

  return doc.toText();
}

beforeAll(async () => {
  db = await Database.open();
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('compaction - reclaim', () => {
  it('shrinks a log that was typed and deleted repeatedly', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 8, minTombstoneRatio: 0.9 });

    const before = await churn(store, id, 30);
    const opsBefore = (await db.readAllOps(id)).length;

    expect(opsBefore).toBeGreaterThan(30);
    expect(before).toBe('');

    const result = await store.compact(id);

    expect(result.compacted).toBe(true);
    expect(result.pruned).toBeGreaterThan(0);

    const opsAfter = (await db.readAllOps(id)).length;

    // The point of the exercise: the log is now a fraction of its former size.
    expect(opsAfter).toBeLessThan(opsBefore / 2);
  });

  it('leaves a document that can still be rebuilt exactly', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 8, minTombstoneRatio: 0.9 });

    await churn(store, id, 20);

    const expected = await db.materializeContent(id);
    expect(expected).toBe('');

    await store.compact(id);

    // The whole claim, end to end: after compaction, what remains still
    // reconstructs the document exactly.
    expect(await rebuild(db, id)).toBe(expected);
  });

  it('rebuilds a document with real surviving text', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 8, minTombstoneRatio: 0.3 });

    const seed = new RgaDocument('seed');
    await store.apply(id, seed.insertAt(0, 'keep this text'));

    // Churn on top of it: type a character at the start and delete it again, so
    // the tombstones pile up around text that must survive.
    for (let round = 0; round < 20; round += 1) {
      const writer = new RgaDocument(`w${round}`);
      await store.apply(id, writer.insertAt(0, 'x'));

      const newest = writer.inspect().at(-1);
      if (newest) {
        await store.apply(id, [{ type: 'delete', target: newest.id }]);
      }
    }

    const expected = await db.materializeContent(id);
    expect(expected).toBe('keep this text');

    const result = await store.compact(id);
    expect(result.compacted).toBe(true);

    // The whole claim, with real text involved: after compaction, what remains
    // still reconstructs the document exactly.
    expect(await rebuild(db, id)).toBe('keep this text');
    expect(await db.materializeContent(id)).toBe('keep this text');
  });
});

describe('compaction - refusal', () => {
  it('refuses when a connected peer is behind', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 4, minTombstoneRatio: 0.9 });

    await churn(store, id, 20);

    // A peer that has acknowledged almost nothing pins the floor at almost nothing.
    store.reportPeerCursor(id, 'slow-peer', 1);

    const result = await store.compact(id);

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('log-too-small');
    // Nothing was deleted, so the peer is untouched.
    expect((await db.readAllOps(id)).length).toBeGreaterThan(20);
  });

  it('refuses when it has already compacted past the floor', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 8, minTombstoneRatio: 0.9 });

    await churn(store, id, 20);
    expect((await store.compact(id)).compacted).toBe(true);

    // Nothing new arrived, so there is nothing to reclaim.
    const second = await store.compact(id);

    expect(second.compacted).toBe(false);
    expect(second.reason).toBe('already-compacted');
  });

  it('declines a document that is mostly live text', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 4, minTombstoneRatio: 0.9 });

    const writer = new RgaDocument('writer');
    const ops: Operation[] = [];

    for (let round = 0; round < 40; round += 1) {
      ops.push(...writer.insertAt(writer.toText().length, 'x'));
    }

    await store.apply(id, ops);

    const result = await store.compact(id);

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('log-too-small');
  });

  it('does nothing when compaction is switched off', async () => {
    const id = nextId();
    await db.createDocument({ id, title: 'Untitled', content: '' });
    const store = new DocumentStore({ db, compaction: false });

    await churn(store, id, 20);

    const result = await store.compact(id);

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('compaction-disabled');
  });
});

/**
 * A document with text that survives, plus enough tombstones to trigger a
 * compaction.
 *
 * Needed because the snapshot of a fully-churned document is legitimately empty,
 * which would not exercise anything.
 */
async function churnAroundText(): Promise<{ store: DocumentStore; id: string }> {
  const { store, id } = await freshStore({ minOpsBelowFloor: 8, minTombstoneRatio: 0.3 });
  const seed = new RgaDocument('seed');
  await store.apply(id, seed.insertAt(0, 'keep me'));

  for (let round = 0; round < 20; round += 1) {
    const writer = new RgaDocument(`w${round}`);
    await store.apply(id, writer.insertAt(0, 'x'));

    const newest = writer.inspect().at(-1);
    if (newest) {
      await store.apply(id, [{ type: 'delete', target: newest.id }]);
    }
  }

  return { store, id };
}

describe('compaction - snapshots in storage', () => {
  it('stores a snapshot with element IDs, not text', async () => {
    const { store, id } = await churnAroundText();

    expect((await store.compact(id)).compacted).toBe(true);

    const row = await db.readSnapshot(id);

    expect(row).not.toBeNull();
    // 'keep me' survived the churn; the 20 typed-then-deleted characters did not.
    expect(row?.elements.length).toBe(7);

    // An element, not a string. A text-only snapshot would leave every later
    // insert unplaceable, which is the failure this whole design avoids.
    const first = row?.elements[0];
    expect(first).toBeDefined();
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('value');
    expect(first).toHaveProperty('origin');
  });

  it('stores an empty snapshot for a fully churned document', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 8, minTombstoneRatio: 0.9 });

    await churn(store, id, 12);
    expect((await store.compact(id)).compacted).toBe(true);

    // Legitimate, and worth asserting: a document whose every character has been
    // deleted has a snapshot with nothing in it. Anything else would mean the
    // tombstone filter is not actually filtering.
    expect((await db.readSnapshot(id))?.elements).toEqual([]);
  });

  it('keeps only the newest snapshot', async () => {
    const { store, id } = await churnAroundText();

    await store.compact(id);
    const first = await db.readSnapshot(id);

    // More edits, so there is something new to reclaim.
    await churn(store, id, 12);
    expect((await store.compact(id)).compacted).toBe(true);

    // One row per document, replaced not accumulated.
    expect((await db.readSnapshot(id))?.seq).toBeGreaterThan(first?.seq ?? 0);
  });

  it('rebuilds from a snapshot whose IDs anchor a new insert', async () => {
    const { store, id } = await churnAroundText();

    expect((await store.compact(id)).compacted).toBe(true);

    const row = await db.readSnapshot(id);
    const snapshot: DocumentSnapshot = { seq: row?.seq ?? 0, elements: row?.elements ?? [] };

    // A peer inserting against an element the snapshot preserved.
    const anchor = snapshot.elements.at(-1);
    if (!anchor) {
      throw new Error('expected a snapshot element');
    }

    const rebuilt = replayFromSnapshot(
      snapshot,
      [{ type: 'insert', id: { site: 'peer', clock: 1 }, origin: anchor.id, value: '!' }],
      'peer',
    );

    expect(rebuilt.unplaced).toBe(0);
    expect(rebuilt.doc.toText().endsWith('!')).toBe(true);
    expect(rebuilt.doc.toText()).toHaveLength(8);
  });
});

describe('compaction - the text cache after compaction', () => {
  it('rebuilds the full document, not just the uncompacted tail', async () => {
    // A regression test for a genuinely nasty bug. `materializeContent` replays
    // the log and then WRITES the result to `documents.content`. Once compaction
    // had pruned the log, it computed an empty document and overwrote a perfectly
    // good cache with it. Silent, and it destroyed the very thing the method
    // exists to verify.
    const { store, id } = await churnAroundText();

    const before = await db.materializeContent(id);
    expect(before).toBe('keep me');

    expect((await store.compact(id)).compacted).toBe(true);

    expect(await db.materializeContent(id)).toBe('keep me');
    expect((await db.getDocument(id))?.content).toBe('keep me');
  });

  it('rebuilds a document whose log was pruned away entirely', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 8, minTombstoneRatio: 0.5 });

    const seed = new RgaDocument('seed');
    await store.apply(id, seed.insertAt(0, 'temporary'));

    // Delete the seeded text, then churn. Every character is a tombstone, so the
    // ratio clears any sensible threshold and the whole log becomes reclaimable.
    for (const element of seed.inspect()) {
      await store.apply(id, [{ type: 'delete', target: element.id }]);
    }

    await churn(store, id, 20);

    expect((await store.compact(id)).compacted).toBe(true);

    // Nothing is left below the snapshot: a log-only replay would produce an empty
    // string and overwrite the cache with it.
    expect((await db.readAllOps(id)).length).toBe(0);
    expect(await db.materializeContent(id)).toBe('');
    expect((await db.getDocument(id))?.content).toBe('');
  });
});

describe('compaction - idempotence', () => {
  it('produces the same document however many times it compacts', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 4, minTombstoneRatio: 0.9 });

    for (let round = 0; round < 5; round += 1) {
      await churn(store, id, 10);
      await store.compact(id);
    }

    const expected = await rebuild(db, id);

    // Compacting again must not move it.
    expect(await rebuild(db, id)).toBe(expected);
  });

  it('writes a snapshot that equals replaying the retained log', async () => {
    const { store, id } = await freshStore({ minOpsBelowFloor: 4, minTombstoneRatio: 0.9 });

    await churn(store, id, 16);

    const doc = new RgaDocument('check');
    doc.applyInAnyOrder(await db.readAllOps(id));

    await store.compact(id);

    const row = await db.readSnapshot(id);
    const rebuilt = new RgaDocument('rebuilt');
    rebuilt.applyInAnyOrder(
      snapshotToOperations({ seq: row?.seq ?? 0, elements: row?.elements ?? [] }),
    );

    expect(rebuilt.toText()).toBe(doc.toText());
  });
});
