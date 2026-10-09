/**
 * Unit tests for the limits: environment resolution, the token bucket, and title length.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS UNIT-TESTED HERE AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * The arithmetic - a bucket refilling, a title counted in code points, a typo falling back - is
 * exact and belongs here, where a test can drive `now` by hand instead of sleeping.
 *
 * Whether the limits are too LOW is not a unit-testable question, and it is the one that
 * matters. That is limits.e2e.test.ts: a 12,000-operation flush at the shipped defaults.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMITS,
  DEFAULT_MAX_DOCUMENT_ELEMENTS,
  DEFAULT_MAX_TITLE_LENGTH,
  DEFAULT_OPS_BURST,
  DEFAULT_OPS_PER_SECOND,
  TokenBucket,
  resolveLimits,
  titleTooLong,
} from './limits.js';

describe('shipped defaults', () => {
  it('are the numbers the instructions specify', () => {
    // Pinned rather than derived from the constants, because the point is that these VALUES
    // were chosen and reviewed - not that they are internally consistent.
    expect(DEFAULT_MAX_TITLE_LENGTH).toBe(200);
    expect(DEFAULT_OPS_BURST).toBe(100_000);
    expect(DEFAULT_OPS_PER_SECOND).toBe(5_000);
    expect(DEFAULT_MAX_DOCUMENT_ELEMENTS).toBe(1_000_000);
  });

  it('are large enough for the work a browser tab actually produces', () => {
    // The application's own frame cap is 1,000 operations, so the burst allows 100 full frames
    // back to back with no refill at all. If MAX_OPS_PER_FRAME ever rose by more than 100x the
    // burst would need raising with it, and this is where that coupling becomes visible.
    expect(DEFAULT_OPS_BURST % 1_000).toBe(0);
    expect(DEFAULT_OPS_BURST / 1_000).toBeGreaterThanOrEqual(100);
  });

  it('let a client run at the sustained rate for twenty seconds on the burst alone', () => {
    // The gap between burst and sustained rate is the anti-flood property: reconnecting costs
    // a legitimate client nothing, while a client that never stops still runs out.
    const seconds = DEFAULT_OPS_BURST / DEFAULT_OPS_PER_SECOND;

    expect(seconds).toBeGreaterThanOrEqual(20);
  });
});

describe('resolveLimits', () => {
  it('reads every variable it documents', () => {
    const resolved = resolveLimits({
      MAX_TITLE_LENGTH: '10',
      OPS_BURST: '20',
      OPS_PER_SECOND: '30',
      MAX_DOCUMENT_ELEMENTS: '40',
    });

    expect(resolved).toEqual({
      maxTitleLength: 10,
      opsBurst: 20,
      opsPerSecond: 30,
      maxDocumentElements: 40,
    });
  });

  it('falls back to the defaults when the environment is empty', () => {
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS);
  });

  it('tolerates surrounding whitespace', () => {
    // An operator writing a value into a YAML block or a systemd unit will have a space in it
    // at some point, and " 5000 " failing closed is a bad first experience.
    expect(resolveLimits({ OPS_PER_SECOND: ' 5000 ' }).opsPerSecond).toBe(5_000);
  });

  it('falls back rather than accepting a value that is not a number', () => {
    // The dangerous mistake is a typo silently REMOVING a limit, so an unparseable value
    // becomes the limit rather than the absence of it. Accepting Number('abc') as NaN, or as 0,
    // would leave a deployment with either a broken comparison or no protection at all.
    expect(resolveLimits({ OPS_BURST: 'many' }).opsBurst).toBe(DEFAULT_OPS_BURST);
    expect(resolveLimits({ OPS_BURST: '' }).opsBurst).toBe(DEFAULT_OPS_BURST);
    expect(resolveLimits({ OPS_BURST: 'Infinity' }).opsBurst).toBe(DEFAULT_OPS_BURST);
    expect(resolveLimits({ OPS_BURST: 'NaN' }).opsBurst).toBe(DEFAULT_OPS_BURST);
    expect(resolveLimits({ OPS_BURST: '10.5' }).opsBurst).toBe(DEFAULT_OPS_BURST);
    expect(resolveLimits({ OPS_BURST: '0x1000' }).opsBurst).toBe(4_096);
  });

  it('accepts exponent notation, because it is a number', () => {
    // `1e6` is a completely reasonable thing to write in a config file, and rejecting it would
    // mean a deployment silently ran on the default instead of the value its operator chose.
    // An earlier version of this test asserted it was rejected; that was the test being wrong
    // about what a number is.
    expect(resolveLimits({ MAX_DOCUMENT_ELEMENTS: '1e6' }).maxDocumentElements).toBe(1_000_000);
  });

  it('rejects a zero or negative limit rather than disabling the protection', () => {
    // A limit of 0 would refuse every operation, and a negative one would refuse them all too -
    // in both cases the server looks configured and is unusable. Falling back is the only
    // outcome that is either working or obviously wrong.
    expect(resolveLimits({ MAX_TITLE_LENGTH: '0' }).maxTitleLength).toBe(DEFAULT_MAX_TITLE_LENGTH);
    expect(resolveLimits({ MAX_TITLE_LENGTH: '-1' }).maxTitleLength).toBe(DEFAULT_MAX_TITLE_LENGTH);
    expect(resolveLimits({ MAX_DOCUMENT_ELEMENTS: '0' }).maxDocumentElements).toBe(
      DEFAULT_MAX_DOCUMENT_ELEMENTS,
    );
  });
});

describe('TokenBucket', () => {
  it('starts full, because an empty bucket refuses the first request after connecting', () => {
    const bucket = new TokenBucket(100, 10, 0);

    expect(bucket.take(100, 0)).toBe(true);
  });

  it('refuses once the burst is spent', () => {
    const bucket = new TokenBucket(100, 10, 0);

    expect(bucket.take(100, 0)).toBe(true);
    expect(bucket.take(1, 0)).toBe(false);
  });

  it('refills continuously rather than in steps', () => {
    // A bucket that refilled in whole seconds would refuse a client sending at exactly the
    // sustained rate for the first fraction of every second. This asserts the property that
    // prevents that: 100ms of refill pays 10% of a second of tokens.
    const bucket = new TokenBucket(100, 10, 0);

    bucket.take(100, 0);

    expect(bucket.take(1, 100)).toBe(true);
    expect(bucket.take(1, 199)).toBe(false);
  });

  it('caps the refill at the burst, so an idle socket cannot bank unlimited credit', () => {
    // Without the cap, a connection that sat idle for an hour could then send an unbounded
    // burst, which is precisely what the burst exists to bound.
    const bucket = new TokenBucket(100, 10, 0);

    bucket.take(100, 0);
    expect(bucket.take(100, 3_600_000)).toBe(true);
    expect(bucket.take(1, 3_600_000)).toBe(false);
  });

  it('is all or nothing', () => {
    // A partial grant would let a client slowly bleed through a burst it was refused, which is
    // the same exhaustion at a lower rate - just slower and harder to see.
    const bucket = new TokenBucket(100, 0, 0);

    expect(bucket.take(60, 0)).toBe(true);
    expect(bucket.take(51, 0)).toBe(false);
    // Nothing was consumed by the refusal, so the remaining 40 are still spendable. If the
    // refusal had taken 40 and failed, the next 40 would be gone too and a client could
    // starve itself one refused frame at a time.
    expect(bucket.take(40, 0)).toBe(true);
    expect(bucket.take(1, 0)).toBe(false);
  });

  it('does not refill when the clock moves backwards', () => {
    // NTP steps and suspended laptops both produce this. A backwards jump must not hand out free
    // tokens, and using the older timestamp means the next forward step is simply a smaller
    // refill - the safe direction.
    const bucket = new TokenBucket(100, 10, 10_000);

    bucket.take(100, 10_000);
    expect(bucket.take(100, 5_000)).toBe(false);
    expect(bucket.take(100, 5_000)).toBe(false);
  });

  it('treats a request for nothing as always allowed', () => {
    // The relay charges the size of every frame, and an empty `ops` array is a legal message.
    // Refusing it would close a connection for sending nothing.
    const bucket = new TokenBucket(0, 0, 0);

    expect(bucket.take(0, 0)).toBe(true);
    expect(bucket.take(-1, 0)).toBe(true);
  });

  it('reports the balance for the refusal message', () => {
    const bucket = new TokenBucket(100, 10, 0);

    bucket.take(100, 0);

    expect(bucket.available(0)).toBe(0);
    expect(bucket.available(500)).toBe(5);
  });
});

describe('titleTooLong', () => {
  const LIMIT = 200;

  it('accepts a title of exactly the limit', () => {
    expect(titleTooLong('x'.repeat(LIMIT), LIMIT)).toBe(false);
  });

  it('rejects one character past it', () => {
    // The boundary in both directions, because a limit that is off by one either rejects a
    // legitimate title or silently allows the next size up.
    expect(titleTooLong('x'.repeat(LIMIT + 1), LIMIT)).toBe(true);
  });

  it('counts CODE POINTS, so an emoji title gets the same allowance', () => {
    // `String.length` on this string is 400, not 200. Counting UTF-16 units would halve the
    // allowance for exactly the users whose titles are short and non-Latin, which is the
    // opposite of what a limit is for.
    const emoji = '\u{1F600}'.repeat(LIMIT);

    expect(emoji.length).toBe(LIMIT * 2);
    expect(titleTooLong(emoji, LIMIT)).toBe(false);
    expect(titleTooLong('\u{1F600}'.repeat(LIMIT + 1), LIMIT)).toBe(true);
  });

  it('counts a mixed-script title the same way a person would', () => {
    // 199 ASCII characters and one emoji: 200 code points, 201 UTF-16 units. A `String.length`
    // check would already have refused this, so the emoji is the whole point.
    const mixed = `${'x'.repeat(199)}\u{1F600}`;

    expect(mixed.length).toBe(201);
    expect(titleTooLong(mixed, LIMIT)).toBe(false);
    expect(titleTooLong(`${mixed}z`, LIMIT)).toBe(true);
  });

  it('accepts an empty title', () => {
    // Nothing to limit, and rejecting it would break every client that sends `title: ''`.
    expect(titleTooLong('', LIMIT)).toBe(false);
  });
});
