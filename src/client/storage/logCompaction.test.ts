/**
 * Client-side log compaction, proven against the real CRDT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The client log hard-capped at 50,000 entries by deleting the oldest, and it did so
 * from inside `append`, so every write could trigger it. That is wrong, and not in a
 * subtle way.
 *
 * An RGA insert names the element it anchors to. Deleting a prefix of the log
 * therefore deletes the elements the surviving operations still refer to.
 * `Replica.init()` refuses to guess and throws, so the document will not open.
 *
 * The test that used to cover this asserted seq contiguity. Contiguity is TRUE after a
 * prefix delete and says nothing about whether the anchors still exist - it is
 * contiguity of the counter, not integrity of the history. `shows seq stays contiguous
 * even though the anchors are gone` below exists to make that false negative explicit,
 * so nobody re-adds a contiguity assertion and calls it coverage.
 *
 * These tests drive the real `Replica`, the real `IndexedDbOperationLog` and the real
 * snapshot code. Writing a second hand-rolled RGA to check the first would be a
 * second, separately wrong implementation of the thing under test.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import { Replica, type LoggedOperation } from '../../core/crdt/replica.js';
import { snapshotText, snapshotVisibleText } from '../../core/crdt/snapshot.js';
import { IndexedDbOperationLog } from './indexedDbLog.js';

let factoryCounter = 0;

beforeEach(() => {
  // A fresh factory per test: a shared one lets state leak between tests and produces
  // order-dependent failures that look like real bugs.
  globalThis.indexedDB = new IDBFactory();
  factoryCounter += 1;
});

function makeLog(options: { maxEntries?: number } = {}): IndexedDbOperationLog {
  return new IndexedDbOperationLog({
    databaseName: `compact-db-${factoryCounter}`,
    ...options,
  });
}

/**
 * A replica over `log`, exactly as `main.ts` builds one.
 *
 * `onOperations` is empty because `Replica.#record` writes to the log itself and
 * `#onOperations` is for broadcast only. An earlier version of this harness appended
 * there as well, with `seq: index` restarting at zero per batch, which overwrote the
 * front of the log on every edit and produced failures that looked like compaction bugs.
 */
function makeReplica(log: IndexedDbOperationLog): Replica {
  return new Replica({ site: 'client', log, onOperations: () => undefined });
}

/**
 * Wait for pending log writes.
 *
 * `#record` appends without awaiting, so an edit is applied in memory before it is
 * durable. IndexedDB orders overlapping transactions, so a read on the same store is a
 * real barrier - and a barrier is required here rather than a `sleep`, which would be
 * both slower and less reliable.
 */
async function settled(log: IndexedDbOperationLog): Promise<void> {
  await log.count();
}

describe('the bug: prune() destroys anchors', () => {
  it('leaves a log Replica.init() can no longer replay', async () => {
    const log = makeLog({ maxEntries: 4 });
    const writer = makeReplica(log);

    await writer.init();

    // Each character anchors to the one before it, which is what typing does.
    for (const letter of 'abcdefghij') {
      writer.insertAt(writer.text.length, letter);
    }

    await settled(log);

    const truth = writer.text;

    expect(truth).toBe('abcdefghij');

    await log.prune();

    const reader = makeReplica(log);
    let threw = false;
    let rebuilt = '';

    try {
      await reader.init();
      rebuilt = reader.text;
    } catch {
      threw = true;
    }

    // Either it throws, or it silently produces the wrong text. Both are the bug, and
    // asserting on which turns a claim about behaviour into a specification.
    expect(threw || rebuilt !== truth, `rebuilt "${rebuilt}", wanted "${truth}"`).toBe(true);
  });

  it('keeps seq contiguous through it, which is why the old test passed', async () => {
    const log = makeLog({ maxEntries: 3 });
    const writer = makeReplica(log);

    await writer.init();
    writer.insertAt(0, 'x');
    await settled(log);

    await log.prune();
    const seqs = (await log.load()).map((entry) => entry.seq);

    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBe((seqs[index - 1] ?? 0) + 1);
    }
  });
});

