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

## Observing it

Two endpoints, no collector, no external service, no configuration.

### Metrics — `GET /api/metrics`

Prometheus text format. Point a scraper at it, or just:

```bash
curl -s localhost:3001/api/metrics | grep -E '^(collab|http|ws)_'
```

The ones worth watching, in the order they matter for this project:

| Metric                             | Read it as                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `collab_operations_unplaced_total` | **The CRDT health signal.** Non-zero means some peer is waiting for an operation that never arrived        |
| `ws_pending_unauthenticated`       | Sockets connected but not authorised. A number that only goes up is an attack, not a bug                   |
| `collab_compaction_skipped_total`  | Why compaction declined. A policy that never fires and one that fires constantly look identical without it |
| `collab_replay_duration_seconds`   | How long a reconnecting client takes to become current                                                     |
| `http_request_duration_seconds`    | By route template                                                                                          |

Every label is bounded. Routes are templates (`/api/documents/:id`), never raw paths,
because one series per document is how a monitoring system falls over while the
application is fine. There is a property test for that, and a second cap in the
registry for anyone who adds a raw path by accident.

### Logs

JSON lines on stdout, one object per line. **Every line is JSON, including the
startup-failure line** — a human-readable warning in the middle of a stream breaks
every parser downstream, and that is exactly the line you want to be able to read
programmatically.

Fields that look like credentials are replaced with `[redacted]` at the point records
become bytes, not per call site. `token`, `authorization`, `password`, `cookie`,
`session`, `secret`, `api_key`, and anything containing them, at any nesting depth.

```bash
npm run dev 2>&1 | jq 'select(.level != "info")'
```

---

## Configuration

Copy `.env.example` to `.env` and fill in values. `.env` is gitignored;
`.env.example` is committed and must never contain real credentials.

| Variable          | Default              | What it does                                                                                    |
| ----------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `JWT_SECRET`      | _unset_              | Signs session tokens. Unset means auth is **open**, which is refused when `NODE_ENV=production` |
| `AUTH_MODE`       | inferred             | `required` or `open`, to pin the decision explicitly                                            |
| `LOG_LEVEL`       | `info`               | `debug` to include per-connection detail                                                        |
| `PORT` / `HOST`   | `3001` / `127.0.0.1` | Where the server listens                                                                        |
| `PGLITE_DATA_DIR` | `./.data/pgdata`     | Where the database lives                                                                        |

Without `JWT_SECRET`, the server logs a warning on startup and `/api/health` reports
`"auth": "open"`. It refuses to start that way under `NODE_ENV=production`.

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

- **`document_ops` is one row per character, but compaction now prunes it.**
  Snapshots preserve element IDs and compaction is gated on causal stability, so the
  log stays bounded while clients are connected. It is not bounded for a document
  nobody is editing.
- **The local IndexedDB log is capped, not compacted.** Past 50,000 entries the
  oldest are dropped, which breaks replay for a log that referenced them. A real
  policy needs snapshot-and-truncate. A client that prunes below the server's
  compaction floor is served a baseline, so it converges — it just wastes a frame.
- **Authentication is anonymous, and that has limits.** A session is a signed token
  carrying a random subject; there are no accounts. Two browser profiles are two
  subjects with no way to prove they are the same person, and clearing site data
  loses access to your documents. `POST /api/documents/:id/claim` takes ownership of
  an unowned document. See [ADR-0012](./docs/adr/0012-authentication-and-ownership.md).
- **Documents created outside the API are world-writable.** `owner IS NULL` means
  anyone with the id may read and write, which is what kept pre-authentication data
  working.
- **There is a race on claiming an unowned document.** First subject to claim wins.
- Rate limiting is per-process and in-memory, so it resets on restart.
- Security has **not** been independently reviewed. Input validation covers
  protocol framing, request bodies and CRDT operations; authorisation is now
  covered by tests, but no one outside this repository has read it.
- Client bundle is 297 kB (96 kB gzipped), mostly CodeMirror.
- The test suite takes ~3 minutes, dominated by Postgres start-up per suite. Files
  that need many cases share one boot and truncate between tests; see
  `Database.truncateAll`.

---

## Licence

MIT — see [LICENSE](LICENSE).
