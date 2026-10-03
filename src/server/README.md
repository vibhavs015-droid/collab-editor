# `src/server`

Node.js backend. Introduced in **Phase 3**, hardened in **Phase 5**.

## Contents

| File               | Phase | Purpose                                                                          |
| ------------------ | ----- | -------------------------------------------------------------------------------- |
| `index.ts`         | 3     | Process entry: config, wiring, graceful shutdown                                 |
| `api.ts`           | 1, 5  | HTTP + WebSocket upgrade on one port                                             |
| `relay.ts`         | 3, 4  | WebSocket fanout, rooms, presence, replay from a log cursor                      |
| `documentStore.ts` | 4     | One CRDT replica per open document: materialise text, reject unreplayable writes |
| `db.ts`            | 1, 4  | Postgres via PGlite. Migrations, `document_ops` append, replay reads             |
| `auth.ts`          | 5     | JWT verification, document-level permissions                                     |
| `observability.ts` | 5     | OpenTelemetry, structured logging, metrics                                       |
| `ratelimit.ts`     | 5     | Per-connection and per-IP limits                                                 |

## Rules

**This layer must never contain merge logic.** Operations are applied to a CRDT
replica in `src/core`, which is pure and exhaustively tested. The relay forwards
operations verbatim and never sends a merged result ([ADR-0007](../../docs/adr/0007-server-is-a-relay-not-a-merge-authority.md)).

`documentStore.ts` holds a replica, which looks like an exception. It is not one:
it exists to materialise `documents.content` for the HTTP API without replaying
the whole log on every read, and to reject a write it cannot replay _at write
time_. It never participates in convergence.

**`documents.content` is a derived cache.** The operation log is authoritative.
`Database.materializeContent()` proves which one is right, and that a disagreement
is detectable at all is the entire benefit.

**If merge logic starts appearing here, it cannot be tested without a network,
and that is a design failure rather than a testing inconvenience.**

## Constraints

- **Validate every inbound frame** with `parseClientMessage`, then every operation
  with `parseOperations`. A WebSocket is reachable by anything that can open a
  port; assume hostile input. A malformed operation that reaches the log makes the
  log permanently unreplayable, so validation happens before the write, not after.
- **`seq` is assigned by the database**, never by the client. It doubles as the
  replay cursor, so two clients choosing their own values would destroy the total
  order.
- **Writes are serialised in-process.** PGlite is a single embedded connection, so
  `SELECT ... FOR UPDATE` provides nothing and concurrent transactions interleave
  their `BEGIN`/`COMMIT`. If this ever runs against a networked Postgres with
  several processes, the row lock has to come back.
- **Graceful shutdown** on `SIGTERM` — drain connections, then close the database.
  Closing the database first fails writes from clients that are still mid-relay.
- **No secrets in code.** Everything comes from environment variables; see
  `.env.example`.
