/**
 * Offline-first replica: a CRDT document plus its durable operation log.
 *
 * ── Why the log is the source of truth ────────────────────────────────────
 * The visible text is a *projection* of the operation log. Storing text and
 * hoping it matches the log is how offline-first systems silently diverge.
 * Instead:
 *
 *   1. Every operation is appended to the log.
 *   2. The document is rebuilt by replaying the log.
 *   3. Text is derived, and can be discarded at any time.
 *
 * That makes the log authoritative, which is what allows a client that has been
 * offline for a week to reconcile by replay rather than by guessing.
 *
 * ── What this file deliberately does not do ────────────────────────────────
 * It does not decide when to persist, and it does not touch the network.
 * Persistence policy belongs to the caller; transport belongs to SyncTransport.
 * Keeping those separate is what lets the whole thing be tested without a
 * browser or a server.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import type { ElementId, SiteId } from '../clock.js';
import { RgaDocument, type Operation } from './rga.js';

/** A stored operation with the metadata a log needs to be replayable. */
export interface LoggedOperation {
  /** Monotonic within this log. Used for ordering and for cursor resumption. */
  readonly seq: number;
  readonly op: Operation;
  /**
   * Wall-clock time of application, for diagnostics only.
   *
   * Never used for ordering. Wall clocks disagree between machines, and ordering
   * by them is exactly the bug CRDTs exist to avoid.
   */
  readonly at: number;
}

/** Storage port. Implemented by IndexedDB in the browser and memory in tests. */
export interface OperationLog {
  load(): Promise<LoggedOperation[]>;
  append(entries: readonly LoggedOperation[]): Promise<void>;
  /** Drop entries below a sequence number. Phase 4 tombstones this. */
  truncateBefore(seq: number): Promise<void>;
  clear(): Promise<void>;
}

export interface ReplicaOptions {
  readonly site: SiteId;
  readonly log: OperationLog;
  /**
   * Called after local or remote operations are applied.
   *
   * The caller is responsible for appending to the log. Splitting it this way
   * keeps this class free of async I/O on the hot path.
   */
  readonly onOperations: (ops: readonly Operation[], origin: 'local' | 'remote') => void;
}

export class Replica {
  readonly #doc: RgaDocument;
  readonly #log: OperationLog;
  readonly #onOperations: ReplicaOptions['onOperations'];

  /** Sequence number of the next entry to append. */
  #nextSeq = 0;
  /** Sequence number of the newest entry this replica has applied. */
  #appliedSeq = -1;
  #initialised = false;

  constructor(options: ReplicaOptions) {
    this.#doc = new RgaDocument(options.site);
    this.#log = options.log;
    this.#onOperations = options.onOperations;
  }

  get site(): SiteId {
    return this.#doc.site;
  }

  get text(): string {
    return this.#doc.toText();
  }

  /** Newest sequence number applied. Phase 4 uses it to resume the server replay. */
  get appliedSeq(): number {
    return this.#appliedSeq;
  }

  /**
   * Rebuild the document from the persisted log.
   *
   * MUST be called before any editing. Until it runs, the document is empty, and
   * a local edit made against an empty document would anchor against nothing and
   * then conflict with the replayed log on load.
   */
  async init(): Promise<void> {
    if (this.#initialised) {
      return;
    }

    const entries = await this.#log.load();

    // Replay in sequence order using applyInAnyOrder, because a log can contain
    // operations whose anchors were truncated in an older version. Order of
    // application is not what makes replay correct; convergence is.
    const unplaced = this.#doc.applyInAnyOrder(
      entries
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((entry) => entry.op),
    );

    if (unplaced > 0) {
      // Silent here would be the worst outcome: a document quietly missing text
      // that the user previously saved. Surface it as an error.
      throw new Error(
        `Replica init failed: ${unplaced} logged operation(s) could not be placed. ` +
          'The log is likely corrupt or was truncated inconsistently.',
      );
    }

