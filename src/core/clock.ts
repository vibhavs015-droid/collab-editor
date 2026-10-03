/**
 * Logical clocks and element identity — foundational primitives for the
 * sequence CRDT (RGA) built in Phase 2.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 * In a non-CRDT system like Google Docs, the server assigns a total order to
 * every edit, so "which edit came first?" has one obvious answer.
 *
 * In a CRDT there is no server in the hot path. Every replica must derive the
 * *same* total order independently, with zero coordination. We get that by
 * giving every inserted character a globally unique ID of the form
 * (site, clock):
 *
 *   site  — which replica created it (stable per session)
 *   clock — a per-replica counter that never goes backwards
 *
 * Two guarantees make the whole scheme work:
 *   1. No two characters ever share an ID  → IDs are totally unique
 *   2. Within a site, clocks only increase  → local edits keep their order
 *
 * Once every character has a unique, locally-ordered ID, comparing any two
 * IDs gives a deterministic answer that every replica computes identically.
 * That is convergence.
 */

/** Identifies a replica for the lifetime of a session. */
export type SiteId = string;

/** A per-replica monotonic counter. */
export type Clock = number;

/**
 * Uniquely identifies a single inserted character in the document.
 *
 * A type alias rather than an interface, because TypeScript infers an implicit
 * index signature for object type aliases but not for interfaces. ElementId is
 * nested inside an Operation, and an operation has to be assignable to the wire
 * type JsonValue so it can be sent without a cast. An interface at this level
 * would break that all the way up the chain.
 */
export type ElementId = {
  readonly site: SiteId;
  readonly clock: Clock;
};

/**
 * Total order over element IDs.
 *
 * Ordering rule (this IS the algorithm — everything else is bookkeeping):
 *   1. Lower clock sorts first.
 *   2. On equal clocks — i.e. two *concurrent* inserts — break the tie on
 *      site ID, lexicographically.
 *
 * Step 2 is the detail people miss. When two replicas insert at the same
 * position with no causal relationship between them, their delivery order is
 * arbitrary and different on each replica. Comparing site IDs gives both
 * replicas the same answer regardless of arrival order, so the tie resolves
 * identically everywhere.
 *
 * The comparison must be a genuine total order: reflexive, antisymmetric, and
 * transitive. If it is merely "consistent enough", the merge is not
 * associative and documents silently diverge. There is a test for this.
 *
 * @returns negative if `a` precedes `b`, positive if it follows, 0 if equal.
 */
export function compareElementId(a: ElementId, b: ElementId): number {
  if (a.clock !== b.clock) {
    return a.clock < b.clock ? -1 : 1;
  }
  if (a.site === b.site) {
    return 0;
  }
  return a.site < b.site ? -1 : 1;
}

/** Structural equality. Relies on the ID fields being primitives. */
export function elementIdEquals(a: ElementId, b: ElementId): boolean {
  return a.site === b.site && a.clock === b.clock;
}

/** Human-readable form for logs and test failure messages: `"alice@7"`. */
export function formatElementId(id: ElementId): string {
  return `${id.site}@${id.clock}`;
}

/** Canonical string key, for use in Sets and Maps. */
export function elementIdKey(id: ElementId): string {
  return `${id.site}@${id.clock}`;
}

/**
 * A replica's monotonic counter, scoped to one site.
 *
 * Invariant: `current` never decreases for the lifetime of the instance.
 */
export class LogicalClock {
  readonly #site: SiteId;
  #clock: Clock = 0;

  constructor(site: SiteId) {
    if (site.length === 0) {
      throw new Error('LogicalClock requires a non-empty site id');
    }
    this.#site = site;
  }

  /** The site this clock belongs to. */
  get site(): SiteId {
    return this.#site;
  }

  /** Most recently issued clock value. Starts at 0; nothing issued yet. */
  get current(): Clock {
    return this.#clock;
  }

  /**
   * Allocate an ID for a locally-created character.
   *
   * @returns the newly issued ID. Never reused.
   */
  tick(): ElementId {
    this.#clock += 1;
    return { site: this.#site, clock: this.#clock };
  }

  /**
   * Absorb an ID observed from the network, keeping our clock monotonic.
   *
   * Only IDs carrying *our own* site matter. Another replica's counter is
   * that replica's business — advancing ours based on it would waste clock
   * values and make debug output meaningless.
   *
   * Why we must handle our own site coming back: a client may reconnect and
   * be re-sent operations it already produced, or restore from a stale
   * snapshot. Without this, we would re-issue a clock we already spent and two
   * characters would collide on the same ID — which breaks the uniqueness
   * guarantee the entire algorithm rests on.
   *
   * Monotonicity only ever moves forward, never backward.
   */
  observe(remote: ElementId): void {
    if (remote.site === this.#site && remote.clock > this.#clock) {
      this.#clock = remote.clock;
    }
  }
}
