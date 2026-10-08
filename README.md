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
| 5     | Production hardening (auth, k6, Docker, deploy)   | ✅ Complete |
| 6     | **End-to-end encryption**                         | ✅ Complete |

**Not done:** public launch. The roadmap's phase 6 was "differentiator + public launch";
end-to-end encryption was chosen as the differentiator and is complete, and the repository is
public, but **nothing is deployed and no real user has used it**. The Docker image has also never
been built, so the deploy path is documented but unproven — see
[docs/deploy.md](docs/deploy.md) for exactly what has and has not been verified.

Visibility is a decision, not a milestone, and it can be reversed with one setting. It was made
public so that other agents could review the code.

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
[ADR-0009](docs/adr/0009-operation-log-is-the-document.md),
[ADR-0014](docs/adr/0014-end-to-end-encryption.md).

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

### Trying it on your own machine

**See [docs/TESTING.md](docs/TESTING.md)** for a step-by-step checklist: the editor,
two-window realtime sync, the offline-first claim, encryption, and restart persistence — each
with what "pass" looks like, and an explicit list of what the checklist does _not_ cover.

```bash
npm run start:local      # build once with `npm run build` first
```

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

## Benchmarks

Recorded, with raw output committed. Full method, and what the numbers do **not** mean:
[`docs/benchmarks.md`](docs/benchmarks.md).

**Three runs per scenario**, reported as median with the observed range — a single run on a
shared machine varies by enough to be misleading.

| Scenario     | Shape                                            | Result                                                          |
| ------------ | ------------------------------------------------ | --------------------------------------------------------------- |
| `connect`    | 50 concurrent, 20 s ramp                         | **3,732** handshakes, p95 **245 ms** (237–252), 0 refusals      |
| `edit`       | 20 concurrent editors                            | **38,465** ops at **1,282/s** (999–1,485), **0** unplaced       |
| `reconnect`  | 10 clients vanishing and returning               | **150** reconnects, **100%** readmitted, catch-up p95 **25 ms** |
| `divergence` | 25 clients, 30% deletes of each other's elements | **43,360** ops at **1,398/s**, **0 unplaced**                   |
| convergence  | 24 real replicas contending for 60 rounds        | **0** diverged, **0** invariant violations                      |

Reproduce with `npm run load:connect -- --repeat 3` (or `load:edit`, `load:reconnect`,
`load:divergence`).

**These are not production throughput figures**, and the benchmark document says so at
length: PGlite is in-process WASM with no network hop, there is one Node thread, the
laptop is shared, and everything runs on loopback with no latency. What they are good
for is showing the relay, the CRDT and the compaction floor behave correctly under
concurrency, and giving a baseline to catch regressions against.

Two things worth singling out, because they are the claims that matter:

- **The server's own counters agree with the client's** on every run. A load generator
  that merely believed its own successes would agree with itself just as happily.
- **`collab_operations_unplaced_total` was zero** across every run. An operation that
  cannot be placed is one some peer is still waiting for, and if it never arrives that
  peer stays silently behind. A latency benchmark reports success while documents
  quietly diverge underneath it.

k6 cannot import this package's TypeScript, so `divergence.js` cannot verify convergence
without writing a second RGA in JavaScript. It drives contention and reads the server's
verdict instead;
[`loadConvergence.test.ts`](src/server/loadConvergence.test.ts) does the convergence check
with the real `Replica`, and runs in CI.

---

## Verification

| Gate            | Command                        | Result      |
| --------------- | ------------------------------ | ----------- |
| Types           | `npm run typecheck`            | 0 errors    |
| Lint            | `npm run lint`                 | 0 problems  |
| Format          | `npm run format:check`         | clean       |
| Line endings    | `npm run check:line-endings`   | clean       |
| Tests           | `npm test`                     | 931 passing |
| Vulnerabilities | `npm audit --audit-level=high` | 0           |

CI runs each as a separate gate, plus a dependency-audit job.

The line-endings gate exists because `.gitattributes` alone was not enough: git normalises
the index on commit, so a file written with CRLF still commits cleanly and only reveals
itself later, as an edit that cannot find text which is visibly present.

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

---

## End-to-end encryption

**The server cannot read your document.** Not "we encrypt at rest", not "TLS in transit" —
the relay holds ciphertext it has no key for, and it never sees the key.

