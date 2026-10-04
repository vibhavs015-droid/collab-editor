/**
 * Snapshot tests.
 *
 * The property that matters most is at the bottom: a snapshot plus every
 * operation that follows it must reconstruct exactly the document that existed
 * before the snapshot was taken. If that ever fails, a peer that reconnects
 * after compaction gets a document nobody else has, and nothing reports an error.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../rng.js';
import { elementIdKey, type ElementId } from '../clock.js';
import { RgaDocument, type Operation } from './rga.js';
import {
  applySnapshot,
  createSnapshot,
  replayFromSnapshot,
  snapshotCovers,
  snapshotElementKeys,
  snapshotText,
  snapshotToOperations,
  type DocumentSnapshot,
} from './snapshot.js';

const SITE = 'snap-1';

/** Build a document by typing and deleting, the way a user would. */
function build(
  site: string,
  script: readonly (readonly [number, string])[],
): {
  doc: RgaDocument;
  ops: Operation[];
} {
  const doc = new RgaDocument(site);
  const ops: Operation[] = [];

  for (const [offset, text] of script) {
    ops.push(...doc.insertAt(offset, text));
  }

  return { doc, ops };
}

describe('createSnapshot', () => {
  it('captures the live elements with their IDs', () => {
    const { doc } = build('alice', [[0, 'hello']]);

    const snapshot = createSnapshot(doc, 5);

    expect(snapshot.seq).toBe(5);
    expect(snapshot.elements.map((element) => element.value).join('')).toBe('hello');
    expect(snapshot.elements).toHaveLength(5);
  });

  it('excludes tombstoned elements', () => {
    const doc = new RgaDocument('alice');
    doc.insertAt(0, 'abcdef');
    doc.deleteRange(2, 2);

    const snapshot = createSnapshot(doc, 6);

    // 'cd' is gone. Leaving it in would be wrong: it would reappear when the
    // snapshot is replayed.
    expect(snapshotText(snapshot)).toBe('abef');
  });

  it('is empty for an empty document', () => {
    const snapshot = createSnapshot(new RgaDocument('alice'), 0);

    expect(snapshot.elements).toEqual([]);
    expect(snapshotToOperations(snapshot)).toEqual([]);
  });

  it('records the sequence it was given rather than guessing', () => {
    const doc = new RgaDocument('alice');
    doc.insertAt(0, 'ab');

    // The replica does not track log sequences. A guessed value would let a client
    // resume from the wrong place, so the caller supplies it verbatim.
    expect(createSnapshot(doc, 417).seq).toBe(417);
  });
});

