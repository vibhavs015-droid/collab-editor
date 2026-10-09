# ADR-0015: Acknowledged writes

- **Status**: accepted
- **Supersedes**: nothing
- **Date**: 2026-10-08

## Context

`SyncTransport` emptied its outbox the moment `ws.send()` returned, and the protocol had no
server-to-client message that confirmed anything. `send()` returning is a claim about the local
socket: it says the operating system accepted the bytes. It says nothing about the server having
read them, and less about the server having stored them.

So a frame written to a socket that then died was gone from memory and had arrived nowhere. This
was measured, not hypothesised — `src/server/writeDurability.test.ts` runs a real relay and a
real database and terminates the socket in the window between "frame received" and "frame
committed". Before the change:

```
AssertionError: the resend never reached the server, so the edits were lost: expected '' to be 'xx'
```

An empty document. The sender's indicator read `Synced`, because `Synced` was derived from the
outbox being empty and the outbox had just been emptied.

Two properties made the fix cheap, and both already existed for other reasons:

- **Server persistence is idempotent.** `INSERT ... ON CONFLICT (document_id, element_key) DO
NOTHING` means a redelivered operation is a no-op rather than a second row. Replay is safe
  precisely because of this.
- **The transport already refuses a `snapshot` baseline while the outbox is non-empty.** A
  reconnect could not paper over a lost edit by silently replacing the document.

## Decision

A client that wants confirmation puts a `batchId` on its `ops` / `ops-enc` frame. The server
sends `{ type: 'ack', batchId }` **after the store has settled**, and sends nothing at all if the
store failed.

The client keeps an in-flight list beside the outbox. An operation leaves the outbox when it is
written and leaves the in-flight list when it is acknowledged. On reconnect, in-flight frames go
back to the front of the outbox, in order, and are resent — the encrypted path resends its exact
ciphertext rather than re-encrypting.

The sync indicator reports `Synced` only when both lists are empty.

### Why `batchId` is OPTIONAL

This is the part that decides whether the change is a version bump or an additive one.

An old client sends `ops` with no `batchId`. Two things follow:

1. The server acknowledges nothing, because there is nothing to acknowledge. **The old client
   behaves exactly as it did before**, including its indicator — it will still report `Synced`
   when its outbox empties, because that logic is in the old bundle and cannot be changed by a
   server.
2. The old client **never receives an `ack`**, because the server only sends one in response to a
   frame that carried a `batchId`.

Point 2 is why this does not need `PROTOCOL_VERSION` bumped, and it is not a lucky accident.
A client that does not recognise `ack` falls through its message switch to
`onError('BAD_RESPONSE', 'Server sent an unrecognised frame.')`. Had the server sent
acknowledgements unconditionally, every deployed client would have shown an error on every
keystroke. Opting in by sending an id makes the new frame unreachable for clients that cannot
understand it.

**`PROTOCOL_VERSION` stays at 1.** The message shapes are a superset of what version 1 already
allowed, and an absent optional field is a valid version-1 message. Bumping it would have made
every currently-deployed client fail the `hello` handshake outright — turning a silent data-loss
bug into a total outage, which is a much worse trade for a bug fix.

### Why the ack follows the store and not the socket

An acknowledgement sent when the frame is _read_ would fix nothing. The failure being addressed
is precisely a frame the relay had in hand and then lost — the process died between reading the
socket and committing — and an ack sent at receipt time tells the client its edit is safe at
exactly that instant. The test kills the socket at that point, and it is green only because the
ack is downstream of the write.

A store call that rejects therefore produces no ack, and the client keeps the batch and replays
it. That is the desired behaviour, not a fallback: the failure was reported to the user _and_ the
edit is retried.

## Alternatives rejected

**Bump `PROTOCOL_VERSION` to 2 and require `batchId`.** Cleaner in the type system, and it would
have made the batch id mandatory rather than conventional. Rejected: it refuses every deployed
client at the `hello` handshake, turning silent data loss into an outage. The optional field gets
the same safety with none of that blast radius.

**A server-side resend, or a write-ahead log the client polls.** The server has no record of what
a client believes it sent, so it cannot know what to resend without becoming a second source of
truth for per-client state. Rejected as a much larger change to a system that is deliberately a
relay (ADR-0007).

**Acknowledge on `send()` returning, client-side only, with no protocol change.** Cheapest, and it
would have fixed the indicator while leaving the data loss exactly as it was — the client would
have been told its edit was safe at the moment it was lost. Rejected: it makes the UI lie more
confidently.

**Have the server echo operations back to the sender.** It already does not echo, deliberately.
Echoing would let the client compare, but it doubles every keystroke's traffic and still needs an
ordering rule for matches. Rejected.

**Resend everything on every reconnect, unconditionally, with no in-flight list.** Simpler: the
outbox is the only list. Rejected because it resends operations the server _did_ store on every
single reconnect, forever, for every client that has ever typed. Idempotency makes that safe for
the data and wasteful for the database.

## Consequences

**Good:**

- A frame the server never stored is replayed. Measured: the document ends up with its
  characters instead of being empty.
- `Synced` now means the server confirmed, which is what a user reads it to mean.
- The in-flight list doubles as the pending count, so the indicator and the queue cannot drift
  apart.

**Bad, and recorded as such:**

- **Replay is unconditional, so a lost _ack_ costs a redundant write.** The client cannot
  distinguish "stored" from "stored but the ack was lost", so it assumes the worst. Idempotency
  makes the duplicate harmless to the data and wasteful to the database.
- **One extra frame per batch, in each direction.** At `MAX_OPS_PER_FRAME = 1000` that is one
  acknowledgement per thousand keystrokes, which is not a bandwidth concern. It is, however, one
  more thing that can be lost, and a _server_ that drops acks will now cause client-side replay
  on every reconnect.
- **The in-flight list holds encrypted ciphertext in memory for longer than before.** Previously
  an encrypted batch was released as soon as it was written. It is still in this process, still
  opaque to the server, and released on ack — but a long-running tab with a stalled database now
  holds more of it than it used to.
- **A client that reconnects faster than it gets acks replays the same batches repeatedly.** The
  reconnect backoff (ADR-0008) bounds the rate, but a flapping server can cause repeated replay.
  A `flushed`/`pending` gauge would make this visible; there is not one yet.

**Not addressed here, and it is the next thing that matters:**

- The protocol still has **no application-level ping**. Both the outage tests in `e2e/` and the
  reconnect logic above rely on the socket's `close` event arriving. A half-open connection that
  silently drops packets is not noticed by either side promptly, and this change does not help:
  the client cannot replay what it does not know is stuck. A `ping` frame with an `pong` reply
  would give both sides a deadline.