A link with a key in its fragment opens an encrypted document:

```
http://localhost:3001/?doc=notes#k=<base64url, 32 random bytes>
```

### Why the fragment

Browsers do not send `#...` in an HTTP request. So the server is not trusted with the
key — it has never been given it. Every other option (a header, a query parameter, a key
stored server-side) is something the server sees, and "the server is trusted not to read
it" is a weaker claim than "the server cannot read it".

A shared link **is** the credential. Whoever has the URL can read and edit the document.
There is no escrow and no recovery: lose the link, lose the document.

### What the server can and cannot see

| Sees                                               | Cannot see    |
| -------------------------------------------------- | ------------- |
| Operation counts, timing, which site sent them     | Any character |
| The element key of each operation, `i:alice@7`     | Any anchor    |
| Which operations are inserts and which are deletes | Any text      |
| Document ids, participant count                    | Titles        |

That metadata is real leakage and nothing here addresses it. But it is the same class the
server already had before encryption, and it is strictly less than the content.

### What it costs

Encrypted documents **cannot be compacted server-side** and get **no text cache**, because
both need plaintext. So their operation log grows for the life of the document, and a cold
device replays the whole history rather than fetching a string.

This is a real trade, made deliberately. `docs/adr/0014-end-to-end-encryption.md` records
it along with the alternative — client-produced snapshots, which would restore compaction
by moving trust to a peer.

### Trying it

1. Click **New encrypted** in the toolbar. A key is generated in your browser and written
   into the address bar — it is never transmitted.
2. Click **Copy link** and paste it into a second window. Both windows now share a document
   the server cannot read.
3. `curl localhost:3001/api/documents/<id>` as the owner: `content` is empty. The server
   holds ciphertext and cannot replay it.

To open someone else's encrypted document you need the whole link. Without the fragment
you get `ENCRYPTED_NO_KEY` rather than a document silently missing what the other person
typed — and the server refuses to accept plaintext for a document that has ever been
encrypted.

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

Copy `.env.example` to `.env` and fill in values. `.env` is gitignored; `.env.example` is
committed and must never contain real credentials.

