# 0009 — The operation log is the document

**Status:** Accepted
**Date:** 2026-10-04
**Phase:** 4

## Context

Phases 1 through 3 stored the document as plain text and added a relay beside it.
That is not offline-first:

- **Phase 1** saved text to the server on a debounce. Closing the tab inside the
  debounce window lost the last edit.
- **Phase 3** forwarded operations over a WebSocket, but the relay held them in
  memory. A restart lost everything it had not written anywhere.

Both designs make the server part of the write path. A document that cannot be
written while the server is absent is not offline-first; it is online-first with a
cache.

The usual repair is to queue operations in the client and replay them on
reconnect. That fixes delivery but not _ordering_: operations produced while
offline have no relationship to the ones produced before the disconnect, and
replaying a queue cannot recover an interleaving that was never recorded.

## Decision

**The operation log is the document. Text is a projection of it.**

```
keystroke → Replica → IndexedDB        durable, synchronous, always
          → EditorBinding diff         what the user sees
          → SyncTransport outbox       best effort, retried with backoff
          → server operation log       authoritative history
```

Three properties follow, and each one is load-bearing:

1. **The log is append-only and per-client.** Local and remote operations are
   recorded in the same place. Remote operations _must_ be logged too, or a reload
   loses everything a collaborator typed.

2. **The document is rebuilt by replaying the log, never by diffing text.** Text
   diffing cannot express "these two characters were inserted concurrently", which
   is the only question that matters when two people typed at once.

3. **`documents.content` becomes a derived cache.** It is rebuilt from the log and
   is disposable. It still exists because the HTTP API needs something to return
   before a client has connected, and because rebuilding text on every read would
   make every GET O(document size).

On the server, each open document holds one CRDT replica. It exists for two
reasons, and neither is collaboration:

- materialising text for the cache, without replaying the whole log per read
- rejecting a write it cannot replay, at write time rather than leaving the log
  permanently unreplayable

The relay still never merges and never sends a merged result (ADR-0007). Clients
converge among themselves; a client that receives fewer operations than the server
stored asks for them and catches up.

## Rationale

**A log is the only representation that survives losing the network.** A text
snapshot describes a moment. A log describes a history, and a history can be
replayed into any replica that has missed part of it.

**Recording remote operations locally is what makes reload safe.** A client that
logs only its own edits would show correct text while connected and lose
everything else on reload. That is the failure the IndexedDB adapter's tests are
built around: `logs remote operations too`.

**Deriving text rather than storing it makes divergence detectable.** If the cache
and the log ever disagree, `materializeContent()` proves which one is right. With
text as the source of truth there is nothing to check against, and the two
representations drift silently.

**Sequence numbers are assigned by the database.** `seq` doubles as the replay
cursor, so if clients chose their own sequence numbers two clients could claim the
same one and the total order would be gone.

**Dedup is enforced by a unique index, not by a check.** A relay that reconnects
hands the server the same operation twice. `ON CONFLICT DO NOTHING` makes that a
non-event; an existence check would be a race.

## Consequences

**Good**

- "Kill the server, keep typing, restore, nothing lost" is now true, and tested
  end to end against a real relay and a real database
  (`src/server/offline.e2e.test.ts`)
- A reload is a replay, not a fetch, so it works with the network down
- The text cache is repairable by construction
- A device offline for a week reconciles by replaying, not by guessing

**Bad**

- Every character is one row in `document_ops`. A 10,000-character document is
  10,000 JSONB rows. Fine at this scale; it needs compaction (tombstone
  squashing plus a periodic snapshot) before it is fine at 100,000
- Replaying a long history costs memory on the client. The IndexedDB adapter caps
  stored entries, but pruning breaks replay, so the cap currently prunes only
  against a hard ceiling rather than a policy
- The log grows monotonically. Nothing in Phase 4 deletes anything
- `materializeContent()` is O(document) and exists mainly as a repair tool, which
  means the relay's replica and the log can disagree if the replica is evicted
  mid-write. It is not, so this is theoretical today

## Alternatives rejected

| Option                                     | Why rejected                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Queue operations in memory                 | Lost on reload. Fixes delivery, not ordering.                                                             |
| Diff text to merge                         | Cannot distinguish concurrent inserts from sequential ones. That distinction is the whole problem.        |
| Text snapshot on the server only           | Requires the server for every keystroke, which is the thing being escaped.                                |
| Store the log but keep text authoritative  | Two sources of truth. They diverge, and there is no way to tell which is wrong.                           |
| Server assigns sequence numbers per client | Two clients can claim the same sequence, and the replay cursor stops meaning anything.                    |
| Content-addressed seed site                | Two documents with identical bodies would share element IDs, and text would leak from one into the other. |
