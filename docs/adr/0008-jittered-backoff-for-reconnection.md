# 0008 — Jittered exponential backoff for reconnection

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** 3

## Context

A collaborative editor reconnects constantly: laptops sleep, phones change
network, and deploys restart the server. The client must retry automatically or
the user sees an editor that stopped working.

Naive retry has a characteristic failure mode that only appears under load.

## Decision

**Exponential backoff with full jitter**, capped at a maximum delay:

```
delay = min(baseRetryMs * 2^attempt, maxRetryMs) * random(0.5, 1.0)
```

The backoff counter resets on a successful connection, not on a failed attempt.

## Rationale

**Without jitter, a restart becomes a self-inflicted denial of service.** Every
client disconnected by the same server restart computes the same delay and
returns in the same millisecond. The restarted server receives all of them at
once and is knocked over again. The retry storm is caused by the recovery
mechanism.

Jitter spreads arrivals across a window, so the same number of clients arrive
smoothly instead of simultaneously.

**Jitter is the important half; exponential growth alone is not sufficient.**
Exponential backoff without jitter reduces the request rate but still
synchronises clients. Full jitter is what breaks the synchronisation, and it is
the reason the test fixes `Math.random` — otherwise the assertion is flaky,
because two adjacent attempts can jitter to nearly the same delay.

**The counter resets on success.** Resetting on failure would keep growing the
delay across a long series of quick failures even when the client is clearly
healthy, and a client that took ten attempts to connect would then stay slow long
after the network recovered.

**The outbox is not cleared on disconnect.** Local edits made while offline are
still unacknowledged by peers. Clearing them would silently lose work the user
believed was saved. The queue is bounded instead, dropping the oldest entries
past a cap, because unbounded buffering converts a long offline session into a
memory leak.

## Consequences

**Good**

- A server restart is survivable
- Clients do not synchronise their retries
- Edits made offline are relayed on reconnect
- Memory stays bounded no matter how long the client is offline

**Bad**

- A genuine partition means up to `maxRetryMs` of delay before the next attempt.
  With a 15s cap that is a poor experience during a long outage. Acceptable
  because the UI shows offline state, so the user is not misled
- Dropping the oldest operations past the cap means a very long offline session
  can leave peers behind. Those peers recover from the persisted log in Phase 4,
  but until then this is a real limitation
- Full jitter means a client can wait nearly twice the nominal delay, which makes
  retry timing harder to reason about when debugging

## Alternatives rejected

| Option                                                          | Why rejected                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Fixed retry interval                                            | Guaranteed synchronised retries. The classic thundering herd.                                         |
| Exponential without jitter                                      | Reduces rate but does not desynchronise clients. Only half the fix.                                   |
| Immediate reconnect with no backoff                             | Worst case. Every client hammers a struggling server simultaneously.                                  |
| Server-directed reconnect (server tells clients when to return) | Centralised and would work, but adds a dependency precisely when the server is the thing that failed. |
| Clearing the outbox on disconnect                               | Silently loses unacknowledged edits. Unacceptable for a document editor.                              |