    const last = entries.at(-1);
    this.#appliedSeq = last?.seq ?? -1;
    this.#nextSeq = this.#appliedSeq + 1;
    this.#initialised = true;
  }

  #assertReady(): void {
    if (!this.#initialised) {
      throw new Error(
        'Replica used before init(). Editing against an unreplayed log would ' +
          "conflict with it on load and lose the user's text.",
      );
    }
  }

  /** Insert text at a visible offset and broadcast the result. */
  insertAt(offset: number, value: string): Operation[] {
    this.#assertReady();

    const ops = this.#doc.insertAt(offset, value);
    if (ops.length === 0) {
      return [];
    }

    this.#record(ops, 'local');
    return ops;
  }

  /** Delete a visible range and broadcast the result. */
  deleteRange(start: number, length: number): Operation[] {
    this.#assertReady();

    const ops = this.#doc.deleteRange(start, length);
    if (ops.length === 0) {
      return [];
    }

    this.#record(ops, 'local');
    return ops;
  }

  /**
   * Apply operations received from peers.
   *
   * @returns the operations that could not be placed, which is non-empty only
   *   when a peer sent an operation anchoring to something this replica has
   *   never seen. Phase 4 resyncs in that case.
   */
  applyRemote(ops: readonly Operation[]): Operation[] {
    this.#assertReady();

    // Record which element IDs exist before the batch, so the operations that
    // actually landed can be identified afterwards.
    const knownBefore = new Set(this.#knownIds());

    const unplaced = this.#doc.applyInAnyOrder(ops);

    const knownAfter = new Set(this.#knownIds());

    // An insert landed if its ID is now known and was not known before.
    // Deletes are never deferred, so they always landed.
    const placed: Operation[] = [];
    const deferred: Operation[] = [];

    for (const op of ops) {
      if (op.type === 'delete') {
        placed.push(op);
        continue;
      }

      const key = `${op.id.site}@${op.id.clock}`;
      if (!knownBefore.has(key) && knownAfter.has(key)) {
        placed.push(op);
      } else if (knownBefore.has(key)) {
        // Duplicate delivery of something already present. Idempotent, so it
        // counts as landed.
        placed.push(op);
      } else {
        deferred.push(op);
      }
    }

    if (placed.length > 0) {
      // Remote operations MUST be logged. Without this a reload loses everything
      // a collaborator typed, which is exactly the data loss the log exists to
      // prevent.
      this.#record(placed, 'remote');
    }

    // Trust the count from applyInAnyOrder over the inferred list. If the two
    // ever disagree, the document is in a state the CRDT does not define and the
    // caller must resync, so report everything we could not positively confirm.
    return unplaced > 0 ? (deferred.length > 0 ? deferred : [...ops]) : [];
  }

  /** Canonical keys for every element currently in the document. */
  #knownIds(): string[] {
    return this.#doc.inspect().map((element) => `${element.id.site}@${element.id.clock}`);
  }

  /** Undo the most recent local edit, returning compensation to broadcast. */
  undo(): Operation[] {
    this.#assertReady();

    const ops = this.#doc.undo();
    if (ops.length === 0) {
      return [];
    }

    this.#record(ops, 'local');
    return ops;
  }

  redo(): Operation[] {
    this.#assertReady();

    const ops = this.#doc.redo();
    if (ops.length === 0) {
      return [];
    }

    this.#record(ops, 'local');
    return ops;
  }

  get canUndo(): boolean {
    return this.#doc.canUndo;
  }

  get canRedo(): boolean {
    return this.#doc.canRedo;
  }

  /** Visible text offset of a character, for mapping a cursor through a merge. */
  offsetOf(visibleIndex: number): number {
    return visibleIndex;
  }

  /**
   * Element ID at a visible offset, used to anchor remote cursor rendering.
   *
   * @returns null at the end of the document.
   */
  elementIdAt(visibleOffset: number): ElementId | null {
    let seen = 0;

    for (const element of this.#inspect()) {
      if (element.deleted) {
        continue;
      }
      if (seen === visibleOffset) {
        return element.id;
      }
      seen += 1;
    }

    return null;
  }

  /**
   * Visible elements in document order.
   *
   * The editor's binding primitive. Diffing two snapshots of this is how a
   * remote operation becomes a minimal editor change rather than a whole-document
   * replacement, which would throw away the caret and the undo history on every
   * keystroke a collaborator types.
   */
  visibleElements(): readonly { key: string; value: string }[] {
    return this.#doc.visibleElements();
  }

  /**
   * Visible offset of an element, given its ID.
   *
   * The inverse of elementIdAt, and what lets a collaborator's cursor survive a
   * merge instead of jumping to the wrong character.
   *
   * @returns -1 when the element is unknown or deleted.
   */
  visibleOffsetOf(id: ElementId): number {
    const key = `${id.site}@${id.clock}`;
    let seen = 0;

    for (const element of this.#inspect()) {
      if (element.deleted) {
        continue;
      }
      if (`${element.id.site}@${element.id.clock}` === key) {
        return seen;
      }
      seen += 1;
    }

    return -1;
  }

  /** Structural health check, surfaced by tests and diagnostics. */
  checkInvariants(): string[] {
    return this.#doc.checkInvariants();
  }

  /**
   * Append operations to the log and notify the caller.
   *
   * Local and remote operations are both logged. Remote ones must be, or a reload
   * would lose everything a collaborator typed.
   */
  #record(ops: readonly Operation[], origin: 'local' | 'remote'): void {
    const now = Date.now();
    const entries: LoggedOperation[] = ops.map((op, index) => ({
      seq: this.#nextSeq + index,
      op,
      at: now,
    }));

    this.#appliedSeq = entries.at(-1)?.seq ?? this.#appliedSeq;
    this.#nextSeq = this.#appliedSeq + 1;

    this.#onOperations(ops, origin);
    void this.#log.append(entries);
  }

  /**
   * Internal element view.
   *
   * Exposed for cursor mapping and diagnostics only. Deliberately returns a copy
   * of the fields the caller needs rather than the mutable Element objects, so
   * nothing outside this class can corrupt deletion state.
   */
  #inspect(): readonly { key: string; id: ElementId; value: string; deleted: boolean }[] {
    return this.#doc.inspect();
  }
}
