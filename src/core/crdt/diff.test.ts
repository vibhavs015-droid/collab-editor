/**
 * Tests for the element diff.
 *
 * The property test at the bottom is the point of this file: it generates random
 * before/after snapshots from a seeded PRNG and asserts that applying the diff
 * reproduces the target text exactly, on every run. A diff that produces
 * plausible-looking-but-wrong edits is the hardest kind of bug to notice in a
 * browser, because the text still looks reasonable; a property test catches it
 * every time.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../rng.js';
import { applyChanges, diffVisible, fullReplacement, snapshotText } from './diff.js';
import type { ElementSnapshot } from './element-snapshot.js';

/**
 * Fresh keys for freshly created characters.
 *
 * Element identity is what the diff uses, so a test must never rebuild a
 * surviving character under a new key. Re-keying everything would make every
 * character look deleted and every new one look inserted, which would still
 * produce the right text while testing nothing about minimality.
 */
let keyCounter = 0;

function freshKey(): string {
  keyCounter += 1;
  return `n${keyCounter}`;
}

function snapshot(text: string, prefix = 'a'): ElementSnapshot[] {
  return [...text].map((value, index) => ({ key: `${prefix}${index}`, value }));
}

/** Snapshot with inserted characters that keep the existing keys intact. */
function insertAt(
  elements: readonly ElementSnapshot[],
  at: number,
  text: string,
): ElementSnapshot[] {
  const inserted: ElementSnapshot[] = [...text].map((value) => ({
    key: freshKey(),
    value,
  }));

  return [...elements.slice(0, at), ...inserted, ...elements.slice(at)];
}

function removeAt(
  elements: readonly ElementSnapshot[],
  at: number,
  count: number,
): ElementSnapshot[] {
  return [...elements.slice(0, at), ...elements.slice(at + count)];
}

/**
 * Read one element, failing loudly rather than asserting non-null.
 *
 * Non-null assertions are banned in this project, and rightly: they convert a
 * test bug into a passing test. A helper that throws keeps the failure at the
 * point of the mistake.
 */
function at(elements: readonly ElementSnapshot[], index: number): ElementSnapshot {
  const element = elements[index];

  if (element === undefined) {
    throw new Error(`no element at index ${index} of ${elements.length}`);
  }

  return element;
}

/** Reorder by an index list, preserving element identity. */
function reorder(
  elements: readonly ElementSnapshot[],
  order: readonly number[],
): ElementSnapshot[] {
  return order.map((index) => at(elements, index));
}

/** Diff two snapshots that RGA could actually have produced. */
function mustDiff(
  before: readonly ElementSnapshot[],
  after: readonly ElementSnapshot[],
): NonNullable<ReturnType<typeof diffVisible>> {
  const changes = diffVisible(before, after);

  expect(changes).not.toBeNull();

  if (changes === null) {
    throw new Error('expected a minimal diff');
  }

  return changes;
}

function apply(
  text: string,
  changes: readonly { from: number; to?: number; insert?: string }[],
): string {
  return applyChanges(text, changes);
}

describe('diffVisible - identity', () => {
  it('returns nothing when nothing changed', () => {
    const elements = snapshot('hello');

    expect(mustDiff(elements, elements.slice())).toEqual([]);
  });

  it('returns nothing for two empty snapshots', () => {
    expect(mustDiff([], [])).toEqual([]);
  });

  it('does not treat equal lengths as equal content', () => {
    // The fast path must check identity, not just length. Here the document
    // swaps one character for another, so the length is unchanged but the content
    // is not.
    const before = snapshot('ab');
    const after = insertAt(removeAt(before, 1, 1), 1, 'c');

    expect(mustDiff(before, after)).toEqual([{ from: 1, to: 2, insert: 'c' }]);
  });
});

