# 0011 — Snapshot compaction gated on causal stability

**Status:** Accepted
**Date:** 2026-10-04
**Phase:** 5

## Context

ADR-0009 made the operation log authoritative. That is what makes offline-first
work, and it has a cost that ADR-0009 recorded as a limitation rather than a
solution:

> Every character is one row in `document_ops`. A 10,000-character document is
> 10,000 JSONB rows. Fine at this scale; it needs compaction (tombstone
> squashing plus a periodic snapshot) before it is fine at 100,000.

Nothing in Phase 4 deletes anything. Typing and then deleting a paragraph leaves
every character in the log forever. Two documents that are textually identical
differ in size by the total number of edits ever made to them.

This is not only a storage problem. An unpaginated, unbounded, ever-growing log is
also why the Phase 5 load tests would have measured database growth rather than
collaboration. Compaction has to come before the numbers mean anything.

## The hard part is not storage

A naive implementation deletes old operations and stores a snapshot of the text.
That is wrong in three distinct ways, and each one is silent.

**A tombstone is load-bearing.** RGA integrates an insert by finding its `origin`
element. If an element is removed from the document and a lagging peer sends an
insert anchored to it, the server must still know the element existed — otherwise
the insert is unplaceable and the peer is permanently, silently behind. This is
the same pending-delete case `RgaDocument` already handles, and dropping the
element just moves the failure somewhere less obvious.

**Pruning what a peer still needs loses data.** A peer that has been offline for
a week holds a cursor far behind the server's. Pruning below that cursor means it
can never catch up, and the only way it discovers this is by receiving a document
it cannot reconcile.

**Replacing a peer's document with a snapshot destroys its unsent work.** This is
the one that makes offline-first genuinely hard. A snapshot is authoritative: it
says "this is the document". Handing it to a client that has operations the
server has not seen yet silently deletes those operations — the client believes
they are saved, and they are not.

## Decision

**Compact with snapshots, and only prune below a point no peer can still need.**

Three pieces, each solving one of the failures above.

### 1. A snapshot preserves element identity, and re-anchors it

A snapshot is the live element set at a sequence:

```ts
interface DocumentSnapshot {
  readonly seq: number; // the log sequence this state corresponds to
  readonly elements: readonly {
    id: ElementId;
    value: string;
    origin: ElementId | null;
    deleted?: boolean;
  }[];
}
```

Element IDs are preserved, so future inserts can anchor to elements the snapshot
created. A text-only snapshot would have no anchors and every subsequent operation
would be unplaceable.

**Each live element is re-anchored to its nearest live ancestor**, rather than
keeping the origin it was originally created with. This is the part that makes
compaction reclaim anything, and getting it wrong in either direction is a real
bug:

- Keeping original origins means carrying every tombstone, because a live element
  frequently anchors to a deleted one. Delete "quick" from "the quick brown fox"
  and the space before "brown" is still visible but was created as a child of the
  deleted "k". So compaction would reclaim nothing on exactly the documents that
  need it most — the heavily edited ones.
- Chaining purely by position would move that space, and the move would be silent.

Re-anchoring is safe: document order is preserved because elements are emitted in
order; relative order among siblings is preserved because the integration rule
compares only the two IDs being ordered; and a later insert anchoring to element X
lands identically, because X's position in the document has not changed. Only X's
history differs.

Tombstones are carried **only** when an operation following the snapshot names
one — an insert anchored to a deleted character. Their own ancestors are not
carried, because a carried tombstone is re-anchored like everything else.

### 2. The causal stability floor is the minimum acknowledged cursor

Every client acknowledges what it has applied, by sequence. The server keeps the
minimum across connected clients, and prunes only below that:

```
floor = min(acknowledged cursors of connected clients)
prune ops with seq <= floor
```

A peer offline for a week is not connected, so it does not hold the floor up. It
is protected by a different mechanism — see (3).

### 3. A peer below the floor gets the snapshot, and only when it is safe

If a client's cursor is below the oldest retained sequence, the server cannot
serve it a delta. It serves a snapshot instead, and the protocol makes the
client's obligation explicit:

```
client → server   resync(sinceSeq = C)
server → client   snapshot(seq = S, elements)     when C < oldest retained
server → client   ops(seq = S+1 …)                then the delta
```

The client applies the snapshot **only if its outbox is empty**. If it has
unsent operations, it flushes first and re-requests. A client that has unsent
work is never handed a snapshot, because a snapshot would discard that work.

This is the whole reason the outbox is exposed as a count rather than being an
internal detail.

## Rationale

**Causal stability is the standard condition, and it is sufficient.** An operation
can only be referenced by an operation that causally follows it. Once every live
peer has acknowledged past a sequence, no operation that could reference anything
below it can still arrive. This is the same argument as vector-clock-based garbage
collection, expressed in one integer per peer because the server already assigns a
total order.

**The floor is computed, not configured.** A configurable retention window is a
guess about how long peers stay offline. Causal stability is a fact about the
peers that are actually connected.

**Snapshots preserving IDs means compaction is transparent to the CRDT.** The
snapshot replays through the same `applyInAnyOrder` path as ordinary operations.
No second code path, no "snapshot mode", nothing extra to test.

**The empty-outbox precondition makes snapshot application safe.** It is stated in
the protocol rather than assumed, so a client bug that sends a resync while holding
unsent work fails a test instead of losing a user's document.

**Compaction is triggered by shape, not by size.** The trigger is "tombstones
exceed a fraction of the log", because that is the condition where compaction
actually buys something. Triggering on raw size would compact a document that is
mostly live text and has nothing to reclaim.

## Consequences

**Good**

- The log stops growing without bound
- A document edited a thousand times stores roughly its current size, not a thousand
  times its size
- Offline peers are still protected, by the snapshot path rather than by retention
- Load-test numbers describe collaboration rather than table growth
- `materializeContent` remains meaningful: it rebuilds from whatever the log retains

**Bad**

- A peer that is offline long enough to fall below the floor must be served a
  snapshot, which is a larger frame than a delta. Bounded by how long a document
  sits un-compacted while someone is away
- Snapshots are stored per document, so the total snapshot storage grows with
  document count. Only the newest is kept; older ones are deleted
- The floor depends on every client acknowledging honestly. A client that claims to
  have applied a sequence it has not will cause the server to prune too far. The
  acknowledgement is the client's own report and is not verified
- Compaction adds a write path. A crash between "snapshot written" and "old ops
  deleted" leaves both, which is wasteful but correct — never incorrect

## Alternatives rejected

| Option                                      | Why rejected                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Text-only snapshots                         | No element IDs, so every subsequent insert is unplaceable. Silent, permanent corruption.                              |
| Time-based retention ("keep 7 days")        | A guess about peer behaviour rather than a fact about peers. Deletes data for anyone offline longer, silently.        |
| Prune immediately, serve snapshots always   | Throws away delta serving entirely and makes every reconnect O(document).                                             |
| Server-only compaction, no client awareness | A client below the floor would have to guess. The obligation to flush before accepting a snapshot has to be explicit. |
| Delete tombstones eagerly                   | Breaks anchoring for any insert that references one. The failure is unplaceable operations, not a visible error.      |
| Compact in the client only                  | The client's log is bounded by IndexedDB already; the unbounded log is the server's.                                  |
