/**
 * Element resolution after T5.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * T5 changed how `RgaDocument.#indexOfElement` compares element ids: it built `site@clock`
 * strings for every element it inspected, and now it compares the two fields directly. The change
 * was made for speed and is supposed to change nothing else.
 *
 * "Supposed to" is not a property, so this file checks it on seeded random operation sequences
 * rather than on a hand-written case that would pass either way.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS COMPARED, AND WHY IT IS THIS RATHER THAN SOMETHING STRONGER
 * ---------------------------------------------------------------------------
 * Two things, and it is worth being exact about each.
 *
 * 1. The COMPARISON itself: the old string-building lookup and the new field-comparing lookup are
 *    both run over the real element list of a document built from a random sequence, and must
 *    return the same index for every element. This is a direct old-versus-new comparison of the
 *    part that was rewritten.
 *
 * 2. The BEHAVIOUR that depends on it, exercised through the production path: deterministic text,
 *    structural invariants, and agreement between two replicas fed the same operations in
 *    different orders.
 *
 * What this does NOT do is call `#indexOfElement` directly. It is private, and reaching it would
 * mean either exposing it or inferring its return value from where a probe character landed -
 * and the second is a trap, because `#elements` keeps tombstones while `toText()` omits them, so an
 * element index and a character offset are different numbers as soon as the sequence contains a
 * delete. An earlier version of this file made exactly that mistake and failed 13 of 14 tests
 * against correct code.
 *
 * Convergence across arbitrary orderings is `convergence.test.ts`'s job, and T5 requires it to stay
 * unmodified. What this file adds is narrow and deliberate: that the optimisation did not change
 * which element a lookup finds, and that documents it builds still hold together.
 */

import { describe, expect, it } from 'vitest';

import { elementIdKey, type ElementId } from '../clock.js';
import { RgaDocument, type Operation } from './rga.js';

/** The lookup exactly as it was before T5. */
function oldIndexOfElement(elements: readonly { readonly id: ElementId }[], id: ElementId): number {
  const key = elementIdKey(id);

  for (let i = 0; i < elements.length; i += 1) {
    if (elementIdKey(elements[i]?.id ?? { site: '', clock: 0 }) === key) {
      return i;
    }
  }

  return -1;
}

/** The lookup as it is now. The comparison is the only thing T5 changed. */
function newIndexOfElement(elements: readonly { readonly id: ElementId }[], id: ElementId): number {
  for (let i = 0; i < elements.length; i += 1) {
    const candidate = elements[i]?.id;

    if (candidate !== undefined && candidate.site === id.site && candidate.clock === id.clock) {
      return i;
    }
  }

  return -1;
}

/**
 * Deterministic pseudo-random source.
 *
 * mulberry32: small, fast, and identical on every platform, which matters because a failing seed
 * is printed and must replay to the same sequence everywhere.
 */
function rng(seed: number): () => number {
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
 * A random sequence with real concurrency, real anchors and real deletes.
 *
 * Inserts anchor to an existing element about two thirds of the time, so the scan has to find a
 * match at varying depths. Deletes are included because a tombstoned element still has to be
 * found by a later insert's anchor, which is the case a naive "skip deleted" optimisation breaks.
 */
function generate(seed: number, count: number, sites: readonly string[]): Operation[] {
  const random = rng(seed);
  const ops: Operation[] = [];
  const ids: ElementId[] = [];

  let clock = 0;

  for (let i = 0; i < count; i += 1) {
    clock += 1;

    const site = sites[Math.floor(random() * sites.length)] ?? 'site-0';
    const id: ElementId = { site, clock };
    ids.push(id);

    const roll = random();

    if (roll < 0.12 && ids.length > 2) {
      ops.push({ type: 'delete', target: ids[Math.floor(random() * ids.length)] ?? id });
      continue;
    }

    const anchor =
      roll < 0.4 || ids.length === 0 ? null : (ids[Math.floor(random() * ids.length)] ?? null);

    ops.push({ type: 'insert', id, origin: anchor, value: String.fromCharCode(97 + (i % 26)) });
  }

  return ops;
}

function build(ops: readonly Operation[]): RgaDocument {
  const doc = new RgaDocument('observer');
  doc.applyInAnyOrder(ops);
  return doc;
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];

describe('element resolution: old lookup vs new lookup', () => {
  for (const seed of SEEDS) {
    it(`resolves every element to the same index for seed ${seed}`, () => {
      const doc = build(generate(seed, 300, ['alpha', 'beta', 'gamma']));
      const elements = doc.inspect();

      expect(elements.length, `seed ${seed} produced no elements`).toBeGreaterThan(0);

      for (const element of elements) {
        expect(
          newIndexOfElement(elements, element.id),
          `seed ${seed}: ${elementIdKey(element.id)} resolved differently under the two lookups`,
        ).toBe(oldIndexOfElement(elements, element.id));
      }
    });
  }

  it('agrees that an absent id is absent', () => {
    // The lookup throws in production; the reference returns -1. Agreement here means the two
    // agree about WHICH ids are missing, which is the property the string form could have broken.
    const doc = build(generate(7, 200, ['alpha', 'beta']));
    const elements = doc.inspect();

    const absent: ElementId[] = [
      { site: 'alpha', clock: 999_999 },
      { site: 'nobody', clock: 1 },
      { site: '', clock: 0 },
      { site: 'alpha@1', clock: 2 },
    ];

    for (const id of absent) {
      expect(newIndexOfElement(elements, id), `${elementIdKey(id)} should be absent`).toBe(
        oldIndexOfElement(elements, id),
      );
    }
  });

  it('resolves ids whose site contains the separator character', () => {
    // The field comparison is injective over the pair itself. The string form is only injective
    // while `@` cannot occur inside a site id - so if one ever could, the encoding would be doing
    // work the fields already do exactly, and doing it with an extra assumption attached.
    //
    // Both lookups are asked to resolve an id from a list whose sites contain `@`, and must agree.
    const elements = [
      { id: { site: 'a@1', clock: 2 } },
      { id: { site: 'a', clock: 1 } },
      { id: { site: 'b', clock: 3 } },
    ];

    for (const element of elements) {
      expect(newIndexOfElement(elements, element.id)).toBe(oldIndexOfElement(elements, element.id));
    }
  });
});

describe('documents built through the production path still hold together', () => {
  for (const seed of SEEDS) {
    it(`is deterministic and valid for seed ${seed}`, () => {
      const ops = generate(seed, 250, ['alpha', 'beta']);

      const first = build(ops);
      const second = build(ops);

      expect(second.toText(), `seed ${seed} is not deterministic`).toBe(first.toText());
      expect(first.checkInvariants(), `seed ${seed} broke an invariant`).toEqual([]);
    });
  }

  it('two replicas fed the operations in different orders agree', () => {
    // The property the lookup actually serves. Two orders: as generated, and reversed. A lookup
    // that found the wrong element would place a character differently and the texts would differ.
    for (const seed of SEEDS) {
      const ops = generate(seed, 200, ['alpha', 'beta', 'gamma']);
      const reversed = [...ops].reverse();

      const forward = build(ops);
      const backward = build(reversed);

      expect(
        backward.toText(),
        `seed ${seed}: replicas disagreed after the lookup was changed`,
      ).toBe(forward.toText());
    }
  });
});