describe('Replica.snapshot', () => {
  it('captures the visible text and the applied sequence', async () => {
    const log = makeLog();
    const replica = makeReplica(log);

    await replica.init();
    replica.insertAt(0, 'hello world');
    replica.deleteRange(5, 6);

    expect(replica.text).toBe('hello');

    const snapshot = replica.snapshot();

    expect(snapshotText(snapshot)).toBe('hello');
    expect(snapshot.seq).toBe(replica.appliedSeq);
  });

  it('refuses before init, rather than snapshotting nothing', () => {
    const log = makeLog();
    const replica = makeReplica(log);

    // A snapshot of an uninitialised document is a snapshot of the empty string, and
    // writing that would replace real history with nothing.
    expect(() => replica.snapshot()).toThrow();
  });

  it('carries a tombstone an unsent delete still needs', async () => {
    const log = makeLog();
    const replica = makeReplica(log);

    await replica.init();
    replica.insertAt(0, 'abcd');
    replica.deleteRange(1, 1);

    expect(replica.text).toBe('acd');

    // Clocks start at 1, so the second character is clock 2. Without `unsent` the
    // tombstone is dropped, because nothing pending references it.
    const target = { site: 'client', clock: 2 } as const;

    expect(replica.snapshot().elements.some((element) => element.deleted === true)).toBe(false);

    const retained = replica.snapshot([{ type: 'delete', target }]);
    const carried = retained.elements.filter((element) => element.deleted === true);

    expect(carried).toHaveLength(1);

    // `snapshotText` is the footgun this caught: it concatenates tombstones too, so it
    // answers "abcd" here. That is what the elements concatenate to, and it is exactly
    // the sort of difference that is invisible until a test compares against the wrong
    // string. `snapshotVisibleText` is the one that means what it says.
    expect(snapshotText(retained)).toBe('abcd');
    expect(snapshotVisibleText(retained)).toBe('acd');
  });
});

