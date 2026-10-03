# `docs/benchmarks`

Measured results. Introduced in **Phase 5** (k6 load testing) and **Phase 6**
(CRDT comparison).

## Rules

**A number without its method is marketing.** Every result file must record how
it was obtained, and the method must be reproducible by someone else.

Each benchmark artefact includes:

- exact command used
- hardware and OS
- Node version, commit SHA
- input parameters (concurrency, duration, payload size, seed)
- raw output, not a summary of it

## Planned artefacts

| File                        | Phase | Contents                                           |
| --------------------------- | ----- | -------------------------------------------------- |
| `phase5-load-baseline.md`   | 5     | k6 results against the unoptimised server          |
| `phase5-optimisation.md`    | 5     | Before/after for each fix, one section per change  |
| `phase6-crdt-comparison.md` | 6     | This CRDT vs. Yjs / Automerge under identical load |

## Why publish a benchmark that shows a loss

Because a comparison claiming only wins is not a comparison. Recording where
this implementation is _worse_ than an established library is the cheapest way to
demonstrate intellectual honesty, and it is far more persuasive to a reviewer than
a chart where everything wins.

It also makes the trade-off concrete: the CRDT here is smaller, dependency-free,
and fully understood, and it is slower at high write throughput. Naming that
trade-off yourself is much stronger than having a reviewer find it.
