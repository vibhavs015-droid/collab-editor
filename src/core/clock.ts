/**
 * Logical clocks and element identity -- foundational primitives for the
 * sequence CRDT (RGA) built in Phase 2.
 *
 * -- Why this file exists ------------------------------------------------
 * In a non-CRDT system like Google Docs, the server assigns a total order to
 * every edit, so "which edit came first?" has one obvious answer.
 *
 * In a CRDT there is no server in the hot path. Every replica must derive the
 * *same* total order independently, with zero coordination. We get that by
 * giving every inserted character a globally unique ID of the form
 * (site, clock):
 *
 *   site  -- which replica created it (stable per session)
 *   clock -- a per-replica counter that never goes backwards
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
 * Ordering rule (this IS the algorithm -- everything else is bookkeeping):
 *   1. Lower clock sorts first.
 *   2. On equal clocks -- i.e. two *concurrent* inserts -- break the tie on
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
 * -- Why this is a Lamport clock -------------------------------------------
 * The counter advances past every clock this replica has *seen*, not only past
 * its own. That is not cosmetic; without it a local edit lands in the wrong
 * place.
 *
 * RGA integrates an insert by skipping every following element with a greater ID
 * (ADR-0003), so among siblings the larger ID comes first. If this replica's
 * counter sat at 3 while a collaborator's characters were at 7 and 8, typing
 * between two of that collaborator's characters would produce a new ID smaller
 * than both, and the integration rule would place it *after* them. The user would
 * see their keystroke jump past the text it was typed directly in front of.
 *
 * Advancing past observed clocks makes every local ID larger than everything seen
 * so far, which is exactly the condition under which the integration rule places
 * it immediately after its anchor.
 *
 * Absorbing another site's counter costs nothing in correctness: IDs are
 * `(site, clock)` pairs, so a counter can only ever collide with another from the
 * *same* site. A replica can never collide with a collaborator, however large its
 * counter grows.
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
   * Absorb a clock observed from the network, keeping ours monotonic.
   *
   * Monotonicity only ever moves forward. The shape is guarded as well as the
   * magnitude: a malformed operation carrying a huge or fractional clock must not
   * be able to push this replica's counter somewhere useless, since every
   * subsequent local insert would then be unable to sort past it and caret
   * positioning would be subtly wrong for the rest of the session.
   */
  observe(remote: ElementId): void {
    if (Number.isSafeInteger(remote.clock) && remote.clock > this.#clock) {
      this.#clock = remote.clock;
    }
  }
}
