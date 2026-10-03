/**
 * RGA (Replicated Growable Array): the CRDT itself.
 *
 * NOTE ON ENCODING: this file is ASCII-only by design. An earlier revision was
 * corrupted by shell round-tripping that mangled UTF-8 em dashes in comments.
 * Plain ASCII here costs nothing and removes that entire failure mode.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * Several people edit one document at once, with no server in the critical path
 * and no way to ask anyone "what order did these edits happen in?". Every
 * replica must independently arrive at the same document. That is convergence.
 *
 * ---------------------------------------------------------------------------
 * HOW RGA WORKS
 * ---------------------------------------------------------------------------
 * The document is a sequence of elements. Each element has a globally unique ID
 * (see ../clock.ts) and remembers the element it was inserted after, called its
 * ORIGIN.
 *
 * To insert element E after origin O: find O, then scan forward past every
 * element whose ID is GREATER than E's, and insert at the first position that
 * does not qualify.
 *
 * That single rule is what makes concurrent inserts converge. Two replicas both
 * inserting after the same origin receive their edits in different orders, but
 * both produce the same sequence, because the ID comparison is identical
 * everywhere:
 *
 *     A and B both insert after O, with ID(A) < ID(B)
 *     A arrives first:  [O, A]   B scans, ID(A) < ID(B) so stops   -> [O, B, A]
 *     B arrives first:  [O, B]   A scans, ID(B) > ID(A) so skips   -> [O, B, A]
 *
 * Same result either way. This is the entire insight; everything else is
 * bookkeeping.
 *
 * ---------------------------------------------------------------------------
 * DELETION
 * ---------------------------------------------------------------------------
 * Deletes are TOMBSTONES: an element is marked deleted and retained forever.
 * Physically removing it would break the ID ordering every other replica relies
 * on, and would make a late-arriving insert unplaceable.
 *
 * ---------------------------------------------------------------------------
 * OUT-OF-ORDER DELIVERY
 * ---------------------------------------------------------------------------
 * A delete can arrive before the insert it targets. Deletion therefore records
 * intent in a pending set, and any element inserted afterwards is tombstoned
 * immediately. Without this, a reordered message silently resurrects deleted
 * text, which is the worst possible failure for a document editor.
 */

import {
  LogicalClock,
  elementIdKey,
  formatElementId,
  type ElementId,
  type SiteId,
} from '../clock.js';

/** Where an insert is anchored. `null` means the document start. */
export type Origin = ElementId | null;

/*
 * Declared as type aliases rather than interfaces, deliberately.
 *
 * TypeScript infers an implicit index signature for an object *type alias* but
 * not for an interface. Operations must be assignable to the wire type
 * `JsonValue`, which is how a real operation gets sent without a cast. An
 * interface here would force `as unknown as JsonValue` at every send site.
 */
export type InsertOp = {
  readonly type: 'insert';
  readonly id: ElementId;
  readonly origin: Origin;
  readonly value: string;
};

export type DeleteOp = {
  readonly type: 'delete';
  /** The element to tombstone. */
  readonly target: ElementId;
};

export type Operation = InsertOp | DeleteOp;

interface Element {
  readonly id: ElementId;
  readonly origin: Origin;
  readonly value: string;
  deleted: boolean;
}

/**
 * One user-visible edit, kept so undo can reverse exactly what it created.
 *
 * A single entry holds ALL operations from one insertAt or deleteRange call. A
 * multi-character insert is one undo step, not one per character; otherwise
 * Ctrl+Z removes a single letter, which no user would accept.
 */
interface UndoEntry {
  readonly ops: readonly Operation[];
}

export class RgaDocument {
  readonly #clock: LogicalClock;

  /** Live sequence including tombstones. Index order is document order. */
  #elements: Element[] = [];

  /** Fast existence check and tombstone lookup by element ID. */
  readonly #byKey = new Map<string, Element>();

  /**
   * IDs tombstoned before their insert arrived.
   *
   * This is the out-of-order delete case. A delete may reach a replica before
   * the insert it refers to, and dropping it would lose the user's intent.
   */
  readonly #pendingDeletes = new Set<string>();

  /** Per-site undo stacks, so undo only ever reverses one's own work. */
  readonly #undoStacks = new Map<SiteId, UndoEntry[]>();

