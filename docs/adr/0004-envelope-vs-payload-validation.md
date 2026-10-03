# 0004 — Transport validates message shape; the CRDT validates operations

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** Established in Phase 0 (protocol layer), enforced from Phase 2

## Context

Every message crossing the WebSocket boundary is attacker-controlled. Anything
able to open a connection can send arbitrary bytes, so the server needs a
validation layer.

The open question is _where_ that validation stops. A frame looks like:

```json
{ "type": "ops", "documentId": "d", "ops": [ ... ] }
```

How much of that does the transport check — just the envelope, or the contents
of `ops` as well?

## Decision

**Two layers, each responsible for its own domain.**

- **Transport (`src/shared/protocol.ts`)** validates the _envelope_: message type,
  required fields present, types correct, numbers finite. It does **not** inspect
  operation contents.
- **The CRDT (`src/core`)** validates every operation against the operation
  schema. An operation it cannot apply is rejected by the CRDT, not by the wire.

`Operation` is therefore an opaque `JsonValue` in the transport layer.

## Rationale

**The transport cannot meaningfully validate operations.** It has no idea what a
valid insert or delete looks like — that type does not exist until Phase 2. Any
guess made now would be wrong by Phase 2 and would need replacing, which is
exactly the churn that gets a wire format out of sync with its producers.

**The CRDT must validate operations regardless.** Even once operations are fully
typed, `src/core` cannot assume a well-behaved caller. It is pure logic designed
to be reused, and the CRDT is the only component where accepting a malformed input
means silent data loss. A defensive CRDT is one that rejects bad input on its own
terms.

**This ordering avoids duplicated rules.** One layer owns each concern. If both
validated operations, they would drift, and the two definitions would disagree —
producing either a false rejection or a missed acceptance.

## Consequences

**Good**

- `src/shared` stays ignorant of the CRDT, so Phase 2 changes operation types
  without touching the wire format
- `src/core` remains independently testable and genuinely defensive
- Each validation rule has exactly one home

**Bad**

- An `ops` frame with garbage inside passes transport validation and is rejected
  later, so rejection errors surface further from the cause. Accepted trade: a
  precise CRDT error beats a transport guess.
- Two places to look when debugging a rejected message. Mitigated by the
  explicit boundary test in `protocol.test.ts`.

## Revisit if

Operations gain a wire representation that can be validated independently of the
CRDT — for example a fixed binary format with a header checksum. At that point
transport-level op validation becomes worthwhile, and this ADR is superseded.

Phase 2 should update the boundary test
`does NOT inspect op payloads` to assert that the CRDT itself rejects an invalid
operation, making the handoff explicit rather than implicit.
