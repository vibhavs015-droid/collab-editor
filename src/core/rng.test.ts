import { describe, expect, it } from 'vitest';

import { mulberry32, pick, randomInt, shuffle } from './rng.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    // The property the whole fuzz-test strategy depends on: a failing run must
    // be replayable from its seed alone.
    const a = mulberry32(12345);
    const b = mulberry32(12345);

    const first = Array.from({ length: 100 }, a);
    const second = Array.from({ length: 100 }, b);

    expect(first).toEqual(second);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 50 }, mulberry32(1));
    const b = Array.from({ length: 50 }, mulberry32(2));

    expect(a).not.toEqual(b);
  });

  it('stays within [0, 1)', () => {
    const random = mulberry32(777);

    for (let i = 0; i < 10_000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('does not get stuck (has no short cycles)', () => {
    // A degenerate generator would silently make the fuzz test vacuous.
    const random = mulberry32(42);
    const seen = new Set<number>();

    for (let i = 0; i < 500; i += 1) {
      seen.add(random());
    }

    expect(seen.size).toBe(500);
  });
});

describe('shuffle', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];

  it('is deterministic for a given seed', () => {
    expect(shuffle(input, mulberry32(9))).toEqual(shuffle(input, mulberry32(9)));
  });

  it('preserves every element exactly once', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const result = shuffle(input, mulberry32(seed));

      expect(result).toHaveLength(input.length);
      expect([...result].sort((x, y) => x - y)).toEqual(input);
    }
  });

  it('does not mutate its input', () => {
    const source = [...input];
    shuffle(source, mulberry32(3));
    expect(source).toEqual(input);
  });

  it('actually reorders (is not accidentally identity)', () => {
    let reorderings = 0;

    for (let seed = 0; seed < 50; seed += 1) {
      const result = shuffle(input, mulberry32(seed));
      if (result.some((value, index) => value !== input[index])) {
        reorderings += 1;
      }
    }

    expect(reorderings).toBeGreaterThan(40);
  });

  it('handles edge cases without throwing', () => {
    const random = mulberry32(1);

    expect(shuffle([], random)).toEqual([]);
    expect(shuffle([1], random)).toEqual([1]);
  });
});

describe('randomInt', () => {
  it('respects inclusive bounds', () => {
    const random = mulberry32(21);

    for (let i = 0; i < 1000; i += 1) {
      const value = randomInt(random, 3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('can return both endpoints', () => {
    const random = mulberry32(5);
    const values = new Set(Array.from({ length: 500 }, () => randomInt(random, 0, 1)));

    expect(values.has(0)).toBe(true);
    expect(values.has(1)).toBe(true);
  });

  it('throws on an inverted range', () => {
    expect(() => randomInt(mulberry32(1), 10, 2)).toThrow(/must be <=/);
  });
});

describe('pick', () => {
  it('returns an element from the array', () => {
    const random = mulberry32(8);
    const items = ['a', 'b', 'c'];

    for (let i = 0; i < 100; i += 1) {
      expect(items).toContain(pick(items, random));
    }
  });

  it('throws on empty input rather than returning undefined', () => {
    // A silent undefined here would poison a fuzz run and be miserable to trace.
    expect(() => pick([], mulberry32(1))).toThrow(/empty array/);
  });
});
