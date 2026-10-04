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
import type { Origin } from './rga.js';
import { RgaDocument, type Operation } from './rga.js';
import {
  createSnapshot,
  snapshotCovers,
  snapshotToOperations,
  type DocumentSnapshot,
} from './snapshot.js';

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
  /**
   * Replace history with a snapshot, atomically.
   *
   * Optional, and this is the interesting part of the interface: a log that does not
   * implement it simply cannot be compacted, and {@link Replica.compactLog} reports
   * that rather than falling back to deleting a prefix. Truncating is always available
   * and always wrong for a log with live history in it, so an implementation that
   * offered no alternative would be an invitation to reintroduce that bug.
   */
  replaceWithSnapshot?(snapshotOps: readonly Operation[], keepFromSeq: number): Promise<boolean>;
}

/** What a compaction attempt did. */
export interface CompactionResult {
  /** False means nothing was written: the log is unchanged. */
  readonly committed: boolean;
  /** Why not, when `committed` is false. */
  readonly reason?: string;
  /** Entries before and after, or null when nothing was attempted. */
  readonly operationsBefore: number;
  readonly operationsAfter: number | null;
  /** The sequence the snapshot represents. */
  readonly snapshotSeq: number;
}

export interface CompactOptions {
  /**
   * How many entries to keep after compaction.
   *
   * The retained tail is what a peer that is slightly behind will be sent, so this is
   * also the window in which a lagging peer can catch up incrementally instead of
   * needing a full baseline.
   */
  readonly keepAtLeast?: number;
  /**
   * Operations not yet accepted by a server.
   *
   * Required in practice. An unsent delete naming an element the snapshot drops can
   * never be sent and never applied, which is silent divergence. Passing the queue
   * makes `createSnapshot` carry those tombstones so the edit survives compaction.
   *
   * Omitting it is allowed, because a fully synced replica has nothing unsent and
   * forcing a caller to pass an empty array would be noise.
   */
  readonly unsent?: readonly Operation[];
}

/**
 * Default retained tail.
 *
 * 200 rather than a round number chosen for looks: a peer reconnecting after a brief
 * drop should catch up by delta, and 200 operations is far more than a few seconds of
 * typing for one person while still keeping the log bounded.
 */
