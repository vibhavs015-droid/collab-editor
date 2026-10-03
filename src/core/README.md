# `src/core`

Pure CRDT logic. **No I/O, no DOM, no Node APIs, no timers, no network.**

This is the heart of the project and the part that must be provably correct.

## Why the constraint is absolute

The CRDT is the only component where a subtle bug causes _silent, permanent data
loss_. If a merge is wrong, there is no error message — two replicas simply
disagree and nobody finds out until much later, possibly in someone else's
document.

Keeping it pure buys three things:

1. **Tests run in milliseconds.** No server, no browser, no mocks. Thousands of
   fuzz cases per second, so CI can run them on every push.
2. **Failures are reproducible.** Pure functions of their inputs, so a failing
   seed replays exactly.
3. **Bugs are findable.** A wrong answer points at a line of logic, not at an
   interaction between six subsystems.

If CRDT logic ever needs `fetch` or `document`, that is a design failure, not a
testing inconvenience.

## Files

| File                       | Phase | Purpose                                                                                              |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `clock.ts`                 | 0     | Element identity and logical clocks ([ADR-0003](../../docs/adr/0003-element-identity-site-clock.md)) |
| `rng.ts`                   | 0     | Seeded randomness, enabling reproducible fuzzing                                                     |
| `crdt/`                    | 2     | RGA insert/delete, tombstones, per-user undo                                                         |
| `crdt/convergence.test.ts` | 2     | **The project's strongest artifact**                                                                 |

## Testing standard for this directory

Coverage percentage is not a meaningful bar here — a CRDT can be 100% covered and
still wrong. The bar is:

1. **Invariant tests** for every property that must hold (convergence,
   commutativity, associativity, idempotence).
2. **A fuzz test** generating thousands of random concurrent operations,
   delivered in a different random order to each replica, asserting identical
   output every time.
3. **Seeded, always.** Every random input records its seed so failures replay.

A CRDT that has only example-based tests has not been tested.
