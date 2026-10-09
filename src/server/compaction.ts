/**
 * Deciding when a log may be compacted.
 *
 * -- Why this is a pure module -----------------------------------------------
 * The rule is "prune only below what no live peer can still need". Getting that
 * wrong deletes operations a peer has not seen, and the symptom is a peer that
 * silently stops receiving updates. There is no error, no log line, and no way to
 * notice from the server.
 *
 * So the rule lives here, as a total function of its inputs, with no I/O. That
 * makes every combination of peer cursors and log shape assertable rather than a
 * matter of judgement, which is the only reason to trust it at all.
 *
 * -- Why a minimum, not a maximum -------------------------------------------
 * Causal stability is about the SLOWEST peer. One client that has acknowledged
 * only sequence 10 pins the floor at 10 no matter how far ahead everyone else is.
 * That is correct and it is also why a single abandoned tab would otherwise stop
 * compaction forever, which is handled by treating a disconnected peer as absent
 * rather than as stalled.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { createSnapshot, snapshotCovers, type DocumentSnapshot } from '../core/crdt/snapshot.js';
import type { Operation, RgaDocument } from '../core/crdt/rga.js';

/** Why a compaction decision went the way it did. Returned so tests can assert it. */
export type CompactionDecision =
  | { readonly compact: false; readonly reason: CompactionSkipReason }
  | {
      readonly compact: true;
      /** Sequence the snapshot records. */
      readonly snapshotSeq: number;
      /** Sequence through which operations may be deleted. */
      readonly pruneThrough: number;
      readonly snapshot: DocumentSnapshot;
      readonly reclaimed: number;
    };

export type CompactionSkipReason =
  | 'log-too-small'
  | 'already-compacted'
  | 'no-stable-prefix'
  | 'snapshot-would-drop-live-operations';

export interface CompactionPolicy {
  /**
   * Minimum operations below the floor before compaction is worth doing.
   *
   * Small, because the work is cheap and a threshold that is too high means the
   * log keeps growing in exactly the cases where it matters least.
   */
  readonly minOpsBelowFloor?: number;
  /**
   * Tombstone fraction above which compaction pays for itself.
   *
   * A log that is mostly live text has nothing to reclaim; snapshotting it would
   * rewrite the whole document to save nothing.
   */
  readonly minTombstoneRatio?: number;
}

export interface CompactionInput {
  /** Document replica, used to build the snapshot. */
  readonly doc: RgaDocument;
  /**
   * Retained operations, each with the sequence it was stored at.
   *
   * The sequence is carried explicitly rather than inferred from array position.
   * Position equals the sequence only while the log is contiguous from 1, and it
   * stops being contiguous the moment compaction prunes anything. Inferring it
   * would make every sequence wrong after the first successful compaction --
   * silently, which is the worst way for it to be wrong.
   */
  readonly ops: readonly { readonly seq: number; readonly op: Operation }[];
  /**
   * Sequence each connected peer has acknowledged applying.
   *
   * An empty list means nobody is connected. The floor is then the whole log,
   * because no peer can be waiting on anything.
   */
  readonly peerCursors: readonly number[];
  /** Sequence of the newest stored snapshot, or null when there is none. */
  readonly snapshotSeq: number | null;
  /** Sequence of the newest operation, or 0 when the log is empty. */
  readonly latestSeq: number;
}

/**
 * Decide whether the log may be compacted, and to where.
 *
 * Total and side-effect free. Every branch has a stated reason so a skip can be
 * explained rather than merely observed.
 */
export function decideCompaction(
  input: CompactionInput,
  policy: CompactionPolicy = {},
): CompactionDecision {
  const minOpsBelowFloor = policy.minOpsBelowFloor ?? 32;
  const minTombstoneRatio = policy.minTombstoneRatio ?? 0.25;

  // The floor: the lowest sequence any connected peer still needs. With nobody
  // connected, no peer is waiting, so everything below the tip is reclaimable.
  const floor = input.peerCursors.length === 0 ? input.latestSeq : Math.min(...input.peerCursors);

  // Operations strictly below the floor. These are the candidates for deletion.
  const belowFloor = input.ops.filter((entry) => entry.seq <= floor);

  // Checked before the size threshold, because after a successful compaction the
  // log below the floor is empty -- so "too small" would be reported for every
  // subsequent call and the real reason ("there is nothing left to reclaim")
  // would never surface.
  if (input.snapshotSeq !== null && input.snapshotSeq >= floor) {
    return { compact: false, reason: 'already-compacted' };
  }

  if (belowFloor.length < minOpsBelowFloor) {
    return { compact: false, reason: 'log-too-small' };
  }

  const tombstones = input.doc.tombstoneCount;
  const total = input.doc.size;
  const ratio = total === 0 ? 0 : tombstones / total;

  if (ratio < minTombstoneRatio) {
    // Almost everything is live text, so a snapshot would be nearly as large as
    // the log it replaces.
    return { compact: false, reason: 'log-too-small' };
  }

  const tail = input.ops.filter((entry) => entry.seq > floor).map((entry) => entry.op);

  // The snapshot re-anchors live elements to their nearest live ancestor, so
  // tombstones are dropped entirely. Only the ones the tail explicitly names are
  // carried, because dropping those would strand the operations that reference
  // them.
  const snapshot = createSnapshot(input.doc, floor, tail);

  // The safety check that makes this correct rather than merely plausible. The
  // operations above the floor must still be placeable against the snapshot, so
  // every anchor and target they name has to survive in it.
  const coverage = snapshotCovers(snapshot, tail);

  if (!coverage.covered) {
    // Refusing here is the whole point of the check. Compacting anyway would leave
    // those operations permanently unplaceable, and their author permanently
    // behind, with nothing logged.
    return { compact: false, reason: 'snapshot-would-drop-live-operations' };
  }

  return {
    compact: true,
    snapshotSeq: floor,
    pruneThrough: floor,
    snapshot,
    reclaimed: belowFloor.length,
  };
}
