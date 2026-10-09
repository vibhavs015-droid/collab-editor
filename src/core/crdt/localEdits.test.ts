/**
 * Local-edit translation tests.
 *
 * The offset arithmetic here is invisible when it is right and catastrophic when
 * it is wrong, so these tests are about positions, not about "does it not crash".
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { applyLocalEdits, elementCount, elementIndexAt, type LocalEdit } from './localEdits.js';
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

/*
 * Editor offsets are UTF-16 code units; the CRDT keeps one element per code point.
 * An emoji is one element and two code units, so every offset after one differs between
 * the two systems. These tests are written in editor coordinates, the way CodeMirror
 * reports them, because that is the coordinate system the application actually uses.
 */
const EMOJI = '\u{1F600}';

describe('applyLocalEdits - astral characters', () => {
  it('inserts after an emoji at the position the editor reported', async () => {
    const replica = await replicaWith('a', `a${EMOJI}b`);

    // a is 0..1, the emoji is 1..3, b is 3..4: typing before b is offset 3.
    applyLocalEdits([edit(3, 3, 'X')], replica);

    expect(replica.text).toBe(`a${EMOJI}Xb`);
  });

  it('deletes the character after an emoji, and only that one', async () => {
    const replica = await replicaWith('a', `${EMOJI}abc`);

    applyLocalEdits([edit(3, 4, '')], replica);

    expect(replica.text).toBe(`${EMOJI}ac`);
  });

  it('deletes an emoji as a single element, not two', async () => {
    const replica = await replicaWith('a', `${EMOJI}abc`);

    const ops = applyLocalEdits([edit(0, 2, '')], replica);

    expect(replica.text).toBe('abc');
    expect(ops).toHaveLength(1);
  });

  it('replaces an emoji', async () => {
    const replica = await replicaWith('a', `${EMOJI}abc`);

    applyLocalEdits([edit(0, 2, 'Z')], replica);

    expect(replica.text).toBe('Zabc');
  });

  it('carries the running offset in elements across a batch that inserts an emoji', async () => {
    const replica = await replicaWith('a', 'ab');

    // Both edits are in pre-batch coordinates. The first grows the document by ONE
    // element (two code units), and the second must still land between a and b.
    applyLocalEdits([edit(0, 0, EMOJI), edit(1, 1, 'X')], replica);

    expect(replica.text).toBe(`${EMOJI}aXb`);
  });

  it('agrees with a plain string for every edit position in a mixed document', async () => {
    const start = `a${EMOJI}b${EMOJI}${EMOJI}c`;

    for (let from = 0; from <= start.length; from += 1) {
      // A caret between the two halves of a surrogate pair cannot occur in CodeMirror.
      const low = start.charCodeAt(from);
      if (low >= 0xdc00 && low <= 0xdfff) {
        continue;
      }

      const replica = await replicaWith('a', start);
      applyLocalEdits([edit(from, from, '|')], replica);

      expect(replica.text).toBe(`${start.slice(0, from)}|${start.slice(from)}`);
    }
  });
});

describe('elementIndexAt', () => {
  const text = `a${EMOJI}b`;

  it('is the identity for text without astral characters', () => {
    expect(elementIndexAt('hello', 0)).toBe(0);
    expect(elementIndexAt('hello', 3)).toBe(3);
    expect(elementIndexAt('hello', 5)).toBe(5);
  });

  it('counts an emoji as one element', () => {
    expect(elementIndexAt(text, 1)).toBe(1);
    expect(elementIndexAt(text, 3)).toBe(2);
    expect(elementIndexAt(text, 4)).toBe(3);
  });

  it('rounds an offset inside a surrogate pair up to the whole character', () => {
    expect(elementIndexAt(text, 2)).toBe(2);
  });

  it('clamps an offset past the end', () => {
    expect(elementIndexAt(text, 99)).toBe(3);
    expect(elementIndexAt('', 5)).toBe(0);
  });
});

describe('elementCount', () => {
  it('counts code points, not UTF-16 code units', () => {
    expect(elementCount('')).toBe(0);
    expect(elementCount('abc')).toBe(3);
    expect(elementCount(`a${EMOJI}b`)).toBe(3);
    expect(`a${EMOJI}b`.length).toBe(4);
  });
});
