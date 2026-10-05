/**
 * Server-side document store.
 *
 * Owns one CRDT replica per open document and persists every accepted operation.
 *
 * ── Why the server keeps a replica at all ──────────────────────────────────
 * The relay is a dumb forwarder (ADR-0007), and this class deliberately does not
 * change that: it does not decide what any operation means, and it never sends
 * a merged result to anybody. It keeps a replica for one reason only, and that
 * reason is not collaboration:
 *
 *   1. Materialising text. `documents.content` is a derived cache that the HTTP
 *      API serves to a client before it has connected. Producing it by replaying
 *      the whole log on every read would make every GET O(document size).
 *   2. Rejecting writes it cannot replay. If a batch cannot be placed, storing it
 *      would leave the log un-replayable forever. Catching that here, at write
 *      time, is the difference between one bad frame and permanent corruption.
 *
 * Clients still converge entirely among themselves. A client that receives fewer
 * operations than the server stored will ask for them and catch up, which is
 * exactly what `readSince` is for.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import { parseOperations } from '../shared/operation-validation.js';
import { decideCompaction, type CompactionPolicy } from './compaction.js';
import type { EncryptedOperationFrame, JsonValue } from '../shared/protocol.js';
import type { Database } from './db.js';
import type { RelayLog, RelayPage } from './relay.js';
import { Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { M, declareMetrics } from './observability/index.js';

/**
 * Write side of the store, implemented by {@link Database}.
 *
 * A port rather than the class itself, so this module can be tested against a
 * stub and so the dependency points one way. `src/server` is allowed to import
 * `src/core`; the reverse would be the layering violation that matters.
 */
export interface OperationSink {
  appendOps(
    documentId: string,
    ops: readonly Operation[],
    options?: { readonly materializedText?: string },
  ): Promise<number>;
  /**
   * Store encrypted frames. Optional so an existing stub keeps working.
   *
   * Optional means the store cannot rely on it, and it checks before calling rather than
   * assuming: a store given a sink without it must refuse encrypted operations loudly,
   * not quietly drop them and report success.
   */
  appendEncryptedOps?(
    documentId: string,
    frames: readonly EncryptedOperationFrame[],
  ): Promise<number>;
}

export interface DocumentStoreOptions {
  readonly db: Database | OperationSink;
  /** Read-side callback. Defaults to the database. */
  readonly log?: RelayLog;
  /** Set false to leave the log growing. Used by tests that assert on raw counts. */
  readonly compaction?: boolean;
  /** Override the compaction thresholds. Defaults are in compaction.ts. */
  readonly compactionPolicy?: CompactionPolicy;
  /**
   * Where to report operation volume and compaction outcomes.
   *
   * Defaults to a private registry and a silent logger, so a store built in a test
   * shares nothing. The real server passes one registry to the API, the relay and the
   * store, so a single /metrics scrape sees all of them.
   */
  readonly metrics?: Metrics;
  readonly logger?: Logger;
}

/** Outcome of applying one inbound batch. */
export interface StoreResult {
  readonly accepted: number;
  readonly rejected: number;
  /** Operations the replica could not place, so they were not persisted. */
  readonly unplaced: readonly Operation[];
}

/** Write side, extended with compaction. Optional so tests can supply a stub. */
export interface CompactionSink extends OperationSink {
  writeSnapshot?(
    documentId: string,
    snapshot: { readonly seq: number; readonly elements: readonly unknown[] },
  ): Promise<void>;
  pruneOpsThrough?(documentId: string, seq: number): Promise<number>;
}

/** What a compaction pass did. Returned so tests and diagnostics can assert it. */
export interface CompactionResult {
  readonly compacted: boolean;
  readonly reason?: string;
  readonly snapshotSeq?: number;
  readonly pruned?: number;
}

/**
 * A peer's acknowledged position in the log.
 *
 * The server cannot compact below the lowest of these, because an operation below
 * it may still be referenced by something that peer has not sent (ADR-0011).
 */
export interface PeerCursor {
  readonly site: string;
  readonly seq: number;
}

/**
 * Writes to accumulate before attempting a compaction pass.
 *
 * Not a round number on purpose: it should land between ordinary typing bursts
 * rather than on a cadence a user could feel.
 */
const DEFAULT_WRITES_PER_COMPACTION = 40;

export class DocumentStore {
  readonly #db: OperationSink;
  readonly #metrics: Metrics;
  readonly #logger: Logger;
  readonly #log: RelayLog;
  /** One replica per open document, created on first sight. */
  readonly #replicas = new Map<string, RgaDocument>();
  /**
   * Serialises writes per document.
   *
   * Two batches arriving together would otherwise interleave their replay and
   * their database write, and the text cache could be written for the batch that
   * landed second while carrying the text from the first.
   */
  readonly #queues = new Map<string, Promise<unknown>>();