describe('diffVisible - insertions', () => {
  it('inserts at the start', () => {
    const before = snapshot('bcd');
    const after = insertAt(before, 0, 'a');

    expect(mustDiff(before, after)).toEqual([{ from: 0, insert: 'a' }]);
    expect(apply('bcd', mustDiff(before, after))).toBe('abcd');
  });

  it('inserts in the middle', () => {
    const before = snapshot('acd');
    const after = insertAt(before, 1, 'b');

    expect(mustDiff(before, after)).toEqual([{ from: 1, insert: 'b' }]);
    expect(apply('acd', mustDiff(before, after))).toBe('abcd');
  });

  it('inserts at the end', () => {
    const before = snapshot('abc');
    const after = insertAt(before, 3, 'd');

    expect(mustDiff(before, after)).toEqual([{ from: 3, insert: 'd' }]);
    expect(apply('abc', mustDiff(before, after))).toBe('abcd');
  });

  it('coalesces a multi-character insertion into one change', () => {
    const before = snapshot('ad');
    const after = insertAt(before, 1, 'bc');

    // One change, not two: a collaborator typing fast produces one batch, and
    // splitting it would give the editor two undo steps for one keystroke.
    expect(mustDiff(before, after)).toEqual([{ from: 1, insert: 'bc' }]);
  });

  it('emits separate changes for two distant insertions', () => {
    const before = snapshot('ad');
    const after = insertAt(insertAt(before, 0, 'X'), 4, 'Y');

    const changes = mustDiff(before, after);

    expect(changes).toHaveLength(2);
    expect(apply('ad', changes)).toBe('XadY');
  });
});

describe('diffVisible - deletions', () => {
  it('deletes a single character', () => {
    const before = snapshot('abc');
    const after = removeAt(before, 1, 1);

    expect(mustDiff(before, after)).toEqual([{ from: 1, to: 2 }]);
    expect(apply('abc', mustDiff(before, after))).toBe('ac');
  });

  it('deletes a run as one change', () => {
    const before = snapshot('abcdef');
    const after = removeAt(before, 1, 4);

    const changes = mustDiff(before, after);

    expect(changes).toEqual([{ from: 1, to: 5 }]);
    expect(apply('abcdef', changes)).toBe('af');
  });

  it('deletes from the start', () => {
    const before = snapshot('abc');
    const after = removeAt(before, 0, 1);

    expect(mustDiff(before, after)).toEqual([{ from: 0, to: 1 }]);
  });

  it('deletes to the end', () => {
    const before = snapshot('abc');
    const after = removeAt(before, 1, 2);

    expect(mustDiff(before, after)).toEqual([{ from: 1, to: 3 }]);
  });

  it('deletes everything', () => {
    const before = snapshot('abc');
    const after: ElementSnapshot[] = [];

    expect(mustDiff(before, after)).toEqual([{ from: 0, to: 3 }]);
    expect(apply('abc', mustDiff(before, after))).toBe('');
  });

  it('keeps two non-adjacent deletions separate', () => {
    const before = snapshot('abcdef');
    const after = removeAt(removeAt(before, 4, 1), 1, 1);

    const changes = mustDiff(before, after);

    expect(changes).toEqual([
      { from: 1, to: 2 },
      { from: 4, to: 5 },
    ]);
    expect(apply('abcdef', changes)).toBe('acdf');
  });
});

