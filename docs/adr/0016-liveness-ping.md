# ADR-0016: Liveness by application-level ping

- **Status**: accepted
- **Supersedes**: nothing
- **Date**: 2026-10-08
- **Related**: ADR-0015 (acknowledged writes)

## Context

Everything in ADR-0015 depends on the socket's `close` event arriving: the reconnect, the
in-flight replay, the honest `Synced` indicator. A TCP connection whose packets are being
silently dropped fires no `error`, fires no `close`, and leaves the browser's `readyState` at
`OPEN`.

This is not a theoretical concern for this repository. The browser tests had to **stop the server
process** to simulate an outage, because three different mechanisms that look like they should
work all leave an ESTABLISHED WebSocket connected:

| Mechanism                                                | Operations typed "offline" reached the server |
| -------------------------------------------------------- | --------------------------------------------- |
| `context.setOffline(true)`                               | yes                                           |
| CDP `Network.emulateNetworkConditions { offline: true }` | yes                                           |
| `routeWebSocket` with the relay stopped                  | yes                                           |

Verified, and recorded in `docs/browser-tests.md`. Real networks behave like those three, not
like a stopped process. A test suite that can only simulate a failure the product never actually
experiences is a suite that cannot catch this class of bug.

## Decision

Two frames, and a deadline on each side.

**Server → client `ping { t }`** every 25 seconds, but only to clients that asked for it.
**Client → server `pong { t }`**, echoed immediately and synchronously.

- The **server** closes a connection whose ping has gone unanswered for 10 seconds.
- The **client** closes a connection that has sent it no frame at all for 75 seconds.

`t` is a token the client echoes. Without it, a `pong` delayed in a buffer for three minutes
would satisfy today's check and the server would conclude a dead client is alive — which is
precisely the failure the frame exists to catch.

## Decisions worth stating

**The capability is opt-in, exactly like `batchId` in ADR-0015.**

A client that does not understand `ping` answers it with its unrecognised-frame handler. So the
client declares `capabilities: ['ping']` in its `hello`, and the relay only pings clients that
declared it. `PROTOCOL_VERSION` stays at 1 again.

The difference from `ack`: `ack` is gated on the client sending a `batchId`, because the id _is_
the thing being acknowledged and asking for one is the opt-in. Two mechanisms for the same idea
would be worse than one, but `batchId` needs no separate declaration and adding one would give
the two a chance to disagree about the same connection.

**An unknown capability is dropped, not refused.** A newer client may declare capabilities this
server does not implement, and failing the handshake over that would make the two versions
incompatible rather than merely less capable.

**One outstanding ping at a time.** The deadline (10s) is deliberately shorter than the interval
(25s). If it were longer, two pings would be in flight and answering either would count as
answering both.

**The client's 75 seconds is much longer than one ping interval.** A single missed ping is a
congested network, not a dead one; reconnecting after one would replay every in-flight batch for
nothing. 75s tolerates two consecutive missed rounds.

**A backgrounded tab is delayed, never falsely declared dead.** Browsers throttle _timers_ in
background tabs, but not network events. So a throttled watchdog fires late, while the client
still records frames and still answers pings promptly. Late detection, not false detection.

**The watchdog drives the same code path as `close`.** It calls `#onSocketClosed()`, which is
what `onclose` calls. Inlining that logic twice would mean the in-flight replay and the refusal
check existed in two places free to diverge — which is how a reconnect ends up working in one
case and silently losing work in the other.

## Alternatives rejected

**Use the WebSocket protocol's own ping/pong control frames.** The browser WebSocket API does not
expose them. They exist on the wire, but a JavaScript client can neither send nor receive them,
so this would only work server-side: half the problem solved, and the client half untouched.

**Have the client ping the server.** Then a server whose _writes_ are dropped still looks alive to
the client, which is one of the two directions. Server-initiated pings cover both: no pings
arriving means the client notices, and no pongs returning means the server does.

**Shorten the existing `STALE_CONNECTION_MS` sweep.** It already closes clients that send nothing,
but only after a full 60 seconds and only on the server side. The client still has no deadline at
all, and 60 seconds of a dead peer holding a room membership and a place in everyone's peer count
is a long time to be wrong.

**Use the TCP keepalive settings of the underlying socket.** Not reachable from Node's `ws`, not
reachable from a browser at all, and the platform defaults are measured in minutes.

## Consequences

**Good:**

- A half-open connection is now noticed by both sides, and noticed because of silence rather
  than because a frame failed to arrive — which is the only thing that distinguishes this failure
  from a working connection.
- The reconnect path, the in-flight replay and the honest indicator all become reachable in the
  case they were written for.

**Bad, and recorded as such:**

- **A reachable-but-slow server can be declared dead.** A client on a link with more than 75
  seconds of latency, or one whose tab is frozen by the OS for longer than that, will reconnect.
  The deadline is a guess and any value is wrong somewhere.
- **Every client that opted in now holds a timer.** Cheap — the watchdog returns immediately when
  there is nothing to check — but it is a timer per tab that did not exist before, and it is
  `unref`'d so it cannot keep a Node process alive.
- **The server keeps room memberships up to 25 seconds longer for a client that stops answering
  pings**, because that is when the next ping is due. The 10-second deadline is only enforced at
  a heartbeat tick, so the real worst case is one interval plus the deadline, not the deadline.
- **An idle client is now pinged.** Before, an idle-but-healthy peer was closed by the stale sweep
  after 60 seconds of saying nothing, which meant idle tabs reconnected roughly every minute.
  Answering pings keeps `lastSeen` fresh, so that churn goes away — which is a fix, but it means
  idle connections are now held open indefinitely rather than recycled.

**Not addressed here:**

- **There is no gauge for either deadline firing.** A deployment that is repeatedly hitting the
  pong deadline looks like a deployment with intermittent network problems, and nothing in
  `/api/metrics` distinguishes that from a genuine outage. `ws_connections_closed_total` has a
  `reason` label, so the data exists; nobody is reading it as a rate.
- **Nothing detects a relay that is alive but not making progress** — wedged on a database
  promise, say. The ping only proves a frame is travelling, not that the work behind it is.
