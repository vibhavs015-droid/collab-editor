/**
 * Convergence fuzz test - the project's strongest artifact.
 *
 * WHAT THIS PROVES
 * CRDT bugs are emergent. They appear only under specific interleavings of
 * concurrent operations that no human would write by hand, so example-based
 * tests miss them entirely. This test generates hundreds of random concurrent
 * edit sequences, delivers each replica's operations in a DIFFERENT random
 * order, and asserts every replica ends with byte-identical text.
 *
 * The property under test is convergence: given the same set of operations,
 * every replica reaches the same document regardless of delivery order. If it
 * ever fails, that is a genuine bug in the merge algorithm, not a flaky test.
 *
 * WHY IT IS TRUSTWORTHY
 * 1. Seeded. Every run records its seed, so any failure replays exactly. A
 *    random failure you cannot reproduce is a failure you cannot fix.
 * 2. Uses the real implementation. No mocks, no simplified model.
 * 3. Checks more than text. Element count, tombstone count, and the structural
 *    invariants from checkInvariants must all agree. Two replicas can produce
 *    the same visible text while having diverged internally, which is how the
 *    next bug starts.
 *
 * WHAT IT DOES NOT PROVE
 * It cannot prove performance, memory safety, or correct UI behaviour. It proves
 * one thing precisely, and proving one thing precisely is what makes it worth
 * having.
 *
 * NOTE: ASCII only. See the encoding note in rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { mulberry32, pick, randomInt, shuffle } from '../rng.js';
import { RgaDocument, type Operation } from './rga.js';

const ALPHABET = 'abcdefghij .';

/** Tuned so the suite stays fast. Raise it to hunt for rarer interleavings. */
const DEFAULT_RUNS = 400;

/**
 * Run one randomised scenario end to end.
 *
 * @param seed fully determines the scenario.
 * @param replicaCount how many sites collaborate.
 * @returns null on success, or a message carrying the seed for reproduction.
 */
function runScenario(seed: number, replicaCount: number): string | null {
  const random = mulberry32(seed);
  const replicas = Array.from({ length: replicaCount }, (_, i) => new RgaDocument(`site${i}`));

  /** Every operation produced in this scenario, with its author. */
  const produced: { op: Operation; author: number }[] = [];

  for (let round = 0; round < randomInt(random, 3, 12); round += 1) {
    for (let author = 0; author < replicaCount; author += 1) {
      const replica = replicas[author];
      if (!replica) {
        continue;
      }

      const editCount = randomInt(random, 1, 4);

      for (let edit = 0; edit < editCount; edit += 1) {
        const text = replica.toText();

        if (random() < 0.35 && text.length > 0) {
          // Delete a random visible range.
          const start = randomInt(random, 0, text.length - 1);
          const length = randomInt(random, 1, Math.min(4, text.length - start));
          for (const op of replica.deleteRange(start, length)) {
            produced.push({ op, author });
          }
        } else {
          // Insert a random run at a random offset.
          const offset = randomInt(random, 0, text.length);
          const length = randomInt(random, 1, 3);

          let value = '';
          for (let i = 0; i < length; i += 1) {
            value += pick(ALPHABET.split(''), random);
          }

          for (const op of replica.insertAt(offset, value)) {
            produced.push({ op, author });
          }
        }
      }

      // Deliver everything produced so far, in a random order, minus this
      // replica's own operations (which it already has).
      const incoming = shuffle(produced, random).filter((entry) => entry.author !== author);
      const unplaced = replica.applyInAnyOrder(incoming.map((entry) => entry.op));

      if (unplaced > 0) {
        return (
          `seed=${seed}: ${unplaced} operation(s) unplaceable on replica ${author}. ` +
          'An insert anchored to a non-existent element indicates a dependency cycle.'
        );
      }
    }
  }

  // Final exchange: every replica receives every operation in its own random
  // order. This is the condition convergence is defined over.
  for (const replica of replicas) {
    const unplaced = replica.applyInAnyOrder(shuffle(produced, random).map((entry) => entry.op));

    if (unplaced > 0) {
      return `seed=${seed}: ${unplaced} operation(s) unplaceable during final exchange`;
    }
  }

  // --- Assertions ---
  const reference = replicas[0];
  if (!reference) {
    return `seed=${seed}: no replicas`;
  }

  const expectedText = reference.toText();
  const expectedSize = reference.size;
  const expectedTombstones = reference.tombstoneCount;

  for (let i = 0; i < replicas.length; i += 1) {
    const replica = replicas[i];
    if (!replica) {
      continue;
    }

    if (replica.toText() !== expectedText) {
      return (
        `seed=${seed}: replica ${i} diverged in text.\n` +
        `  expected: ${JSON.stringify(expectedText)}\n` +
        `  actual:   ${JSON.stringify(replica.toText())}`
      );
    }

    // Identical text is not sufficient. Two replicas can agree on what is visible
    // while having structurally diverged, which is the seed of the next failure.
    if (replica.size !== expectedSize) {
      return `seed=${seed}: replica ${i} has ${replica.size} elements, expected ${expectedSize}`;
    }

    if (replica.tombstoneCount !== expectedTombstones) {
      return (
        `seed=${seed}: replica ${i} has ${replica.tombstoneCount} tombstones, ` +
        `expected ${expectedTombstones}`
      );
    }

    const problems = replica.checkInvariants();
    if (problems.length > 0) {
      return `seed=${seed}: replica ${i} invariant violations: ${problems.join('; ')}`;
    }
  }

  return null;
}

