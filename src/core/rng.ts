/**
 * Seeded randomness.
 *
 * CRDT correctness is an emergent property -- bugs show up as rare orderings of
 * operations that no human would ever write by hand. Testing this properly
 * means running *thousands* of randomly generated concurrent edits and checking
 * that every replica converges.
 *
 * That only works with randomness you can reproduce. When a fuzz run fails, we
 * need to replay the exact same sequence to debug it. `Math.random()` cannot
 * do that; a seeded PRNG can. Same seed in, same sequence out, forever.
 */

/**
 * Mulberry32 -- a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen deliberately: it is short enough to read in full and audit, which
 * matters more for a testing tool than raw statistical quality.
 *
 * @param seed any 32-bit value. Identical seeds yield identical sequences.
 * @returns a generator producing floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle driven by a seeded generator.
 *
 * This is the workhorse of Phase 2's convergence test: we generate N random
 * operations, deliver them to each replica in a *different* random order, and
 * assert every replica ends up with identical text. If the merge is not
 * associative, some orderings will diverge -- which is exactly the bug class
 * that hand-written tests never find.
 *
 * Takes `readonly` input and returns a new array; the source is never mutated,
 * so the same input can be shuffled many times with different seeds.
 *
 * @param items source array, left untouched.
 * @param random a generator returning floats in [0, 1).
 * @returns a new, shuffled array containing exactly the same elements.
 */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];

  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    // Safe under noUncheckedIndexedAccess: i > 0 and j <= i are both in range.
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }

  return out;
}

/**
 * Pick a uniformly random integer in [min, max], inclusive.
 *
 * @throws if `min > max`.
 */
export function randomInt(random: () => number, min: number, max: number): number {
  if (min > max) {
    throw new Error(`randomInt: min (${min}) must be <= max (${max})`);
  }
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Pick a random element.
 *
 * @throws if `items` is empty -- a silent undefined here would poison a fuzz
 * run in a way that is painful to trace later.
 */
export function pick<T>(items: readonly T[], random: () => number): T {
  if (items.length === 0) {
    throw new Error('pick: cannot choose from an empty array');
  }
  const index = Math.floor(random() * items.length);
  return items[index] as T;
}