  /**
   * Latest acknowledged sequence per peer, per document.
   *
   * Read by compaction to find the causal-stability floor. Held here rather than
   * in the relay because compaction is a storage concern and has no business
   * knowing about sockets.
   */
  readonly #cursors = new Map<string, Map<string, number>>();

  /** Writes seen per document since the last compaction attempt. */
  readonly #pendingWrites = new Map<string, number>();

  /**
   * Documents known to hold ciphertext.
   *
   * An in-memory latch rather than a column read on every call, because it is consulted
   * from `maybeCompact`, which runs after every write. A query per keystroke to learn
   * something that cannot change is a cost paid forever for a fact established once.
   *
   * Set from the first encrypted frame and never cleared. A document's mode is decided
   * once (ADR-0014), and the latch mirrors that: a document cannot go back.
   *
   * Not persisted, so it is empty after a restart. That is safe rather than lossy: the
   * column in the database is the authority, `readForClient` asks it, and the latch only
   * spares the compaction hot path. After a restart the first write repopulates it, and
   * a document nobody writes is not compacting anything anyway.
   */
  readonly #encrypted = new Set<string>();

  /**
   * One compaction pass in flight, process-wide.
   *
   * Serialising matters more than it looks: two concurrent passes would both
   * snapshot the same state and the second would prune against a floor the first
   * has already moved.
   */
  #compactionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DocumentStoreOptions) {
    this.#db = options.db;
    this.#metrics = options.metrics ?? new Metrics();
    this.#logger = options.logger ?? Logger.silent();
    declareMetrics(this.#metrics);
    this.#log = options.log ?? defaultReadSince(options.db);

    if (options.compaction !== false) {
      this.#compaction =
        options.compactionPolicy === undefined
          ? { enabled: true, writesPerRun: DEFAULT_WRITES_PER_COMPACTION }
          : {
              enabled: true,
              policy: options.compactionPolicy,
              writesPerRun: DEFAULT_WRITES_PER_COMPACTION,
            };
    }
  }

  // ── Compaction ─────────────────────────────────────────────────────────────

