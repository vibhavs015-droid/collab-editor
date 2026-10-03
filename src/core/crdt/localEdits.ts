/**
 * Turning editor edits into CRDT operations.
 *
 * ── Why this is not a method on the binding ────────────────────────────────
 * The translation is the part most likely to be wrong and the part hardest to
 * eyeball. A single offset mistake does not crash; it quietly inserts a
 * character in the wrong place, and the document still looks plausible. Pulling
 * it out of the CodeMirror-bound class means it can be tested exhaustively with
 * no DOM at all.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * Every edit is expressed in the coordinates of the document as it was BEFORE
 * the batch. Multiple edits in one batch (multi-cursor typing, find-and-replace)
 * are therefore all in the same coordinate space and must be applied in ascending
 * order, carrying a running offset of how much the document has already shifted.
 *
 * Getting that offset wrong is the classic bug: the second cursor's text lands
 * one character too far right, and nothing complains.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import type { Operation } from './rga.js';
import type { Replica } from './replica.js';

/** One edit, in pre-batch document coordinates. */
export interface LocalEdit {
  /** Start offset in the document before the batch. */
  readonly from: number;
  /** End offset in the document before the batch. `from` for a pure insert. */
  readonly to: number;
  /** Inserted text. Empty for a pure deletion. */
  readonly inserted: string;
}

/**
 * Apply a batch of local edits, returning the operations to broadcast.
 *
 * @param edits in the order the editor reported them. Not sorted: the order is
 *   meaningful, because the running offset depends on it, and silently sorting
 *   would hide a caller that gets it wrong.
 */
export function applyLocalEdits(edits: readonly LocalEdit[], replica: Replica): Operation[] {
  const ops: Operation[] = [];

  // How much the document has already grown or shrunk in this batch.
  let delta = 0;
  let previousFrom = -1;

  for (const edit of edits) {
    if (edit.from < previousFrom) {
      // Out-of-order edits mean the running offset below would be applied against
      // the wrong document state. Failing loudly beats producing text that looks
      // almost right.
      throw new Error(
        `Local edits must be in ascending offset order: ${edit.from} followed ${previousFrom}.`,
      );
    }

    previousFrom = edit.from;

    const at = edit.from + delta;
    const removed = edit.to - edit.from;

    if (removed < 0) {
      throw new Error(`Local edit has a negative length: ${edit.from}..${edit.to}.`);
    }

    // A replacement is a delete then an insert at the same offset. The CRDT has
    // no replace operation, and inventing one would be a second way to describe
    // the same thing, with two sets of edge cases to keep in step.
    if (removed > 0) {
      ops.push(...replica.deleteRange(at, removed));
    }

    if (edit.inserted !== '') {
      ops.push(...replica.insertAt(at, edit.inserted));
    }

    delta += edit.inserted.length - removed;
  }

  return ops;
}
