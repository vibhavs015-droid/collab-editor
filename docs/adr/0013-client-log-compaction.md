# 0013 - Client log compaction by snapshot, never by truncation

**Status:** Accepted

## Context

The client keeps its operation log in IndexedDB and the log is authoritative
(ADR-0009). Two facts then combine badly:

1. `IndexedDbOperationLog.append` ended with `await this.prune()`, which deleted the
   oldest entries once the store passed a 50,000-entry cap. So **every write could
   trigger deletion**.
2. An RGA insert names the element it anchors to.

Together those mean a pruned log refers to elements that no longer exist.
`Replica.init()` replays with `applyInAnyOrder` and refuses to guess: it counts the
unplaceable operations and **throws**. The next page load fails to open the document.

This was not a theoretical risk found by reading. It was found by writing the test that
compaction was supposed to pass, and watching the reload-after-prune case throw.

The existing coverage made it invisible. It asserted **seq contiguity** after pruning.
Contiguity is true after a prefix delete - it is contiguity of the counter, not integrity
of the history - and it says nothing about whether the anchors survive.

ADR-0011 solves the identical problem on the **server**, with the snapshot machinery
already written and already proven under load. The client needed the same answer and had
none.

## Decision

### 1. The client compacts by snapshot-and-truncate, never by truncating

`Replica.snapshot(retainTombstones)` produces the live element set with **original element
IDs**, re-anchored to the nearest live ancestor, using `createSnapshot` unchanged.
`snapshotToOperations` expresses it as ordinary operations.

Those operations are written into the **same IndexedDB store** as the history and the
stale entries are deleted in **one transaction**. There is no "replay the snapshot first"
special case, because once written the snapshot is indistinguishable from history.

Writing it to a separate store would mean two reads and a consistency question on every
reload, and `Replica.init()` loads exactly one store.

### 2. `append` never prunes

The bound is enforced by `Replica.compactLog()`, which can see the document. Enforcing it
inside `append` put the decision in the one place that cannot see what it is deleting.

`IndexedDbOperationLog.prune()` still exists, because `OperationLog` requires it and
because pruning a log that is already entirely below the cap is harmless. It is no longer
called automatically, and its doc comment says why it is not the same thing as compaction.

### 3. The snapshot write and the truncate are one transaction

Done separately there is a failure mode that destroys the document: crash after the
truncate, and the log holds a tail whose inserts anchor to elements the snapshot would
have carried. Unrecoverable without a backup, and a browser tab closing mid-compaction is
not exotic.

### 4. The unsent queue is a parameter, never inferred

`compactLog({ keepAtLeast, unsent })`. An unsent delete naming an element the snapshot
drops can never be sent and never applied: silent divergence from the server, invisible
until someone reads the document back.

The transport is the only component that knows which operations the server has
acknowledged, so it supplies them. `SyncTransport` gained a `queuedOperations` getter
because it previously exposed only a count, which is not enough to answer "which
tombstones must be carried".

`createSnapshot` is given the unsent operations as `retainTombstones`, which is exactly
the parameter the server's `decideCompaction` already uses for the same purpose.

### 5. Compaction refuses rather than producing an unusable log

`snapshotCovers` is checked against the retained tail first. If the snapshot cannot carry
everything the tail references, compaction is declined and the log is untouched. The
refusal is also self-clearing: once enough later operations push the offending delete
below the floor, the tail stops containing it and compaction proceeds.

### 6. Compaction is triggered on `onSyncState === 'synced'`, not on socket state

A socket can be open while operations are still queued. Compacting then would drop
tombstones the queued deletes need. `main.ts` also gates on a cheap `log.count()` against
a 5,000-entry threshold, because `compactLog` reads the whole log and doing that on every
sync to discover there is nothing to do would be the expensive part.

## Rationale

The alternative was to leave the 50,000-entry cap and hope no document reaches it. That is
rejected because the failure is not "history is lost, so a late peer gets a full
snapshot". It is "the document will not open", on the device that has the user's work in
it, with no local backup.

Reusing ADR-0011's machinery rather than writing a second implementation is the whole
point. A client-side RGA or snapshot written to match would be a second, separately wrong
implementation of the algorithm, disagreeing for reasons that have nothing to do with the
real CRDT - the mistake this project has already had to undo once.

The threshold of 5,000 is chosen from what compaction costs and saves. A snapshot element
becomes one stored operation, so a 5,000-entry log on a 1,000-character document costs
roughly ten times what the text needs. It is well above a normal working session, so
compaction is rare rather than constant - which matters because it rewrites the log.

## Consequences

**Good**

- The log stops growing without bound on the device, not just on the server
- A reload after compaction reproduces the document exactly, which is tested against the
  real `Replica`
- An element whose creating operation was dropped can still be anchored to, because IDs
  are preserved
- An unsent edit can never be dropped by compaction

**Bad**

- Compaction is a full read and a full rewrite. Triggering it on every sync would be a
  performance problem, which is why it is threshold-gated
- **Compaction can make a small log longer.** A snapshot element is one stored operation; a
  carried tombstone is an insert _and_ a delete. On a document whose history is barely
  longer than its text, compaction produces a bigger log. This is tested explicitly,
  because the first response to seeing the log grow is to assume compaction is broken and
  turn it off
- A seq gap can remain after compaction when the snapshot is larger than the space
  available before the tail. Closing it would mean renumbering retained entries, and those
  numbers are what a transport cursor and a server replay cursor are expressed in.
  `init()` does not require contiguity, so the gap costs tidiness only
- `snapshotText()` returns the concatenation of _all_ elements including carried
  tombstones, so for a snapshot of `acd` carrying the tombstone for `b` it returns
  `abcd`. Correct for its purpose, wrong for the obvious one.
  `snapshotVisibleText()` now exists beside it

## Alternatives rejected

| Option                                       | Why rejected                                                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raise the cap, or remove it                  | Moves the cliff rather than removing it. The document that opens it is the one on the device holding the user's work, with no backup.                                                                      |
| Delete a prefix and accept re-anchoring      | A prefix delete cannot re-anchor: the elements are gone, so a later insert has nothing to resolve against. `Replica.init()` throws rather than guessing, which is correct and unfixable from the log side. |
| A second store for snapshots                 | Two stores means two reads and a consistency question on every reload, and `init()` loads one store.                                                                                                       |
| Write snapshot, then truncate separately     | Crash between the two destroys the document. One transaction removes the window entirely.                                                                                                                  |
| Infer the unsent queue inside `Replica`      | `Replica` does not know what a server has acknowledged. Only the transport does, and a wrong guess is silent divergence.                                                                                   |
| Give the server the client's job             | The client's log is in the browser. A server cannot compact storage it does not have, and a peer on a stale baseline gets a snapshot regardless.                                                           |
| Compact only after a server baseline arrives | Waiting for the server leaves the failure window open indefinitely for anyone editing offline, which is exactly the case a local-first design exists to support.                                           |