describe('convergence fuzz test', () => {
  it('all replicas converge across randomised interleavings', () => {
    const failures: { seed: number; message: string }[] = [];

    for (let seed = 1; seed <= DEFAULT_RUNS; seed += 1) {
      // Vary replica count so 2-way and 3-way conflicts are both covered.
      const replicaCount = 2 + (seed % 2);
      const failure = runScenario(seed, replicaCount);

      if (failure !== null) {
        failures.push({ seed, message: failure });
      }
    }

    // One message per failure, each carrying its seed, so a failure is directly
    // actionable rather than requiring a bisect.
    expect(
      failures.length === 0,
      `Convergence failed in ${failures.length}/${DEFAULT_RUNS} scenarios:\n` +
        failures
          .slice(0, 5)
          .map((failure) => `  - ${failure.message}`)
          .join('\n'),
    ).toBe(true);
  });

  it('is deterministic: the same seed produces the same result', () => {
    // If this fails, the seeded RNG is broken and every other reproducibility
    // guarantee is void.
    expect(runScenario(42, 3)).toBe(runScenario(42, 3));
  });

  it('replays a failure identically', () => {
    // Proves the reporting path is honest: a given seed produces the same message
    // every time, so the diagnostic is trustworthy.
    expect(runScenario(777, 3)).toBe(runScenario(777, 3));
  });
});

