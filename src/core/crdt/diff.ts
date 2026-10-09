/**
 * Minimal change-set derivation between two element snapshots.
 *
 * ── Why diff by element ID rather than by text ─────────────────────────────
 * A remote operation lands at a position the local editor cannot know in
 * advance: RGA breaks ties between concurrent inserts by site ID and clock, so
 * "where did the collaborator's character end up" is only answerable by asking
 * the CRDT.
 *
 * Two ways to reflect that in the editor:
 *
 *   1. Ask the CRDT where each operation landed and construct the edit.
 *      Fast, but any mistake in predicting sibling ordering makes the editor and
 *      the CRDT silently disagree. That is the worst class of bug in this system:
 *      the text on screen stops being the text that will be saved.
 *
 *   2. Snapshot the visible elements before and after, then diff the two
 *      snapshots. Exact by construction, because it uses the same IDs the CRDT
 *      uses to decide identity.
 *
 * This is (2). It is O(n) rather than O(n log n) because element IDs are unique,
 * so the "longest common subsequence" is just a greedy merge.
 *
 * ── Why minimal matters ────────────────────────────────────────────────────
 * Replacing the whole document on every remote keystroke would discard the
 * caret, the selection, the scroll position and the undo history, several times
 * a second, for every collaborator. A minimal change set touches only the
 * characters that actually moved, which is the difference between an editor that
 * feels local-first and one that feels broken.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import type { Operation } from './rga.js';
import type { ElementSnapshot } from './element-snapshot.js';

/**
 * One edit in start-document coordinates.
 *
 * Positions are editor offsets, in UTF-16 code units, into the document as it was
 * BEFORE any of these changes. They are NOT element indices: the CRDT keeps one element
 * per Unicode code point, so an astral character such as an emoji is one element but two
 * code units, and every position after it differs between the two systems.
 * The editor applies the whole array as one unit, so positions do not need to be
 * adjusted for earlier changes: that is the caller's editor's job, not this
 * function's.
 *
 * Shaped to be structurally assignable to CodeMirror's ChangeSpec, so the
 * binding can spread these straight into a dispatch without casting.
 */
export interface ElementChange {
  readonly from: number;
  readonly to?: number;
  readonly insert?: string;
}

/**
 * Minimal change set turning `before` into `after`.
 *
 * @returns the changes, or `null` when a minimal change set cannot be produced.
 *
 * ── When this returns null ────────────────────────────────────────────────
 * The algorithm relies on an invariant that RGA guarantees: applying operations
 * never relocates a character that already existed, it only inserts between them
 * and tombstone them. So the surviving characters of `before` must appear in
 * `after` in the same relative order.
 *
 * When that does not hold, the input is not something this CRDT can produce. The
 * honest response is to report that rather than emit edits that would put the
 * wrong text on screen. The caller falls back to replacing the document, which
 * is ugly but correct.
 *
 * Guarantees when non-null:
 *
 *   - `to` is omitted for a pure insertion, and present for a deletion or a
 *     replacement.
 *   - Changes are returned in ascending `from` order and never overlap.
 *   - Applying them to the text of `before` yields exactly the text of `after`.
 *   - No change is emitted when the snapshots are identical.
 */
