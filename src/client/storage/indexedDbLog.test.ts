/**
 * IndexedDB operation log tests.
 *
 * fake-indexeddb stands in for the browser. It is a real implementation of the
 * spec running in Node, so transaction semantics, key ordering and cursor
 * behaviour are exercised for real rather than mocked away. A mock that returned
 * whatever the test wanted would prove nothing about the adapter that ships.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Operation } from '../../core/crdt/rga.js';
import type { LoggedOperation } from '../../core/crdt/replica.js';
import { IndexedDbOperationLog } from './indexedDbLog.js';

function op(value: string): Operation {
  return { type: 'insert', id: { site: 'seed', clock: 0 }, origin: null, value };
}

function entry(seq: number, value = `v${seq}`): LoggedOperation {
  return { seq, op: op(value), at: 1_700_000_000_000 + seq };
}

let factoryCounter = 0;

beforeEach(() => {
  // A fresh factory per test. Sharing one would let state leak between tests and
  // produce order-dependent failures that look like real bugs.
  globalThis.indexedDB = new IDBFactory();
  factoryCounter += 1;
});

afterEach(() => {
  // Drop the backing store so a leaked connection in one test cannot hold a lock
  // and make the next test fail for the wrong reason.
  globalThis.indexedDB = new IDBFactory();
});

function makeLog(options: { maxEntries?: number } = {}): IndexedDbOperationLog {
  return new IndexedDbOperationLog({
    databaseName: `test-db-${factoryCounter}`,
    ...options,
  });
}

describe('IndexedDbOperationLog - basics', () => {
  it('starts empty', async () => {
    const log = makeLog();

    expect(await log.load()).toEqual([]);
    expect(await log.count()).toBe(0);
  });

  it('round-trips entries', async () => {
    const log = makeLog();
    await log.append([entry(0, 'a'), entry(1, 'b')]);

    const loaded = await log.load();

    expect(loaded).toHaveLength(2);
    expect(loaded.map((e) => (e.op.type === 'insert' ? e.op.value : ''))).toEqual(['a', 'b']);
  });

  it('returns entries in sequence order regardless of append order', async () => {
    const log = makeLog();

    // Deliberately out of order: replay order is defined by seq, not arrival.
    await log.append([entry(2, 'c')]);
    await log.append([entry(0, 'a')]);
    await log.append([entry(1, 'b')]);

    const loaded = await log.load();
    expect(loaded.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('preserves the wall-clock field', async () => {
    const log = makeLog();
    await log.append([entry(0)]);

    const [loaded] = await log.load();
    expect(loaded?.at).toBe(1_700_000_000_000);
  });

  it('overwrites rather than duplicating an existing sequence', async () => {
    const log = makeLog();
    await log.append([entry(0, 'first')]);
    await log.append([entry(0, 'second')]);

    const loaded = await log.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.op.type === 'insert' ? loaded[0].op.value : '').toBe('second');
  });

  it('ignores an empty append', async () => {
    const log = makeLog();
    await log.append([]);

    expect(await log.load()).toEqual([]);
  });

  it('appends many entries in one batch', async () => {
    const log = makeLog();
    const batch = Array.from({ length: 200 }, (_, index) => entry(index));

    await log.append(batch);

    expect(await log.count()).toBe(200);
  });

  it('survives being reopened, which is the reload path', async () => {
    const first = makeLog();
    await first.append([entry(0, 'persisted')]);
    first.close();

    // Same database name: this is what a page reload does.
    const second = new IndexedDbOperationLog({ databaseName: `test-db-${factoryCounter}` });
    const loaded = await second.load();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.op.type === 'insert' ? loaded[0].op.value : '').toBe('persisted');
  });
});

describe('IndexedDbOperationLog - truncation', () => {
  it('truncates entries below a sequence number', async () => {
    const log = makeLog();
    await log.append([entry(0), entry(1), entry(2), entry(3)]);

    await log.truncateBefore(2);

    const loaded = await log.load();
    expect(loaded.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('keeps everything when truncating at or below zero', async () => {
    const log = makeLog();
    await log.append([entry(0), entry(1)]);

    await log.truncateBefore(-1);

    expect(await log.count()).toBe(2);
  });

  it('clears the store', async () => {
    const log = makeLog();
    await log.append([entry(0), entry(1)]);

    await log.clear();

    expect(await log.count()).toBe(0);
  });
});

describe('IndexedDbOperationLog - pruning', () => {
  it('never prunes as a side effect of append', async () => {
    // The bug. `append` used to end with `await this.prune()`, so every write could
    // delete history - and deleting a prefix deletes the elements the surviving
    // operations anchor to. The bound on the log belongs to `Replica.compactLog`,
    // which can replace what it drops with a snapshot.
    //
    // See logCompaction.test.ts for what a pruned log does to `Replica.init()`.
    const log = makeLog({ maxEntries: 10 });
    await log.append(Array.from({ length: 25 }, (_, index) => entry(index)));

    expect(await log.count()).toBe(25);
  });

  it('keeps the newest entries and drops the oldest when asked', async () => {
    const log = makeLog({ maxEntries: 10 });
    await log.append(Array.from({ length: 25 }, (_, index) => entry(index)));

    expect(await log.prune()).toBe(true);

    const loaded = await log.load();

    // A client catching up after a long absence needs the recent operations, not
    // the first keystrokes of the document's life.
    expect(loaded).toHaveLength(10);
    expect(loaded[0]?.seq).toBe(15);
    expect(loaded.at(-1)?.seq).toBe(24);
  });

  it('does not prune below the cap', async () => {
    const log = makeLog({ maxEntries: 10 });
    await log.append(Array.from({ length: 5 }, (_, index) => entry(index)));

    // Nothing to remove, and reported as such rather than as a failure.
    expect(await log.prune()).toBe(false);
    expect(await log.count()).toBe(5);
  });

  it('keeps seq contiguous when pruning, which is necessary but not sufficient', async () => {
    // Contiguity is what a prefix delete preserves, and it is NOT evidence the log is
    // still replayable: the surviving operations can reference elements that were
    // deleted. This test is kept because contiguity is genuinely necessary, with the
    // comment saying plainly that it is not the property that matters. The property that
    // matters is in logCompaction.test.ts.
    const log = makeLog({ maxEntries: 6 });
    await log.append(Array.from({ length: 20 }, (_, index) => entry(index)));
    await log.prune();

    const seqs = (await log.load()).map((e) => e.seq);

    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBe((seqs[index - 1] ?? 0) + 1);
    }
  });

  it('prunes across multiple appends', async () => {
    const log = makeLog({ maxEntries: 4 });

    for (let batch = 0; batch < 4; batch += 1) {
      await log.append([entry(batch * 2), entry(batch * 2 + 1)]);
      await log.prune();
    }

    const loaded = await log.load();
    expect(loaded).toHaveLength(4);
    expect(loaded.at(-1)?.seq).toBe(7);
  });
});

describe('IndexedDbOperationLog - degraded environments', () => {
  it('degrades to memory-only when indexedDB is unavailable', async () => {
    const original: IDBFactory = globalThis.indexedDB;
    // A context where storage is blocked entirely, e.g. a hardened browser
    // profile. The editor must keep working; only durability is lost.
    Reflect.deleteProperty(globalThis, 'indexedDB');

    try {
      const log = makeLog();

      await log.append([entry(0)]);
      expect(await log.load()).toEqual([]);
      expect(await log.count()).toBe(0);

      await expect(log.truncateBefore(0)).resolves.toBeUndefined();
      await expect(log.clear()).resolves.toBeUndefined();
      // Reports false rather than resolving void: a caller can tell "nothing to"
      // from "removed some" without counting entries.
      await expect(log.prune()).resolves.toBe(false);

      // close() is synchronous by design: it is called on unload, where a
      // promise nobody awaits would be pointless.
      expect(log.close()).toBeUndefined();
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it('degrades rather than throwing when open fails', async () => {
    const log = makeLog();

    // Simulate a browser that refuses the request, e.g. a private-browsing quota
    // policy. Every operation must resolve.
    globalThis.indexedDB = {
      open() {
        throw new Error('refused');
      },
    } as unknown as IDBFactory;

    await expect(log.append([entry(0)])).resolves.toBeUndefined();
    expect(await log.load()).toEqual([]);
  });

  it('resolves empty when the open request errors asynchronously', async () => {
    const log = makeLog();

    globalThis.indexedDB = {
      open() {
        const request: Record<string, unknown> = {};
        // Fire the error on the next tick, like a real failed request.
        setTimeout(() => {
          const handler = request.onerror as (() => void) | undefined;
          handler?.();
        }, 0);
        return request;
      },
    } as unknown as IDBFactory;

    expect(await log.load()).toEqual([]);
    await expect(log.append([entry(0)])).resolves.toBeUndefined();
  });

  it('resolves empty when every transaction throws', async () => {
    const log = makeLog();

    // A database that opens but refuses every transaction. This is the shape of a
    // real failure: the handle exists, the store is unreachable.
    const unreachableDb = {
      // The store already exists, so onupgradeneeded must not try to create it.
      objectStoreNames: { contains: () => true },
      transaction() {
        throw new DOMException('store unreachable', 'InvalidStateError');
      },
      close() {
        return undefined;
      },
    } as unknown as IDBDatabase;

    globalThis.indexedDB = {
      open() {
        const request: Record<string, unknown> = {};

        setTimeout(() => {
          request.result = unreachableDb;
          (request.onsuccess as (() => void) | undefined)?.();
        }, 0);

        return request;
      },
    } as unknown as IDBFactory;

    // Operations must resolve rather than reject, so the editor is not taken
    // down by a storage failure it can do nothing about.
    expect(await log.load()).toEqual([]);
    await expect(log.append([entry(1)])).resolves.toBeUndefined();
    await expect(log.truncateBefore(0)).resolves.toBeUndefined();
    await expect(log.clear()).resolves.toBeUndefined();
    // Reports false rather than resolving void: a caller can tell "nothing to"
    // from "removed some" without counting entries.
    await expect(log.prune()).resolves.toBe(false);
    await expect(log.count()).resolves.toBe(0);
  });
});