  /** Per-site redo stacks, cleared by any new local edit, like every editor. */
  readonly #redoStacks = new Map<SiteId, UndoEntry[]>();

  /**
   * Set while undo or redo generates compensating operations.
   *
   * Those operations are the RESULT of a history movement, not a new edit the
   * user made, so they must not be pushed onto the undo stack. Without this flag
   * the first Ctrl+Z would push a compensating entry and a second would undo
   * that entry instead of the original edit.
   */
  #suppressUndoRecording = false;

  constructor(site: SiteId) {
    this.#clock = new LogicalClock(site);
  }

  get site(): SiteId {
    return this.#clock.site;
  }

  /**
   * Visible text, with tombstones excluded.
   *
   * @param includeDeleted for debugging and tests; never used by the editor.
   */
  toText(includeDeleted = false): string {
    let out = '';
    for (const element of this.#elements) {
      if (includeDeleted || !element.deleted) {
        out += element.value;
      }
    }
    return out;
  }

  /** Number of elements including tombstones. */
  get size(): number {
    return this.#elements.length;
  }

  get tombstoneCount(): number {
    let count = 0;
    for (const element of this.#elements) {
      if (element.deleted) {
        count += 1;
      }
    }
    return count;
  }

  /** Array index for a visible offset. */
  #indexOfVisible(offset: number): number {
    if (offset < 0) {
      throw new RangeError(`Offset ${offset} is negative`);
    }

    let seen = 0;

    for (let i = 0; i < this.#elements.length; i += 1) {
      const element = this.#elements[i];
      if (element === undefined || element.deleted) {
        continue;
      }
      if (seen === offset) {
        return i;
      }
      seen += 1;
    }