  #compaction: {
    enabled: boolean;
    policy?: CompactionPolicy;
    /** Writes to accumulate before attempting a compaction pass. */
    writesPerRun: number;
  } = { enabled: false, writesPerRun: DEFAULT_WRITES_PER_COMPACTION };

  /**
   * Record where each connected peer has got to.
   *
   * Called from the relay on every acknowledgement. The store keeps the map
   * because compaction needs the minimum across all peers and has no business
   * knowing anything about sockets.
   */
  reportPeerCursor(documentId: string, site: string, seq: number): void {
    let cursors = this.#cursors.get(documentId);

    if (!cursors) {
      cursors = new Map<string, number>();
      this.#cursors.set(documentId, cursors);
    }

    cursors.set(site, seq);
  }

  /** Forget a departing peer, so it stops holding the compaction floor down. */
  forgetPeer(documentId: string, site: string): void {
    this.#cursors.get(documentId)?.delete(site);
  }

  /** Peers currently counted toward the floor. Used by tests and diagnostics. */
  peerCursors(documentId: string): PeerCursor[] {
    const cursors = this.#cursors.get(documentId);

    if (!cursors) {
      return [];
    }

    return [...cursors].map(([site, seq]) => ({ site, seq }));
  }

  /**
   * Compact a document if it is safe and worthwhile to do so.
   *
   * Safe is decided by {@link decideCompaction}; this method performs the two
   * writes, snapshot first.
   *
   * Order matters and is not an implementation detail: the snapshot is committed
   * before any operation is deleted. A crash between the two leaves both, which
   * wastes storage. The reverse order would leave a log with a hole in it, which
   * loses data.
   *
   * @returns what happened, including why it declined.
   */
  async compact(documentId: string): Promise<CompactionResult> {
    if (!this.#compaction.enabled) {
      this.#metrics.increment(M.compactionRuns, { outcome: 'disabled' });
      return { compacted: false, reason: 'compaction-disabled' };
    }

    const sink = this.#db as CompactionSink;

    if (typeof sink.writeSnapshot !== 'function' || typeof sink.pruneOpsThrough !== 'function') {
      return { compacted: false, reason: 'compaction-unsupported' };
    }

    return this.#enqueue(documentId, async () => {
      const replica = await this.#replicaFor(documentId);

      // readAllOps rather than readOpsSince(0): the decision needs every operation
      // still retained, and paging it would be the same work with more code.
      const ops = await this.#readRetained(documentId);

      const snapshotRow = await this.#readSnapshot(documentId);

      // Everything above the snapshot is retained and contiguous, so the newest
      // sequence is the snapshot's plus however many rows remain. Deriving it any
      // other way (row count, for instance) is wrong as soon as a prune has
      // happened, and wrong silently.
      const snapshotSeq = snapshotRow?.seq ?? null;
      const latestSeq = (snapshotSeq ?? 0) + ops.length;

      const decision = decideCompaction(
        {
          doc: replica,
          ops,
          peerCursors: this.peerCursors(documentId).map((peer) => peer.seq),
          snapshotSeq,
          latestSeq,
        },
        this.#compaction.policy,
      );

      if (!decision.compact) {
        // Why it declined is the useful signal: a policy that never fires and one that
        // fires constantly look identical from the outside.
        this.#metrics.increment(M.compactionRuns, { outcome: 'declined' });
        this.#metrics.increment(M.compactionSkipped, { reason: decision.reason });

        return { compacted: false, reason: decision.reason };
      }

      await sink.writeSnapshot?.(documentId, {
        seq: decision.snapshotSeq,
        elements: decision.snapshot.elements,
      });

      const pruned = (await sink.pruneOpsThrough?.(documentId, decision.pruneThrough)) ?? 0;

      this.#metrics.increment(M.compactionRuns, { outcome: 'compacted' });
      this.#metrics.increment(M.compactionPruned, {}, pruned);
      this.#metrics.set(M.logLength, {}, ops.length);

      return {
        compacted: true,
        snapshotSeq: decision.snapshotSeq,
        pruned,
      };
    });
  }

  /**
   * Read every retained operation with the sequence it was stored at.
   *
   * The sequence is recovered, not assumed. `readAllOps` returns operations in
   * order without their sequences, and everything above the snapshot is contiguous
   * from `snapshot + 1`, so it is recoverable. Deriving it from row position alone
   * would be wrong the moment a prune has happened — and wrong silently.
   */
  async #readRetained(
    documentId: string,
  ): Promise<{ readonly seq: number; readonly op: Operation }[]> {
    const ops = await this.#readAll(documentId);
    const base = (await this.#readSnapshot(documentId))?.seq ?? 0;

    return ops.map((op, index) => ({ seq: base + index + 1, op }));
  }

  async #readSnapshot(
    documentId: string,
  ): Promise<{ seq: number; elements: readonly unknown[] } | null> {
    const withRead = this.#db as Partial<Database>;
    return withRead.readSnapshot?.(documentId) ?? Promise.resolve(null);
  }

  /** Documents currently held in memory. Used by tests and the health endpoint. */
  get openDocumentCount(): number {
    return this.#replicas.size;
  }

  /**
   * Apply and persist a batch of untrusted operations.
   *
   * @param raw operations exactly as received off the socket. Validation happens
   *   here rather than at the relay, so a malformed operation is dropped from
   *   persistence as well as from replay. Accepting it in the log and failing to
   *   apply it would make the log permanently unreplayable.
   */
  async apply(documentId: string, raw: readonly JsonValue[]): Promise<StoreResult> {
    return this.#enqueue(documentId, async () => {
      const ops = parseOperations(raw);
      const replica = await this.#replicaFor(documentId);

      const unplaced = replica.applyInAnyOrder(ops);
      const placeable = ops.length - unplaced;

      this.#metrics.increment(M.opsReceived, { type: 'accepted' }, placeable);
      this.#metrics.increment(M.opsRejected, {}, raw.length - ops.length);

      // THE metric for a CRDT server. An operation that cannot be placed is an
      // operation some peer is still waiting for, and if it never arrives the peer stays
      // silently behind. Non-zero here is the signal that something is wrong upstream.
      if (unplaced > 0) {
        this.#metrics.increment(M.opsUnplaced, {}, unplaced);
        this.#logger.warn('operations could not be placed', {
          document: documentId,
          unplaced,
        });
      }

      if (placeable > 0) {
        await this.#db.appendOps(
          documentId,
          ops.slice(0, placeable),
          // Written in the same transaction as the operations themselves, so the
          // text cache can never contradict the log.
          { materializedText: replica.toText() },
        );
      }

      return {
        accepted: placeable,
        rejected: raw.length - ops.length,
        unplaced: ops.slice(placeable),
      };
    });
  }

  /**
   * Store a batch of encrypted frames, without reading them.
   *
   * ---------------------------------------------------------------------------
   * NO REPLICA, NO VALIDATION, NO TEXT
   * ---------------------------------------------------------------------------
   * Every step {@link apply} takes is skipped, and each omission is forced:
   *
   *   - No replica, so no `applyInAnyOrder` and therefore no `unplaced` count. The
   *     server cannot place a frame it cannot read. So it cannot detect divergence, which
   *     means an encrypted document's convergence claim rests entirely on the clients -
   *     which is the honest consequence of withholding the key.
   *   - No `parseOperations`, because there is nothing to parse that this process can
   *     check. `parseEncryptedFrame` already validated the shape at the relay.
   *   - No `materializedText`, because there is no text. `documents.content` stays empty
   *     for the life of the document.
   *
   * `accepted` counts FRAMES STORED, not operations applied. Saying "accepted: 3" for a
   * batch the server never understood would be a lie with a number on it.
   */
  async applyEncrypted(
    documentId: string,
    frames: readonly EncryptedOperationFrame[],
  ): Promise<StoreResult> {
    // Captured in a local because the optional-ness does not survive into the closure
    // below, and the check must happen before the enqueue rather than inside it: an
    // unsatisfiable store should fail before it takes the write lock.
    const sink = this.#db.appendEncryptedOps?.bind(this.#db);

    if (sink === undefined) {
      // Refuse rather than drop. A client told "accepted: 0, rejected: 0" for its edit
      // would believe it was saved.
      throw new Error(
        'This store cannot persist encrypted operations; its sink has no appendEncryptedOps.',
      );
    }

    return this.#enqueue(documentId, async () => {
      await sink(documentId, frames);

      // One-way latch. Set from the first frame, never cleared, matching the column's own
      // one-way semantics. See ADR-0014.
      this.#encrypted.add(documentId);

      this.#metrics.increment(M.opsReceived, { type: 'accepted-encrypted' }, frames.length);

      return { accepted: frames.length, rejected: 0, unplaced: [] };
    });
  }

  /** Whether this document's operations are ciphertext, as far as this store knows. */
  isEncrypted(documentId: string): boolean {
    return this.#encrypted.has(documentId);
  }

  /**
   * Compact if enough has accumulated since the last time.
   *
   * Called after a write, off the critical path: the result of the write is
   * returned without waiting for compaction, so a slow snapshot cannot delay a
   * user's keystroke reaching a collaborator.
   *
   * The counter is per process and resets on restart, so a freshly started server
   * compacts a little later than a warm one. That is acceptable — compaction is
   * opportunistic, and skipping a pass costs storage for a while, never
   * correctness.
   */
  maybeCompact(documentId: string): void {
    if (!this.#compaction.enabled || this.#compactionTimer !== null) {
      return;
    }

    // Declined BEFORE the counter, not after.
    //
    // Compaction needs the live element set, and an encrypted document's operations are
    // ciphertext this process cannot read. Attempting it would either throw or - worse -
    // produce a snapshot of an empty document, and a client that adopts an empty baseline
    // loses everything.
    //
    // Checking before incrementing also means the write counter for an encrypted document
    // stays at zero rather than filling with writes that will never trigger anything,
    // which keeps `pendingCompactionWrites` meaning "writes since the last attempt" for
    // every document rather than only the plaintext ones.
    if (this.#encrypted.has(documentId)) {
      return;
    }

    const counter = this.#pendingWrites.get(documentId) ?? 0;
    this.#pendingWrites.set(documentId, counter + 1);

    if (counter + 1 < this.#compaction.writesPerRun) {
      return;
    }

    this.#pendingWrites.set(documentId, 0);
    this.#compactionTimer = setTimeout(() => {
      this.#compactionTimer = null;

      void this.compact(documentId).catch(() => {
        // Compaction is best effort. Its own failure must never surface as a write
        // failure, and the next trigger will try again.
      });
    }, 0);

    // Do not hold the process open for a maintenance task.
    this.#compactionTimer.unref?.();
  }

  /** Writes accumulated per document since the last compaction attempt. */
  pendingCompactionWrites(documentId: string): number {
    return this.#pendingWrites.get(documentId) ?? 0;
  }

  /** Read every retained operation for a document. */
  async #readAll(documentId: string): Promise<Operation[]> {
    const withRead = this.#db as Partial<Database>;
    return withRead.readAllOps?.(documentId) ?? [];
  }

  /**
   * Read side of the log, handed straight to the relay.
   *
   * Returns a snapshot baseline when the caller's cursor is below the compaction
   * floor, and an ordinary delta otherwise. Choosing wrongly is not cosmetic: a
   * delta to a client below the floor produces a document missing everything that
   * was compacted away, and nothing reports it.
   */
  async readSince(documentId: string, sinceSeq: number, limit?: number): Promise<RelayPage> {
    return this.#log.readSince(documentId, sinceSeq, limit);
  }

  /** Current text, warming the replica if this document has not been seen yet. */
  async text(documentId: string): Promise<string> {
    const replica = await this.#replicaFor(documentId);
    return replica.toText();
  }

  /**
   * Load or create a document's replica.
   *
   * A cold replica is rebuilt from the log, not from `documents.content`. The
   * content cache is a projection; replaying the log is what guarantees the
   * replica agrees with what every client sees. Reading the cache instead would
   * mean two sources of truth, which is the failure mode this whole design exists
   * to remove.
   */
  async #replicaFor(documentId: string): Promise<RgaDocument> {
    const existing = this.#replicas.get(documentId);
    if (existing) {
      return existing;
    }

    const replica = new RgaDocument(`store-${documentId}`);
    let cursor = 0;

    // Page through, because a document can have far more operations than one
    // frame's worth and the store must be fully warm before it accepts writes.
    for (let round = 0; round < 10_000; round += 1) {
      const page = await this.#log.readSince(documentId, cursor, LOAD_BATCH);

      if (page.ops.length > 0) {
        replica.applyInAnyOrder(parseOperations(page.ops));
      }

      if (page.seq <= cursor) {
        break;
      }

      cursor = page.seq;

      if (page.ops.length < LOAD_BATCH) {
        break;
      }
    }

    this.#replicas.set(documentId, replica);
    return replica;
  }

  /** Run work exclusively for one document, in arrival order. */
  #enqueue<T>(documentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(documentId) ?? Promise.resolve();
    const result = previous.then(work, work);

    // The tail must never reject, or one failed write would poison every write
    // queued behind it.
    this.#queues.set(
      documentId,
      result.catch(() => undefined),
    );

    return result;
  }

  /**
   * Forget a document's replica.
   *
   * Called when the last client leaves. Memory only: the log is the truth, so a
   * dropped replica can always be rebuilt, and keeping one per document forever
   * would grow without bound.
   */
  release(documentId: string): void {
    this.#replicas.delete(documentId);
  }

  /** Drop every replica. Used on shutdown and between tests. */
  releaseAll(): void {
    this.#replicas.clear();
  }
}