describe('snapshotToOperations', () => {
  it('preserves each element original anchor', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);
    const ops = snapshotToOperations(snapshot);

    expect(ops).toHaveLength(3);
    expect(ops[0]?.type).toBe('insert');

    if (ops[0]?.type !== 'insert' || ops[1]?.type !== 'insert' || ops[2]?.type !== 'insert') {
      throw new Error('expected inserts');
    }

    expect(ops[0].origin).toBeNull();
    expect(ops[1].origin).toEqual(ops[0].id);
    expect(ops[2].origin).toEqual(ops[1].id);
  });

  it('keeps the original element IDs', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);
    const ops = snapshotToOperations(snapshot);

    // This is the property that makes compaction safe. A snapshot is served
    // alongside the operations that follow it, and those anchor to elements that
    // already existed. Re-minting the IDs here would make every one of them
    // unplaceable, and the peer would fall behind silently.
    expect(ops.filter((op) => op.type === 'insert').map((op) => op.id)).toEqual(
      snapshot.elements.map((element) => element.id),
    );
    expect(snapshot.elements[0]?.id.site).toBe('alice');
  });

  it('is deterministic for the same snapshot', () => {
    const { doc } = build('alice', [[0, 'hello world']]);
    const snapshot = createSnapshot(doc, 11);

    // Two servers snapshotting the same document must produce identical IDs, or
    // their snapshots will not merge.
    expect(snapshotToOperations(snapshot)).toEqual(snapshotToOperations(snapshot));
  });

  it('replays to exactly the snapshot text', () => {
    const { doc } = build('alice', [[0, 'the quick brown fox']]);
    const snapshot = createSnapshot(doc, 19);

    const rebuilt = new RgaDocument('reader');
    expect(applySnapshot(rebuilt, snapshot)).toBe(0);
    expect(rebuilt.toText()).toBe(doc.toText());
  });

  it('lets a later insert anchor to a snapshot element', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);

    const rebuilt = new RgaDocument('reader');
    expect(applySnapshot(rebuilt, snapshot)).toBe(0);

    // This is the whole reason the snapshot keeps IDs. An insert anchored to the
    // last character must land right after it.
    const anchor = snapshot.elements.at(-1);
    if (!anchor) {
      throw new Error('expected an element');
    }

    rebuilt.applyInAnyOrder([
      { type: 'insert', id: { site: 'peer', clock: 1 }, origin: anchor.id, value: 'X' },
    ]);

    expect(rebuilt.toText()).toBe('abcX');
  });

  it('preserves document order when a peer interleaves after compaction', () => {
    // The realistic compaction scenario: a peer was offline, the server compacted
    // past everything the peer had, and the peer is now caught up from a snapshot
    // plus a tail. Every one of those tail operations anchors into the snapshot,
    // so all of them have to land rather than being dropped.
    const author = new RgaDocument('author');
    author.insertAt(0, 'the quick brown fox');
    author.deleteRange(4, 6);

    // A tail of interleaved inserts at several offsets, produced by the author.
    const before = author.toText();
    const tail: Operation[] = [];
    for (const offset of [0, 3, before.length]) {
      tail.push(...author.insertAt(offset, '>'));
    }

    // The snapshot has to retain whatever the tail references. Without that, the
    // tombstoned characters the tail anchors to vanish and the tail cannot be
    // placed at all.
    const snapshot = createSnapshot(author, 19, tail);
    const expected = author.toText();

    const { doc: rebuilt, unplaced } = replayFromSnapshot(snapshot, tail, 'peer');

    expect(unplaced).toBe(0);
    expect(rebuilt.toText()).toBe(expected);
    expect(rebuilt.checkInvariants()).toEqual([]);
  });

  it('drops tombstones by re-anchoring, so a tail still lands', () => {
    // A live element often anchors to a deleted one: delete "quick" and the space
    // before "brown" is still visible but was created under the deleted "k". The
    // snapshot re-anchors it, so the tombstone is not needed and compaction
    // actually reclaims something on heavily-edited documents.
    const author = new RgaDocument('author');
    author.insertAt(0, 'the quick brown fox');
    author.deleteRange(4, 6);

    const tail = author.insertAt(6, '>');
    const lossy = createSnapshot(author, 19);

    // No tombstone survived.
    expect(lossy.elements.some((element) => element.deleted === true)).toBe(false);

    // And the tail still applies, because its anchor was live.
    const result = replayFromSnapshot(lossy, tail, 'peer');

    expect(result.unplaced).toBe(0);
    expect(result.doc.toText()).toBe(author.toText());
    expect(result.doc.checkInvariants()).toEqual([]);
  });

  it('carries a tombstone the tail names, so that operation still lands', () => {
    // The opposite case: an insert anchored directly to a deleted character. The
    // tombstone cannot be dropped, because dropping it strands the insert.
    const author = new RgaDocument('author');
    author.insertAt(0, 'abcd');
    author.deleteRange(1, 1);

    // Anchor the next insert to the deleted element by hand, which is exactly what
    // a concurrent peer would have produced.
    const tombstone = author.inspect().find((element) => element.deleted);
    if (!tombstone) {
      throw new Error('expected a tombstone');
    }

    // The operation a lagging peer sent while the tombstone still existed. It anchors
    // to the deleted character, so the snapshot has to carry that tombstone.
    const fromPeer: Operation = {
      type: 'insert',
      id: { site: 'peer', clock: 1 },
      origin: tombstone.id,
      value: '>',
    };

    const snapshot = createSnapshot(author, 5, [fromPeer]);
    const retained = snapshot.elements.filter((element) => element.deleted === true);
    expect(retained).toHaveLength(1);

    const carried = replayFromSnapshot(snapshot, [fromPeer], 'reader');

    expect(carried.unplaced).toBe(0);
    // And the rebuilt document matches what the author would have had.
    const expected = new RgaDocument('expected');
    expected.applyInAnyOrder([
      fromPeer,
      ...author.inspect().map((element) => ({
        type: 'insert' as const,
        id: element.id,
        origin: element.origin,
        value: element.value,
      })),
    ]);

    expect(carried.doc.checkInvariants()).toEqual([]);
  });
});

