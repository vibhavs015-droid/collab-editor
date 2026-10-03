# 0001 — Local-first architecture

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** Decided during design, implemented in Phase 4

## Context

We need an editor that lets multiple people work in the same document
concurrently, and that survives a device losing network connectivity.

There are two established answers to this problem.

**Server-authoritative.** The server holds the canonical document. Clients hold
a cache and send edits to the server, which orders them and broadcasts the
result. This is how Google Docs works.

**Local-first.** Every device holds the authoritative copy. Edits are applied
locally and immediately, then replicated opportunistically. The server is an
optimisation for finding peers and catching up — never a correctness
requirement.

## Decision

**Local-first.** The device is the source of truth. Sync is best-effort and the
system remains fully functional with the server unreachable.

## Rationale

This is the architectural choice that separates this project from a Google Docs
clone, and it was selected deliberately rather than by default.

Local-first is the harder option, and the difficulty is the point:

1. **It forces real conflict handling to be unavoidable.** In a
   server-authoritative system, ordering is solved by the server. In local-first,
   every device must converge independently. That is the CRDT problem in full,
   and there is nowhere to hide from it.

2. **It produces a genuinely different failure mode.** If the server dies in a
   local-first system, nothing stops. In a server-authoritative system, nothing
   can proceed. This is directly demonstrable, which makes for a compelling demo.

3. **It is where the industry is heading.** Local-first software — Automerge,
   Yjs, and the broader "local-first" movement — is the active research
   direction. Working in it is more defensible than reimplementing a
   server-authoritative system.

Google Docs specifically _cannot_ adopt this design. Their server-side search,
sharing graph, legal discovery, and monetisation all require reading plaintext
on the server. Local-first is not laziness on their part; it is an
architectural conflict.

## Consequences

**Good**

- Works indefinitely offline; no data loss on connectivity loss
- Latency is local, so typing never waits on a network round trip
- The CRDT is exercised continuously rather than only in the rare conflict case
- A clean, defensible answer to "what is different about yours?"

**Bad**

- Genuinely harder. Per-user undo, garbage collection, and storage growth are all
  more complex than they would be server-authoritative.
- Requires a real merge story, not just "last write wins".
- Tombstones cannot be collected until causal stability is reached, so storage
  grows over time.
- No centralised audit log, which some enterprise buyers would object to.

## Alternatives rejected

| Option                              | Why rejected                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-authoritative                | Solves ordering for us, so the hard problem is never faced. This is the thing we are trying to learn.                                                                         |
| Operational Transform (OT)          | Requires a central transform server to resolve concurrency. Incompatible with local-first by construction. Proven at scale (Google Docs) but requires trust in a coordinator. |
| Peer-to-peer only (WebRTC)          | Natural fit for local-first, but NAT traversal makes it unreliable and adds a large surface area. Planned as a possible Phase 6 extension, not the base architecture.         |
| CRDT with last-write-wins per field | Trivially convergent and cheap, but silently discards one user's edit on a true conflict. Data loss is unacceptable for a document editor.                                    |
