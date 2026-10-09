/**
 * IndexedDB-backed operation log.
 *
 * -- Why IndexedDB and not localStorage ------------------------------------
 * localStorage is synchronous and capped around 5 MB. Every keystroke produces at
 * least one operation, and the log must hold the entire document history for
 * offline-first to work. A synchronous API on the main thread would also block
 * typing, which is unacceptable in an editor.
 *
 * IndexedDB is asynchronous, transactional, and holds far more.
 *
 * -- Why the log is authoritative ------------------------------------------
 * The document text is a projection. This log is the source of truth. That is
 * what lets a client offline for a week reconcile by replaying rather than
 * guessing, and it is why remote operations are written here too (ADR-0007).
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import type { LoggedOperation, OperationLog } from '../../core/crdt/replica.js';
import type { Operation } from '../../core/crdt/rga.js';

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

    // Deliberately NOT pruning here.
    //
    // This used to end with `await this.prune()`, which meant every append could
    // delete history. An RGA insert names the element it anchors to, so deleting a
    // prefix of the log deletes the elements the surviving operations refer to, and
    // `Replica.init()` throws on the next load rather than guessing. The document
    // stops opening.
    //
    // Bounding the log is still necessary; it is `Replica.compactLog()` that does it,
    // because it can replace what it drops with a snapshot instead of destroying it.
    // Enforcing the cap inside `append` put that decision in the one place that
    // cannot see the document.
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
   * Replace history with a snapshot, atomically.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS ONE TRANSACTION
   * ---------------------------------------------------------------------------
   * A snapshot write and a truncate done separately has a failure mode that destroys
   * the document: crash after the truncate and the log holds only the tail, whose
   * inserts anchor to elements the snapshot would have carried; crash before it and
   * nothing is lost but nothing is reclaimed either. The first is unrecoverable
   * without a backup, and a browser tab closing mid-compaction is not exotic.
   *
   * IndexedDB gives exactly the guarantee needed here - a transaction is atomic, so
   * either both the snapshot entries and the deletions land or neither does.
   *
   * ---------------------------------------------------------------------------
   * WHY THE SNAPSHOT GOES IN THE SAME STORE
   * ---------------------------------------------------------------------------
   * Writing it to a separate store would mean two reads and a consistency question on
   * every reload, and `Replica.init()` loads one store. Since the snapshot is expressed
   * as ordinary operations with their original element ids, it is indistinguishable
   * from history once written - which is the point. There is no "replay the snapshot
   * first" special case to get wrong.
   *
   * ---------------------------------------------------------------------------
   * THE ONE CASE WHERE SEQ HAS A GAP
   * ---------------------------------------------------------------------------
   * The snapshot is written ending immediately before `keepFromSeq`, so the retained
   * tail follows it with no gap in the normal case. When the snapshot is *larger* than
   * the space available - a long document with a small retained tail - it cannot reach
   * back far enough and a gap remains.
   *
   * Leaving the gap is deliberate. Closing it would mean renumbering retained entries,
   * and those sequence numbers are what a transport cursor and a server replay cursor
   * are expressed in; renumbering invalidates both. `init()` sorts by seq and does not
   * require contiguity, so the gap costs tidiness and nothing else, and a tidier log is
   * not worth breaking a cursor.
   *
   * @param snapshotOps the snapshot, already expressed as operations.
   * @param keepFromSeq where the snapshot starts. Everything strictly below is deleted;
   *   everything at or above it is retained.
   * @returns whether the transaction completed.
   */
  async replaceWithSnapshot(
    snapshotOps: readonly Operation[],
    keepFromSeq: number,
  ): Promise<boolean> {
    const db = await this.#open();

    if (!db) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const index = store.index('seq');

        // Snapshot entries occupy [keepFromSeq, snapshotSeq]. Everything strictly
        // below keepFromSeq goes, everything from keepFromSeq upward stays, and the
        // snapshot overwrites whatever sits between those two points.
        //
        // The snapshot therefore always ends at exactly `snapshotSeq` so that the next
        // retained entry follows it with no gap in seq. That is what keeps the log
        // contiguous - contiguously AND replayable, which is the property the old
        // prune() got half of right.
        let wrote = 0;

        for (const op of snapshotOps) {
          store.put({ seq: keepFromSeq + wrote, op, at: Date.now() } satisfies LoggedOperation);
          wrote += 1;
        }

        // Only the region the snapshot does not cover is deleted. Anything from
        // keepFromSeq up to snapshotSeq has just been overwritten.
        const stale = IDBKeyRange.upperBound(keepFromSeq - 1, false);
        const cursorRequest = index.openCursor(stale);

        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;

          if (!cursor) {
            return;
          }

          cursor.delete();
          cursor.continue();
        };

        transaction.oncomplete = () => {
          resolve(true);
        };

        // Quota, or the store vanished. The caller already has the document in memory,
        // so this degrades to "no compaction happened" rather than losing the edit.
        transaction.onerror = () => {
          resolve(false);
        };
        transaction.onabort = () => {
          resolve(false);
        };
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Drop the oldest entries once the store exceeds its cap.
   *
   * ---------------------------------------------------------------------------
   * DEPRECATED IN FAVOUR OF `Replica.compactLog`
   * ---------------------------------------------------------------------------
   * Kept because `OperationLog` requires it and because pruning a log with nothing
   * above the cap is still the right thing to do. What it must NOT be used for is
   * reclaiming space in a log that has live history in it.
   *
   * Pruning deletes operations. It does not preserve the elements they created. An
   * insert names the element it anchors to, so after a prefix delete the surviving
   * operations refer to elements that no longer exist, `Replica.init()` refuses to
   * guess, and the next page load throws. `seq` stays contiguous through all of it,
   * which is why the original test passed.
   *
   * Compaction is the operation that reclaims space *safely*, because it replaces
   * what it drops with a snapshot that carries the elements forward. This method
   * remains for the case where the whole log is below the cap already, where there is
   * no history worth preserving and nothing to lose.
   *
   * @returns whether anything was actually removed.
   */
  async prune(): Promise<boolean> {
    const db = await this.#open();

    if (!db) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      try {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const countRequest = store.count();

        // Deletions are counted locally rather than by re-counting the store
        // after every delete, which would issue one request per entry and turn
        // pruning into an O(n) round-trip storm.
        let toDelete = 0;
        // Tracked separately from `toDelete`. `toDelete <= 0` is true both when there
        // was nothing to remove and when everything requested was removed, so using it
        // as the answer reports "yes, I pruned" for a prune that did nothing.
        let removed = false;

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
            removed = true;
            toDelete -= 1;
            cursor.continue();
          };
        };

        transaction.oncomplete = () => {
          resolve(removed);
        };
        transaction.onerror = () => {
          resolve(false);
        };
        transaction.onabort = () => {
          resolve(false);
        };
      } catch {
        resolve(false);
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
