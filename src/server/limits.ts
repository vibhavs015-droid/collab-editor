/**
 * Write quotas and rate limits.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE MODULE
 * ---------------------------------------------------------------------------
 * These four numbers are the whole resource-exhaustion story, and they were scattered: one in
 * api.ts, the rest absent. Everything here is a DEFAULT that an environment variable can
 * change, because the right number depends on the deployment and a number baked into the image
 * is a number nobody can change without a release.
 *
 * What they defend against, stated plainly: **one row is stored per character.** A document of
 * N characters is N rows, each carrying a JSON operation. That is fine for a note and ruinous
 * for a paste of a novel, and an anonymous session is obtainable without credentials in open
 * mode. Before this module the only limit anywhere was MAX_CREATE_PER_HOUR, so a single socket
 * could write as fast as the disk allowed.
 *
 * Each limit is sized so that no legitimate use hits it. See `defaults` below for the reasoning
 * on each number, which is the part that matters: a quota that rejects ordinary work gets
 * raised under pressure by whoever is loudest, and then it protects nothing.
 */

/** Code points, not UTF-16 units. See {@link titleTooLong}. */
export const DEFAULT_MAX_TITLE_LENGTH = 200;

/**
 * Operations a single connection may send back-to-back before the bucket is empty.
 *
 * 100,000 is roughly the size of a very large offline flush. The application's own frame cap
 * (MAX_OPS_PER_FRAME) is 1,000, so 100,000 is 100 full frames accepted without waiting. Anything
 * a browser tab can produce in one sitting fits; nothing a script can produce on purpose does.
 */
export const DEFAULT_OPS_BURST = 100_000;

/**
 * Operations per second a single connection may sustain once the burst is spent.
 *
 * 5,000/sec is 300,000/minute, which is about 40x faster than the fastest human typist by an
 * order of magnitude and is above any measured single-client write rate from the load suite. The
 * gap between the two numbers is what stops a flood: a client at the sustained rate needs 20
 * seconds of the burst allowance before it is limited at all, so reconnecting costs it nothing,
 * but a client trying to fill the disk never gets past the bucket.
 */
export const DEFAULT_OPS_PER_SECOND = 5_000;

/**
 * Rows in one document's operation log, past which new elements are refused.
 *
 * 1,000,000 rows is a document about a million characters. At roughly 200 bytes a row that is
 * ~200 MB for one document, which is already past what a free container has - so the cap is a
 * ceiling that stops one document consuming a whole disk, not a target.
 *
 * Deletions are still accepted at the cap. That is what makes the limit recoverable rather than
 * terminal: a user who fills a document can delete from it, and compaction (ADR-0013) then
 * prunes the tombstoned rows. A cap that refused tombstones would leave a full document with no
 * way out of being full.
 */
export const DEFAULT_MAX_DOCUMENT_ELEMENTS = 1_000_000;

/** The four limits, resolved. */
export interface Limits {
  readonly maxTitleLength: number;
  readonly opsBurst: number;
  readonly opsPerSecond: number;
  readonly maxDocumentElements: number;
}

/** The shipped defaults. One object, so a caller can spread and override a single field. */
export const DEFAULT_LIMITS: Limits = {
  maxTitleLength: DEFAULT_MAX_TITLE_LENGTH,
  opsBurst: DEFAULT_OPS_BURST,
  opsPerSecond: DEFAULT_OPS_PER_SECOND,
  maxDocumentElements: DEFAULT_MAX_DOCUMENT_ELEMENTS,
};

/**
 * Read one limit from the environment, falling back to its default.
 *
 * A value that is absent, not a number, not finite, or not a positive whole number uses the
 * default. The asymmetry is deliberate and matches {@link resolveCspMode}: for a LIMIT, the
 * dangerous mistake is a typo silently removing the protection, so an unparseable value
 * becomes the protection rather than the absence of it. An operator who meant 1,000,000 and
 * typed a letter gets the default and a visible limit, not no limit.
 */