describe('diffVisible - replacements', () => {
  it('fuses a deletion and an adjacent insertion into one change', () => {
    const before = snapshot('ac');
    const after = insertAt(removeAt(before, 0, 1), 0, 'xyz');

    const changes = mustDiff(before, after);

    // Two separate changes here would momentarily leave the document as "cxyz",
    // which is a visible flicker in the editor.
    expect(changes).toEqual([{ from: 0, to: 1, insert: 'xyz' }]);
    expect(apply('ac', changes)).toBe('xyzc');
  });

  it('handles a replacement at the end', () => {
    const before = snapshot('abc');
    const after = insertAt(removeAt(before, 2, 1), 2, 'XY');

    const changes = mustDiff(before, after);

    expect(changes).toEqual([{ from: 2, to: 3, insert: 'XY' }]);
    expect(apply('abc', changes)).toBe('abXY');
  });

  it('handles trailing deletion fused with trailing insertion', () => {
    const before = snapshot('abc');
    const after = insertAt(removeAt(before, 1, 2), 1, 'Z');

    const changes = mustDiff(before, after);

    expect(changes).toEqual([{ from: 1, to: 3, insert: 'Z' }]);
    expect(apply('abc', changes)).toBe('aZ');
  });

  it('does not fuse edits separated by a kept character', () => {
    const before = snapshot('axy');
    const after = insertAt(removeAt(before, 1, 1), 2, 'Z');

    const changes = mustDiff(before, after);

    // 'y' survives between the two edits, so fusing them would delete 'y' too.
    expect(apply('axy', changes)).toBe('ayZ');

    // Positions are in the ORIGINAL document's coordinates, so the appended 'Z'
    // sits at offset 3 even though the post-delete text is only two characters.
    expect(changes).toEqual([
      { from: 1, to: 2 },
      { from: 3, insert: 'Z' },
    ]);
  });
});

describe('diffVisible - concurrent insertion', () => {
  it('places a character that lands before existing ones', () => {
    // This is the real collaborative case: a collaborator's insert has a lower
    // site ID than the local characters, so RGA places it BEFORE them. From the
    // editor's point of view the text before the caret shifted.
    const before = snapshot('bc');
    const after: ElementSnapshot[] = [{ key: freshKey(), value: 'a' }, ...before];

    const changes = mustDiff(before, after);

    expect(changes).toEqual([{ from: 0, insert: 'a' }]);
    expect(apply('bc', changes)).toBe('abc');
  });

  it('places a character that lands between two existing ones', () => {
    const before = snapshot('ac');
    const after: ElementSnapshot[] = [
      at(before, 0),
      { key: freshKey(), value: 'b' },
      at(before, 1),
    ];

    const changes = mustDiff(before, after);

    expect(changes).toEqual([{ from: 1, insert: 'b' }]);
  });
});

describe('diffVisible - unsafe input', () => {
  it('refuses to diff a snapshot where a character moved backwards', () => {
    // RGA never relocates an existing character, so this input cannot arise.
    // Emitting edits anyway would put the wrong text on screen, so the function
    // reports failure instead.
    const before = snapshot('abc');
    const after = reorder(before, [2, 0, 1]);

    expect(diffVisible(before, after)).toBeNull();
  });

  it('refuses a full shuffle', () => {
    const before = snapshot('abcdef');
    const after = reorder(before, [3, 0, 5, 1, 4, 2]);

    expect(diffVisible(before, after)).toBeNull();
  });

  it('produces a usable fallback for the unsafe case', () => {
    const before = snapshot('abc');
    const after = reorder(before, [2, 0, 1]);

    const changes = diffVisible(before, after) ?? fullReplacement('abc', 'cab');

    // Ugly, but correct: the fallback always reproduces the target text.
    expect(apply('abc', changes)).toBe('cab');
  });
});

describe('fullReplacement', () => {
  it('replaces the whole document', () => {
    expect(apply('old text', fullReplacement('old text', 'new text'))).toBe('new text');
  });

  it('handles emptying the document', () => {
    expect(apply('old text', fullReplacement('old text', ''))).toBe('');
  });

  it('handles filling an empty document', () => {
    expect(apply('', fullReplacement('', 'new text'))).toBe('new text');
  });

  it('handles two empty documents', () => {
    expect(apply('', fullReplacement('', ''))).toBe('');
  });
});

