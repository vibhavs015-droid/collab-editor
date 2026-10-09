/**
 * Document snapshots.
 *
 * -- Why a snapshot is not just text ----------------------------------------
 * RGA integrates an insert by finding the element its `origin` names. If a
 * snapshot were a string, every operation that arrives after it would be
 * unplaceable, and the peer that sent it would be permanently, silently behind.
 * Nothing would error; the text would simply stop appearing.
 *
 * So a snapshot is the live *element set*, IDs included. It replays through the
 * same `applyInAnyOrder` path as any other operation, which means there is no
 * second code path and nothing extra to keep correct.
 *
 * -- What a snapshot deliberately excludes ----------------------------------
 * Tombstones. A tombstoned character is not in the document, and no future
 * insert should ever land after it in a way that matters. They stay in the
 * operation log until causal stability says otherwise (ADR-0011).
 *
 * -- Determinism ------------------------------------------------------------
 * `snapshotToOperations` mints IDs under a caller-supplied site. Two servers
 * snapshotting the same document must produce identical IDs or their snapshots
 * will not merge, so the site is derived from the document, never generated here.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import { elementIdKey, type ElementId } from '../clock.js';
import { RgaDocument, type Operation } from './rga.js';

/**
 * The state of a document at a known point in the log.
 *
 * `seq` is the log sequence this state corresponds to, not a count. A client
 * resumes from it, so it has to mean "every operation at or below this is
 * reflected here".
 */
export interface DocumentSnapshot {
  readonly seq: number;
  /** Live elements in document order. IDs preserved so future inserts can anchor. */
  readonly elements: readonly SnapshotElement[];
}

export interface SnapshotElement {
  readonly id: ElementId;
  readonly value: string;
  /**
   * What this element anchors to *in the rebuilt snapshot*.
   *
   * Not necessarily the anchor it was originally created with, because tombstones
   * are not carried. See {@link createSnapshot} for why re-anchoring is safe.
   */
  readonly origin: ElementId | null;
  /**
   * True when this element is tombstoned and kept only because a later operation
   * references it.
   */
  readonly deleted?: boolean;
}

/**
 * Build a snapshot from a replica.
 *
 * -- Why live elements are re-anchored, not stored with their original origins -
 * The obvious version of this function copies each element's original `origin`.
 * That does not work, because a live element frequently anchors to a DELETED one:
 * delete "quick" from "the quick brown fox" and the space before "brown" is still
 * visible but was created as a child of the deleted "k".
 *
 * Carrying that origin means carrying every tombstone, so compaction reclaims
 * nothing on exactly the documents that need it most -- the ones people have edited
 * heavily.
 *
 * Instead each live element is re-anchored to its nearest live ancestor, and
 * tombstones are dropped. This is safe:
 *
 *   - Document order is preserved exactly, because elements are emitted in order
 *     and chained to the previous live one.
 *   - Relative order among siblings is preserved, because the integration rule
 *     compares only the two IDs being ordered. Two elements that were siblings
 *     under a tombstone become siblings under the nearest live ancestor, and the
 *     rule orders them the same way in both cases.
 *   - A later insert anchoring to element X lands identically, because X's
 *     position in the document has not changed. Only X's history differs.
 *
 * @param seq the log sequence the caller's replica has applied. Recorded rather
 *   than computed, because the replica does not track log sequences itself and a
 *   guessed value would let a client resume from the wrong place.
 * @param retainTombstones operations that will follow this snapshot. Tombstones
 *   they name are carried, because dropping one would make them unplaceable. Their
 *   own ancestors do not need carrying: a retained tombstone is re-anchored to the
 *   nearest live ancestor exactly like everything else.
 */
export function createSnapshot(
  doc: RgaDocument,
  seq: number,
  retainTombstones: readonly Operation[] = [],
): DocumentSnapshot {
  const referenced = referencedElementKeys(retainTombstones);
  const elements: SnapshotElement[] = [];

  /** Nearest live element emitted so far. The anchor for everything after it. */
  let anchor: ElementId | null = null;

  for (const element of doc.inspect()) {
    if (!element.deleted) {
      elements.push({ id: element.id, value: element.value, origin: anchor });
      anchor = element.id;
      continue;
    }

    if (referenced.has(element.key)) {
      // Carried purely so a later operation can resolve. Emitted as deleted so
      // replaying the snapshot does not resurrect a deleted character.
      elements.push({
        id: element.id,
        value: element.value,
        origin: anchor,
        deleted: true,
      });

      // Deliberately NOT advancing the anchor. A live element must never come to
      // depend on a tombstone, which is the whole reason tombstones are droppable.
    }
  }

  return { seq, elements };
}

/**
 * Every element key the given operations reference.
 *
 * An insert names an anchor, a delete names a target, and both must resolve.
 */
export function referencedElementKeys(ops: readonly Operation[]): Set<string> {
  const keys = new Set<string>();

  for (const op of ops) {
    if (op.type === 'delete') {
      keys.add(elementIdKey(op.target));
      continue;
    }

    // An insert at the document start references nothing.
    if (op.origin !== null) {
      keys.add(elementIdKey(op.origin));
    }
  }

  return keys;
}

/**
 * Express a snapshot as operations, replayable like any other batch.
 *
 * **The elements keep their original IDs.** This is not an implementation detail,
 * it is the whole point.
 *
 * A snapshot is served to a peer alongside the operations that follow it. Those
 * operations anchor to elements that already existed, so if the snapshot re-minted
 * their IDs, every one of them would become unplaceable and the peer would be
 * permanently behind with no error reported anywhere. Preserving the IDs is what
 * lets a compacted log behave exactly like an uncompacted one.
 *
 * Each element chains after its predecessor so document order is preserved, with
 * one exception: a retained tombstone is followed by the element that originally
 * anchored to IT, not by whatever element happens to sit next to it now. Without
 * that, a rebuilt document would place a later insert in the wrong position.
 *
 * Retained tombstones are additionally emitted as delete operations, so replaying
 * a snapshot reproduces the same visible text and the same anchors.
 */