describe('Replica.compactLog', () => {
  it('survives a reload after compacting', async () => {
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();
    writer.insertAt(0, 'the quick brown fox');
    await settled(log);

    const truth = writer.text;

    expect(truth).toBe('the quick brown fox');

    const result = await writer.compactLog({ keepAtLeast: 2 });

    expect(result.committed).toBe(true);

    // A fresh replica over the same log: exactly what a page reload does.
    const reader = makeReplica(log);
    await reader.init();

    expect(reader.text).toBe(truth);
  });

  it('survives a delete surviving compaction', async () => {
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();

    for (const letter of 'the quick brown fox') {
      writer.insertAt(writer.text.length, letter);
    }

    // One character, deliberately. `deleteRange` emits ONE delete operation per
    // character, so deleting six of them puts six targets in the tail and every one
    // would have to be declared unsent. Deleting a single character keeps the test
    // about compaction rather than about counting delete operations.
    writer.deleteRange(10, 1);
    await settled(log);

    const truth = writer.text;

    expect(truth).toBe('the quick rown fox');

    // The delete is passed as unsent, because it is not acknowledged by any server. Its
    // target is a tombstone, and a snapshot that dropped it would make the delete
    // permanently unapplicable -- a silently undelivered edit.
    const result = await writer.compactLog({
      keepAtLeast: 2,
      unsent: [{ type: 'delete', target: { site: 'client', clock: 11 } }],
    });

    expect(result.committed).toBe(true);

    const reader = makeReplica(log);
    await reader.init();

    expect(reader.text).toBe(truth);
  });

  it('declines rather than dropping a tombstone the tail still needs', async () => {
    // The coverage check earning its keep. The tail contains a delete of clock 11, and
    // with nothing declared unsent the snapshot drops that tombstone -- so the delete
    // could never be applied again. Refusing is the only safe answer.
    //
    // It is also self-clearing: once enough later operations push the delete below the
    // floor, the tail no longer contains it and compaction proceeds.
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();

    for (const letter of 'the quick brown fox') {
      writer.insertAt(writer.text.length, letter);
    }

    writer.deleteRange(10, 1);
    await settled(log);

    const result = await writer.compactLog({ keepAtLeast: 2 });

    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/absent from the snapshot/u);

    const reader = makeReplica(log);
    await reader.init();

    expect(reader.text).toBe('the quick rown fox');
  });

  it('survives repeated compaction', async () => {
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();

    for (let round = 0; round < 5; round += 1) {
      writer.insertAt(writer.text.length, String(round));
      await settled(log);
      await writer.compactLog({ keepAtLeast: 2 });
    }

    const truth = writer.text;

    const reader = makeReplica(log);
    await reader.init();

    expect(reader.text).toBe(truth);
  });

  it('keeps every element id a later insert needs', async () => {
    // The property that makes compaction invisible: an insert after an element whose
    // history was dropped must still find its anchor. Re-minting ids would make that
    // permanently impossible, with no error anywhere.
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();
    writer.insertAt(0, 'abcdefghij');
    writer.deleteRange(1, 1);
    await settled(log);

    expect(writer.text).toBe('acdefghij');

    await writer.compactLog({
      keepAtLeast: 2,
      unsent: [{ type: 'delete', target: { site: 'client', clock: 2 } }],
    });

    const reader = makeReplica(log);
    await reader.init();

    expect(
      reader
        .visibleElements()
        .map((element) => element.value)
        .join(''),
    ).toBe('acdefghij');

    // Anchors to the 'a' at clock 1, whose creating operation compaction just dropped.
    reader.insertAt(1, 'X');

    expect(reader.text).toBe('aXcdefghij');
  });

  it('preserves an unsent delete across compaction', async () => {
    // The silent-divergence case. If the snapshot drops the tombstone's target, the
    // delete can never be sent and never applied, and nothing reports it.
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();

    for (const letter of 'abcdef') {
      writer.insertAt(writer.text.length, letter);
    }

    await settled(log);

    const result = await writer.compactLog({
      keepAtLeast: 2,
      unsent: [{ type: 'delete', target: { site: 'client', clock: 2 } }],
    });

    expect(result.committed).toBe(true);

    // The tombstone survived, so the unsent delete is still applicable.
    const reader = makeReplica(log);
    await reader.init();

    expect(reader.text).toBe('abcdef');

    reader.applyRemote([{ type: 'delete', target: { site: 'client', clock: 2 } }]);

    expect(reader.text).toBe('acdef');
  });

  it('declines when there is nothing to gain', async () => {
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();
    writer.insertAt(0, 'short');
    await settled(log);

    const before = await log.count();
    const result = await writer.compactLog({ keepAtLeast: 200 });

    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/tail/u);
    expect(await log.count()).toBe(before);
  });

  it('declines when the log cannot be compacted at all', async () => {
    // A log without `replaceWithSnapshot` can only be truncated, which destroys anchors.
    // Reporting that is the honest answer; silently falling back to `truncateBefore`
    // would reintroduce the original bug through a new route.
    const entries: LoggedOperation[] = [];

    const log = {
      load: (): Promise<LoggedOperation[]> => Promise.resolve(entries),
      append: (added: readonly LoggedOperation[]): Promise<void> => {
        for (const entry of added) {
          entries.push(entry);
        }

        return Promise.resolve();
      },
      truncateBefore: (): Promise<void> => Promise.resolve(),
      clear: (): Promise<void> => Promise.resolve(),
    };

    const writer = new Replica({ site: 'client', log, onOperations: () => undefined });
    await writer.init();

    for (const letter of 'abcdef') {
      writer.insertAt(writer.text.length, letter);
    }

    const result = await writer.compactLog({ keepAtLeast: 1 });

    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/cannot be compacted/u);
  });

  it('reclaims a large log whose history dwarfs its text', async () => {
    // The case compaction exists for. 500 characters typed, 400 of them deleted, then two
    // more typed so the retained tail holds inserts rather than deletes whose targets the
    // snapshot would have to carry.
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();

    for (let index = 0; index < 500; index += 1) {
      writer.insertAt(writer.text.length, String(index % 10));
    }

    writer.deleteRange(50, 400);
    writer.insertAt(writer.text.length, 'x');
    writer.insertAt(writer.text.length, 'y');
    await settled(log);

    const before = await log.count();
    const truth = writer.text;

    expect(before).toBe(902);
    expect(truth).toHaveLength(102);

    const result = await writer.compactLog({ keepAtLeast: 2 });

    expect(result.committed).toBe(true);
    expect(result.operationsBefore).toBe(before);
    expect(result.operationsAfter).toBeLessThan(before / 2);

    const reader = makeReplica(log);
    await reader.init();

    expect(reader.text).toBe(truth);
  });

  it('can grow a small log, because a carried tombstone costs two entries', async () => {
    // The counter-case, stated rather than hidden. A snapshot element becomes one insert;
    // a carried tombstone becomes an insert AND a delete. So compacting a document whose
    // history is barely longer than its text can produce a LONGER log.
    //
    // Worth knowing because it looks like compaction is broken, and the fix is not to
    // disable it - it is to compact on a threshold where there is real history to drop.
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();

    for (const letter of 'abcdefghij') {
      writer.insertAt(writer.text.length, letter);
    }

    writer.deleteRange(2, 5);
    await settled(log);

    const before = await log.count();

    expect(before).toBe(15);

    const result = await writer.compactLog({
      keepAtLeast: 2,
      // Clocks 3..7 were deleted, and `deleteRange` emitted a delete for each. All five
      // have to be declared: a snapshot dropping any one of their targets makes that
      // delete unapplicable forever.
      unsent: [3, 4, 5, 6, 7].map((clock) => ({
        type: 'delete' as const,
        target: { site: 'client', clock },
      })),
    });

    expect(result.committed).toBe(true);
    expect(result.operationsAfter).toBeGreaterThan(before);

    // Still correct, which is the point: bigger is not the same as broken.
    const reader = makeReplica(log);
    await reader.init();

    expect(reader.text).toBe('abhij');
  });

  it('leaves the log unchanged when it declines', async () => {
    const log = makeLog();
    const writer = makeReplica(log);

    await writer.init();

    for (const letter of 'abcdefghij') {
      writer.insertAt(writer.text.length, letter);
    }

    writer.deleteRange(2, 3);
    await settled(log);

    const before = (await log.load()).map((entry) => entry.op);
    await writer.compactLog({ keepAtLeast: 999 });
    const after = (await log.load()).map((entry) => entry.op);

    expect(after).toEqual(before);
  });
});
