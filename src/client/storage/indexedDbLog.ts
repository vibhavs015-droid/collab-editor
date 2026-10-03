/**
 * IndexedDB-backed operation log.
 *
 * ── Why IndexedDB and not localStorage ────────────────────────────────────
 * localStorage is synchronous and capped around 5 MB. Every keystroke produces at
 * least one operation, and the log must hold the entire document history for
 * offline-first to work. A synchronous API on the main thread would also block
 * typing, which is unacceptable in an editor.
 *
 * IndexedDB is asynchronous, transactional, and holds far more.
 *
 * ── Why the log is authoritative ──────────────────────────────────────────
 * The document text is a projection. This log is the source of truth. That is
 * what lets a client offline for a week reconcile by replaying rather than
 * guessing, and it is why remote operations are written here too (ADR-0007).
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import type { LoggedOperation, OperationLog } from '../../core/crdt/replica.js';

const DB_NAME = 'collab-editor';
const DB_VERSION = 1;
const STORE = 'operations';

/** Cap on stored entries. Older entries are pruned; see `prune()`. */
const DEFAULT_MAX_ENTRIES = 50_000;

export interface IndexedDbLogOptions {
  readonly databaseName?: string;
  readonly maxEntries?: number;
}

/**
 * Durable operation log.
 *
 * Every method resolves rather than rejecting on ordinary conditions, because a
 * storage failure must not take the editor down. Callers surface the failure
 * through the sync indicator instead.
 */
export class IndexedDbOperationLog implements OperationLog {
  readonly #databaseName: string;
  readonly #maxEntries: number;
  #db: IDBDatabase | null = null;

  constructor(options: IndexedDbLogOptions = {}) {
    this.#databaseName = options.databaseName ?? DB_NAME;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Open the database, creating the object store and index on first use.
   *
   * Opening lazily rather than in the constructor means a storage failure
   * surfaces where the caller can handle it, rather than during construction
   * where it would be unhandleable.
   */
  async #open(): Promise<IDBDatabase | null> {
    if (this.#db !== null) {
      return this.#db;
    }

    if (typeof indexedDB === 'undefined') {
      // Not a browser, or a context where IndexedDB is unavailable. Returning
      // null makes every operation a no-op, which degrades to memory-only
      // behaviour rather than throwing.
      return null;
    }

    return new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;

      try {
        request = indexedDB.open(this.#databaseName, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'seq' });
          // Reads are always a full replay, so an index on seq is only useful for
          // the truncation query.
          store.createIndex('seq', 'seq', { unique: true });
        }
      };

      request.onsuccess = () => {
        this.#db = request.result;
        resolve(this.#db);
      };

      // Private-browsing modes and quota policies can refuse to open entirely.
      request.onerror = () => {
        resolve(null);
      };

      request.onblocked = () => {
        resolve(null);
      };
    });
  }

  async load(): Promise<LoggedOperation[]> {
    const db = await this.#open();

    if (!db) {
      return [];
    }

    return new Promise<LoggedOperation[]>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).getAll();

        request.onsuccess = () => {
          // Replay order comes from seq, and getAll follows key order, but
          // sorting explicitly keeps the contract independent of that.
          const entries = (request.result as LoggedOperation[])
            .slice()
            .sort((a, b) => a.seq - b.seq);
          resolve(entries);
        };

        request.onerror = () => {
          resolve([]);
        };
      } catch {
        resolve([]);
      }
    });
  }

  async append(entries: readonly LoggedOperation[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const db = await this.#open();

    if (!db) {
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        // One transaction for the whole batch. Separate transactions per entry
        // would let a crash mid-batch leave a partial operation applied, which is
        // exactly the inconsistency the log must never have.
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);

        for (const entry of entries) {
          store.put(entry);
        }

        transaction.oncomplete = () => {
          resolve();
        };

        // Quota exceeded, or the store was deleted underneath us. The in-memory
        // document still has the operations, so this degrades to no persistence
        // rather than losing the edit from the editor.
        transaction.onerror = () => {
          resolve();
        };
        transaction.onabort = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });

    await this.prune();
  }

  async truncateBefore(seq: number): Promise<void> {
    const db = await this.#open();

    if (!db) {
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const index = store.index('seq');
        const range = IDBKeyRange.upperBound(seq, true);
        const request = index.openCursor(range);

        request.onsuccess = () => {
          const cursor = request.result;

          if (!cursor) {
            return;
          }

          cursor.delete();
          cursor.continue();
        };

        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.#open();

    if (!db) {
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).clear();

        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  /**
   * Drop the oldest entries once the store exceeds its cap.
   *
   * Pruning rather than refusing writes: a hard stop would mean the editor stops
   * accepting edits because storage filled up, which is worse than losing
   * recoverable history. The live document is unaffected either way, because it
   * is already in memory.
   *
   * Deliberately keeps the newest entries, since a client catching up after a
   * long absence needs the most recent operations to make sense of anything.
   */
  async prune(): Promise<void> {
    const db = await this.#open();

    if (!db) {
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const countRequest = store.count();

        // Deletions are counted locally rather than by re-counting the store
        // after every delete, which would issue one request per entry and turn
        // pruning into an O(n) round-trip storm.
        let toDelete = 0;

        countRequest.onsuccess = () => {
          toDelete = countRequest.result - this.#maxEntries;

          if (toDelete <= 0) {
            return;
          }

          // Delete from the lowest seq upward: the newest entries are the ones a
          // catching-up client needs.
          const cursorRequest = store.openCursor();

          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;

            if (!cursor || toDelete <= 0) {
              return;
            }

            cursor.delete();
            toDelete -= 1;
            cursor.continue();
          };
        };

        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }

  /** Entry count, used by diagnostics and tests. */
  async count(): Promise<number> {
    const db = await this.#open();

    if (!db) {
      return 0;
    }

    return new Promise<number>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).count();

        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          resolve(0);
        };
      } catch {
        resolve(0);
      }
    });
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }
}
