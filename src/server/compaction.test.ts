/**
 * Compaction policy tests.
 *
 * The rule is "prune only below what no live peer can still need", and getting it
 * wrong deletes operations a peer has not seen. The symptom is a peer that
 * silently stops receiving updates: no error, no log line, nothing to notice from
 * the server.
 *
 * So these assert the skip reasons as carefully as the decisions. A compaction
 * that declines for the wrong reason is as much a bug as one that proceeds for the
 * wrong reason.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../core/rng.js';
import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import {
  replayFromSnapshot,
  snapshotCovers,
  type DocumentSnapshot,
} from '../core/crdt/snapshot.js';
import { decideCompaction, type CompactionInput } from './compaction.js';

/**
 * A document with real history: typed, then edited, then heavily deleted, so the
 * tombstone ratio is high enough to trigger compaction.
 */
function churnedDocument(): { doc: RgaDocument; ops: Operation[] } {
  const doc = new RgaDocument('author');
  const ops: Operation[] = [...doc.insertAt(0, 'the quick brown fox jumps over the lazy dog')];

  for (let round = 0; round < 6; round += 1) {
    // Delete a middle character, then type somewhere else. Each round leaves
    // tombstones behind, which is exactly the state compaction exists to reclaim.
    ops.push(...doc.deleteRange(4 + round, 3));
    ops.push(...doc.insertAt(0, 'x'));
  }

  return { doc, ops };
}

/**
 * Attach consecutive sequences to a list of operations.
 *
 * A contiguous log from 1 is the easy case. Compaction makes the general case
 * matter, which is why the sequence travels with each entry rather than being
 * inferred from position.
 */
function logged(ops: readonly Operation[], base = 0): { seq: number; op: Operation }[] {
  return ops.map((op, index) => ({ seq: base + index + 1, op }));
}

function input(overrides: Partial<CompactionInput> = {}): CompactionInput {
  const { doc, ops } = churnedDocument();

  return {
    doc,
    ops: ops.map((op, index) => ({ seq: index + 1, op })),
    peerCursors: [ops.length],
    snapshotSeq: null,
    latestSeq: ops.length,
    ...overrides,
  };
}

describe('decideCompaction - proceeding', () => {
  it('compacts a heavily edited document with no peers connected', () => {
    const decision = decideCompaction(input({ peerCursors: [] }));

    expect(decision.compact).toBe(true);

    if (!decision.compact) {
      return;
    }

    // With nobody connected, no peer is waiting on anything, so the floor is the
    // tip and everything below it is reclaimable.
    expect(decision.snapshotSeq).toBe(input().latestSeq);
    expect(decision.reclaimed).toBeGreaterThan(0);
  });

  it('reclaims the whole log when no peer is connected', () => {
    const base = input({ peerCursors: [] });
    const decision = decideCompaction(base);

    if (!decision.compact) {
      throw new Error(`expected compaction, got ${decision.reason}`);
    }

    expect(decision.reclaimed).toBe(base.ops.length);
  });

  it('produces a snapshot that rebuilds the document exactly', () => {
    const base = input({ peerCursors: [] });
    const decision = decideCompaction(base);

    if (!decision.compact) {
      throw new Error(`expected compaction, got ${decision.reason}`);
    }

    const { doc, unplaced } = replayFromSnapshot(decision.snapshot, [], 'reader');

    // The whole point. A snapshot that rebuilds anything other than the document is
    // worse than useless: it is a silent corruption.
    expect(unplaced).toBe(0);
    expect(doc.toText()).toBe(base.doc.toText());
    expect(doc.checkInvariants()).toEqual([]);
  });

  it('reclaims a log edited to death', () => {
    const doc = new RgaDocument('author');
    const ops: Operation[] = [...doc.insertAt(0, 'abcdefghij')];

    // Delete most of it, then type again. Textually this is tiny; operationally it
    // is the case that must not grow without bound.
    for (let round = 0; round < 8; round += 1) {
      ops.push(...doc.deleteRange(1, 1));
      ops.push(...doc.insertAt(0, 'z'));
    }

    const decision = decideCompaction(
      { doc, ops: logged(ops), peerCursors: [], snapshotSeq: null, latestSeq: ops.length },
      { minOpsBelowFloor: 4 },
    );

    if (!decision.compact) {
      throw new Error(`expected compaction, got ${decision.reason}`);
    }

    expect(decision.reclaimed).toBe(ops.length);
    // Far fewer elements than operations, which is the reclaim.
    expect(decision.snapshot.elements.length).toBeLessThan(ops.length);
  });
});