function readLimit(value: string | undefined, fallback: number): number {
  const raw = value;

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw.trim());

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Build the limits from an environment.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH VARIABLE IS NAMED LITERALLY RATHER THAN LOOKED UP BY KEY
 * ---------------------------------------------------------------------------
 * A helper taking the variable name as a key is tidier, and it was the first version. It also
 * breaks `scripts/env-example.test.ts`, which fails on a documented-but-unread variable,
 * because the gate finds variables by searching the source for the two access shapes this
 * codebase uses - a bracketed read of the global, and a dotted read of an injected
 * environment. A computed key is invisible to both, so the gate reported four variables the
 * code "ignores" - correctly, from where it stood. (This paragraph once quoted a pattern
 * verbatim, and the gate then found a variable literally called NAME: the same lesson twice.)
 *
 * Naming each one keeps the gate working, makes every variable greppable, and costs four
 * repetitions. The gate is worth more than the tidiness.
 *
 * The environment is a parameter rather than `process.env` so the resolution is testable
 * without mutating global state.
 */
export function resolveLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    maxTitleLength: readLimit(env.MAX_TITLE_LENGTH, DEFAULT_LIMITS.maxTitleLength),
    opsBurst: readLimit(env.OPS_BURST, DEFAULT_LIMITS.opsBurst),
    opsPerSecond: readLimit(env.OPS_PER_SECOND, DEFAULT_LIMITS.opsPerSecond),
    maxDocumentElements: readLimit(env.MAX_DOCUMENT_ELEMENTS, DEFAULT_LIMITS.maxDocumentElements),
  };
}

/** Limits for a test or an embedded caller, with everything at its default. */
export function limitsWith(overrides: Partial<Limits>): Limits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/**
 * Whether a title is over the limit.
 *
 * Counts CODE POINTS, not UTF-16 code units, and the difference is not academic. A title of
 * 100 emoji is 100 characters to a person and 200 to `String.length`. Counting code units would
 * halve the allowance for exactly the users whose titles are most likely to be short and
 * non-Latin, which is the opposite of what a limit is for.
 *
 * `Array.from` spreads by code point, so an astral character is one element and a combining
 * sequence is several - the same thing `String.prototype.length` would do to a Zalgo title if
 * it counted graphemes, and a deliberate trade: a limit exists to bound storage, and storage is
 * what code points bound.
 */
export function titleTooLong(title: string, maxCodePoints: number): boolean {
  return Array.from(title).length > maxCodePoints;
}

/**
 * A token bucket, per connection.
 *
 * ---------------------------------------------------------------------------
 * WHY A BUCKET AND NOT A FIXED WINDOW
 * ---------------------------------------------------------------------------
 * A fixed window ("100 operations per second, reset on the second") lets a client send 100 at
 * 0.999s and 100 again at 1.001s: 200 operations in 2 ms, and 100x the intended rate at every
 * boundary. Buckets have no boundary to exploit. A sliding-window counter has no boundary
 * either but needs a list of timestamps, which is unbounded memory on a connection the process
 * does not otherwise size.
 *
 * The bucket refills continuously rather than in steps, so a client sending at exactly the
 * sustained rate is never limited, at any moment, rather than only on average.
 *
 * Not thread-safe, and does not need to be: one bucket belongs to one WebSocket, and every call
 * arrives on that socket's own event-loop turn. `now` is a parameter so the refill can be
 * tested without sleeping.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #perSecond: number;
  #tokens: number;
  #updatedAt: number;

  constructor(capacity: number, perSecond: number, now: number = Date.now()) {
    this.#capacity = capacity;
    this.#perSecond = perSecond;
    // Start FULL. An empty bucket would make the first request after connecting a failure, and
    // a client that has just paid for a TCP connection and a WebSocket handshake has not yet
    // done anything worth refusing.
    this.#tokens = capacity;
    this.#updatedAt = now;
  }

  /**
   * Ask for `amount`, refilling for elapsed time first.
   *
   * All or nothing: a partial grant would let a client slowly bleed through a burst it was
   * refused, which is the same exhaustion at a lower rate.
   */
  take(amount: number, now: number = Date.now()): boolean {
    // A clock that goes backwards must not refill the bucket to full. Using `Math.max(0, ...)`
    // means a backwards jump simply refills nothing, which is the safe direction.
    const elapsedSeconds = Math.max(0, now - this.#updatedAt) / 1000;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedSeconds * this.#perSecond);
    this.#updatedAt = now;

    if (amount <= 0) {
      return true;
    }

    if (this.#tokens >= amount) {
      this.#tokens -= amount;
      return true;
    }

    return false;
  }

  /** Tokens remaining, rounded down. For tests and for the refusal message. */
  available(now: number = Date.now()): number {
    const elapsedSeconds = Math.max(0, now - this.#updatedAt) / 1000;
    return Math.max(0, Math.floor(this.#tokens + elapsedSeconds * this.#perSecond));
  }
}