export function snapshotToOperations(snapshot: DocumentSnapshot): Operation[] {
  const ops: Operation[] = [];

  // First pass: recreate every element with the anchor it was originally created
  // against, so document order is reproduced exactly.
  for (const element of snapshot.elements) {
    ops.push({
      type: 'insert',
      id: element.id,
      origin: element.origin,
      value: element.value,
    });
  }

  // Second pass: tombstone whatever the snapshot says is deleted. Separate so the
  // inserts above can reference each other regardless of deletion order.
  for (const element of snapshot.elements) {
    if (element.deleted === true) {
      ops.push({ type: 'delete', target: element.id });
    }
  }

  return ops;
}

/**
 * Rebuild the text a snapshot represents.
 *
 * Not a shortcut around the CRDT -- a cross-check. A caller that uses this instead
 * of replaying has quietly stopped testing the CRDT, and this exists so the
 * cheaper path can be verified against it.
 *
 * ---------------------------------------------------------------------------
 * NOT THE VISIBLE TEXT WHEN TOMBSTONES ARE CARRIED
 * ---------------------------------------------------------------------------
 * This concatenates *every* element, including ones marked `deleted`. A snapshot built
 * with `retainTombstones` carries tombstones so later operations can resolve, and
 * their `value` is included here -- so for a snapshot of "acd" that carries the
 * tombstone for "b" this returns "abcd".
 *
 * That is correct for its purpose, which is what the elements concatenate to. It is a
 * trap for a caller who wanted visible text, and the difference is invisible unless it
 * is written down. Use {@link snapshotVisibleText} for that.
 */
export function snapshotText(snapshot: DocumentSnapshot): string {
  let out = '';
  for (const element of snapshot.elements) {
    out += element.value;
  }
  return out;
}

/**
 * Visible text of a snapshot, ignoring tombstones carried for resolvability.
 *
 * Exists because {@link snapshotText} is the more obvious name and gives the *wrong*
 * answer for a snapshot that carries tombstones. Naming both is cheaper than a
 * comment nobody reads at the call site.
 */
export function snapshotVisibleText(snapshot: DocumentSnapshot): string {
  let out = '';
  for (const element of snapshot.elements) {
    if (element.deleted !== true) {
      out += element.value;
    }
  }
  return out;
}

/**
 * Replay a snapshot into a document.
 *
 * Goes through `applyInAnyOrder` like any other operation, so a snapshot is not a
 * privileged input.
 *
 * @returns operations that could not be placed, which for a well-formed snapshot
 *   is always zero. A non-zero return means the snapshot is corrupt.
 */
export function applySnapshot(doc: RgaDocument, snapshot: DocumentSnapshot): number {
  return doc.applyInAnyOrder(snapshotToOperations(snapshot));
}

/** Element IDs a snapshot can anchor a future insert to. */
export function snapshotElementKeys(snapshot: DocumentSnapshot): Set<string> {
  const keys = new Set<string>();
  for (const element of snapshot.elements) {
    keys.add(elementIdKey(element.id));
  }
  return keys;
}

/**
 * Whether a snapshot can be followed by `ops` without losing any of them.
 *
 * The check that makes compaction safe. An insert whose `origin` is not in the
 * snapshot can never be placed, and neither can a delete targeting an element the
 * snapshot does not contain.
 *
 * Used before compacting: if the pending tail references something the snapshot
 * would drop, compaction has to wait. Catching this here turns a silent,
 * permanent divergence into a refusal to compact.
 */
export function snapshotCovers(
  snapshot: DocumentSnapshot,
  ops: readonly Operation[],
): { covered: boolean; reason?: string } {
  const keys = snapshotElementKeys(snapshot);

  for (const op of ops) {
    if (op.type === 'delete') {
      if (!keys.has(elementIdKey(op.target))) {
        return {
          covered: false,
          reason: `delete targets ${elementIdKey(op.target)}, absent from the snapshot`,
        };
      }
      continue;
    }

    // An insert at the document start has no anchor and is always placeable.
    if (op.origin === null) {
      continue;
    }

    if (!keys.has(elementIdKey(op.origin))) {
      return {
        covered: false,
        reason: `insert anchors to ${elementIdKey(op.origin)}, absent from the snapshot`,
      };
    }
  }

  return { covered: true };
}

/**
 * Merge a snapshot with the operations that follow it.
 *
 * The shape a reconnecting client actually receives. Returns a fresh document
 * rather than mutating one, so a caller can validate before committing.
 *
 * @returns the rebuilt document and any operations that could not be placed. A
 *   non-empty `unplaced` is a bug in what was stored, not a runtime condition
 *   to recover from, so it is returned loudly rather than swallowed.
 */
export function replayFromSnapshot(
  snapshot: DocumentSnapshot,
  ops: readonly Operation[],
  site: string,
): { doc: RgaDocument; unplaced: number } {
  // The site only names this rebuild's own identity. It has no effect on the
  // snapshot's elements, which keep the IDs they were created with.
  const doc = new RgaDocument(site);

  const fromSnapshot = applySnapshot(doc, snapshot);
  const fromOps = doc.applyInAnyOrder(ops);

  return { doc, unplaced: fromSnapshot + fromOps };
}
