# collab-editor

An offline-first collaborative document editor built on a sequence CRDT (RGA).

The goal is not to compete with Google Docs — it is to understand, from first
principles, what makes real-time conflict-free sync hard, and to prove the
implementation correct rather than merely claiming it.

---

## Status

| Phase | Scope                                             | Status      |
| ----- | ------------------------------------------------- | ----------- |
| 0     | Toolchain, CI, CRDT primitives, protocol envelope | ✅ Complete |
| 1     | Single-user editor (CodeMirror + Postgres)        | ✅ Complete |
| 2     | **RGA CRDT + convergence fuzz test**              | ✅ Complete |
| 3     | Real-time sync (WebSocket relay, presence)        | ✅ Complete |
| 4     | **Offline-first** (operation log, replay)         | ✅ Complete |
| 5     | Production hardening (auth, k6, Docker, deploy)   | Next        |
| 6     | Differentiator + public launch                    | Not started |

---

## Architecture

**Local-first.** Each device holds the authoritative document; the server is a
sync optimisation, not a source of truth. This inverts the usual
server-authoritative design and changes the failure modes — in this system the
server can be down indefinitely and every user keeps working.

```
 device A                    server                    device B
 ┌──────────────┐          ┌──────────────┐         ┌──────────────┐
 │  CodeMirror  │  ops     │  Relay       │   ops   │  CodeMirror  │
 │      ↓       │ ───────► │  (fanout)    │ ──────► │      ↓       │
 │  Replica     │          │      ↓       │         │  Replica     │
 │      ↓       │          │  op log      │         │      ↓       │
 │  IndexedDB ◄─┼──── catch-up from a cursor ─────────┼─► IndexedDB   │
 └──────────────┘          └──────────────┘         └──────────────┘
        ▲                          │
        └────── replay on load ───┘
```

The write path stops at the device. Nothing waits for the server, and nothing is
lost when it is absent — `src/server/offline.e2e.test.ts` tests exactly that claim
against a real relay and a real database.

Rationale and rejected alternatives:
[ADR-0001](docs/adr/0001-local-first-architecture.md),
[ADR-0007](docs/adr/0007-server-is-a-relay-not-a-merge-authority.md),
[ADR-0009](docs/adr/0009-operation-log-is-the-document.md).

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

`src/core/crdt/convergence.test.ts` generates N random concurrent operations,
delivers them to each replica in a _different_ random order, then asserts every
replica produces byte-identical text. All randomness is seeded, so a failure
replays exactly from its seed.

This is the project's strongest artifact — an executable proof, not a claim in a
README.

**Convergence is not correctness, and Phase 4 proved it the hard way.** A Lamport
clock bug made every local keystroke land at the end of the document instead of at
the caret. The fuzzer could not catch it, because every replica agreed on the same
wrong document. Convergence asks "do all replicas agree?"; correctness asks "does
the document match what the user typed?" — and a CRDT can satisfy the first while
failing the second completely.

Both questions now have tests. `rga.test.ts` walks every offset in a document and
asserts a local insert lands exactly where it was typed, building the expectation
by slicing the original string so a CRDT bug cannot make the test agree with
itself. See [ADR-0010](docs/adr/0010-lamport-clock.md).

Three rules learned along the way, each encoded as a test:

- **Test at the byte level.** A passing `fetch`-based test missed a real
  `charset` defect that only appeared in a client which guessed its encoding.
  `src/server/e2e.test.ts` asserts on raw bytes.
- **Seed everything random.** A failure you cannot replay is a failure you cannot
  debug.
- **Never mock the wiring you are testing.** The editor↔CRDT binding's worst bug
  is an echo loop, which only exists when the change listener and the dispatch
  share one view. A mock removes exactly that, so `binding.test.ts` drives a real
  `EditorView` in jsdom.

---

## Verification

| Gate            | Command                        | Result      |
| --------------- | ------------------------------ | ----------- |
| Types           | `npm run typecheck`            | 0 errors    |
| Lint            | `npm run lint`                 | 0 problems  |
| Format          | `npm run format:check`         | clean       |
| Tests           | `npm test`                     | 397 passing |
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
    │   └── crdt/             rga.ts, replica.ts, diff.ts, seed.ts
    ├── shared/               Wire protocol, used by client and server
    ├── client/               Browser app
    │   ├── storage/          IndexedDB operation log
    │   └── sync/             Transport, editor binding, status indicator
    └── server/               Node API: HTTP, Postgres, relay, op log
```

`src/core` is constrained to pure logic — no DOM, no Node APIs, no network, no
external dependencies. That is what lets the fuzz test run thousands of cases in
milliseconds on every push.

**Platform boundaries are enforced by lint**, not just convention: `src/server`
cannot reference `window`, `src/client` cannot import `node:*`, and `src/core`
cannot import anything external at all. See [`src/core/README.md`](src/core/README.md).

---

## Try the offline claim yourself

With `npm run dev` running and two tabs open on the same `?doc=`:

1. Type in tab A. The indicator reads **Synced**.
2. Stop the server (Ctrl+C).
3. Keep typing in tab A. The indicator reads **Offline — N queued**. Nothing is lost.
4. Reload tab A. The text is still there — replayed from IndexedDB, not fetched.
5. Restart the server. It reconnects on its own, flushes, and reads **Synced**.
6. Open the document in a third tab. It catches up from the server's operation log.

`window.collabEditor` exposes `text()`, `state()`, `invariants()` and `resync()` in
the console. A CRDT project should make the CRDT inspectable.

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

- **`document_ops` is one row per character and grows forever.** A 10,000-character
  document is 10,000 JSONB rows. Needs compaction — tombstone squashing plus
  periodic snapshots — before this scales past a demo.
- **The local IndexedDB log is capped, not compacted.** Past 50,000 entries the
  oldest are dropped, which breaks replay for a log that referenced them. A real
  policy needs snapshot-and-truncate.
- No authentication, so document ids are the only access control. Phase 5.
- Rate limiting is per-process and in-memory, so it resets on restart.
- Security has **not** been independently reviewed. Input validation covers
  protocol framing, request bodies and CRDT operations, not authorisation.
- Client bundle is 297 kB (96 kB gzipped), mostly CodeMirror.
- The test suite takes ~2.5 minutes, dominated by Postgres start-up per suite.
- One full-suite run had a flaky `fetch failed` in `api.test.ts` under load. It
  passed in isolation and in every run since, and is not root-caused.

---

## Licence

MIT — see [LICENSE](LICENSE).