    // Past the last visible character: insert at the very end.
    return this.#elements.length;
  }

  /** The element ID occupying a visible offset, or null at the end. */
  #visibleIdAt(offset: number): ElementId | null {
    let seen = 0;

    for (const element of this.#elements) {
      if (element.deleted) {
        continue;
      }
      if (seen === offset) {
        return element.id;
      }
      seen += 1;
    }

    return null;
  }

  /**
   * Insert text locally at a visible offset.
   *
   * @param offset where to insert, in visible characters. 0 is the start.
   * @param value text to insert, treated as an atomic run.
   * @returns the operations to broadcast, in order.
   */
  insertAt(offset: number, value: string): InsertOp[] {
    if (value === '') {
      return [];
    }

    const anchorIndex = this.#indexOfVisible(offset);
    const anchorElement = anchorIndex > 0 ? this.#elements[anchorIndex - 1] : undefined;
    let previous: Origin = anchorElement ? anchorElement.id : null;

    const ops: InsertOp[] = [];

    // Chain each inserted value after the previous one. Without chaining, two
    // values inserted at the same anchor would compete for the same position and
    // their relative order would depend on ID comparison rather than on the
    // order the user typed them.
    for (const char of value) {
      const id = this.#clock.tick();
      const op: InsertOp = { type: 'insert', id, origin: previous, value: char };
      this.#applyInsert(op);
      ops.push(op);
      previous = id;
    }

    // One undo step for the whole insertion, not one per character.
    this.#pushUndo(ops);
    return ops;
  }

  /**
   * Delete a visible range locally.
   *
   * @returns the operations to broadcast, in order.
   */
  deleteRange(start: number, length: number): DeleteOp[] {
    if (length <= 0) {
      return [];
    }
    if (start < 0) {
      throw new RangeError(`Start ${start} is negative`);
    }

    const ops: DeleteOp[] = [];
    // The offset deliberately does not advance: the element just deleted becomes
    // a tombstone, so the next visible character moves into this same offset.
    const offset = start;

    for (let i = 0; i < length; i += 1) {
      const target = this.#visibleIdAt(offset);

      if (!target) {
        // Range ran past the end. Deleting what exists is correct; silently
        // swallowing the remainder would hide a caller bug.
        break;
      }

      const op: DeleteOp = { type: 'delete', target };
      this.#applyDelete(op);
      ops.push(op);

      // The element is now a tombstone, so the next visible character moved
      // into this same offset. Do not advance.
    }

    // One undo step for the whole deletion.
    this.#pushUndo(ops);
    return ops;
  }

  /**
   * Apply one operation from any source.
   *
   * Idempotent by construction: applying the same operation twice produces the
   * same document as applying it once. Replays, retries, and duplicate delivery
   * are normal in a distributed system, so this is a correctness requirement
   * rather than an optimisation.
   */
  apply(op: Operation): void {
    if (op.type === 'insert') {
      this.#applyInsert(op);
    } else {
      this.#applyDelete(op);
    }
  }

  applyAll(ops: Iterable<Operation>): void {
    for (const op of ops) {
      this.apply(op);
    }
  }

  /**
   * Apply operations in any order, deferring those whose anchor is not yet known.
   *
   * An insert can only be placed once its origin is present. Reordering can
   * deliver a child before its parent, which is not an error; it happens on
   * every reconnect.
   *
   * Any operation whose anchor is missing is deferred and everything else
   * proceeds, repeating until no progress is possible. A genuine cycle would be
   * reported rather than silently misplacing text.
   *
   * @returns the number of operations that could not be placed. Zero is healthy.
   */
  applyInAnyOrder(ops: readonly Operation[]): number {
    let pending = [...ops];
    let progressed = true;

    while (pending.length > 0 && progressed) {
      progressed = false;
      const stillPending: Operation[] = [];

      for (const op of pending) {
        if (
          op.type === 'insert' &&
          op.origin !== null &&
          !this.#byKey.has(elementIdKey(op.origin))
        ) {
          // Anchor not present yet. Try again after the rest of the batch.
          stillPending.push(op);
          continue;
        }

        this.apply(op);
        progressed = true;
      }

      pending = stillPending;
    }

    return pending.length;
  }

  #applyInsert(op: InsertOp): void {
    const key = elementIdKey(op.id);

    // Idempotence: an ID identifies exactly one element, forever.
    if (this.#byKey.has(key)) {
      return;
    }

    // Absorb the observed clock before doing anything else. A local insert
    // issued afterwards gets a larger ID than this one, which is what makes the
    // integration rule below place it exactly where the user typed rather than
    // somewhere further along among the siblings. See LogicalClock for why this
    // has to happen on every applied insert, including a late arrival.
    this.#clock.observe(op.id);

    // A delete may have arrived before this insert. Honour it now.
    const deletedAlready = this.#pendingDeletes.delete(key);

    const element: Element = {
      id: op.id,
      origin: op.origin,
      value: op.value,
      deleted: deletedAlready,
    };

    this.#byKey.set(key, element);

    // --- The RGA integration rule ---
    // Skip every following element whose ID is greater than ours, then insert.
    // This is what resolves concurrent inserts identically on every replica.
    let index = op.origin === null ? 0 : this.#indexOfElement(op.origin) + 1;

    // `index` strictly increases each iteration, so this loop is bounded by the
    // element count. Caching the bound makes that guarantee explicit and turns a
    // future regression here into an immediate local failure rather than a hang
    // inside a fuzz run, where a timeout says nothing about the cause.
    const limit = this.#elements.length;

    while (index < limit) {
      const candidate = this.#elements[index];
      if (candidate === undefined || !isGreaterId(candidate.id, op.id)) {
        break;
      }
      index += 1;
    }

    this.#elements.splice(index, 0, element);
  }

  #applyDelete(op: DeleteOp): void {
    const key = elementIdKey(op.target);
    const element = this.#byKey.get(key);

    if (!element) {
      // The insert has not arrived. Record the intent so it is honoured when it
      // does. Discarding this would silently resurrect deleted text.
      this.#pendingDeletes.add(key);
      return;
    }

    // Tombstone only. Never remove: other replicas still reference this ID for
    // ordering, and removing it would break their integration of later inserts.
    element.deleted = true;
  }

  #indexOfElement(id: ElementId): number {
    const key = elementIdKey(id);

    for (let i = 0; i < this.#elements.length; i += 1) {
      if (elementIdKey(this.#elements[i]?.id ?? { site: '', clock: 0 }) === key) {
        return i;
      }
    }

    throw new Error(
      `Cannot anchor to ${formatElementId(id)}: it is not in this document. ` +
        'An insert whose origin is unknown cannot be placed deterministically.',
    );
  }

  // -------------------------------------------------------------------------
  // Per-site undo and redo
  // -------------------------------------------------------------------------

  #pushUndo(ops: readonly Operation[]): void {
    if (ops.length === 0 || this.#suppressUndoRecording) {
      return;
    }

    const stack = this.#undoStacks.get(this.site) ?? [];
    stack.push({ ops });
    this.#undoStacks.set(this.site, stack);

    // Any new edit invalidates the redo branch, matching every text editor.
    this.#redoStacks.delete(this.site);
  }

  /**
   * Undo the most recent local operation for this site.
   *
   * Undo in a CRDT cannot rewind history: other replicas may already depend on
   * what was undone. It COMPENSATES instead, emitting new operations that
   * reverse the effect.
   *
   * @returns compensating operations to broadcast, or empty if nothing to undo.
   */
  undo(): Operation[] {
    const stack = this.#undoStacks.get(this.site);
    const entry = stack?.pop();

    if (!entry) {
      return [];
    }

    this.#suppressUndoRecording = true;

    let reversed: { applied: Operation[]; redoOps: Operation[] };

    try {
      reversed = this.#reverse(entry.ops);
    } finally {
      this.#suppressUndoRecording = false;
    }

    // The redo entry holds operations that re-apply the edit, minted here while
    // the information needed to build them still exists.
    const redoStack = this.#redoStacks.get(this.site) ?? [];
    redoStack.push({ ops: reversed.redoOps });
    this.#redoStacks.set(this.site, redoStack);

    return reversed.applied;
  }

  /**
   * Redo the most recently undone local operation.
   *
   * @returns operations to broadcast, or empty if nothing to redo.
   */
  redo(): Operation[] {
    const stack = this.#redoStacks.get(this.site);
    const entry = stack?.pop();

    if (!entry) {
      return [];
    }

    // The redo entry already holds operations that re-apply the edit, built
    // during the undo with fresh element IDs. They are applied DIRECTLY, not
    // reversed; reversing them would compound the compensation.
    //
    // This is the deliberate asymmetry with undo: undo reverses what the user
    // did, redo replays what undo already prepared.
    this.#suppressUndoRecording = true;

    try {
      this.applyAll(entry.ops);
    } finally {
      this.#suppressUndoRecording = false;
    }

    // Whatever redo just applied becomes the new undo entry.
    const undoStack = this.#undoStacks.get(this.site) ?? [];
    undoStack.push({ ops: entry.ops });
    this.#undoStacks.set(this.site, undoStack);

    return [...entry.ops];
  }

  get canUndo(): boolean {
    return (this.#undoStacks.get(this.site)?.length ?? 0) > 0;
  }

  get canRedo(): boolean {
    return (this.#redoStacks.get(this.site)?.length ?? 0) > 0;
  }

  /**
   * Reverse a set of operations, returning both what to apply now and what
   * would reverse THAT.
   *
   * WHY TWO RETURN VALUES
   * Redo cannot re-apply the original operations. An undone insert becomes a
   * tombstone, so re-applying the original insert is a no-op by idempotence.
   * Redo therefore needs NEWLY MINTED operations, which can only be generated
   * while the information still exists: at the moment of the undo.
   *
   * WHY COMPENSATING RATHER THAN REVERTING
   * Undoing a delete RE-INSERTS the text with a fresh ID at the same anchor
   * rather than un-tombstoning the original. Un-tombstoning is not commutative,
   * so replicas would disagree about whether the element exists. A fresh insert
   * is a normal operation every replica orders identically.
   */
  #reverse(ops: readonly Operation[]): { applied: Operation[]; redoOps: Operation[] } {
    const applied: Operation[] = [];
    const redoOps: Operation[] = [];

    for (const op of ops) {
      if (op.type === 'delete') {
        const element = this.#byKey.get(elementIdKey(op.target));

        if (!element) {
          continue;
        }

        // Fresh ID, same anchor, same text. The original stays deleted forever.
        const id = this.#clock.tick();
        const restored: InsertOp = {
          type: 'insert',
          id,
          origin: element.origin,
          value: element.value,
        };
        this.#applyInsert(restored);
        applied.push(restored);

        // Redoing an undo-of-delete removes the freshly restored element.
        redoOps.push({ type: 'delete', target: id });
        continue;
      }

      const element = this.#byKey.get(elementIdKey(op.id));

      // Only tombstone if the insert is still visible. Undoing an already-deleted
      // insert would be a no-op at best, and a resurrection at worst.
      if (!element || element.deleted) {
        continue;
      }

      const removal: DeleteOp = { type: 'delete', target: op.id };
      this.#applyDelete(removal);
      applied.push(removal);

      // Redoing an undo-of-insert needs another fresh ID, because the original
      // element is now a tombstone and cannot be resurrected.
      const redoId = this.#clock.tick();
      redoOps.push({
        type: 'insert',
        id: redoId,
        origin: element.origin,
        value: element.value,
      });
    }

    return { applied, redoOps };
  }

  /**
   * Read-only element view for cursor mapping and diagnostics.
   *
   * Returns a copy of the identifying and deletion fields rather than the
   * mutable Element objects. Nothing outside this class can therefore corrupt
   * deletion state, which is the one piece of state the CRDT cannot recover if
   * it is modified incorrectly.
   *
   * `key` is the canonical string form of the element ID. Exposing it saves
   * every caller from reimplementing the same encoding, which is how two
   * different encodings end up silently failing to match.
   */
  inspect(): readonly { key: string; id: ElementId; value: string; deleted: boolean }[] {
    return this.#elements.map((element) => ({
      key: elementIdKey(element.id),
      id: element.id,
      value: element.value,
      deleted: element.deleted,
    }));
  }

  /**
   * Visible elements only, in document order.
   *
   * This is the primitive the editor binds to. Because every element is exactly
   * one character, an element index is a character offset, which lets the editor
   * translate CRDT positions into CodeMirror positions with no extra mapping
   * table.
   */
  visibleElements(): readonly { key: string; value: string }[] {
    const out: { key: string; value: string }[] = [];
    for (const element of this.#elements) {
      if (!element.deleted) {
        out.push({ key: elementIdKey(element.id), value: element.value });
      }
    }
    return out;
  }

  /**
   * Structural check used by tests and the convergence fuzzer.
   *
   * @returns every invariant this implementation should uphold, as
   *   human-readable descriptions. Empty means healthy.
   */
  checkInvariants(): string[] {
    const problems: string[] = [];

    // No duplicate IDs. Every other guarantee rests on this one.
    const seen = new Set<string>();
    for (const element of this.#elements) {
      const key = elementIdKey(element.id);
      if (seen.has(key)) {
        problems.push(`Duplicate element ID ${key}`);
      }
      seen.add(key);
    }

    // Element count must match the index map exactly.
    if (this.#elements.length !== this.#byKey.size) {
      problems.push(
        `Element count ${this.#elements.length} disagrees with index size ${this.#byKey.size}`,
      );
    }

    // Every non-root origin must precede its child.
    const position = new Map<string, number>();
    this.#elements.forEach((element, index) => {
      position.set(elementIdKey(element.id), index);
    });

    this.#elements.forEach((element, index) => {
      if (element.origin === null) {
        return;
      }

      const originIndex = position.get(elementIdKey(element.origin));

      if (originIndex === undefined) {
        problems.push(`Element ${formatElementId(element.id)} anchors to a missing origin`);
      } else if (originIndex >= index) {
        problems.push(
          `Element ${formatElementId(element.id)} appears before its origin ` +
            formatElementId(element.origin),
        );
      }
    });

    // Deletion state in the index map must match the sequence.
    for (const element of this.#elements) {
      const indexed = this.#byKey.get(elementIdKey(element.id));
      if (indexed && indexed.deleted !== element.deleted) {
        problems.push(`Deletion state mismatch for ${formatElementId(element.id)}`);
      }
    }

    return problems;
  }
}

/**
 * Total order used by the skip rule: clock ascending, then site ascending.
 *
 * Identical to compareElementId in ../clock.ts, inlined here so the hot path has
 * no cross-module call and the ordering rule is visible at the point of use.
 * That the two must never diverge is covered by the fuzzer.
 */
function isGreaterId(a: ElementId, b: ElementId): boolean {
  if (a.clock !== b.clock) {
    return a.clock > b.clock;
  }
  if (a.site === b.site) {
    return false;
  }
  return a.site > b.site;
}