export function diffVisible(
  before: readonly ElementSnapshot[],
  after: readonly ElementSnapshot[],
): ElementChange[] | null {
  if (before.length === after.length) {
    // Same length does not imply same content, so this is a fast path only for
    // the extremely common "no remote change" case: check identity cheaply.
    let identical = true;
    for (let index = 0; index < before.length; index += 1) {
      if (before[index]?.key !== after[index]?.key) {
        identical = false;
        break;
      }
    }
    if (identical) {
      return [];
    }
  }

  // Position of each surviving element in the new document. Keys are unique, so
  // this map is also the identity relation between the two snapshots.
  const positionAfter = new Map<string, number>();
  for (let index = 0; index < after.length; index += 1) {
    const element = after[index];
    if (element) {
      positionAfter.set(element.key, index);
    }
  }

  // Editor offset of the start of each `before` element, plus the total at the end.
  // Everything below reasons in element indices; this is applied only when a change
  // is emitted, which keeps the algorithm itself unchanged and puts the whole
  // coordinate translation in one place.
  const offsetBefore: number[] = [0];
  for (const element of before) {
    offsetBefore.push((offsetBefore[offsetBefore.length - 1] ?? 0) + (element?.value.length ?? 0));
  }
  const at = (elementIndex: number): number => offsetBefore[elementIndex] ?? 0;

  const changes: ElementChange[] = [];

  /** Start of a run of deletions not yet emitted, or -1. */
  let deleteFrom = -1;
  /** Next unread index into `after`. */
  let afterCursor = 0;

  const flushDelete = (upTo: number): void => {
    if (deleteFrom >= 0) {
      changes.push({ from: at(deleteFrom), to: at(upTo) });
      deleteFrom = -1;
    }
  };

  for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex += 1) {
    const element = before[beforeIndex];
    const next = positionAfter.get(element?.key ?? '');

    if (next === undefined) {
      // Gone in the new snapshot. Extend the pending deletion run.
      if (deleteFrom < 0) {
        deleteFrom = beforeIndex;
      }
      continue;
    }

    if (next < afterCursor) {
      // A surviving character moved backwards. RGA cannot produce this, so the
      // caller is holding two snapshots this function was not designed for.
      return null;
    }

    // The element survives. Anything in `after` between afterCursor and next was
    // inserted immediately before it.
    if (next > afterCursor) {
      const inserted = joinValues(after, afterCursor, next);

      if (deleteFrom >= 0) {
        // A deletion run that ends exactly where an insertion begins is one
        // replacement, not two separate edits. CodeMirror renders that as a
        // single change, which keeps the diff readable and avoids a transient
        // empty range.
        changes.push({ from: at(deleteFrom), to: at(beforeIndex), insert: inserted });
        deleteFrom = -1;
      } else {
        changes.push({ from: at(beforeIndex), insert: inserted });
      }
    } else {
      // Nothing inserted before this element; just close any open deletion run.
      flushDelete(beforeIndex);
    }

    afterCursor = next + 1;
  }

  // Trailing deletions and trailing insertions may fuse into one replacement.
  const tail = joinValues(after, afterCursor, after.length);

  if (deleteFrom >= 0) {
    changes.push({
      from: at(deleteFrom),
      to: at(before.length),
      ...(tail === '' ? {} : { insert: tail }),
    });
  } else if (tail !== '') {
    changes.push({ from: at(before.length), insert: tail });
  }

  return changes;
}

function joinValues(elements: readonly ElementSnapshot[], from: number, to: number): string {
  let out = '';
  for (let index = from; index < to; index += 1) {
    out += elements[index]?.value ?? '';
  }
  return out;
}

/**
 * The safe fallback: throw the whole document away and write the new text.
 *
 * Correct, and much worse than a minimal change set: CodeMirror resets the caret
 * to the start and collapses the undo history. That is why it exists only as a
 * fallback for the `null` case above, and why it is worth a loud warning if it
 * ever fires in production. A minimal diff failing once is a curiosity; a
 * minimal diff failing on every keystroke would be unusable.
 */
export function fullReplacement(beforeText: string, afterText: string): ElementChange[] {
  if (afterText === '') {
    return [{ from: 0, to: beforeText.length }];
  }

  if (beforeText === '') {
    return [{ from: 0, insert: afterText }];
  }

  return [{ from: 0, to: beforeText.length, insert: afterText }];
}

/**
 * Text represented by an element snapshot.
 *
 * Exported because the tests need it to assert that a change set actually
 * produces the intended document, and because the binding uses it as the
 * fallback when verification fails.
 */
export function snapshotText(elements: readonly ElementSnapshot[]): string {
  return joinValues(elements, 0, elements.length);
}

/**
 * Apply a change set to text.
 *
 * A deliberately independent implementation of the same transformation the
 * editor performs. The binding uses it to verify its own output against the
 * CRDT before committing the transaction, so an error in `diffVisible` surfaces
 * as a caught fallback rather than as corrupted text on screen.
 */
export function applyChanges(text: string, changes: readonly ElementChange[]): string {
  // Applied right to left so earlier offsets stay valid.
  const ordered = [...changes].sort((a, b) => b.from - a.from);
  let out = text;

  for (const change of ordered) {
    const to = change.to ?? change.from;
    out = out.slice(0, change.from) + (change.insert ?? '') + out.slice(to);
  }

  return out;
}

/**
 * Operations that represent a local edit, for callers that need to distinguish
 * origins without inspecting the operation shape themselves.
 *
 * Deletes carry no origin tag, so this is a type guard rather than a filter that
 * can decide intent. It exists so the binding has one place that knows an
 * insert is a content-bearing operation.
 */
export function isInsert(op: Operation): op is Extract<Operation, { type: 'insert' }> {
  return op.type === 'insert';
}