describe('diffVisible - invariants', () => {
  /**
   * Each case states the before snapshot, how to build the after snapshot, and
   * the text the after snapshot must contain.
   *
   * Written as transformations rather than as two strings precisely so that
   * surviving characters keep their keys. Two independently-built snapshots
   * share no keys, which makes every character look deleted and every new one
   * look inserted: the text still matches, but nothing about minimality is
   * actually being tested.
   */
  const cases: readonly {
    readonly name: string;
    readonly before: string;
    readonly build: (base: ElementSnapshot[]) => ElementSnapshot[];
    readonly expectText: string;
  }[] = [
    {
      name: 'insert into empty',
      before: '',
      build: (base) => insertAt(base, 0, 'a'),
      expectText: 'a',
    },
    {
      name: 'empty everything',
      before: '',
      build: (base) => base,
      expectText: '',
    },
    {
      name: 'unchanged',
      before: 'aaaa',
      build: (base) => base,
      expectText: 'aaaa',
    },
    {
      name: 'insert at start',
      before: 'world',
      build: (base) => insertAt(base, 0, 'hello '),
      expectText: 'hello world',
    },
    {
      name: 'insert a word mid-document',
      before: 'hello  world',
      build: (base) => insertAt(base, 6, 'brave'),
      expectText: 'hello brave world',
    },
    {
      name: 'insert at end',
      before: 'abc',
      build: (base) => insertAt(base, 3, 'def'),
      expectText: 'abcdef',
    },
    {
      name: 'delete one character',
      before: 'abc',
      build: (base) => removeAt(base, 1, 1),
      expectText: 'ac',
    },
    {
      name: 'delete a run',
      before: 'abcdef',
      build: (base) => removeAt(base, 2, 3),
      expectText: 'abf',
    },
    {
      name: 'delete everything',
      before: 'abc',
      build: (base) => removeAt(base, 0, 3),
      expectText: '',
    },
    {
      name: 'delete two runs',
      before: 'abcdef',
      build: (base) => removeAt(removeAt(base, 4, 1), 1, 1),
      expectText: 'acdf',
    },
    {
      name: 'replace a word',
      before: 'the quick fox',
      build: (base) => insertAt(removeAt(base, 4, 5), 4, 'red'),
      expectText: 'the red fox',
    },
    {
      name: 'insert and delete in one batch',
      before: 'the quick brown fox',
      build: (base) => insertAt(removeAt(base, 16, 3), 16, 'red'),
      expectText: 'the quick brown red',
    },
    {
      name: 'append to a one-character document',
      before: 'a',
      build: (base) => insertAt(base, 1, 'bc'),
      expectText: 'abc',
    },
  ];

  it('always reproduces the target text', () => {
    for (const testCase of cases) {
      const before = snapshot(testCase.before);
      const after = testCase.build(before);
      const changes = diffVisible(before, after);

      expect(changes, testCase.name).not.toBeNull();
      expect(apply(snapshotText(before), changes ?? []), testCase.name).toBe(testCase.expectText);
    }
  });

  it('matches the target snapshot text', () => {
    for (const testCase of cases) {
      const before = snapshot(testCase.before);
      const after = testCase.build(before);

      // The stated expectation must itself be right, or every test above is
      // asserting against a typo.
      expect(snapshotText(after), testCase.name).toBe(testCase.expectText);
    }
  });

  it('emits changes in ascending, non-overlapping order', () => {
    for (const testCase of cases) {
      const before = snapshot(testCase.before);
      const after = testCase.build(before);

      let previousTo = -1;
      for (const change of mustDiff(before, after)) {
        expect(change.from, testCase.name).toBeGreaterThanOrEqual(previousTo);
        previousTo = change.to ?? change.from;
      }
    }
  });

  it('never emits an empty change', () => {
    for (const testCase of cases) {
      const before = snapshot(testCase.before);
      const after = testCase.build(before);

      for (const change of mustDiff(before, after)) {
        const removed = (change.to ?? change.from) - change.from;
        const added = change.insert?.length ?? 0;

        // A change with no effect is noise, and CodeMirror rejects it outright.
        expect(removed + added, testCase.name).toBeGreaterThan(0);
      }
    }
  });

  it('keeps positions inside the source document', () => {
    for (const testCase of cases) {
      const before = snapshot(testCase.before);
      const after = testCase.build(before);

      for (const change of mustDiff(before, after)) {
        expect(change.from, testCase.name).toBeGreaterThanOrEqual(0);
        expect(change.from, testCase.name).toBeLessThanOrEqual(before.length);
        expect(change.to ?? change.from, testCase.name).toBeLessThanOrEqual(before.length);
      }
    }
  });
});

