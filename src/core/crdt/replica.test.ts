import { beforeEach, describe, expect, it } from 'vitest';

import { RgaDocument, type Operation } from './rga.js';
import { Replica, type LoggedOperation, type OperationLog } from './replica.js';

/**
 * In-memory log.
 *
 * Implements the same contract as the IndexedDB adapter, including the parts that
 * matter for correctness: entries are returned in sequence order, and append is
 * atomic from the caller's point of view. A log that silently reordered entries
 * would let a replica rebuild into a different document, which is precisely the
 * failure the log is meant to prevent.
 */
class MemoryLog implements OperationLog {
  entries: LoggedOperation[] = [];
  appendCount = 0;

  load(): Promise<LoggedOperation[]> {
    // Promise.resolve, not sync: this adapter has no I/O, and a fake await
    // would make the sync tests look like they test async behaviour.
    return Promise.resolve(this.entries.map((entry) => ({ ...entry })));
  }

  append(entries: readonly LoggedOperation[]): Promise<void> {
    this.appendCount += 1;
    for (const entry of entries) {
      // Reject a duplicate sequence rather than storing both. Two entries with
      // the same seq would make replay order ambiguous.
      if (this.entries.some((existing) => existing.seq === entry.seq)) {
        throw new Error(`duplicate sequence ${entry.seq} appended to the log`);
      }
      this.entries.push({ ...entry });
    }

    return Promise.resolve();
  }

  truncateBefore(seq: number): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.seq >= seq);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }
}

interface Harness {
  readonly replica: Replica;
  readonly log: MemoryLog;
  readonly localOps: Operation[];
  readonly remoteOps: Operation[];
}

function harness(site = 'alice'): Harness {
  return harnessWithLog(new MemoryLog(), site);
}

/**
 * Build a replica over an EXISTING log.
 *
 * Separate from `harness` because a reload test must reuse the original log.
 * Calling `harness()` for the reloaded replica would hand it a fresh empty log
 * and silently "prove" that replay reconstructs nothing.
 */
function harnessWithLog(log: MemoryLog, site = 'alice'): Harness {
  const localOps: Operation[] = [];
  const remoteOps: Operation[] = [];

  const replica = new Replica({
    site,
    log,
    onOperations: (ops, origin) => {
      (origin === 'local' ? localOps : remoteOps).push(...ops);
    },
  });

  return { replica, log, localOps, remoteOps };
}

describe('Replica - initialisation', () => {
  it('starts empty', async () => {
    const h = harness();
    await h.replica.init();

    expect(h.replica.text).toBe('');
    expect(h.replica.appliedSeq).toBe(-1);
  });

  it('rebuilds text from the persisted log', async () => {
    const first = harness();
    await first.replica.init();
    first.replica.insertAt(0, 'persisted text');

    // Fresh replica, same log: the log is the source of truth, not the text.
    const second = harnessWithLog(first.log);
    await second.replica.init();

    expect(second.replica.text).toBe('persisted text');
  });

  it('is idempotent when init runs twice', async () => {
    const h = harness();
    await h.replica.init();
    h.replica.insertAt(0, 'once');

    await h.replica.init();

    // Replaying twice would double every character.
    expect(h.replica.text).toBe('once');
  });

  it('refuses to edit before init', () => {
    const h = harness();

    // Editing against an unreplayed log would anchor against nothing, then
    // conflict with the replay on load and lose the user's text.
    expect(() => h.replica.insertAt(0, 'x')).toThrow(/before init/i);
  });

  it('reports operations it cannot place during replay', async () => {
    const log = new MemoryLog();

    // An operation anchored to an element that was never logged.
    await log.append([
      {
        seq: 0,
        op: {
          type: 'insert',
          id: { site: 'ghost', clock: 9 },
          origin: { site: 'ghost', clock: 8 },
          value: 'x',
        },
        at: 0,
      },
    ]);

    const replica = new Replica({
      site: 'alice',
      log,
      onOperations: () => undefined,
    });

    // Silent here would mean a document quietly missing previously-saved text.
    await expect(replica.init()).rejects.toThrow(/could not be placed/i);
  });
});