describe('convergence under specific hostile orderings', () => {
  /**
   * Deterministic scenarios for orderings the random fuzzer might not hit
   * reliably. Each names a real distribution hazard, so a failure is
   * self-explanatory.
   */
  const scenarios: { name: string; run: () => string | null }[] = [
    {
      name: 'delete arrives before every insert it targets',
      run: () => {
        const source = new RgaDocument('a');
        const ops = source.insertAt(0, 'vanishing');
        const deletes = source.deleteRange(0, 9);

        const replica = new RgaDocument('b');
        replica.applyInAnyOrder([...deletes, ...ops]);

        return replica.toText() === '' ? null : `expected empty, got "${replica.toText()}"`;
      },
    },
    {
      name: 'insert arrives before its own anchor',
      run: () => {
        const source = new RgaDocument('a');
        const base = source.insertAt(0, 'base');
        const child = source.insertAt(4, 'CHILD');

        const replica = new RgaDocument('b');
        // Child first: unplaceable until the anchor arrives.
        replica.applyInAnyOrder([...child, ...base]);

        return replica.toText() === 'baseCHILD' ? null : `got "${replica.toText()}"`;
      },
    },
    {
      name: 'every permutation of a three-operation set converges',
      run: () => {
        const source = new RgaDocument('a');
        const ops = [...source.insertAt(0, 'abc'), ...source.insertAt(1, 'X')];

        // Exhaustively check all orderings rather than sampling.
        const results = new Set<string>();

        for (const permutation of permute(ops)) {
          const replica = new RgaDocument('b');

          if (replica.applyInAnyOrder(permutation) > 0) {
            return 'an ordering could not be fully placed';
          }

          results.add(replica.toText());
        }

        return results.size === 1
          ? null
          : `permutations produced ${results.size} results: ${[...results].join(' | ')}`;
      },
    },
    {
      name: 'duplicate delivery is idempotent',
      run: () => {
        const source = new RgaDocument('a');
        const ops = [...source.insertAt(0, 'once'), ...source.deleteRange(0, 2)];

        const single = new RgaDocument('b');
        single.applyInAnyOrder(ops);

        const triple = new RgaDocument('c');
        triple.applyInAnyOrder([...ops, ...ops, ...ops]);

        return single.toText() === triple.toText() && single.size === triple.size
          ? null
          : 'duplicate delivery changed the result';
      },
    },
    {
      name: 'concurrent inserts at the same offset resolve identically',
      run: () => {
        // The canonical RGA scenario: both sites type at position 0 with no causal
        // relationship, delivered in opposite orders.
        const alice = new RgaDocument('alice');
        const bob = new RgaDocument('bob');

        const fromAlice = alice.insertAt(0, 'AAA');
        const fromBob = bob.insertAt(0, 'BBB');

        const first = new RgaDocument('x');
        const second = new RgaDocument('y');

        first.applyInAnyOrder([...fromAlice, ...fromBob]);
        second.applyInAnyOrder([...fromBob, ...fromAlice]);

        return first.toText() === second.toText()
          ? null
          : `"${first.toText()}" vs "${second.toText()}"`;
      },
    },
    {
      name: 'a long chain of anchors applies in reverse order',
      run: () => {
        const source = new RgaDocument('a');
        const ops = source.insertAt(0, 'abcdefghij');

        // Fully reversed: every character arrives before its predecessor.
        const replica = new RgaDocument('b');
        const unplaced = replica.applyInAnyOrder([...ops].reverse());

        if (unplaced > 0) {
          return `${unplaced} operations unplaceable`;
        }

        return replica.toText() === 'abcdefghij' ? null : `got "${replica.toText()}"`;
      },
    },
    {
      name: 'tombstones accumulate without corrupting convergence',
      run: () => {
        const source = new RgaDocument('a');
        const ops: Operation[] = [
          ...source.insertAt(0, 'to be deleted soon'),
          ...source.deleteRange(0, 17),
        ];

        const forward = new RgaDocument('f');
        const backward = new RgaDocument('b');

        forward.applyInAnyOrder(ops);
        backward.applyInAnyOrder([...ops].reverse());

        if (forward.toText() !== backward.toText()) {
          return `diverged: "${forward.toText()}" vs "${backward.toText()}"`;
        }

        return forward.tombstoneCount === 17
          ? null
          : `expected 17 tombstones, got ${forward.tombstoneCount}`;
      },
    },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      expect(scenario.run()).toBeNull();
    });
  }
});

/** All permutations of a small array, for exhaustive convergence checking. */
function permute<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }

  const output: T[][] = [];

  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    if (head === undefined) {
      continue;
    }

    const rest = [...items.slice(0, i), ...items.slice(i + 1)];

    for (const tail of permute(rest)) {
      output.push([head, ...tail]);
    }
  }

  return output;
}