const DEFAULT_KEEP_TAIL = 200;

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
  #doc: RgaDocument;
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

  /**
   * Discard everything and rebuild from a baseline.
   *
   * The operation a client performs when the server tells it it is too far behind
   * for a delta (ADR-0011). Applying a snapshot incrementally instead would leave
   * the client with its old document PLUS the whole compacted history, which is
   * visibly wrong.
   *
   * Two things are deliberately NOT cleared:
   *
   *   - **The site id.** This replica keeps its identity, so clocks stay
   *     monotonic and its next local edit cannot collide with an id it issued
   *     before the reset.
   *   - **The local clock's high-water mark.** Clearing it would let the replica
   *     reissue ids that already exist in the document it just adopted.
   *
   * The log IS cleared, because it is the thing being replaced.
   *
   * @param baseline operations that reconstruct the document from nothing. They are
   *   recorded as the new log, so a reload replays them rather than refetching.
   */
  async resetTo(baseline: readonly Operation[]): Promise<void> {
    this.#assertReady();

    // New document, same site. See the note above on why the clock is not reset.
    const replacement = new RgaDocument(this.#doc.site);
    const unplaced = replacement.applyInAnyOrder(baseline);

    if (unplaced > 0) {
      // Adopting a baseline that cannot be replayed would leave a document
      // missing text, with no way for the caller to tell. Refuse instead.
      throw new Error(
        `Replica reset failed: ${unplaced} baseline operation(s) could not be placed.`,
      );
    }

    this.#doc = replacement;
    await this.#log.clear();

    this.#nextSeq = 0;
    this.#appliedSeq = -1;

    this.#record([...baseline], 'remote');
  }

  /**
   * Snapshot the current document, for compaction.
   *
   * Exists on `Replica` rather than on the log because the snapshot needs the live
   * document and only the replica has it. It also records `#appliedSeq` itself, so a
   * caller cannot pass a stale sequence and produce a snapshot that claims to cover
   * operations it does not.
   *
   * @param retainTombstones operations that will be replayed after this snapshot.
   *   Tombstones they name are carried, because dropping one would make them
   *   unplaceable. Pass the unsent queue here: an unsent delete whose target the
   *   snapshot drops is an edit that can never be sent.
   *
   * @throws when called before {@link init}, since the document would be empty and the
   *   snapshot would silently be of nothing.
   */
  snapshot(retainTombstones: readonly Operation[] = []): DocumentSnapshot {
    this.#assertReady();

    return createSnapshot(this.#doc, this.#appliedSeq, retainTombstones);
  }

  /**
   * Replace the log's history with a snapshot, keeping a tail.
   *
   * ---------------------------------------------------------------------------
   * WHY NOT JUST DELETE THE OLD ENTRIES
   * ---------------------------------------------------------------------------
   * An RGA insert names the element it anchors to. Deleting a prefix of the log
   * therefore deletes elements the surviving operations still refer to, and
   * {@link init} throws rather than guessing, because guessing produces a document
   * missing text the user typed. The old entry cap did exactly this on every append,
   * once the log passed it.
   *
   * Compaction replaces what it drops with a snapshot that carries those elements
   * forward with their original ids, so nothing downstream can tell the difference.
   * Same idea as the server's compaction (ADR-0011), on the client's own log.
   *
   * ---------------------------------------------------------------------------
   * WHY THE UNSENT QUEUE IS A PARAMETER
   * ---------------------------------------------------------------------------
   * An unsent delete naming a dropped element is an edit that can never be sent and
   * never applied. That is silent divergence between this device and the server, and
   * it is invisible until someone reads the document back.
   *
   * The decision of what is unsent belongs to the transport, which is the only thing
   * that knows whether an operation was acknowledged. So it is passed in rather than
   * guessed at here.
   *
   * @returns what happened. `committed: false` always means the log is unchanged, so
   *   a caller can treat a refusal as a no-op without inspecting anything.
   */
  async compactLog(options: CompactOptions = {}): Promise<CompactionResult> {
    this.#assertReady();

    const entries = await this.#log.load();
    const before = entries.length;
    const keepAtLeast = options.keepAtLeast ?? DEFAULT_KEEP_TAIL;
    const snapshotSeq = this.#appliedSeq;

    if (this.#log.replaceWithSnapshot === undefined) {
      return {
        committed: false,
        reason: 'this log cannot be compacted; only truncated',
        operationsBefore: before,
        operationsAfter: null,
        snapshotSeq,
      };
    }

    // Nothing to gain below the threshold. Attempting anyway would rewrite the whole
    // log on every call, which for a short document is pure write amplification.
    if (before <= keepAtLeast) {
      return {
        committed: false,
        reason: 'log is already at or below the retained tail',
        operationsBefore: before,
        operationsAfter: before,
        snapshotSeq,
      };
    }

    const unsent = options.unsent ?? [];
    const snapshot = this.snapshot(unsent);
    const snapshotOps = snapshotToOperations(snapshot);

    // The floor: everything from here up survives untouched. Chosen so the snapshot
    // and the tail cannot overlap, which would mean an operation present twice.
    const keepFrom = snapshotSeq - keepAtLeast + 1;
    const tail = entries.filter((entry) => entry.seq >= keepFrom).map((entry) => entry.op);

    // The check that makes this safe rather than hopeful. If the snapshot cannot carry
    // everything the tail references, refuse: the alternative is a log that throws on
    // the next load, which is a far worse outcome than a log that stays large.
    const coverage = snapshotCovers(snapshot, [...snapshotOps, ...tail].slice(snapshotOps.length));

    if (!coverage.covered) {
      return {
        committed: false,
        reason: coverage.reason ?? 'snapshot would drop live operations',
        operationsBefore: before,
        operationsAfter: before,
        snapshotSeq,
      };
    }

    const committed = await this.#log.replaceWithSnapshot(
      snapshotOps,
      Math.max(0, keepFrom - snapshotOps.length),
    );

    if (!committed) {
      return {
        committed: false,
        reason: 'the log refused the write (quota, or the store went away)',
        operationsBefore: before,
        operationsAfter: before,
        snapshotSeq,
      };
    }

    return {
      committed: true,
      operationsBefore: before,
      operationsAfter: snapshotOps.length + tail.length,
      snapshotSeq,
    };
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
  #inspect(): readonly {
    key: string;
    id: ElementId;
    origin: Origin | null;
    value: string;
    deleted: boolean;
  }[] {
    return this.#doc.inspect();
  }
}
