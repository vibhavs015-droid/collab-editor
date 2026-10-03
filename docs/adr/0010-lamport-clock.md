# 0010 — The local clock absorbs every clock it observes

**Status:** Accepted
**Date:** 2026-10-04
**Phase:** 4

**Supersedes:** nothing. Amends the reasoning in ADR-0003, which specified the
`(site, clock)` identity but not how the clock advances.

## Context

ADR-0003 gave every character a `(site, clock)` ID and defined a total order:
lower clock first, ties broken on site. RGA integrates an insert by skipping every
following element with a greater ID, so among siblings the larger ID comes first.

Phase 2 implemented `LogicalClock` with `observe()` restricted to IDs carrying the
local site, and `RgaDocument` never called `observe()` at all.

That is correct for convergence and completely broken for typing.

## Decision

**`observe()` absorbs every observed clock, from every site, and `RgaDocument` calls
it on every applied insert.**

```
tick()   -> clock = clock + 1
observe() -> clock = max(clock, remote.clock)
```

## Rationale

**Without it, a local keystroke lands in the wrong place.** Consider a document
written entirely by a collaborator, elements at clocks 1 to 11. This replica's
counter is still 0.

Typing at offset 7 anchors to element 7 and mints clock 1. Integration skips every
following element with a greater ID — clocks 8, 9, 10, 11 all qualify — so the new
character is placed at the **end of the document** instead of at offset 7.

Nothing crashes. Nothing reports an error. Convergence still holds; every replica
agrees on the same wrong document. This is the class of bug a convergence fuzzer
cannot find, because it converges.

**Convergence and caret correctness are different properties.** Convergence asks
"do all replicas agree?"; correctness asks "does the document match what the user
typed?". A CRDT can satisfy the first and fail the second completely.

**Absorbing another site's clock cannot cause a collision.** IDs are `(site, clock)`
pairs. A counter can only ever collide with another counter from the _same_ site,
and those are already monotonic. A replica cannot mint an ID equal to a
collaborator's no matter how large its counter grows.

**It costs nothing but larger integers.** Clocks stay well inside `Number.MAX_SAFE_INTEGER`
at any realistic typing rate, and `observe()` rejects non-integer and non-finite
values so a malformed operation cannot park a replica's counter somewhere useless.

**The test that proves it walks every offset.** `rga.test.ts` →
`puts a local insert exactly where the user typed` builds the expectation by slicing
the original string rather than by asking the CRDT, so a bug in the CRDT cannot make
the test agree with itself. Two Phase 2 tests had encoded the buggy output and now
assert the correct behaviour.

## Consequences

**Good**

- Local edits land exactly where they were typed, regardless of who wrote the
  surrounding text
- One integration rule for local and remote operations, so there is no second code
  path that could disagree
- A newly connected client immediately sorts past everything it has read

**Bad**

- Concurrent inserts are ordered by descending ID, which means two replicas typing
  at the same offset interleave in clock order rather than wall-clock order. That is
  standard RGA behaviour and deterministic, but it is not "whoever typed first"
- Clock values grow with the largest clock a replica has seen, so a document with a
  high-clock history produces high-clock IDs forever. Harmless, and bounded by
  `Number.MAX_SAFE_INTEGER`
- Phase 2's reasoning, which said advancing on remote clocks "would waste clock
  values and make debug output meaningless", was wrong. It optimised the log at the
  cost of the product

## Alternatives rejected

| Option                                      | Why rejected                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Advance only on the local site              | The bug this ADR exists to fix. Keeps clocks small and puts keystrokes in the wrong place.                                                 |
| Special-case local inserts in the skip rule | Two integration rules means two sets of edge cases, and a bug in either would silently diverge. It also breaks "one algorithm everywhere". |
| Mint a very large clock for every insert    | Same effect but unbounded, and it destroys the property that clocks order local edits.                                                     |
| Let the server assign clocks                | A central sequencer is exactly the dependency this project is removing. Also breaks on reconnect.                                          |
