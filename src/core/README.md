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

| File                       | Phase | Purpose                                                                                                                                                |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clock.ts`                 | 0, 4  | Element identity and Lamport clocks ([ADR-0003](../../docs/adr/0003-element-identity-site-clock.md), [ADR-0010](../../docs/adr/0010-lamport-clock.md)) |
| `rng.ts`                   | 0     | Seeded randomness, enabling reproducible fuzzing                                                                                                       |
| `crdt/rga.ts`              | 2     | RGA insert/delete, tombstones, per-site undo                                                                                                           |
| `crdt/replica.ts`          | 4     | A document plus its durable operation log. The log is the source of truth ([ADR-0009](../../docs/adr/0009-operation-log-is-the-document.md))           |
| `crdt/diff.ts`             | 4     | Minimal change sets between element snapshots, so a remote keystroke is one edit and not a whole-document replace                                      |
| `crdt/localEdits.ts`       | 4     | Editor edits → CRDT operations, with the running-offset arithmetic isolated and DOM-free                                                               |
| `crdt/seed.ts`             | 4     | Deterministic text → operations, so two devices seeding a document agree                                                                               |
| `crdt/element-snapshot.ts` | 4     | The one shape used to talk about "what the document shows"                                                                                             |
| `crdt/convergence.test.ts` | 2     | **The project's strongest artifact**                                                                                                                   |

## Testing standard for this directory

Coverage percentage is not a meaningful bar here — a CRDT can be 100% covered and
still wrong. The bar is:

1. **Invariant tests** for every property that must hold (convergence,
   commutativity, associativity, idempotence).
2. **A fuzz test** generating thousands of random concurrent operations,
   delivered in a different random order to each replica, asserting identical
   output every time.
3. **Seeded, always.** Every random input records its seed so failures replay.
4. **Convergence is not enough.** Phase 4 shipped a bug the fuzzer provably could
   not catch: every replica agreed on the same _wrong_ document, because a local
   keystroke landed at the end of the file instead of at the caret. So there is
   also a test that walks every offset and asserts a local insert lands exactly
   where it was typed, building its expectation from the original string rather
   than from the CRDT. [ADR-0010](../../docs/adr/0010-lamport-clock.md)

A CRDT that has only example-based tests has not been tested.