describe('decideCompaction - causal stability', () => {
  it('stops at the slowest peer', () => {
    const base = input();
    const floor = 20;
    const decision = decideCompaction(input({ peerCursors: [base.latestSeq, floor] }), {
      minOpsBelowFloor: 4,
    });

    if (!decision.compact) {
      throw new Error(`expected compaction, got ${decision.reason}`);
    }

    // One peer at 20 pins the floor at 20, no matter how far ahead the other is.
    // Pruning past 20 would delete operations that peer has not seen.
    expect(decision.snapshotSeq).toBe(floor);
  });

  it('takes the minimum across many peers', () => {
    const base = input();
    const decision = decideCompaction(input({ peerCursors: [base.latestSeq, 40, 12, 90] }), {
      minOpsBelowFloor: 4,
    });

    if (!decision.compact) {
      throw new Error(`expected compaction, got ${decision.reason}`);
    }

    expect(decision.snapshotSeq).toBe(12);
  });

  it('will not compact when the slowest peer has nothing to reclaim', () => {
    const base = input();
    const decision = decideCompaction(input({ peerCursors: [base.latestSeq, 3] }), {
      minOpsBelowFloor: 32,
    });

    // Only three operations sit below the floor. Compacting would rewrite the whole
    // document to save three rows.
    expect(decision.compact).toBe(false);

    if (decision.compact) {
      return;
    }

    expect(decision.reason).toBe('log-too-small');
  });
});

describe('decideCompaction - declining', () => {
  it('declines a document that is mostly live text', () => {
    const doc = new RgaDocument('author');
    const ops: Operation[] = [];

    // A lot of typing, no deleting. There is nothing to reclaim, and a snapshot
    // would be nearly as large as the log it replaces.
    for (let round = 0; round < 60; round += 1) {
      ops.push(...doc.insertAt(doc.toText().length, 'x'));
    }

    const decision = decideCompaction(
      { doc, ops: logged(ops), peerCursors: [], snapshotSeq: null, latestSeq: ops.length },
      { minOpsBelowFloor: 4 },
    );

    expect(decision.compact).toBe(false);

    if (decision.compact) {
      return;
    }

    expect(decision.reason).toBe('log-too-small');
  });

  it('declines when there is nothing below the floor', () => {
    const decision = decideCompaction(input({ peerCursors: [0] }));

    expect(decision.compact).toBe(false);

    if (decision.compact) {
      return;
    }

    expect(decision.reason).toBe('log-too-small');
  });

  it('declines when it has already compacted past the floor', () => {
    const base = input({ peerCursors: [] });
    const decision = decideCompaction(input({ peerCursors: [], snapshotSeq: base.latestSeq }));

    expect(decision.compact).toBe(false);

    if (decision.compact) {
      return;
    }

    expect(decision.reason).toBe('already-compacted');
  });

  it('declines an empty log', () => {
    const doc = new RgaDocument('author');
    const decision = decideCompaction({
      doc,
      ops: [],
      peerCursors: [],
      snapshotSeq: null,
      latestSeq: 0,
    });

    expect(decision.compact).toBe(false);
  });
});