describe('diffVisible - randomised property', () => {
  /**
   * Evolve a snapshot with random insertions and deletions, preserving the keys
   * of surviving characters. This is the shape a CRDT merge actually produces:
   * characters are added or tombstoned, never edited in place.
   */
  function evolve(
    elements: readonly ElementSnapshot[],
    rng: () => number,
    steps: number,
  ): ElementSnapshot[] {
    const pool = [...elements];

    for (let step = 0; step < steps; step += 1) {
      const at = Math.floor(rng() * (pool.length + 1));

      if (rng() < 0.5 || pool.length === 0) {
        const run = 1 + Math.floor(rng() * 4);
        const inserted: ElementSnapshot[] = [];

        for (let index = 0; index < run; index += 1) {
          inserted.push({
            key: freshKey(),
            value: String.fromCharCode(97 + Math.floor(rng() * 26)),
          });
        }

        pool.splice(at, 0, ...inserted);
      } else {
        const run = Math.min(1 + Math.floor(rng() * 3), pool.length);
        pool.splice(at, run);
      }
    }

    return pool;
  }

  it('reproduces the target on every seeded run', () => {
    const rng = mulberry32(0x5eed);

    for (let run = 0; run < 500; run += 1) {
      const length = Math.floor(rng() * 24);
      const before: ElementSnapshot[] = [];

      for (let index = 0; index < length; index += 1) {
        before.push({
          key: `s${index}`,
          value: String.fromCharCode(97 + Math.floor(rng() * 26)),
        });
      }

      const after = evolve(before, rng, 1 + Math.floor(rng() * 6));
      const changes = diffVisible(before, after);

      // Evolving never reorders survivors, so this must always succeed.
      expect(changes).not.toBeNull();

      // The single most important assertion in this file. If it ever fails, the
      // editor would show text that does not match what gets saved.
      expect(apply(snapshotText(before), changes ?? [])).toBe(snapshotText(after));

      // Positions must stay valid, or CodeMirror throws instead of rendering.
      for (const change of changes ?? []) {
        expect(change.from).toBeGreaterThanOrEqual(0);
        expect(change.from).toBeLessThanOrEqual(before.length);
        expect(change.to ?? change.from).toBeLessThanOrEqual(before.length);
      }

      // Changes must not overlap, which is what makes them applicable as one unit.
      let previousTo = 0;
      for (const change of changes ?? []) {
        expect(change.from).toBeGreaterThanOrEqual(previousTo);
        previousTo = change.to ?? change.from;
      }
    }
  });

  it('is deterministic', () => {
    const before = snapshot('hello');
    const after = insertAt(before, 3, ' there');

    expect(mustDiff(before, after)).toEqual(mustDiff(before, after));
  });

  it('is minimal for a single remote keystroke in a large document', () => {
    // The case that matters most in practice: one collaborator types one
    // character into a large document. Exactly one change, one character wide.
    const before = snapshot('x'.repeat(5_000));
    const after = insertAt(before, 2_500, 'Q');

    const changes = mustDiff(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ from: 2_500, insert: 'Q' });
  });

  it('is minimal for a remote backspace in a large document', () => {
    const before = snapshot('x'.repeat(5_000));
    const after = removeAt(before, 1_234, 1);

    const changes = mustDiff(before, after);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ from: 1_234, to: 1_235 });
  });
});
