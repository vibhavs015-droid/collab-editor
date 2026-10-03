# 0007 — The server relays; it never merges

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** 3

## Context

Phase 3 connects the CRDT to real clients. The server must receive operations
from one client and deliver them to the rest. The obvious question is how much
merge logic belongs there.

There are two plausible designs:

- **Merging server.** The server holds an authoritative document, applies
  operations, and broadcasts the result or the operations.
- **Relay.** The server forwards operations verbatim and keeps no document state.

## Decision

**Relay.** The server holds room membership and nothing else. It never inspects
an operation's meaning, never orders them, and never merges.

## Rationale

**A second merge implementation is a second source of truth.** Convergence is
proven for the CRDT in `src/core/crdt/convergence.test.ts` and nowhere else. A
server-side merge would be a completely separate implementation of the same
algorithm, with its own tests. Two implementations of a subtle algorithm will
eventually disagree, and the failure mode is documents that silently diverge with
no error anywhere.

**The server cannot be authoritative in a local-first system.** That is the
premise of [ADR-0001](./0001-local-first-architecture.md). A server that holds
truth reintroduces exactly the dependency local-first exists to remove: one
machine's outage becomes everyone's outage. [ADR-0004](./0004-envelope-vs-payload-validation.md)
extends the same reasoning to validation — each layer owns its own concern.

**Forwarding is a genuinely easy problem to get right.** Room membership, connection
lifecycle, and backpressure are all straightforward. Merge is the part that
deserves a fuzz test, and the CRDT already has one.

**Reordering is not the server's job.** Operation order is part of what the CRDT
must be robust to, so the relay must not helpfully sort. A test asserts the
server preserves order exactly as sent, because a sorting relay would mask
ordering bugs that the fuzzer would never see.

## Consequences

**Good**

- One merge implementation, one place it can be wrong
- The server has no document state, so it cannot corrupt a document by being
  restarted or losing a write
- The relay is small enough to reason about completely
- Operation order stays under the CRDT's control, which is what makes the
  convergence proof meaningful

**Bad**

- Bandwidth is higher than broadcasting document snapshots, because every
  keystroke becomes an operation that must be sent to every peer. A snapshot
  design would amortise this. Not a concern at Phase 3 scale; Phase 5 measures it
- Reconnect requires replaying the operation log, so the log must be persisted.
  Deferred to Phase 4, and recorded as an open question in the ADR index
- No server-side validation of operations, by design. A malicious client can send
  well-formed but nonsensical operations; the CRDT must tolerate them, and it
  does, because it rejects what it cannot place

## Alternatives rejected

| Option                                      | Why rejected                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Server-authoritative merge                  | Second implementation of the CRDT, reintroduces the dependency local-first removes, and creates two sources of truth that can disagree.    |
| Broadcast document snapshots                | Hides ordering from the CRDT, so the fuzzer tests less than it appears to. Also O(document size) per keystroke per peer.                   |
| Operational Transform on the server         | Requires a central transform authority, which is incompatible with offline editing by construction.                                        |
| CRDT library on the server (Yjs, Automerge) | Functionally identical to a hand-written merge, but the algorithm would then be untested by this project. The CRDT is the point.           |
| Peer-to-peer WebRTC only                    | Natural fit for local-first, but NAT traversal makes it unreliable. Kept as a possible Phase 6 addition rather than the base architecture. |

## Revisit if

Bandwidth measurements in Phase 5 show per-keystroke operation fanout is the
bottleneck. The mitigation then is operation batching or delta compression, not
moving merge authority to the server.
