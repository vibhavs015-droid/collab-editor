# collab-editor

An offline-first collaborative document editor built on a sequence CRDT (RGA).

The goal is not to compete with Google Docs — it is to understand, from first
principles, what makes real-time conflict-free sync hard, and to prove the
implementation correct rather than merely claiming it.

---

## Status

| Phase | Scope                                                 | Status      |
| ----- | ----------------------------------------------------- | ----------- |
| 0     | Toolchain, CI, CRDT primitives, protocol envelope     | ✅ Complete |
| 1     | Single-user editor (CodeMirror + Postgres + autosave) | ✅ Complete |
| 2     | **RGA CRDT + convergence fuzz test**                  | Next        |
| 3     | Real-time sync (WebSocket, presence)                  | Not started |
| 4     | **Offline-first** (IndexedDB, merge on reconnect)     | Not started |
| 5     | Production hardening (RBAC, k6, Docker, deploy)       | Not started |
| 6     | Differentiator + public launch                        | Not started |

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

Rationale and rejected alternatives: [ADR-0001](docs/adr/0001-local-first-architecture.md).

---

## Quickstart

```bash
nvm use          # reads .nvmrc — pins Node 24
npm install
npm run dev      # API on :3001, client on :5173
```

Open <http://localhost:5173>. No database setup, no accounts, no Docker.

```bash
npm run verify   # typecheck + lint + format check + tests
npm run build    # tsc + vite build
npm start        # API only
```

Requires Node 22+ (24 pinned in `.nvmrc`).

---

## How correctness is proven

CRDT bugs are emergent. They appear only under specific orderings of concurrent
operations that no human would write by hand, so hand-written tests miss them.

Phase 2 adds `src/core/crdt/convergence.test.ts`: generate N random concurrent
operations, deliver them to each replica in a _different_ random order, then
assert every replica produces byte-identical text. All randomness is seeded, so
a failure replays exactly from its seed.

This is the project's strongest artifact — an executable proof, not a claim in a
README.

Two things already learned the hard way and encoded as rules:

- **Test at the byte level.** A passing `fetch`-based test missed a real
  `charset` defect that only appeared in a client which guessed its encoding.
  `src/server/e2e.test.ts` asserts on raw bytes.
- **Seed everything random.** A failure you cannot replay is a failure you cannot
  debug.

---

## Verification

| Gate            | Command                        | Result      |
| --------------- | ------------------------------ | ----------- |
| Types           | `npm run typecheck`            | 0 errors    |
| Lint            | `npm run lint`                 | 0 problems  |
| Format          | `npm run format:check`         | clean       |
| Tests           | `npm test`                     | 106 passing |
| Vulnerabilities | `npm audit --audit-level=high` | 0           |

CI runs each as a separate gate, plus a dependency-audit job.

---

## Repository layout

```
collab-editor/
├── docs/
│   ├── adr/                  Architecture decision records
│   └── benchmarks/           Measured results with recorded method
├── scripts/load/             k6 load-test suite (Phase 5)
└── src/
    ├── core/                 Pure CRDT logic — no I/O. The heart of it.
    ├── shared/               Wire protocol, used by client and server
    ├── client/               Browser app: editor, autosave, UI states
    └── server/               Node API: HTTP, Postgres, migrations
```

`src/core` is constrained to pure logic — no DOM, no Node APIs, no network. That
is what lets the fuzz test run thousands of cases in milliseconds on every push.

**Platform boundaries are enforced by lint**, not just convention: `src/server`
cannot reference `window`, `src/client` cannot import `node:*`, and `src/core`
cannot import anything external at all. See [`src/core/README.md`](src/core/README.md).

---

## Configuration

Copy `.env.example` to `.env` and fill in values. `.env` is gitignored;
`.env.example` is committed and must never contain real credentials.

Phase 1 requires no environment variables. `PGLITE_DATA_DIR` overrides where the
database is stored; it defaults to `./.data/pgdata`.

---

## Documentation

| Where                                   | What it holds                                  |
| --------------------------------------- | ---------------------------------------------- |
| [`NOTES.md`](NOTES.md)                  | Running log: what confused me, what went wrong |
| [`docs/`](docs/README.md)               | Architecture decisions, benchmarks, rationale  |
| [`src/*/README.md`](src/core/README.md) | Per-directory rules and planned contents       |

Recording _why_ a decision was made is the highest-signal part of this project.
Code shows what was built; only documentation shows what was rejected.

---

## Known limitations

Stated explicitly rather than left for a reviewer to discover.

- **Single user only.** No WebSocket sync yet — that is Phase 3.
- `documents.content` is plain text. From Phase 2 it becomes a derived cache
  rebuilt from the CRDT operation log.
- No authentication, so document ids are the only access control. Phase 5.
- Rate limiting is per-process and in-memory, so it resets on restart.
- Security has **not** been independently reviewed. Input validation covers
  protocol framing and request bodies, not authorisation.
- Client bundle is 281 kB (91 kB gzipped), mostly CodeMirror.
- The test suite takes ~2 minutes, dominated by Postgres start-up per suite.

---

## Licence

MIT — see [LICENSE](LICENSE).
