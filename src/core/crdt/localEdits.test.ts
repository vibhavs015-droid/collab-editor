/**
 * Local-edit translation tests.
 *
 * The offset arithmetic here is invisible when it is right and catastrophic when
 * it is wrong, so these tests are about positions, not about "does it not crash".
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { applyLocalEdits, type LocalEdit } from './localEdits.js';
import { RgaDocument, type Operation } from './rga.js';
import { Replica, type LoggedOperation, type OperationLog } from './replica.js';

class NullLog implements OperationLog {
  entries: LoggedOperation[] = [];

  load(): Promise<LoggedOperation[]> {
    return Promise.resolve([]);
  }

  append(entries: readonly LoggedOperation[]): Promise<void> {
    for (const entry of entries) {
      this.entries.push(entry);
    }
    return Promise.resolve();
  }

  truncateBefore(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }
}

async function replicaWith(site: string, text: string): Promise<Replica> {
  const replica = new Replica({ site, log: new NullLog(), onOperations: () => undefined });
  await replica.init();

  if (text !== '') {
    replica.applyRemote(new RgaDocument(`${site}-seed`).insertAt(0, text));
  }

  return replica;
}

function edit(from: number, to: number, inserted: string): LocalEdit {
  return { from, to, inserted };
}

describe('applyLocalEdits - single edits', () => {
  it('inserts', async () => {
    const replica = await replicaWith('a', 'ac');

    applyLocalEdits([edit(1, 1, 'b')], replica);

    expect(replica.text).toBe('abc');
  });

  it('deletes', async () => {
    const replica = await replicaWith('a', 'abc');

    applyLocalEdits([edit(1, 2, '')], replica);

    expect(replica.text).toBe('ac');
  });

  it('replaces as a delete then an insert', async () => {
    const replica = await replicaWith('a', 'abc');

    const ops = applyLocalEdits([edit(1, 2, 'XY')], replica);

    expect(replica.text).toBe('aXYc');

    // The compensation is explicit in the operation stream: one delete, then two
    // inserts. A single "replace" operation would be a second description of the
    // same thing, with its own edge cases.
    expect(ops.map((op: Operation) => op.type)).toEqual(['delete', 'insert', 'insert']);
  });

  it('inserts a multi-character run', async () => {
    const replica = await replicaWith('a', 'ad');

    applyLocalEdits([edit(1, 1, 'bc')], replica);

    expect(replica.text).toBe('abcd');
  });

  it('does nothing for a no-op edit', async () => {
    const replica = await replicaWith('a', 'a');

    expect(applyLocalEdits([edit(1, 1, '')], replica)).toEqual([]);
    expect(replica.text).toBe('a');
  });
});

describe('applyLocalEdits - multiple edits in one batch', () => {
  it('handles two cursors typing at the same time', async () => {
    const replica = await replicaWith('a', 'ad');

    // Both offsets are in the pre-batch document. The second must be shifted by
    // what the first inserted, which is exactly what the running offset is for.
    applyLocalEdits([edit(1, 1, 'b'), edit(1, 1, 'c')], replica);

    expect(replica.text).toBe('abcd');
  });

  it('handles two cursors typing far apart', async () => {
    const replica = await replicaWith('a', 'ad');

    applyLocalEdits([edit(1, 1, 'b'), edit(1, 1, 'c')], replica);

    expect(replica.text).toBe('abcd');
  });

  it('handles one cursor deleting while another inserts', async () => {
    const replica = await replicaWith('a', 'abcd');

    applyLocalEdits([edit(1, 2, ''), edit(2, 2, 'X')], replica);

    // 'b' is removed, so the second edit's pre-batch offset 2 is now offset 1.
    expect(replica.text).toBe('aXcd');
  });

  it('handles three cursors at the same offset', async () => {
    const replica = await replicaWith('a', 'ad');

    applyLocalEdits([edit(1, 1, 'x'), edit(1, 1, 'y'), edit(1, 1, 'z')], replica);

    // Three characters in one position. Order among them is RGA's tie-break rule
    // (same site, so clocks decide), not the order they were typed, so the test
    // asserts membership rather than sequence.
    expect(replica.text).toHaveLength(5);
    expect([...replica.text].sort().join('')).toBe('adxyz');
  });

  it('handles a find-and-replace across several ranges', async () => {
    const replica = await replicaWith('a', 'cat bat rat');

    applyLocalEdits([edit(0, 3, 'dog'), edit(4, 7, 'log'), edit(8, 11, 'log')], replica);

    expect(replica.text).toBe('dog log log');
  });

  it('produces a document with intact invariants', async () => {
    const replica = await replicaWith('a', 'hello world');

    applyLocalEdits([edit(0, 0, 'well '), edit(11, 11, '!')], replica);

    expect(replica.checkInvariants()).toEqual([]);
  });

  it('keeps the CRDT able to accept a merge afterwards', async () => {
    const local = await replicaWith('a', 'hello');

    // A collaborator's operations, anchored to an element this replica already
    // has, must still apply after a batch of local edits.
    //
    // Same seed site, so both replicas hold identical element IDs and there is
    // something real for the merge to converge on.
    const seed = new RgaDocument('a-seed').insertAt(0, 'hello');
    const theirs = new RgaDocument('b');
    theirs.applyInAnyOrder(seed);

    // Each side appends while the other is unaware, then the two batches cross.
    const fromThem = theirs.insertAt(5, '!');
    const fromLocal = applyLocalEdits([edit(5, 5, ' world')], local);

    expect(local.applyRemote(fromThem)).toEqual([]);
    expect(theirs.applyInAnyOrder(fromLocal)).toBe(0);

    // Convergence, not a particular interleaving: whichever side's text ends up
    // first, both replicas must agree on it.
    expect(local.text).toBe(theirs.toText());
    expect(local.text).toContain('hello');
    expect(local.text).toContain(' world');
    expect(local.text).toContain('!');
    expect(local.checkInvariants()).toEqual([]);
    expect(theirs.checkInvariants()).toEqual([]);
  });
});

describe('applyLocalEdits - rejects bad input', () => {
  it('refuses out-of-order edits', async () => {
    const replica = await replicaWith('a', 'abcd');

    // Silently sorting would hide a caller bug and produce text that is almost
    // right, which is worse than a loud failure.
    expect(() => applyLocalEdits([edit(3, 3, 'X'), edit(1, 1, 'Y')], replica)).toThrow(
      /ascending/i,
    );
  });

  it('refuses a negative length', async () => {
    const replica = await replicaWith('a', 'abcd');

    expect(() => applyLocalEdits([edit(3, 1, 'X')], replica)).toThrow(/negative length/i);
  });

  it('accepts an empty batch', async () => {
    const replica = await replicaWith('a', 'a');

    expect(applyLocalEdits([], replica)).toEqual([]);
    expect(replica.text).toBe('a');
  });
});