describe('Replica - logging', () => {
  it('logs local operations', async () => {
    const h = harness();
    await h.replica.init();

    h.replica.insertAt(0, 'abc');

    expect(h.log.entries).toHaveLength(3);
    expect(h.log.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('logs remote operations too', async () => {
    const h = harness();
    await h.replica.init();

    h.replica.applyRemote([
      { type: 'insert', id: { site: 'bob', clock: 1 }, origin: null, value: 'z' },
    ]);

    // Losing a collaborator's text on reload would be data loss.
    expect(h.log.entries).toHaveLength(1);
    expect(h.replica.text).toBe('z');
  });

  it('records wall-clock time for diagnostics', async () => {
    const h = harness();
    await h.replica.init();
    h.replica.insertAt(0, 'a');

    expect(h.log.entries[0]?.at).toBeGreaterThan(0);
  });

  it('continues sequence numbers after a remote batch', async () => {
    const h = harness();
    await h.replica.init();

    h.replica.insertAt(0, 'a');
    h.replica.applyRemote([
      { type: 'insert', id: { site: 'bob', clock: 1 }, origin: null, value: 'b' },
    ]);
    h.replica.insertAt(1, 'c');

    // Duplicate sequence numbers would make replay order ambiguous.
    const seqs = h.log.entries.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('survives a reload with interleaved local and remote work', async () => {
    const h = harness();
    await h.replica.init();

    h.replica.insertAt(0, 'local');
    h.replica.applyRemote([
      { type: 'insert', id: { site: 'bob', clock: 1 }, origin: null, value: 'R' },
    ]);
    h.replica.insertAt(6, 'more');

    const reloaded = harnessWithLog(h.log);
    await reloaded.replica.init();

    expect(reloaded.replica.text).toBe(h.replica.text);
    expect(reloaded.replica.checkInvariants()).toEqual([]);
  });
});

describe('Replica - editing', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await h.replica.init();
  });

  it('inserts and returns operations for broadcast', () => {
    const ops = h.replica.insertAt(0, 'hello');

    expect(ops).toHaveLength(5);
    expect(h.replica.text).toBe('hello');
    expect(h.localOps).toHaveLength(5);
  });

  it('deletes a range', () => {
    h.replica.insertAt(0, 'hello world');
    h.replica.deleteRange(5, 6);

    expect(h.replica.text).toBe('hello');
  });

  it('ignores a no-op insert', () => {
    expect(h.replica.insertAt(0, '')).toEqual([]);
    expect(h.log.entries).toHaveLength(0);
  });

  it('applies remote operations and reports what it could not place', () => {
    const placed: Operation[] = [
      { type: 'insert', id: { site: 'bob', clock: 1 }, origin: null, value: 'a' },
    ];
    const orphaned: Operation[] = [
      {
        type: 'insert',
        id: { site: 'ghost', clock: 5 },
        origin: { site: 'ghost', clock: 4 },
        value: '?',
      },
    ];

    // Phase 4 uses the unplaced list to decide when a resync is required.
    expect(h.replica.applyRemote([...placed, ...orphaned])).toEqual(orphaned);
    expect(h.replica.text).toBe('a');
  });
});

describe('Replica - undo and redo', () => {
  it('undoes an insert', async () => {
    const h = harness();
    await h.replica.init();

    h.replica.insertAt(0, 'hello');
    h.replica.undo();

    expect(h.replica.text).toBe('');
  });

  it('logs the compensation so a reload keeps the undone state', async () => {
    const h = harness();
    await h.replica.init();

    h.replica.insertAt(0, 'hello');
    h.replica.undo();

    const reloaded = harnessWithLog(h.log);
    await reloaded.replica.init();

    // If compensation were not logged, the reload would resurrect 'hello'.
    expect(reloaded.replica.text).toBe('');
  });

  it('redoes an undone insert', async () => {
    const h = harness();
    await h.replica.init();

    h.replica.insertAt(0, 'hello');
    h.replica.undo();
    h.replica.redo();

    expect(h.replica.text).toBe('hello');
  });
});

describe('Replica - resetTo', () => {
  async function seeded(site: string, text: string): Promise<Replica> {
    const log = new MemoryLog();
    const replica = new Replica({ site, log, onOperations: () => undefined });
    await replica.init();
    replica.applyRemote(new RgaDocument(`${site}-seed`).insertAt(0, text));
    return replica;
  }

  it('replaces the document rather than adding to it', async () => {
    const replica = await seeded('alice', 'stale text that should vanish');
    expect(replica.text).toContain('stale');

    await replica.resetTo(new RgaDocument('server').insertAt(0, 'server baseline'));

    // The whole point. Merging instead would leave the old document plus the
    // baseline, which is visibly wrong.
    expect(replica.text).toBe('server baseline');
  });

  it('clears the local log so a reload replays the baseline', async () => {
    const log = new MemoryLog();
    const replica = new Replica({ site: 'alice', log, onOperations: () => undefined });
    await replica.init();
    replica.applyRemote(new RgaDocument('a-seed').insertAt(0, 'before'));
    expect(log.entries.length).toBeGreaterThan(0);

    await replica.resetTo(new RgaDocument('server').insertAt(0, 'after'));

    // The baseline is recorded as the new log, so a reload does not refetch it.
    const reloaded = new Replica({ site: 'alice', log, onOperations: () => undefined });
    await reloaded.init();

    expect(reloaded.text).toBe('after');
  });

  it('keeps the site and the clock across a reset', async () => {
    const replica = await seeded('alice', 'abc');
    replica.insertAt(3, 'd');
    const before = replica.site;

    await replica.resetTo(new RgaDocument('server').insertAt(0, 'xyz'));

    // Same identity, and a clock still ahead of everything in the adopted
    // document. Clearing either would let this replica reissue an ID that already
    // exists, which is the one failure the CRDT cannot detect for itself.
    expect(replica.site).toBe(before);

    const next = replica.insertAt(3, 'Q');
    const first = next[0];

    if (first === undefined || first.type !== 'insert') {
      throw new Error('expected an insert');
    }

    expect(first.id.clock).toBeGreaterThan(3);
    expect(replica.checkInvariants()).toEqual([]);
  });

  it('accepts operations recorded after the baseline', async () => {
    const replica = await seeded('alice', 'old');

    // The baseline and its tail, built by one author so the tail anchors into it.
    const server = new RgaDocument('server');
    const baseline = server.insertAt(0, 'new');
    const tail = server.insertAt(3, '!');

    await replica.resetTo(baseline);
    expect(replica.applyRemote(tail)).toEqual([]);
    expect(replica.text).toBe('new!');
  });

  it('refuses a baseline it cannot replay', async () => {
    const replica = await seeded('alice', 'abc');

    // Anchored to an element that does not exist. Adopting this would leave a
    // document missing text, with nothing to report it.
    await expect(
      replica.resetTo([
        {
          type: 'insert',
          id: { site: 'server', clock: 1 },
          origin: { site: 'ghost', clock: 7 },
          value: '?',
        },
      ]),
    ).rejects.toThrow(/could not be placed/i);

    // And the original document is untouched, because the reset is all-or-nothing.
    expect(replica.text).toBe('abc');
  });

  it('leaves undo history empty, because the baseline is not an edit', async () => {
    const replica = await seeded('alice', 'abc');
    replica.insertAt(3, 'd');
    expect(replica.canUndo).toBe(true);

    await replica.resetTo(new RgaDocument('server').insertAt(0, 'fresh'));

    // Undoing a server baseline would be meaningless, and pretending otherwise
    // would let one user's undo reverse another user's whole document.
    expect(replica.canUndo).toBe(false);
  });
});

describe('Replica - cursor mapping', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await h.replica.init();
    h.replica.insertAt(0, 'abcdef');
  });

  it('maps a visible offset to an element id', () => {
    const id = h.replica.elementIdAt(2);
    expect(id).not.toBeNull();
    expect(id?.clock).toBeGreaterThan(0);
  });

  it('round-trips an element id back to its offset', () => {
    const id = h.replica.elementIdAt(3);

    if (!id) {
      throw new Error('expected an element id at offset 3');
    }

    expect(h.replica.visibleOffsetOf(id)).toBe(3);
  });

  it('returns -1 for an unknown element', () => {
    expect(h.replica.visibleOffsetOf({ site: 'ghost', clock: 99 })).toBe(-1);
  });

  it('returns null at the end of the document', () => {
    expect(h.replica.elementIdAt(6)).toBeNull();
  });

  it('keeps offsets correct across a remote insert', () => {
    // A collaborator inserts at the very start. Every visible offset shifts, but
    // an element ID still identifies the same character. That is why cursors are
    // anchored to IDs rather than to positions.
    const before = h.replica.elementIdAt(4);
    if (!before) {
      throw new Error('expected an element id at offset 4');
    }

    h.replica.applyRemote([
      { type: 'insert', id: { site: 'bob', clock: 1 }, origin: null, value: 'Z' },
    ]);

    expect(h.replica.text).toBe('Zabcdef');
    // The same character moved from offset 4 to 5, but its ID is unchanged.
    expect(h.replica.visibleOffsetOf(before)).toBe(5);
  });
});