| Variable          | Default              | What it does                                                                                         |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`      | _unset_              | Signs session tokens. Unset means auth is **open**, which is refused when `NODE_ENV=production`      |
| `AUTH_MODE`       | inferred             | `required` or `open`, to pin the decision explicitly                                                 |
| `LOG_LEVEL`       | `info`               | `debug` to include per-connection detail                                                             |
| `PORT` / `HOST`   | `3001` / `127.0.0.1` | Where the server listens. **`HOST` must be `0.0.0.0` in a container** — see [deploy](docs/deploy.md) |
| `PGLITE_DATA_DIR` | `./.data/pgdata`     | Where the database lives. Must be a mounted volume in a container                                    |
| `CLIENT_DIST`     | `./dist/client`      | Where the built client lives, served by the same process                                             |
| `CSP_MODE`        | `enforce`            | `report-only` to watch for policy violations instead of enforcing them                               |

`.env.example` documents exactly the variables the code reads. A test compares it against
the source in both directions, so a variable that does nothing — or a variable that does
something but is undocumented — fails CI rather than misleading the next reader.

### Write quotas

**One row is stored per character**, so a document of N characters is N rows each carrying a
JSON operation. An anonymous session is obtainable without credentials in open mode. These
four limits are what stops one client filling a disk.

| Variable                | Default   | What it does                                                               |
| ----------------------- | --------- | -------------------------------------------------------------------------- |
| `MAX_TITLE_LENGTH`      | `200`     | Code points, on create **and** rename                                      |
| `OPS_BURST`             | `100000`  | Operations one connection may send back-to-back before the bucket is empty |
| `OPS_PER_SECOND`        | `5000`    | Sustained rate per connection, once the burst is spent                     |
| `MAX_DOCUMENT_ELEMENTS` | `1000000` | Rows in one document's log, past which **new elements** are refused        |

Every default is chosen so that no legitimate session trips it. The burst is 100 full
`MAX_OPS_PER_FRAME` chunks — 12,000 operations, which is what a long offline session actually
produces, passes with room to spare — and the gap between the burst and the sustained rate
gives a reconnecting client 20 seconds of free credit before anything is refused.

Three things worth knowing before you change a number:

- **A bad value falls back to the default, not to zero.** Unparseable, zero, negative and
  fractional values all use the default. A limit that silently became 0 would refuse every
  operation while looking configured.
- **Deletions are still accepted at the document cap.** Refusing tombstones would leave a full
  document with no way to empty it, turning a quota into a dead end.
- **A refused connection is closed with `1008` and gets a fresh budget on reconnect.** The
  client backs off with jittered exponential backoff (ADR-0008) rather than spinning, and
  `RATE_LIMITED` is deliberately _not_ on its list of permanent refusals.

The two counters to watch are `collab_ops_rate_limited_total` (connections closed for rate) and
`collab_documents_too_large_total` (writes refused by the cap). Zero in both is the healthy
state; either being non-zero means a limit is doing its job.

Without `JWT_SECRET`, the server logs a warning on startup and `/api/health` reports
`"auth": "open"`. It refuses to start that way under `NODE_ENV=production`.

---

## Running it in a container

```bash
export JWT_SECRET="$(openssl rand -base64 48)"
docker compose up --build      # http://127.0.0.1:3001
```

One process serves the API, the WebSocket and the client on one port, from one origin —
which is why no CORS configuration exists anywhere in this project.

`PGLITE_DATA_DIR` must be a mounted volume. Without one, every rebuild starts from an
empty database. [`docs/deploy.md`](docs/deploy.md) covers the free-tier deploy options,
the three container traps that each produce a container which starts and serves nothing,
and — importantly — **what has and has not been verified** about the image.

---

## Documentation

| Where                                   | What it holds                                  |
| --------------------------------------- | ---------------------------------------------- |
| [`NOTES.md`](NOTES.md)                  | Running log: what confused me, what went wrong |
| [`docs/`](docs/README.md)               | Architecture decisions, benchmarks, rationale  |
| [`docs/deploy.md`](docs/deploy.md)      | Containers, free-tier deployment, the traps    |
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
- **Encrypted documents never compact server-side and get no text cache.** Compaction
  walks the live element set and the text cache replays the log; both need plaintext.
  Their `document_ops` log therefore grows for the life of the document, and a cold device
  replays the whole history rather than fetching a string. See
  [ADR-0014](./docs/adr/0014-end-to-end-encryption.md), which names client-produced
  snapshots as the way out and the new trust problem that would introduce.
- **Authentication is anonymous, and that has limits.** A session is a signed token
  carrying a random subject; there are no accounts. Two browser profiles are two
  subjects with no way to prove they are the same person, and clearing site data
  loses access to your documents. `POST /api/documents/:id/claim` takes ownership of
  an unowned document. See [ADR-0012](./docs/adr/0012-authentication-and-ownership.md).
- **Documents created outside the API are world-writable.** `owner IS NULL` means
  anyone with the id may read and write, which is what kept pre-authentication data
  working.
- **There is a race on claiming an unowned document.** First subject to claim wins.
- **Run exactly one server instance.** Fan-out is in-process, so a second instance would
  not see the first one's connected clients and a document's collaborators would be split
  across two half-relays. A pub/sub broker is the fix and has not been built.
- Rate limiting is per-process and in-memory, so it resets on restart.
- Security has **not** been independently reviewed. Input validation covers
  protocol framing, request bodies and CRDT operations; authorisation is now
  covered by tests, but no one outside this repository has read it.
- Client bundle is 302 kB (100 kB gzipped), mostly CodeMirror. No sourcemap is emitted
  unless `SOURCE_MAPS=true`, since a 1.6 MB map referenced from the bundle is five times the
  payload every visitor would download for a debugging aid most deployments never use.
- The test suite takes ~5 minutes, dominated by Postgres start-up per suite. Files
  that need many cases share one boot and truncate between tests; see
  `Database.truncateAll`.
- **The encrypted path has load numbers but no k6 figures.** k6 runs on Go with no
  WebCrypto, so it cannot encrypt, and writing AES-GCM in JavaScript for the load
  generator would be a second crypto implementation. Convergence under contention is proven
  in `src/server/encryptedConvergence.test.ts` with the real `Replica`; server-side
  throughput for encrypted frames is not measured at all.

---

## Licence

MIT — see [LICENSE](LICENSE).
