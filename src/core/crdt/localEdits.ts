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
 * -- Two coordinate systems ---------------------------------------------------
 * The editor counts UTF-16 code units; the CRDT stores one element per Unicode code
 * point (see InsertOp: `for (const char of value)`). They agree for every character in
 * the Basic Multilingual Plane and disagree after any astral character, such as an
 * emoji, which is one element but two code units. Passing editor offsets straight to
 * the CRDT therefore places an edit after an emoji one character too far to the right,
 * and a deletion that spans an emoji removes one element too many. Nothing throws and
 * the editor keeps showing what the user typed, so the replica and the screen drift
 * apart silently.
 *
 * `LocalEdit` offsets are in editor coordinates (UTF-16). They are converted to element
 * indices here, against the document as it was before the batch, which is the only
 * place both coordinate systems are visible at once.
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
 * Number of CRDT elements (Unicode code points) in the first `utf16Offset` code units of
 * `text`.
 *
 * An offset that falls between the two halves of a surrogate pair rounds up to include
 * the whole character. CodeMirror never produces such an offset, but rounding keeps the
 * result a valid element index if something else ever does.
 */
export function elementIndexAt(text: string, utf16Offset: number): number {
  let index = 0;
  let units = 0;

  for (const char of text) {
    if (units >= utf16Offset) {
      break;
    }
    units += char.length;
    index += 1;
  }

  return index;
}

/** Number of CRDT elements (Unicode code points) in `text`. */
export function elementCount(text: string): number {
  let count = 0;
  for (const _char of text) {
    count += 1;
  }
  return count;
}

/**
 * Apply a batch of local edits, returning the operations to broadcast.
 *
 * @param edits in the order the editor reported them, in editor (UTF-16) coordinates.
 *   Not sorted: the order is meaningful, because the running offset depends on it, and
 *   silently sorting would hide a caller that gets it wrong.
 */
export function applyLocalEdits(edits: readonly LocalEdit[], replica: Replica): Operation[] {
  const ops: Operation[] = [];

  // Read once, before the first mutation: every edit is in pre-batch coordinates, and
  // the replica stops matching them as soon as the first operation is applied.
  const textBefore = replica.text;

  // How much the document has already grown or shrunk in this batch, in elements.
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

    if (edit.to - edit.from < 0) {
      throw new Error(`Local edit has a negative length: ${edit.from}..${edit.to}.`);
    }

    const fromElement = elementIndexAt(textBefore, edit.from);
    const removed = elementIndexAt(textBefore, edit.to) - fromElement;
    const at = fromElement + delta;

    // A replacement is a delete then an insert at the same offset. The CRDT has
    // no replace operation, and inventing one would be a second way to describe
    // the same thing, with two sets of edge cases to keep in step.
    if (removed > 0) {
      ops.push(...replica.deleteRange(at, removed));
    }

    if (edit.inserted !== '') {
      ops.push(...replica.insertAt(at, edit.inserted));
    }

    delta += elementCount(edit.inserted) - removed;
  }

  return ops;
}