describe('Replica - offline-first convergence', () => {
  it('converges after two replicas edit independently and merge', async () => {
    const alice = harness('alice');
    const bob = harness('bob');
    await alice.replica.init();
    await bob.replica.init();

    // Shared starting document.
    const seed: Operation[] = [
      { type: 'insert', id: { site: 'seed', clock: 1 }, origin: null, value: 'b' },
      {
        type: 'insert',
        id: { site: 'seed', clock: 2 },
        origin: { site: 'seed', clock: 1 },
        value: 'a',
      },
      {
        type: 'insert',
        id: { site: 'seed', clock: 3 },
        origin: { site: 'seed', clock: 2 },
        value: 's',
      },
      {
        type: 'insert',
        id: { site: 'seed', clock: 4 },
        origin: { site: 'seed', clock: 3 },
        value: 'e',
      },
    ];

    alice.replica.applyRemote(seed);
    bob.replica.applyRemote(seed);

    // Each edits offline, unaware of the other.
    const fromAlice = alice.replica.insertAt(0, 'A');
    const fromBob = bob.replica.insertAt(4, 'B');

    // Both changes cross, out of order, as they would after a partition heals.
    alice.replica.applyRemote(fromBob);
    bob.replica.applyRemote(fromAlice);

    expect(alice.replica.text).toBe(bob.replica.text);
    expect(alice.replica.checkInvariants()).toEqual([]);
    expect(bob.replica.checkInvariants()).toEqual([]);
  });

  it('keeps both replicas identical after repeated offline cycles', () => {
    // The RGA itself is the subject here, so use it directly: Replica adds a log
    // this scenario does not need, and the convergence property under test is
    // RGA's, already covered in convergence.test.ts.
    const a = new RgaDocument('alice');
    const b = new RgaDocument('bob');

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const fromA = a.insertAt(a.toText().length, 'a');
      const fromB = b.insertAt(0, 'b');

      b.applyInAnyOrder(fromA);
      a.applyInAnyOrder(fromB);

      expect(a.toText()).toBe(b.toText());
      expect(a.checkInvariants()).toEqual([]);
    }
  });

  it('never loses text across many offline cycles with deletes', async () => {
    const a = harness('alice');
    const b = harness('bob');
    await a.replica.init();
    await b.replica.init();

    const seed: Operation[] = [...new RgaDocument('seed').insertAt(0, 'shared document')];
    a.replica.applyRemote(seed);
    b.replica.applyRemote(seed);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const fromA = a.replica.insertAt(a.replica.text.length, 'x');
      const fromB = b.replica.deleteRange(0, 1);

      a.replica.applyRemote(fromB);
      b.replica.applyRemote(fromA);

      expect(a.replica.text).toBe(b.replica.text);
      expect(a.replica.checkInvariants()).toEqual([]);
    }
  });
});