/** Operations loaded per round trip when warming a replica. */
const LOAD_BATCH = 2_000;

/**
 * Adapt a write-only sink into the read side the relay needs.
 *
 * Returns null for an object without `readOpsSince`, and the caller treats a null
 * log as "no durable history", which the relay reports honestly rather than
 * claiming a catch-up it cannot perform.
 */
function defaultReadSince(db: OperationSink): RelayLog {
  const withRead = db as Partial<Database>;

  // `readForClient` is what decides between a delta and a snapshot baseline. A
  // sink without it can only ever serve deltas, which is correct as long as
  // nothing compacts. Once it does, this must be replaced rather than silently
  // returning partial documents.
  if (typeof withRead.readForClient !== 'function') {
    return {
      readSince: () => Promise.resolve({ snapshot: null, ops: [], seq: 0 }),
    };
  }

  return {
    readSince: (documentId, sinceSeq, limit) => {
      const caught = withRead.readForClient?.(documentId, sinceSeq, limit);

      if (!caught) {
        return Promise.resolve({ snapshot: null, ops: [], seq: sinceSeq });
      }

      return caught.then((page) => {
        if (page.kind === 'ops-enc') {
          // Frames go out untouched, alongside an EMPTY `ops`. Both fields are always
          // present so a consumer reading `ops` gets an empty list rather than
          // `undefined`, and `frames: null` rather than a missing key means "not an
          // encrypted document" as distinct from "an encrypted batch that was empty".
          return {
            snapshot: null,
            ops: [] as readonly JsonValue[],
            frames: page.frames,
            seq: page.seq,
          };
        }

        if (page.kind === 'ops') {
          return { snapshot: null, ops: page.ops, frames: null, seq: page.seq };
        }

        return {
          // The elements go out as JSON, not as a string. RGA anchors an
          // insert to the element its origin names, so a text-only baseline
          // would leave every subsequent operation unplaceable.
          snapshot: page.snapshot.elements as unknown as readonly JsonValue[],
          ops: page.ops,
          frames: null,
          seq: page.seq,
        };
      });
    },
  };
}