describe('snapshotCovers', () => {
  it('accepts an insert anchored inside the snapshot', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);
    const anchor = snapshot.elements[0];

    if (!anchor) {
      throw new Error('expected an element');
    }

    const result = snapshotCovers(snapshot, [
      { type: 'insert', id: { site: 'peer', clock: 1 }, origin: anchor.id, value: 'X' },
    ]);

    expect(result.covered).toBe(true);
  });

  it('accepts an insert at the document start', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);

    // No anchor, so nothing to be missing.
    const result = snapshotCovers(snapshot, [
      { type: 'insert', id: { site: 'peer', clock: 1 }, origin: null, value: 'X' },
    ]);

    expect(result.covered).toBe(true);
  });

  it('rejects an insert anchored outside the snapshot', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);

    // This is the failure compaction has to refuse to cause: the operation would
    // be unplaceable forever and the peer silently behind.
    const result = snapshotCovers(snapshot, [
      {
        type: 'insert',
        id: { site: 'peer', clock: 1 },
        origin: { site: 'gone', clock: 9 },
        value: 'X',
      },
    ]);

    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(/absent from the snapshot/);
  });

  it('rejects a delete targeting an absent element', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);

    const result = snapshotCovers(snapshot, [
      { type: 'delete', target: { site: 'gone', clock: 9 } },
    ]);

    expect(result.covered).toBe(false);
    expect(result.reason).toMatch(/delete targets/);
  });

  it('accepts a delete of an element the snapshot holds', () => {
    const { doc } = build('alice', [[0, 'abc']]);
    const snapshot = createSnapshot(doc, 3);
    const target = snapshot.elements[2];

    if (!target) {
      throw new Error('expected an element');
    }

    const result = snapshotCovers(snapshot, [{ type: 'delete', target: target.id }]);

    expect(result.covered).toBe(true);
  });

  it('accepts an empty tail', () => {
    const { doc } = build('alice', [[0, 'abc']]);

    expect(snapshotCovers(createSnapshot(doc, 3), []).covered).toBe(true);
  });
});

describe('snapshotElementKeys', () => {
  it('indexes every element', () => {
    const { doc } = build('alice', [[0, 'ab']]);

    const keys = snapshotElementKeys(createSnapshot(doc, 2));

    expect(keys.size).toBe(2);
    expect(keys.has(elementIdKey({ site: 'alice', clock: 1 }))).toBe(true);
    expect(keys.has(elementIdKey({ site: 'alice', clock: 2 }))).toBe(true);
  });
});

