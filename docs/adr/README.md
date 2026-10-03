# Architecture Decision Records

One file per significant decision. Numbered sequentially, never edited after
acceptance — if a decision changes, write a new ADR that supersedes the old one
and update its status.

## Format

Copy [`0000-template.md`](./0000-template.md) and fill in every section,
including **Alternatives rejected**. That last section is the valuable one: it
records what was considered, which is exactly the reasoning a reviewer cannot
infer from code.

## Rules

1. **Write it when the decision is made.** Reconstructing rationale a month later
   produces plausible fiction rather than the real reasoning.
2. **One decision per file.** A file covering three decisions cannot be
   superseded cleanly.
3. **Never edit an accepted ADR.** Supersede it. The history of how the design
   changed is itself useful signal.
4. **Record consequences honestly,** including the bad ones. An ADR with only
   upsides reads as advocacy, not engineering.

## Index

| #                                                         | Title                                   | Status   |
| --------------------------------------------------------- | --------------------------------------- | -------- |
| [0001](./0001-local-first-architecture.md)                | Local-first architecture                | Accepted |
| [0002](./0002-single-package-layout.md)                   | Single package, not a monorepo          | Accepted |
| [0003](./0003-element-identity-site-clock.md)             | Element identity is `(site, clock)`     | Accepted |
| [0004](./0004-envelope-vs-payload-validation.md)          | Envelope vs. payload validation split   | Accepted |
| [0005](./0005-codemirror-not-handrolled.md)               | CodeMirror 6, not a hand-rolled editor  | Accepted |
| [0006](./0006-pglite-for-local-and-ci.md)                 | PGlite for local/CI, Supabase in prod   | Accepted |
| [0007](./0007-server-is-a-relay-not-a-merge-authority.md) | Server relays, never merges             | Accepted |
| [0008](./0008-jittered-backoff-for-reconnection.md)       | Jittered exponential backoff            | Accepted |
| [0009](./0009-operation-log-is-the-document.md)           | The operation log is the document       | Accepted |
| [0010](./0010-lamport-clock.md)                           | The local clock absorbs observed clocks | Accepted |

## Planned

Roughly where decisions are expected to be needed. Each will be written when the
decision is actually made.

| Phase | Likely decision                                           |
| ----- | --------------------------------------------------------- |
| 4     | Tombstone garbage collection and log compaction           |
| 5     | Observability stack                                       |
| 5     | Auth: real tokens vs. the Phase 3 placeholder             |
| 6     | Server fanout: single process vs. pub/sub broker          |
| 6     | Differentiator: benchmark suite vs. end-to-end encryption |

Two entries from the original plan were resolved without a full ADR, because the
choice was forced rather than weighed:

- **Sync transport**: raw WebSocket, decided in Phase 3. Socket.IO adds a protocol
  the CRDT does not need, and Phase 3's relay already had the frame handling it
  required.
- **Local storage engine**: IndexedDB, decided in Phase 4. ADR-0009 covers the
  reasoning; the brief version is that localStorage is synchronous and capped
  around 5 MB, which is disqualifying for a log that must hold a whole document's
  history.
