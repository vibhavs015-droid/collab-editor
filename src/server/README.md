# `src/server`

Node.js backend. Introduced in **Phase 3**, hardened in **Phase 5**.

## Planned contents

| File               | Phase | Purpose                                                  |
| ------------------ | ----- | -------------------------------------------------------- |
| `index.ts`         | 3     | Process entry: config, graceful shutdown                 |
| `ws.ts`            | 3     | WebSocket server, connection lifecycle, heartbeat        |
| `rooms.ts`         | 3     | Document fanout — which sockets belong to which document |
| `protocol.ts`      | 3     | Re-export `src/shared/protocol` validation               |
| `presence.ts`      | 3     | Live cursor tracking and broadcast                       |
| `routes/`          | 5     | HTTP API: documents, auth, RBAC                          |
| `auth.ts`          | 5     | JWT verification, document-level permissions             |
| `db.ts`            | 1/5   | Postgres access via Supabase                             |
| `observability.ts` | 5     | OpenTelemetry, structured logging, metrics               |
| `ratelimit.ts`     | 5     | Per-connection and per-IP limits                         |

## Rules

**This layer must never contain CRDT logic.** Sync operations are applied to a
CRDT replica in `src/core`, which is pure and fully tested. The server's only job
is transport, fanout, and persistence.

If merge logic starts appearing here, it cannot be tested without a network, and
that is a design failure rather than a testing inconvenience.

## Constraints

- **Validate every inbound frame** with `parseClientMessage`. A WebSocket is
  reachable by anything that can open a port; assume hostile input.
- **Graceful shutdown** on `SIGTERM` — drain connections, then close. Abrupt exit
  mid-broadcast is how replicas end up diverging.
- **No secrets in code.** Everything comes from environment variables; see
  `.env.example`.
