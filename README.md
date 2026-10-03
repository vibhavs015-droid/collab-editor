# colllab-editor

An offline-first collaborative document editor built on a sequence CRDT (RGA).

The goal is not to compete with Google Docs — it is to understand, from first
principles, what makes real-time conflict-free sync hard, and to prove the
implementation correct rather than merely claiming it.

---

## Status

| Phase | Scope                                             | Status      |
| ----- | ------------------------------------------------- | ----------- |
| 0     | Toolchain, CI, CRDT primitives                    | ✅ Complete |
| 1     | Single-user editor (CodeMirror + Postgres)        | Not started |
| 2     | **RGA CRDT + convergence fuzz test**              | Not started |
| 3     | Real-time sync (WebSocket, presence)              | Not started |
| 4     | **Offline-first** (IndexedDB, merge on reconnect) | Not started |
| 5     | Production hardening (RBAC, k6, Docker, deploy)   | Not started |
| 6     | Differentiator + public launch                    | Not started |

---

## Architecture

**Local-first.** Each device holds the authoritative document; the server is a
sync optimisation, not a source of truth. This inverts the usual
server-authoritative design and changes the failure modes — in this system the
server can be down indefinitely and every user keeps working.

```
 device A                    server                    device B
 ┌──────────────┐          ┌──────────┐             ┌──────────────┐
 │  Editor      │  ops     │  Relay   │    ops     │  Editor      │
 │    ↓         │ ───────► │  (fanout)│ ────────►  │    ↓         │
 │  RGA replica │          └──────────┘             │  RGA replica │
 │    ↓         │                                  │    ↓         │
 │  IndexedDB   │◄───────  catch-up on reconnect ──►│  IndexedDB   │
 └──────────────┘                                  └──────────────┘
```

---

## Quickstart

```bash
npm install
npm run verify   # typecheck + lint + format check + tests
npm start        # toolchain self-check
npm run test:watch
```

Requires Node 20+.

---

## How correctness is proven

CRDT bugs are emergent. They appear only under specific orderings of concurrent
operations that no human would write by hand, so hand-written tests miss them.

Phase 2 adds `src/core/crdt/convergence.test.ts`: generate N random concurrent
operations, deliver them to each replica in a _different_ random order, then
assert every replica produces byte-identical text. All randomness is seeded, so
a failure replays exactly from its seed.

This is the project's strongest artifact. It is a real executable proof, not a
claim in a README.

---

## Design notes

Decisions and their rationale are recorded in [`NOTES.md`](./NOTES.md) as they
are made, and summarised in the blog post (Phase 6).

---

## Scripts

| Command                 | Purpose                                    |
| ----------------------- | ------------------------------------------ |
| `npm run verify`        | Everything CI runs. Use before every push. |
| `npm test`              | Run test suite once                        |
| `npm run test:watch`    | Watch mode                                 |
| `npm run test:coverage` | Coverage report                            |
| `npm run typecheck`     | TypeScript, no emit                        |
| `npm run lint`          | ESLint with type-aware rules               |
| `npm run format`        | Rewrite with Prettier                      |
| `npm run build`         | Compile to `dist/`                         |

---

## Known limitations

Stated explicitly rather than left for a reviewer to discover.

- Phase 0 only: no editor UI, no network layer, no persistence yet.
- Single-document scope is not yet defined.
- Target client count is unverified; see Phase 5 for k6 load testing.

---

## Licence

MIT