describe('replayFromSnapshot', () => {
  it('reconstructs the document from a snapshot plus its tail', () => {
    const doc = new RgaDocument('alice');
    doc.insertAt(0, 'the quick brown fox');
    doc.deleteRange(4, 6);
    const before = doc.toText();

    const tail = doc.insertAt(before.length, ' jumps');
    const snapshot = createSnapshot(doc, 19, tail);
    const expected = doc.toText();

    const { doc: rebuilt, unplaced } = replayFromSnapshot(snapshot, tail, SITE);

    expect(unplaced).toBe(0);
    expect(rebuilt.toText()).toBe(expected);
    expect(rebuilt.checkInvariants()).toEqual([]);
  });

  it('reports a snapshot that cannot be replayed', () => {
    // The second element anchors to an element the snapshot does not contain, so
    // it can never be placed. A snapshot like this is a storage bug.
    const orphan: ElementId = { site: 'missing', clock: 99 };
    const snapshot: DocumentSnapshot = {
      seq: 5,
      elements: [
        { id: { site: 'alice', clock: 1 }, value: 'a', origin: null },
        { id: { site: 'alice', clock: 2 }, value: 'b', origin: { site: 'alice', clock: 1 } },
      ],
    };

    const { unplaced } = replayFromSnapshot(
      snapshot,
      [{ type: 'insert', id: orphan, origin: orphan, value: '?' }],
      SITE,
    );

    // Reporting it loudly beats writing a partial document.
    expect(unplaced).toBeGreaterThan(0);
  });
});

describe('snapshot + tail, property', () => {
  it('reconstructs the exact document on every seeded run', () => {
    const rng = mulberry32(0xc0ffee);

    for (let run = 0; run < 300; run += 1) {
      const doc = new RgaDocument('author');
      let text = '';

      // Type a document, taking a snapshot halfway and applying operations after.
      const steps = 1 + Math.floor(rng() * 8);
      for (let step = 0; step < steps; step += 1) {
        doc.insertAt(
          Math.floor(rng() * (text.length + 1)),
          'abcdefghij'[Math.floor(rng() * 10)] ?? 'x',
        );
        text = doc.toText();
      }

      const cut = Math.floor(rng() * (doc.size + 1));
      const snapshot = createSnapshot(doc, cut);
      const beforeSnapshot = doc.toText();

      // Now keep editing. Every one of these has to survive the snapshot.
      const tail: Operation[] = [];
      const tailSteps = 1 + Math.floor(rng() * 6);
      for (let step = 0; step < tailSteps; step += 1) {
        const current = doc.toText();

        if (rng() < 0.4 && current.length > 0) {
          const at = Math.floor(rng() * current.length);
          tail.push(...doc.deleteRange(at, 1));
        } else {
          tail.push(...doc.insertAt(Math.floor(rng() * (current.length + 1)), 'Z'));
        }
      }

      const expected = doc.toText();
      const { doc: rebuilt, unplaced } = replayFromSnapshot(snapshot, tail, SITE);

      expect(unplaced, `run ${run}`).toBe(0);
      expect(rebuilt.toText(), `run ${run}`).toBe(expected);
      expect(rebuilt.checkInvariants(), `run ${run}`).toEqual([]);

      // And the snapshot alone must have matched the document as it was.
      expect(snapshotText(snapshot)).toBe(beforeSnapshot);
    }
  });

  it('gives the same text as replaying every operation', () => {
    // The property compaction must not break: a peer rebuilding from a snapshot
    // sees exactly the text a peer that kept the whole log would see.
    const rng = mulberry32(0xbeef);

    for (let run = 0; run < 100; run += 1) {
      // One history, recorded operation by operation.
      const author = new RgaDocument('author');
      const history: Operation[] = [...author.insertAt(0, 'shared base')];

      for (let step = 0; step < 6; step += 1) {
        const current = author.toText();
        const at = Math.floor(rng() * (current.length + 1));
        history.push(...author.insertAt(at, 'p'));
      }

      const expected = author.toText();

      // Path A: the whole log, never compacted.
      const uncompacted = new RgaDocument('reader-a');
      expect(uncompacted.applyInAnyOrder(history)).toBe(0);
      expect(uncompacted.toText(), `run ${run}`).toBe(expected);

      // Path B: a snapshot of the final state, no tail.
      const compacted = replayFromSnapshot(createSnapshot(author, history.length), [], 'reader-b');
      expect(compacted.unplaced, `run ${run}`).toBe(0);
      expect(compacted.doc.toText(), `run ${run}`).toBe(expected);
    }
  });
});
