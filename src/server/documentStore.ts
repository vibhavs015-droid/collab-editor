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
import type { JsonValue } from '../shared/protocol.js';
import type { Database } from './db.js';
import type { RelayLog, RelayPage } from './relay.js';

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
}

export interface DocumentStoreOptions {
  readonly db: Database | OperationSink;
  /** Read-side callback. Defaults to the database. */
  readonly log?: RelayLog;
}

/** Outcome of applying one inbound batch. */
export interface StoreResult {
  readonly accepted: number;
  readonly rejected: number;
  /** Operations the replica could not place, so they were not persisted. */
  readonly unplaced: readonly Operation[];
}

export class DocumentStore {
  readonly #db: OperationSink;
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

  constructor(options: DocumentStoreOptions) {
    this.#db = options.db;
    this.#log = options.log ?? defaultReadSince(options.db);
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

  /** Read side of the log, handed straight to the relay. */
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

  if (typeof withRead.readOpsSince !== 'function') {
    return {
      readSince: () => Promise.resolve({ ops: [], seq: 0 }),
    };
  }

  return {
    readSince: (documentId, sinceSeq, limit) =>
      withRead.readOpsSince?.(documentId, sinceSeq, limit) ??
      Promise.resolve({ ops: [], seq: sinceSeq }),
  };
}