describe('decideCompaction - the safety check', () => {
  it('refuses when the tail references something the snapshot dropped', () => {
    // Constructed by hand, because producing this state through the CRDT would
    // require a bug. It is what the check is there to catch, so it is tested
    // directly rather than hoped for.
    const snapshot: DocumentSnapshot = {
      seq: 5,
      elements: [{ id: { site: 'a', clock: 1 }, value: 'x', origin: null }],
    };

    const coverage = snapshotCovers(snapshot, [
      {
        type: 'insert',
        id: { site: 'b', clock: 1 },
        origin: { site: 'ghost', clock: 1 },
        value: 'y',
      },
    ]);

    expect(coverage.covered).toBe(false);
    expect(coverage.reason).toMatch(/absent from the snapshot/);
  });

  it('never drops a tombstone the tail names', () => {
    // The realistic version: delete a character, then have a peer insert after it.
    // A peer has to be behind for this to matter at all — with no peers connected
    // the floor is the tip, the tail is empty, and the check is trivially true.
    const doc = new RgaDocument('author');
    const ops: Operation[] = [...doc.insertAt(0, 'abcdef')];
    ops.push(...doc.deleteRange(2, 1));

    const tombstone = doc.inspect().find((element) => element.deleted);
    if (!tombstone) {
      throw new Error('expected a tombstone');
    }

    // A lagging peer's insert, anchored to the deleted character.
    const fromPeer: Operation = {
      type: 'insert',
      id: { site: 'peer', clock: 1 },
      origin: tombstone.id,
      value: '>',
    };
    doc.applyInAnyOrder([fromPeer]);
    ops.push(fromPeer);

    const decision = decideCompaction(
      {
        doc,
        ops: logged(ops),
        // One peer only up to the first insert, so the floor sits below fromPeer.
        peerCursors: [1],
        snapshotSeq: null,
        latestSeq: ops.length,
      },
      { minOpsBelowFloor: 1, minTombstoneRatio: 0 },
    );

    if (!decision.compact) {
      throw new Error(`expected compaction, got ${decision.reason}`);
    }

    // fromPeer sits above the floor, so it is part of the tail the snapshot has to
    // stay compatible with.
    expect(decision.snapshotSeq).toBeLessThan(ops.length);

    // The tombstone survives in the snapshot, so the tail operation resolves.
    expect(snapshotCovers(decision.snapshot, [fromPeer]).covered).toBe(true);
    expect(replayFromSnapshot(decision.snapshot, [fromPeer], 'r').unplaced).toBe(0);
  });
});

describe('decideCompaction - property', () => {
  it('never prunes above a peer cursor, on any interleaving', () => {
    const rng = mulberry32(0xfeed);

    for (let run = 0; run < 400; run += 1) {
      const doc = new RgaDocument('author');
      const ops: Operation[] = [];

      const steps = 3 + Math.floor(rng() * 12);
      for (let step = 0; step < steps; step += 1) {
        const current = doc.toText();

        if (rng() < 0.45 && current.length > 1) {
          ops.push(...doc.deleteRange(Math.floor(rng() * (current.length - 1)), 1));
        } else {
          ops.push(...doc.insertAt(Math.floor(rng() * (current.length + 1)), 'q'));
        }
      }

      // Peers at arbitrary positions, including none connected.
      const cursors: number[] = [];
      const peerCount = Math.floor(rng() * 3);
      for (let peer = 0; peer < peerCount; peer += 1) {
        cursors.push(Math.floor(rng() * (ops.length + 1)));
      }

      const decision = decideCompaction(
        {
          doc,
          ops: ops.map((op, index) => ({ seq: index + 1, op })),
          peerCursors: cursors,
          snapshotSeq: null,
          latestSeq: ops.length,
        },
        { minOpsBelowFloor: 1, minTombstoneRatio: 0 },
      );

      if (!decision.compact) {
        continue;
      }

      const lowest = cursors.length === 0 ? ops.length : Math.min(...cursors);

      // The invariant that makes this safe. If it ever fails, a peer below
      // `lowest` loses operations it has never seen.
      expect(decision.snapshotSeq, `run ${run}`).toBeLessThanOrEqual(lowest);

      // And whatever it decided, the result must rebuild the document exactly.
      const rebuilt = replayFromSnapshot(decision.snapshot, [], 'reader');
      expect(rebuilt.unplaced, `run ${run}`).toBe(0);
      expect(rebuilt.doc.toText(), `run ${run}`).toBe(doc.toText());
    }
  });

  it('produces the same decision for the same inputs', () => {
    const base = input({ peerCursors: [] });

    expect(decideCompaction(base)).toEqual(decideCompaction(base));
  });
});
