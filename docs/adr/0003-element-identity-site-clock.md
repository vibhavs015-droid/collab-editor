# 0003 — Element identity is `(site, clock)`

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** Implemented in Phase 0

## Context

Every character inserted into the document must be identifiable, and every
replica must independently derive the same total order over those characters
without any coordination.

Ordering is the whole problem. If two replicas disagree about order, their
documents diverge and there is no way to detect or repair it without a
coordinator — which local-first does not have.

## Decision

Identify each inserted character by an **element ID** of the form `(site, clock)`:

- `site` — a per-replica identifier, stable for the session
- `clock` — a per-replica counter that only ever increases

Order two element IDs by **clock ascending, then site ascending** as the
tie-break. This must be a genuine total order: reflexive, antisymmetric, and
transitive.

## Rationale

**Uniqueness by construction.** Two characters collide only if the same site
issues the same clock twice. `LogicalClock` prevents this by never
reissuing, and by absorbing any echoed remote ID carrying its own site — which
covers reconnects and stale-snapshot restores.

**Local ordering for free.** Because a replica's own clocks only increase, edits
made locally always preserve their relative order, with no extra bookkeeping.

**Why the tie-break must be on site.** When two replicas insert concurrently
there is no causal relationship between them, and delivery order differs per
replica. Arrival time is therefore not an option — each replica would decide
differently. Site is identical on every replica, so comparing it produces the
same verdict everywhere. That is convergence.

**Why transitivity is non-negotiable.** Merge must be associative. If ordering
is only "consistent enough", applying operations in different groupings yields
different results, and documents silently diverge. There is an explicit test:
`compareElementId > is reflexive, antisymmetric, and transitive`.

## Consequences

**Good**

- Total order is provable and unit-tested
- No central authority needed
- Deterministic replay — given the same op set, every replica produces identical output

**Bad**

- Element IDs are immutable and never reused, so IDs grow with total edits
- Lexicographic site comparison means site must be uniformly formatted, or
  ordering becomes arbitrary (though still consistent)
- Tombstones must be retained for deleted elements until causally stable, so
  storage grows over time

## Alternatives rejected

| Option                            | Why rejected                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lamport timestamp alone           | Two replicas can issue the same value. Cross-document uniqueness is the property everything rests on, and this does not provide it.                                                                   |
| Hybrid Logical Clock (HLC)        | Correlates with wall-clock time, which helps human-readable logs. Adds complexity not currently needed. Worth revisiting if timestamps must be meaningful across machines.                            |
| UUID / UUIDv7 per element         | Globally unique with no coordination, but carries no ordering information. Ordering would require a separate comparison that is _not_ stable under concurrent insertion, which is the entire problem. |
| Server-assigned sequence numbers  | Simple and totally ordered, but requires a server in the critical path. Directly incompatible with local-first ([ADR-0001](./0001-local-first-architecture.md)).                                      |
| Fractional indexing (Figma-style) | Elegant for ordered strings, but concurrent inserts at the same position still need a tie-break, and the scheme becomes fragile under heavy concurrency.                                              |
