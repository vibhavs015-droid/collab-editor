import { describe, expect, it } from 'vitest';

import {
  LogicalClock,
  compareElementId,
  elementIdEquals,
  elementIdKey,
  formatElementId,
  type ElementId,
} from './clock.js';
import { mulberry32, shuffle } from './rng.js';

const id = (site: string, clock: number): ElementId => ({ site, clock });

describe('compareElementId', () => {
  it('orders by clock before site', () => {
    // 'z' sorts after 'a' lexicographically, but clock 1 must still win.
    expect(compareElementId(id('z', 1), id('a', 2))).toBeLessThan(0);
    expect(compareElementId(id('a', 2), id('z', 1))).toBeGreaterThan(0);
  });

  it('breaks same-clock ties on site, deterministically', () => {
    // Two replicas inserted concurrently. Neither is "first" causally, so we
    // resolve on site ID — and both replicas must reach the same answer.
    expect(compareElementId(id('alice', 5), id('bob', 5))).toBeLessThan(0);
    expect(compareElementId(id('bob', 5), id('alice', 5))).toBeGreaterThan(0);
  });

  it('reports equality for identical ids', () => {
    expect(compareElementId(id('alice', 5), id('alice', 5))).toBe(0);
  });

  it('is reflexive, antisymmetric, and transitive (is a total order)', () => {
    // Not academic: if this fails, the merge stops being associative and
    // replicas silently diverge. This is the single most important property.
    const sample: ElementId[] = [
      id('alice', 1),
      id('alice', 2),
      id('bob', 1),
      id('bob', 2),
      id('carol', 1),
      id('carol', 3),
    ];

    for (const a of sample) {
      // reflexive
      expect(compareElementId(a, a)).toBe(0);

      for (const b of sample) {
        // Antisymmetric: sign(cmp(a,b)) and sign(cmp(b,a)) must cancel.
        // Expressed as a sum rather than `x === -y` because JavaScript has a
        // signed zero: Object.is(-0, 0) is false, so `expect(x).toBe(-y)` fails
        // on the a === b case even though the comparator is correct.
        expect(Math.sign(compareElementId(a, b)) + Math.sign(compareElementId(b, a))).toBe(0);

        for (const c of sample) {
          // transitive
          if (compareElementId(a, b) < 0 && compareElementId(b, c) < 0) {
            expect(compareElementId(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });

  it('produces the same sort regardless of input order (convergence at the id level)', () => {
    const ids: ElementId[] = [
      id('dave', 3),
      id('alice', 9),
      id('carol', 1),
      id('bob', 7),
      id('alice', 2),
    ];

    const expected = [...ids].sort(compareElementId).map(elementIdKey);

    for (let seed = 0; seed < 200; seed += 1) {
      const actual = shuffle(ids, mulberry32(seed)).sort(compareElementId).map(elementIdKey);
      expect(actual).toEqual(expected);
    }
  });
});

describe('LogicalClock', () => {
  it('issues strictly increasing clocks', () => {
    const clock = new LogicalClock('alice');

    const first = clock.tick();
    const second = clock.tick();
    const third = clock.tick();

    expect(first.clock).toBe(1);
    expect(second.clock).toBe(2);
    expect(third.clock).toBe(3);
  });

  it('never reissues an id', () => {
    const clock = new LogicalClock('alice');
    const issued = new Set<string>();

    for (let i = 0; i < 1000; i += 1) {
      issued.add(elementIdKey(clock.tick()));
    }

    expect(issued.size).toBe(1000);
  });

  it('advances past an observed id carrying its own site', () => {
    // Simulates a reconnect that re-delivers operations we already produced.
    const clock = new LogicalClock('alice');
    clock.tick();
    clock.tick();

    clock.observe(id('alice', 500));

    expect(clock.current).toBe(500);
    expect(clock.tick().clock).toBe(501);
  });

  it('ignores observed ids from other sites', () => {
    // Another replica's counter must not consume our clock values.
    const clock = new LogicalClock('alice');
    clock.tick();

    clock.observe(id('bob', 9999));

    expect(clock.current).toBe(1);
    expect(clock.tick().clock).toBe(2);
  });

  it('never moves backward', () => {
    const clock = new LogicalClock('alice');
    clock.tick();
    clock.tick();
    clock.tick();

    clock.observe(id('alice', 1));
    clock.observe(id('alice', 0));

    expect(clock.current).toBe(3);
  });

  it('rejects an empty site id', () => {
    expect(() => new LogicalClock('')).toThrow(/non-empty/);
  });
});

describe('element id helpers', () => {
  it('formats ids for human-readable failure messages', () => {
    expect(formatElementId(id('alice', 7))).toBe('alice@7');
  });

  it('compares structurally', () => {
    expect(elementIdEquals(id('a', 1), id('a', 1))).toBe(true);
    expect(elementIdEquals(id('a', 1), id('a', 2))).toBe(false);
    expect(elementIdEquals(id('a', 1), id('b', 1))).toBe(false);
  });
});
