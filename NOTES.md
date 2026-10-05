# NOTES — design decisions and learning log

Two jobs:

1. Record **why** each decision was made. The trade-off reasoning is the
   highest-signal part of this project in an interview — the code itself is
   expected; the judgement is not.
2. Record what was confusing. This file becomes the blog post outline in Phase 6,
   and it proves the work was a learning process rather than copy-paste.

---

## Phase 0 — Toolchain and primitives

### Decision: element ID is `(site, clock)`

**Alternative considered:** Lamport timestamps, HLC (hybrid logical clocks),
UUIDv7.

A Lamport timestamp alone is not enough — two replicas can issue the same
value, and uniqueness across the whole document is the property everything
depends on. A `(site, counter)` pair gives uniqueness by construction while
keeping per-site ordering free.

HLC would add wall-clock correlation, which is useful for human-readable logs
but adds complexity we do not need yet. Revisit if timestamps ever need to be
meaningful across machines.

### Decision: tie-break on `site` lexicographically

**The subtle part.** When two replicas insert concurrently, there is no causal
relationship between them, so delivery order differs per replica. Comparing
site IDs gives every replica the same answer regardless of arrival order.

This is why `compareElementId` must be a genuine _total_ order (reflexive,
antisymmetric, transitive). If it is only "consistent enough", merge stops being
associative and documents diverge silently. There is an explicit test for this —
`compareElementId > is reflexive, antisymmetric, and transitive`.

Confusing bit: intuition says "tie-break by arrival time" or "by replica ID
assigned at join". Both are wrong. Arrival time differs per replica. Replica ID
is fine _only_ if it is stable and identical everywhere — which `site` is.

### Decision: seeded PRNG for all test randomness

`Math.random()` cannot be replayed. When a fuzz test finds a divergence after
10,000 operations, we must reproduce the exact sequence to debug it. Seed →
sequence must be a pure function.

This is why `mulberry32` exists rather than relying on a library — it is short
enough to read and audit in full.

### Decision: strictest practical TypeScript settings

`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`verbatimModuleSyntax` are all on.

They are painful for roughly the first two days and then pay for themselves.
Array indexing returns `T | undefined` under the first flag, which forces
explicit handling of every bounds case — in a CRDT, out-of-bounds and
off-by-one are exactly the bug class that destroys documents.

### Decision: no framework in Phase 0

Deliberate. The CRDT is pure logic with no I/O, so it is fully testable in
milliseconds. If it needs mocking or a browser to test, the design is wrong.

---

### Gotchas hit while building this (real, not hypothetical)

**JavaScript signed zero broke a correct test.** The antisymmetry check was
written as:

```ts
expect(Math.sign(cmp(a, b))).toBe(-Math.sign(cmp(b, a)));
```

The comparator was right; the assertion was wrong. When `a` and `b` are equal
both sides are `0`, and `Object.is(-0, 0)` is `false`, so `toBe` fails.
Fixed by expressing antisymmetry as a sum:

```ts
expect(Math.sign(cmp(a, b)) + Math.sign(cmp(b, a))).toBe(0);
```

Worth remembering: `toBe` uses `Object.is`, so it distinguishes `-0` from `0`.
A test that fails only on the equal-elements case is usually an assertion bug,
not a logic bug. Check the simplest explanation first.

**TypeScript 7 exists but cannot be used here yet.** TS 7 (the native
compiler) is out, but `typescript-eslint@8.71.0` declares
`peer typescript ">=4.8.4 <6.1.0"`. Pinned to `~5.9.3` instead.

Lesson: check the peer dependency range before jumping to a new major version
of anything. A three-line version bump that blocks the whole toolchain is not
worth the novelty.

**`@eslint/js` is versioned independently of `eslint`.** Asking for
`@eslint/js@^10.12.0` fails because it is at `10.0.1`. Worth a moment's
confusion the first time it happens.

**Type-aware ESLint cannot see config files.** `tsconfig.json` includes only
`src/`, so `eslint.config.js` and `vitest.config.ts` sit outside any project
and type-aware rules fail to parse them. Fixed with:

```js
projectService: {
  allowDefaultProject: ['*.config.ts', '*.config.js'];
}
```

**Dependency hygiene was not optional.** The initial install pulled
`vitest@2.x`, which carried 2 critical and 1 high advisory (path traversal in
`@vitest/mocker`, dev-server request exposure in `esbuild`). Upgrading to
`vitest@5.0.3` took the audit to zero. A green test suite means nothing if the
toolchain underneath it has known holes.

---

## Open questions for later phases

- [x] Phase 1: CodeMirror 6 vs. hand-rolled editor? → CodeMirror.
      [ADR-0005](./docs/adr/0005-codemirror-not-handrolled.md)
- [x] Phase 2: Per-user undo without undoing a collaborator's work. → Per-site
      undo stacks, and CodeMirror's own history removed in Phase 4 so only one
      stack can be authoritative.
- [ ] Phase 2/5: Tombstone garbage collection. Still open, and now load-bearing:
      `document_ops` grows monotonically and nothing deletes anything.
- [x] Phase 3: Server fanout vs. peer-to-peer WebRTC? → Server. Recorded in
      [ADR-0007](./docs/adr/0007-server-is-a-relay-not-a-merge-authority.md).
- [ ] Phase 5: Which observability stack — OpenTelemetry + Grafana, or just
      structured logs plus Prometheus?
- [ ] Phase 6: Benchmark suite vs. end-to-end encryption as the differentiator.
      Pick one.

## Phase 5 — Compaction

452 tests, 22 files. ~200s.

ADR-0009 left one limitation standing: `document_ops` is one row per character and
nothing ever deletes anything. A document edited a thousand times stored a thousand
times its size. That is not a demo limitation — it also means any load-test number
would mostly be measuring table growth.

### What was built

| Module                        | Why it exists                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `core/crdt/snapshot.ts`       | Snapshot as a live element set with IDs. Replays through `applyInAnyOrder` like anything else. |
| `server/compaction.ts`        | The decision: is it safe, and is it worth it? Total, pure, no I/O.                             |
| `server/compaction.test.ts`   | 15 tests, including a 400-run property test on the safety invariant.                           |
| `server/compactionDb.test.ts` | 15 tests against real Postgres, proving the reclaim is real.                                   |

### Three bugs the tests caught, one of them serious

- **A live element can anchor to a deleted one.** Delete "quick" from "the quick
  brown fox" and the space before "brown" is still visible, but it was created as a
  child of the deleted "k". My first implementation copied each element's original
  origin, which means carrying every tombstone — so compaction reclaimed nothing
  on exactly the documents that need it most, the heavily edited ones.

  The fix is to **re-anchor live elements to their nearest live ancestor** and drop
  tombstones entirely. That is safe because document order is preserved (elements
  are emitted in order), sibling order is preserved (the integration rule compares
  only the two IDs being ordered), and a later insert anchoring to X lands
  identically because X's position has not changed — only its history differs.
  Tombstones are now carried only when an operation that follows the snapshot names
  one.

- **`materializeContent` ignored snapshots, and then wrote the wrong answer back.**
  This is the serious one. The method replays the log and _writes_ the result to
  `documents.content`. Once compaction had pruned the log, it computed an empty
  document and overwrote a perfectly good cache with it. Silent, and it destroyed
  the exact thing the method exists to verify. Now it replays snapshot-then-log,
  and there are two regression tests on it.

- **Sequences were inferred from array position.** `latestSeq` was `ops.length` and
  each op's sequence was `index + 1`. Both are correct only while the log is
  contiguous from 1, and it stops being contiguous the instant a prune happens. So
  every sequence would have been wrong after the first successful compaction —
  silently. Sequences now travel with each entry.

Also a smaller one: the `already-compacted` check was masked by `log-too-small`,
because after a successful compaction the log below the floor is empty and the size
check fired first. Reordered, so the real reason surfaces.

### The causal-stability floor

Prune only below the minimum acknowledged cursor across connected peers. One
abandoned tab would otherwise stop compaction forever, which is handled by
treating a disconnected peer as absent rather than as stalled.

The invariant is asserted directly: over 400 seeded runs, the chosen snapshot
sequence is never above the lowest peer cursor, and the result always rebuilds the
document exactly.

A consequence worth recording: **with no peers connected the floor is the tip, so
after one compaction nothing new can ever be reclaimed until a peer reconnects and
falls behind.** That is correct — there is nothing to protect — but it means
compaction only runs meaningfully when clients are actively connected, which is
also when it costs the least.

### Known limitations

- Peer cursors are self-reported and unverified. A buggy client claiming to have
  applied a sequence it has not would let the server prune too far.
- The IndexedDB cap on the client prunes against a hard ceiling only. Pruning
  breaks replay, so a real policy needs a snapshot-and-truncate scheme. A client
  that prunes its own log below the server's compaction floor will be served a
  baseline, so this converges correctly but wastes a frame.
- `materializeContent` is O(document) and exists mainly for repair.

---

## Phase 5 — Baseline protocol, and enabling compaction

470 tests, 23 files.

Phase 5 part one built the compaction mechanism but deliberately did not wire it
into the relay, because `readSince` still assumed a contiguous log. Part two is the
protocol that closes that gap, which is what makes compaction safe to enable.

### What was built

| Module                                   | Why it exists                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `server/db.ts` → `readForClient`         | Chooses delta or baseline. The choice, and getting it wrong is silent. |
| `shared/protocol.ts` → `SnapshotMessage` | The baseline frame, with the client's obligation written into it.      |
| `server/relay.ts` → `onCursor`           | Feeds the causal-stability floor from what each client has applied.    |
| `core/crdt/replica.ts` → `resetTo`       | Replaces a replica, keeping its site and clock.                        |
| `server/baseline.e2e.test.ts`            | A peer below the floor converges against a real relay and database.    |

### The client obligation, and why the transport enforces it

A baseline **replaces** the document. Applying one to a client holding unsent
operations would discard work the user believes is saved, and nothing would report
it — the client's log looks consistent right up until the next reload.

So the transport refuses when the outbox is non-empty, flushes, and re-requests.
Three refusals and it gives up with `BASELINE_REFUSED` rather than spinning.

Getting that test to run at all exposed a **real bug**: `#flushOutbox` cleared the
outbox _before_ calling `#send`, and `#send` silently no-opped when the socket was
not actually ready. So in the window where the transport believed it was open but
the network had already dropped the connection — exactly the window where offline
matters — **keystrokes were dropped on the floor with no error**. The outbox is now
cleared only after a frame is genuinely accepted.

I could not reach the refusal branch until I fixed that, which is a good sign: the
branch was unreachable because the bug was unreachable.

### Two test bugs worth recording

- **A test that hand-derives CRDT ordering is a second, wrong implementation.**
  My baseline e2e test computed the expected text by simulating twenty edits from
  twenty sites. It disagreed with the CRDT, and the CRDT was right. It now reads
  the expected text from the store, because the interleaving is exactly what RGA's
  tie-break decides and re-deriving it proves nothing.
- **"The peer never heard about it" was a test bug, not a bug.** `store.apply`
  persists but does not broadcast; only the relay does. The test was calling the
  wrong entry point, so the code was fine.

### Known limitations

- Peer cursors are self-reported and unverified. A buggy client claiming to have
  applied a sequence it has not would let the server prune too far.
- Compaction runs on a write counter (40 writes), so a document edited more slowly
  compacts later than one edited in a burst. Correct either way; only the timing
  differs.
- The client's IndexedDB cap is still a hard ceiling, not a snapshot-and-truncate.
  A client that prunes below the server's floor gets served a baseline, so it
  converges — it just wastes a frame.
- With no peers connected the floor is the log tip, so compaction cannot run again
  until a peer reconnects and falls behind. That is correct (nothing to protect)
  and means compaction mostly does its work while clients are active.

---

## Phase 5 — Authentication

605 tests, 27 files. This is the item that closed a real hole rather than adding
capability, so it got the most scrutiny.

### What was built

| Module                           | Why it exists                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `server/auth.ts`                 | HS256 sessions with a pinned algorithm and required claims; an open-mode class that is refused in production |
| `shared/subject.ts`              | One rule for what a subject is, used by both the token path and the database                                 |
| migration `0004`                 | `documents.owner` plus a `document_collaborators` grant table                                                |
| `db.ts` → `canAccess`            | The single authorisation decision both transports call                                                       |
| `relay.ts` → `authorize`         | Authorise at `hello`; pending sockets live in a set of their own                                             |
| `api.ts`                         | Bearer middleware, scoped listing, grants, claim                                                             |
| `client/api.ts` → `SessionStore` | Token per connect, renewed an hour early, one retry on 401                                                   |

### The four real findings

`jwtVerify` **accepts a token with no `exp` claim at all.** Expiry is checked when
present, not demanded. A signed token with the expiry stripped would have been a
permanent credential and nothing would ever report it. `requiredClaims` now names
`exp`, `sub`, `iss` and `aud`. I only found this because I wrote a test asserting
the token is rejected, and it wasn't.

`AUTH_MODE=required` outside production silently fell through to open mode. The flag
was decorative.

`grantAccess` never validated the subject shape, so arbitrary text from a request
body went straight into a database primary key that is also rendered in a
collaborator list. The rule now lives in `shared/subject.ts` and both paths use it.

Making the hello send asynchronous **introduced a race I had not seen for three
phases**: queued operations flushed immediately after `hello` was written, while the
server's authorisation check was still awaiting the database. The server refused them
and closed the socket. The fix is a real handshake — open, then hello written, then
welcome received — and only then may anything else be sent. Both flags are required
rather than relying on their order.

### Two test bugs, same mistake twice

A presence broadcast goes to everyone in the room **except the sender**, so a lone
client observing her own presence sees nothing and I wrote the test backwards.

A document id that always resolved to `'default'` turned a per-document
authorisation test into one that only ever checked a single document — which passed
for entirely the wrong reason. `socket.url` is not populated the way the upgrade
request's URL is; the document id has to come from `request.url`.

Both are recorded because "the test was wrong, not the code" is the conclusion that
is easiest to skip and most expensive to get wrong.

### Test suite performance

`httpAuth.test.ts` took 102 seconds, almost all of it booting PGlite once per test.
`Database.truncateAll()` truncates `documents` with `CASCADE`, which is real
isolation — `documents` cascades to `document_ops`, `document_collaborators` and
`document_snapshots` — for one boot per file. **102s → 1.9s.**

The rule that mattered: sharing a database _without_ resetting it would have made
exact-list assertions order-dependent, which fails confusingly rather than loudly.

### Known limitations

- **Anonymous subjects are not identity.** Two browser profiles are two subjects with
  no way to prove they are the same person, and there is no recovery: clear site
  data and the old documents are unreachable. A `POST /api/documents/:id/claim` lets
  an unowned document stop being world-writable, but there is no way to find yours if
  you have lost your token.
- **Unowned documents are world-writable.** Every document created before migration
  0004, and every document created outside the API, is readable and writable by
  anyone who learns its id. `claim` is the exit, and it is not automatic.
- **There is a race on claiming.** Any two subjects can race for an unowned document
  and the first wins. That is the price of keeping pre-authentication data working;
  the alternative is `NOT NULL` plus a backfill that assigns every existing document
  to a sentinel owner.
- **Collaborating means sharing a subject out of band.** The API can grant access; no
  UI does, because a share UI is CRUD. Two people collaborating today means one
  tells the other their subject.
- **The token lives in memory only.** Clearing site data loses it. Persisting to
  `localStorage` would make it readable by any script on the origin.
- Peer cursors are still self-reported and unverified; a client claiming to have
  applied a sequence it has not would let the server prune too far.

---

## Phase 5 — Observability

704 tests, 31 files. Built before the load-testing work, because a benchmark whose
numbers nothing can corroborate is a press release.

### What was built

| Module                     | Why it exists                                                 |
| -------------------------- | ------------------------------------------------------------- |
| `observability/metrics.ts` | Registry and Prometheus text rendering. No client dependency  |
| `observability/logger.ts`  | JSON lines with redaction at the serialisation boundary       |
| `observability/routes.ts`  | Bounded route templates for metric labels                     |
| `observability/index.ts`   | Every metric name, type and help text, in one table           |
| `GET /api/metrics`         | The scrape. Unauthenticated, because a scraper has no session |

### Label cardinality is the thing that actually bites

`requests_total{path="/api/documents/8f2c1a"}` is one series per document. Forty
documents is forty series for one endpoint; a crawler creates thousands; the
monitoring system falls over while the application is fine.

Two defences, because one is a convention and conventions get broken:

1. Labels are route **templates**. `/api/documents/:id` is one series forever.
   `routes.ts` is 60 lines and a property test generates 2,000 hostile paths with a
   delimiter-heavy alphabet and asserts the output is always one of ten known
   strings.
2. Every metric has a hard cap on distinct label combinations. Past it, new ones are
   refused and counted, and `overflowedMetrics()` names the culprits. The backstop for
   the case someone adds a raw path by accident.

### Four findings

**`declareMetrics` declared gauges as counters first.** It called `describe`, which
creates a counter, then `ensure`d the same name as a gauge — which the registry
correctly refused. My own guard, catching my own ordering bug. Fixed by putting every
metric in one table with its type, so the order cannot be got wrong.

**`http_requests_in_flight` used `increment` on a gauge.** Caught by the same guard,
in the other direction. The fix is `add`: a cumulative representation of a gauge
would report every request ever handled as still in flight.

**`#leave` published the connection gauge before removing the client from the room.**
So it reported the count as it was _before_ the leave — the opposite of what a gauge
is for, and it made the gauge permanently stuck at its last high-water mark. Found by
a test asserting the gauge returns to zero and never does.

**The "authentication is OPEN" warning was emitted twice**, once as plain text and
once as JSON. Only visible by running the real server and reading its output, which
tests do not do: `index.ts` has no test coverage, and the warning was harmless-looking
in the source. Every line the process writes is now JSON, including the startup-failure
line, and there is a smoke check in NOTES for it.

### Four test bugs, all measuring the wrong thing

`http_requests_in_flight` asserted as `0` from inside a scrape. A scrape is itself a
request, so while `/api/metrics` renders the gauge is legitimately 1 — the test was
asserting on the timing of the scrape, not the behaviour.

The cardinality test compared 50 documents against 0 and expected growth under 10. It
grew by 80, all of it `/api/metrics` observing itself for the first time. Fixed by
comparing 50 against 5, with a warm-up scrape so the endpoint has already recorded its
own series.

The same test then failed comparing series _lines_, which change value on every single
request. Comparing series _names_ is the property; comparing lines reports growth on
every call.

WebSocket close timing used fixed sleeps. Those pass on a fast machine and fail on a
slow one, which is exactly what a load-test run on the same CI budget is. Replaced
with `waitFor`.

### Also worth knowing

The registry renders sample families in sorted order and is byte-stable between
identical scrapes. A scrape that reorders itself makes every diff noisy, which is how
people stop reading them.

`DEFAULT_BUCKETS` ends with a real `+Inf` bucket rather than an implied one. Without
it a 30-second replay appeared in `_count` and in no bucket at all, which reads as "no
slow requests happened".

### Known limitations

- **No Prometheus client dependency**, so no remote write, no exemplars, no native
  histograms. The text format is a few dozen lines and vendoring the ecosystem to
  serialise a `Map` is a poor trade. A collector scraping `/api/metrics` is the
  intended deployment and costs nothing.
- **Metrics are per-process and in memory.** Two instances behind a load balancer each
  report their own. Aggregation is the scraper's job; there is no shared store.
- **The cardinality cap silently drops observations** past the limit. It counts the
  drops and names the metric, but a histogram losing observations looks like latency
  improving. The route templates are the real defence; the cap is the alarm.
- **No tracing.** `x-request-id` is not propagated, so one request across the HTTP
  handler and the database cannot be followed as a unit. Structured logs with a shared
  `requestId` field would be the cheap version of this.
- **No log sampling.** At INFO every request writes nothing, but a debug-level
  deployment would write one line per request with no way to turn that down.

---

## Phase 5 — Load testing, and the benchmarks it produced

The suite exists because "it is correct" and "here is what it does" are different claims,
and only one of them is checkable by a reviewer.

### What was built

| Module                                                | Why it exists                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `scripts/load/run.mjs`                                | Starts a production-mode server, runs k6, captures the server's own metrics |
| `scripts/load/lib/auth.js`                            | Mints **real** HS256 tokens inside k6                                       |
| `scripts/load/lib/protocol.js`                        | Handshake, frame handling, valid operation generation                       |
| `connect.js` `edit.js` `reconnect.js` `divergence.js` | The four scenarios                                                          |
| `src/server/loadConvergence.test.ts`                  | Convergence under load, using the **real** `Replica`                        |
| `docs/benchmarks.md`                                  | The numbers, the method, and what they do not mean                          |

### The design decision that mattered

**k6 does not verify convergence, and cannot honestly.**

k6 cannot import this package's TypeScript. Checking convergence inside it would mean
writing a second RGA in JavaScript: a second, separately wrong implementation of the
algorithm under test, disagreeing for reasons that have nothing to do with the real
CRDT. That is the same mistake as the test that hand-derived CRDT ordering and was wrong.

So the jobs are split. `divergence.js` generates maximum contention and reads the server's
verdict — `collab_operations_unplaced_total`, which is zero. And
`loadConvergence.test.ts` verifies convergence with the real `Replica`, over a real
relay, with real authorisation: 24 replicas inserting and deleting simultaneously for 60
rounds, all ending with identical documents and no invariant violations.

### Every one of these produced a plausible, WRONG benchmark

Not a crash. A clean exit code and a number that meant something else.

| Trap                                                            | What it looked like                                                                                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `k6/ws` sockets have no `readyState`                            | A `readyState === 1` guard dropped **every operation**. One burst per client, no server broadcast — indistinguishable from a server that went quiet                                |
| `WebSocket.open` is gone in k6 v2                               | The export is a bare `connect`. The old name fails with `Cannot read property 'open' of undefined`                                                                                 |
| Timers do not fire inside a websocket callback                  | `setInterval` and `setTimeout` both silently never ran. Bursts are now driven by incoming frames, which is a better model of typing anyway                                         |
| `sleep()` inside a websocket callback stops after one iteration | Same shape of failure: one burst, then silence                                                                                                                                     |
| k6's `sleep` takes **seconds**                                  | `sleep(1000)` meant a thousand seconds. The teardown timed out and the whole run was reported as a script exception                                                                |
| **`K6_*` is k6's configuration namespace**                      | A custom `K6_DURATION` silently overrode the scenario's own duration. Every knob is now `LOAD_*`                                                                                   |
| `connect()` blocks for the socket's lifetime                    | A scenario that does not close explicitly hangs its VU, and **everything recorded after the call records nothing** — a rate reported as `0 out of 0` rather than as a number       |
| k6 `hmac` returns a base64 _string_                             | Base64url needs that string converted, not base64-encoded again. Double-encoding yields a well-formed token that never verifies — which looks exactly like "the load test is slow" |

### Two harness bugs that reported clean exits while measuring nothing

Both are why `run.mjs` now checks the result rather than trusting the exit code.

1. **`--quiet` hid a total failure.** Every iteration was throwing, zero samples were
   recorded, and k6 still exited 0 — because thresholds on an absent metric are silently
   ignored. The harness now asserts that samples were recorded.
2. **`setup()`'s own checks satisfied that first guard.** Two setup checks were enough to
   pass it while every scenario iteration hung. It now also asserts that iterations
   completed.

### A measurement bug worth recording

The first `connect.js` reported a **74-second handshake**. k6's `connect` blocks for the
socket's lifetime, so timing around the call measures the whole ramped session. The
handshake is now timed inside the `welcome` handler, which is the only moment it is
genuinely complete. The real figure is 212 ms at p95.

The same class of bug appeared twice more: a clock-value trend labelled as a duration,
and a burst-latency trend measured around a non-blocking call, which is always ~0 ms.

### Results

Recorded, with raw output committed in `docs/benchmarks/`. i5-12500H, 16 threads,
Windows 11, Node 24.16.0, k6 2.3.0, PGlite in-process, auth **required**. **Three
runs per scenario** — medians, with the observed range.

| Scenario     | What                                             | Result                                                                  |
| ------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `connect`    | 50 concurrent, 20 s ramp                         | **3,732** handshakes, p95 **245 ms** (237–252), 0 refusals              |
| `edit`       | 20 concurrent editors                            | **38,465** ops at **1,282/s** (999–1,485), **0** unplaced               |
| `reconnect`  | 10 clients vanishing and returning               | **150** reconnects, **100%** readmitted, catch-up p95 **25 ms** (22–36) |
| `divergence` | 25 clients, 30% deletes of each other's elements | **43,360** ops at **1,398/s** (1,135–2,477), **0 unplaced**             |
| convergence  | 24 real replicas, 60 rounds                      | **0** diverged, **0** invariant violations                              |

The server's independent counters agree with the client's — in the final `connect` run,
3,778 connections opened matched 3,778 client handshakes exactly. That cross-check is
why the numbers are worth quoting: a generator that merely believed its own successes
would agree with itself just as happily.

**Under real load, compaction refused 12 times because peers had not caught up.** ADR-0011's
causal-stability floor holding in production-shaped conditions, rather than only in a unit
test.

### The honesty section is not optional

`docs/benchmarks.md` opens with four reasons these are **not** production-representative:
PGlite is in-process WASM with no network hop, one Node thread, a shared laptop that once
had 700 MB of 16 GB free (the server could not start at all), and loopback with no
network latency. It also lists what is not measured at all: database performance,
horizontal scaling, network conditions, large documents, steady-state compaction, and
client-side rendering.

A benchmark document that skips this section is a press release.

### One run is not a measurement

After clearing memory I re-ran every scenario expecting better numbers, and got
**worse** ones: `edit` dropped from 1,411 to 1,027 ops/s. That is worth recording
because the instinct was to distrust the run.

Running each scenario **three times** instead of once settled it. The spread is
not noise around a stable value — latency percentiles are tight (`connect` p95
within 3%, `reconnect` within 6%) while throughput is not (`edit` send rate ±20%,
fan-out ±120%). Quoting the first run would have meant reporting which end of the
distribution I happened to hit as if it were the number.

So `run.mjs` now takes `--repeat N` and writes an aggregate with **median and
min–max**, and the doc reports ranges. A figure with no range is a story about one
afternoon, not a measurement.

The fan-out spread turned out to be explainable rather than mysterious: fan-out is
`ops × (clients − 1)`, and k6 starts and stops sessions as iterations complete, so
a run that holds 20 clients concurrently broadcasts ~12× more than one whose
clients stagger. A property of the workload, not the relay.

### `--repeat` found a real bug in the product

Running `setup()` against a warm database re-granted access that already existed,
and the API answered **400**. Root cause: `grantAccess` returned a boolean, and
`ON CONFLICT DO NOTHING` returns no row, so "you may not" and "you already have"
were the same value. A client retrying a grant because it never saw the response
hits the identical case and is told its successful request was malformed.

Replaced with a `GrantResult` union — `granted`, `already-granted`, `no-document`,
`invalid-subject`, `not-owner` — and made the endpoint idempotent.

Writing the union is what made the _next_ mistake visible. My first version folded
`invalid-subject` into `no-document`, on the grounds that both were "it did not
happen". The HTTP test caught it immediately: a malformed subject on a document
the caller demonstrably owns must be **400**, not 404. The exact conflation I was
removing, reintroduced one level down. Splitting the cases is the whole point of
the union; not splitting them makes it decoration.

### Known limitations

- **The load suite drives the server only.** CodeMirror's per-keystroke cost is in none
  of these numbers.
- **Every run starts from an empty document.** A 200,000-character document would
  exercise the RGA's tree structure, which short documents never touch. This is the most
  valuable next benchmark.
- **k6 must be downloaded**, not vendored. `run.mjs` prefers `.tools/k6/` over `PATH` so
  a result names the exact version, but a fresh clone has nothing until the binary is
  unpacked.
- **No load test runs in CI.** It needs roughly 2 GB of free memory and a minute of wall
  clock, a poor trade against the rest of the gates. The correctness half
  (`loadConvergence.test.ts`) _does_ run in CI, which is the deliberate split: CI asserts
  convergence, and the numbers are recorded here for a human to compare against.
- **Single-process only.** The pub/sub question in the Phase 6 planned table is
  unanswered by any of this.

---

## Phase 4 — Offline-first

397 tests, 19 files. ~155s, still dominated by PGlite boots.

The headline claim is now tested as a claim rather than as a set of features:
`src/server/offline.e2e.test.ts` runs "kill the server, keep typing, restore,
nothing lost" against a real relay and a real database.

### What was built

| Module                           | Why it exists                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `core/crdt/replica.ts`           | CRDT plus its durable log. The log is authoritative; text is derived.                                        |
| `core/crdt/diff.ts`              | Minimal change sets by element identity, so a remote keystroke is one edit and not a whole-document replace. |
| `core/crdt/localEdits.ts`        | Editor edits → CRDT operations. The running-offset arithmetic, tested without a DOM.                         |
| `core/crdt/seed.ts`              | Deterministic text → operations, so two devices seeding the same document agree.                             |
| `client/storage/indexedDbLog.ts` | Durable log. Chosen over localStorage for the obvious reasons.                                               |
| `client/sync/binding.ts`         | CodeMirror ↔ CRDT. Owns the echo guard and the drift repair.                                                 |
| `client/sync/status.ts`          | The indicator's state machine, total and side-effect free.                                                   |
| `server/documentStore.ts`        | One replica per open document, for materialising text and rejecting unreplayable writes.                     |

`autosave.ts` was deleted. Two write paths would mean two sources of truth.

### Four real bugs, found by tests written to look for them

- **Insert and delete shared a dedup key.** The server's `element_key` was
  `(site, clock)` for both, so a delete looked like a redelivered insert and was
  dropped. A user deleted a word and it came back. Fixed by putting the operation
  type in the key. The test that caught it is the one asserting a delete actually
  removes the character.

- **`LogicalClock.observe` was restricted to the local site, and nothing called
  it.** This was the worst bug in the project so far, because it was invisible.
  A replica with a low counter typing into a document a collaborator had written
  produced an ID smaller than every sibling, so RGA's integration rule placed the
  character at the **end of the document** instead of at the caret.

  Nothing crashed. Convergence still held — every replica agreed on the same
  wrong document. A convergence fuzzer cannot find this, because it _does_
  converge.

  Fixed by making the clock a proper Lamport clock, called on every applied
  insert. Two Phase 2 tests had encoded the buggy output and now assert the
  correct behaviour. [ADR-0010](./docs/adr/0010-lamport-clock.md).

  The lesson worth keeping: **convergence and correctness are different
  properties.** Convergence asks "do all replicas agree?"; correctness asks "does
  the document match what the user typed?". A CRDT can satisfy the first and fail
  the second completely. The test that now guards it walks every offset and builds
  its expectation by slicing the original string, so a CRDT bug cannot make the
  test agree with itself.

- **PGlite is one connection, so `FOR UPDATE` bought nothing.** Two concurrent
  `appendOps` calls interleaved their `BEGIN` and `COMMIT` and produced a primary
  key violation. `SELECT ... FOR UPDATE` is the portable answer and is simply not
  the right one for an embedded single-connection database. Replaced with an
  in-process promise chain, and the code says so — including that it has to come
  back if this ever runs against a networked Postgres.

- **A redelivered operation consumed a sequence number.** `ON CONFLICT DO NOTHING`
  dropped the row but the counter had already advanced, so the cursor returned to
  the client ran ahead of the log. Harmless for a "since N" query, but the cursor
  no longer meant what its name said. Fixed with `RETURNING seq`, so the value only
  advances when a row was actually written.

### Two decisions I got wrong in the first draft

- **The diff assumed an invariant and did not check it.** `diffVisible` walked two
  element snapshots and trusted that survivors keep their relative order — true for
  RGA, but a wrong assumption produces plausible-looking edits rather than an
  error. It now returns `null` on violation, and the binding falls back to a full
  replacement and reports an anomaly. `applyChanges` then verifies the output
  against the CRDT before the transaction is committed. Cheap insurance, because
  the alternative is text on screen that disagrees with what gets saved.

- **The first drift test did not actually drift.** It dispatched into a view whose
  listener was wired, so the CRDT learned about the extra characters too. The test
  passed for the wrong reason. Replaced with a second view that has no listener,
  which is what the bug actually looks like.

### Testing notes

- **The binding needs a real DOM, and that is not optional.** The echo — dispatch,
  listener fires, convert to operations, broadcast, peer sends it back — only
  exists when the listener and the dispatch share one view. A mock cannot catch it
  because it removes the very wiring that causes it. Hence `jsdom` and a real
  `EditorView`.

- **Test peers must send explicitly, not through a queue.** My first version of
  the offline e2e test reused the outbox, and the reconnect cases failed for a
  reason that had nothing to do with offline-first: the outbox belonged to the old
  socket. Driving `send()` explicitly is honest about what the suite is testing —
  the architecture — and leaves the outbox to `transport.test.ts`, which already
  covers it.

- **`fake-indexeddb` is a real implementation, not a mock.** It runs the spec in
  Node, so transaction semantics, key order and cursor behaviour are exercised for
  real. Worth the dependency.

### Known limitations, recorded so they are not rediscovered

- `document_ops` is one row per character and grows forever. Needs compaction
  (tombstone squashing plus periodic snapshots) before it is more than a demo.
- The IndexedDB cap prunes against a hard ceiling only. Pruning breaks replay, so
  a real policy needs a snapshot-and-truncate scheme.
- `materializeContent` is O(document) and exists mainly for repair. The relay's
  replica and the log could disagree if a replica were evicted mid-write; it is
  not, so this is theoretical today.

### A CI failure that sat unnoticed for two phases

After the Phase 4 push I checked CI for the first time since Phase 2 and found it
had been **red the whole time**: `listDocuments > returns newest first`.

This then took **three attempts to fix properly**, which is the interesting part.

**Attempt 1 — the code was genuinely wrong.** `ORDER BY updated_at DESC` is not a
total order. Two documents written in the same transaction tie, and Postgres
returns tied rows in whatever order the heap gives it. A list endpoint whose order
changes between identical calls cannot be paginated against. Fixed with `id DESC`
as an explicit tiebreaker.

**Attempt 2 — the test was also wrong, and my fix made it worse.** I changed the
test to touch `a` after creating `b`, so it asserted `updated_at` ordering rather
than insertion order. That still assumed the timestamps would differ. It passed
locally and failed again on CI.

**Attempt 3 — the actual cause.** `now()` in Postgres is the **transaction start
time**, not the statement time. PGlite on CI batches aggressively enough that three
sequential statements land in one transaction and share a timestamp. So the
ordering was being decided by the tiebreaker, and the test was measuring Postgres's
batching behaviour rather than anything in this code.

The fix is to stop depending on the database's clock at all: `saveDocument` takes an
optional `updatedAt`, and the tests set explicit timestamps. That is a real API
addition with a real second use (restoring a document's age on import), not a test
hook dressed up as one.

Three lessons, in order of how much they cost:

1. **Check CI after every push.** Two phases of red because I verified locally and
   assumed the pipeline agreed.
2. **A flaky test is a broken test, even when the code is fine.** Twice.
3. **"Passes locally, fails in CI" is a fact about the test, not about the
   machine.** I reached for the tiebreaker first and the clock second, when the
   clock was the whole problem. The tiebreaker was still worth having — it is a
   genuine correctness fix — but it was not the bug.

Also worth noting: the Phase 2 CI run failed for an unrelated reason (a
`concurrently` install step), and I never looked at either run until Phase 4.

---

## Phase 1 — Single-user editor

### Decisions

- **CodeMirror 6** rather than a hand-rolled editor. A textarea has no document
  model, so every remote CRDT operation would degrade to whole-document
  replacement — losing the cursor on each edit. [ADR-0005](./docs/adr/0005-codemirror-not-handrolled.md)
- **PGlite** for local and CI. winget's PostgreSQL download is blocked on this
  machine (HTTP 403) and Docker needs WSL2, which needs a reboot. PGlite is real
  Postgres compiled to WASM, so the SQL is identical to production.
  [ADR-0006](./docs/adr/0006-pglite-for-local-and-ci.md)

### The bug that mattered most

Multi-byte text appeared corrupted when checking a save with PowerShell
`Invoke-RestMethod`. The instinct is to blame the database.

It was not the database. Node's `fetch` decodes responses as UTF-8 per spec;
PowerShell _guesses_, and with `Content-Type: application/json` carrying no
`charset`, it guessed Latin-1. Every multi-byte character came back as
mojibake. Sending the same bytes and decoding explicitly as UTF-8 round-tripped
perfectly.

The real defect it exposed was on the server: `Content-Type: application/json`
with no `charset=utf-8`. Any client is then free to guess, and several guess
wrong — so non-ASCII document text could be silently corrupted for real users.

Two lessons, and the second is the one worth keeping:

1. Add `charset=utf-8` to every JSON response. One line, prevents an entire
   category of data corruption.
2. **Verify at the byte level in tests.** The unit test using `fetch` was correct
   all along and would never have caught this. `src/server/e2e.test.ts` now
   asserts on raw bytes with `TextDecoder('utf-8', { fatal: true })`, so it
   cannot be fooled by an encoding mistake in the harness itself.

When a manual check disagrees with a passing test, the manual check is the more
likely thing to be wrong. Verify the harness before changing the code.

### Smaller things hit along the way

- **PGlite has no `':memory:'` path.** Passing it created a directory literally
  named `:memory:` on disk and failed with a confusing `EINVAL`. Omitting the
  argument selects the in-memory filesystem. Now documented at the call site.
- **Column DEFAULT does not apply to an explicit NULL.** `createDocument` bound
  `input.title ?? 'Untitled'` correctly, but binding `undefined` sent a real
  NULL and violated NOT NULL. Defaults must be applied in code when the value is
  passed as a parameter.
- **PGlite does not create the parent directory chain.** A fresh clone failed
  with `ENOENT` pointing at the wrong thing. Added `Database.openAt`, which
  creates the parent first.
- **A debounce is not a save guarantee.** Added `flush()` plus a `beforeunload`
  guard, because closing the tab mid-debounce silently loses the final edit. Also
  guarded against out-of-order responses with a revision counter, so a slow
  request cannot mark newer content as saved.
- **Two lint rules I wrote were wrong.** The `src/core` purity rule banned test
  files too, and `require-await` flagged a deliberate pending-promise mock. The
  first was a real over-restriction; the second was the rule correctly spotting
  that I had left an `async` on a function that awaits nothing.
- **`concurrently@9` shipped a critical advisory** (via `shell-quote`). Upgraded
  to `10.0.5`. The CI audit gate caught this automatically, which is the first
  real proof that gate earns its keep.

### Test suite

106 tests, ~2 minutes. The runtime is dominated by Postgres initialisation
(~2.5s per suite), not assertion count, so `fileParallelism` is `false`. Phase
2's fuzz test will likely force revisiting that.

---

## Log

- **Phase 4** — Offline-first. 397 tests. Two ADRs. The headline claim is now
  tested end to end against a real relay and a real database. Caught a Lamport
  clock bug that sent every local keystroke to the end of the document while
  converging perfectly, and a dedup key that made deleted text come back.

- **Phase 3** — WebSocket relay, jittered reconnect, real operation validation.
  213 tests. Two ADRs. The relay stayed dumb on purpose, so there is exactly one
  merge implementation in the project.

- **Phase 2** — RGA sequence CRDT with a seeded convergence fuzzer. Found no
  divergence in 5,000 seeds. The fuzzer is still the strongest artifact here and
  still cannot catch a bug that converges to the wrong document.

- **Phase 1** — Editor, persistence, autosave, and designed loading/error states.
  106 tests. Two ADRs. Caught a real content-type bug that would have corrupted
  non-ASCII text for some clients. Superseded in Phase 4: autosave is gone, and
  its role is taken by the operation log.

- **Phase 0** — Toolchain, strict TS, CI, and the `(site, clock)` element ID
  primitive with a total-order test. 39 tests passing, 97.3% statement
  coverage, zero dependency vulnerabilities.

  Friction encountered and recorded above: a signed-zero test bug, the
  TypeScript 7 peer-dependency wall, `@eslint/js` versioning, and
  type-aware ESLint not seeing config files. All four are normal first-day
  problems; writing them down is faster than rediscovering them later.

  Later in the phase, four problems worth recording because each would have
  become a real defect:

  - **Type guards do not narrow property access.** The first cut of
    `parseClientMessage` used helpers like `hasString(parsed, 'token')` and
    then read `parsed['token']` anyway. TypeScript cannot carry a narrowing
    across that helper call, so the values stayed `unknown` and needed five
    casts. Fixed by extracting fields to locals and narrowing each one
    directly. This removed every `as` from the function and made it shorter —
    the compiler was telling me the structure was wrong before I did.

  - **A passing test I had not earned.** One boundary test asserted that
    `ops: [{}]` would be rejected by the transport. It is accepted, correctly:
    `Operation` is an opaque `JsonValue` and the envelope makes no claim about
    contents. The test was encoding a wrong belief. Rewrote it to assert the
    real boundary and explain where op validation belongs instead —
    [ADR-0004](./docs/adr/0004-envelope-vs-payload-validation.md).

  - **Redundant assertions are a smell, not a style issue.** `cursor as
number | null` survived narrowing and type-aware ESLint correctly flagged
    it. An assertion that changes nothing usually means the surrounding logic
    is doing the work twice.

  - **Version drift is the real enemy.** The first install pulled
    `vitest@2.x` with two critical advisories. Added a CI audit gate that fails
    on high or critical, plus Dependabot so the upgrade PR exists
    automatically. Also pinned the Node version in `.nvmrc` and pointed CI at
    that file, so local and CI cannot disagree.

  - **Windows line endings.** Added `.gitattributes` forcing LF in the working
    tree except for `.bat`/`.cmd`/`.ps1`. Without it, `autocrlf=true` produces
    whole-file diffs that look like real changes and are not. Now backed by a real
    gate — see below — because the attribute alone did not stop it.

## Line endings needed a check, not just an attribute

`.gitattributes` said `* text=auto eol=lf` from Phase 0, and it was correct,
and it was **not enough**.

Editing two source files through PowerShell's `WriteAllLines` on Windows emits
CRLF. Those files became a mix of CRLF and bare LF. Git normalised the index on
commit, so the committed blob was fine and the commit looked clean — which is
exactly why it went unnoticed. The damage surfaced later as a _text-match
failure_: an edit tool could not find a string that was visibly present in the
file, because half the file's line endings disagreed.

`scripts/check-line-endings.mjs` now reports, as a CI gate:

- CRLF where `.gitattributes` mandates LF, and files that are genuinely mixed
- lone CR (very old Mac convention, or a botched edit)
- missing final newline, which usually means a truncated write
- UTF-8 BOM, which breaks the first line of every text tool and is invisible
- **U+FFFD**, the replacement character, which is what mangled UTF-8 looks like
  after a PowerShell round-trip

Two things worth recording from building it:

**The check failed on itself.** The detector compared against a _literal_ U+FFFD
glyph, so its own source contained the sequence it searched for and it reported
itself as corrupted. Fixed by comparing against `'\uFFFD'`. A detector that
depends on readable text will eventually match its own text.

**I verified the guard by breaking it, and my first sabotage was fake.** I
replaced the metrics write with a write of different content — the file still
existed, so the existence check correctly passed. Deleting the write entirely made
it fire with exit 5. A guard that has only ever been observed passing has not been
tested.

`docs/benchmarks/` is prettier-ignored for a related reason: reformatting
tool-generated artifacts on commit buries the data that actually differs between two
runs under indentation churn.

## The deployment work found the app could not be deployed at all

Starting on Docker exposed something with nothing to do with Docker.

`npm run build` emits `dist/client`. Nothing served it. `npm run dev` worked
because Vite's dev server proxies to the API; production had no equivalent.
Starting the built server and asking for `/` returned **401**, and
`/index.html` returned 401 too.

Found by running the thing and requesting a URL, not by reading the routing
table. A routing table with no static branch and no static handler looks correct
right up until a browser asks for a document.

`src/server/static.ts` now serves the built client. Public, deliberately: a
browser cannot present a bearer token when fetching the HTML shell, and the
shell is what obtains the token. That is only acceptable because nothing under
the root is user content - document content is never written into
`dist/client`, and `/api/` is refused by the resolver so no file can shadow a
real endpoint.

### Four bugs in the first version, two of them found by probing and two by tests

**`/` resolved to null.** The root path normalised to the empty string, which
the containment check treated as "nothing to serve", so the most common request
in the application fell through to authentication. Caught by starting the server
and probing `/`.

**The SPA fallback looked in the wrong directory.** `/documents/abc` looked for
`/documents/abc/index.html` instead of the root's `index.html`, so every
client-side route 404'd. Also caught by probing - `resolveStaticPath` was
correct, so a unit test of the resolver alone passed happily. That is the reason
the suite has an HTTP-level group as well as direct tests of the pure functions.

**`normalize` silently rewrote traversal attempts.** `/../package.json`
normalised to `/package.json` on Windows, because `..` at the root of a rooted
path is _dropped_. The result was safely inside the root so no escape was
possible, but a malformed request was quietly rewritten to a different file
instead of refused, and a probe would not appear in the access log. Now any `..`
segment is rejected before normalising, which also means the segment check and
the containment check test different things rather than the same thing twice.

**Double-encoded traversal slipped through.** `/%252e%252e/x` decodes once to
`/%2e%2e/x`, which is an ordinary directory name and not a `..` segment.
Decoding is now repeated, bounded at three passes so a caller cannot turn it into
a decompression loop.

### Two rules that drifted apart, and why that is worth fixing structurally

`static.ts` refused `/api` and `/api/...`. `routes.ts`, which builds metric
labels, excluded only `/api/`. So a 401 for `/api` was reported as
`/index.html` - every unauthenticated API call sharing one series with a
successful page load.

One predicate, `isApiPath`, is now exported from `static.ts` and used by both. A
security check and an observability label that each have their own copy of "what
is an API path" are a disagreement waiting to happen, and this was the
disagreement.

The same function also grows a new cardinality trap the moment static files
exist: Vite names bundles `index-<hash>.js`, so one label per asset is one dead
series per deploy, permanently, because nothing ever requests the old hash again.
The existing bounded-output test caught my first attempt immediately - which is
precisely why that test exists.

The fix over-collapses on purpose: `collab-editor.js` becomes
`/assets/collab-*.js`, because a hash is indistinguishable from an ordinary word
by shape. Losing one distinguishable series costs nothing; leaving a dead series
per deploy costs a registry that only ever grows.

### Narrowing a security check is often just a new bug

While wiring this in I changed `/api/auth/session` from POST-only to GET-or-POST
by accident, while copying a block. **No test caught it**, because no test
asserted that GET is refused. Reverted immediately, and the test now exists.

Worth recording as a process point: the fix for a security bug can silently
remove a different security property. This one was caught by noticing, not by
the suite - and the reason it was not caught is a coverage gap that had been
there since Phase 5.

## Docker, and what could not be verified

Docker is not installed on this machine. Rather than write a `Dockerfile` and hope,
the parts that could be verified without Docker were verified by simulating its
stages:

- **The `deps` stage**: a real `npm ci --omit=dev` into a clean directory. Then `dist/`
  copied in and nothing else - 10 packages, no devDependencies. The server started and
  served from it, which is the single most common Dockerfile failure and it does not
  reproduce on a developer machine that still has every devDependency installed.
- **The `build` stage**: exactly the `COPY` list from the Dockerfile, nothing more, built
  with `npm run build`. Produced `dist/server/index.js`, `dist/client/index.html` and
  `dist/client/assets`, which is everything the runtime stage consumes. A `COPY` that
  misses one file produces a build error 200 lines from the omission.
- **The runtime contract**, against that tree, in production mode with `JWT_SECRET`:
  health check 200, app shell 200, anonymous session, document created, content written
  and read back, scoped listing showing only that subject's document, a _different_
  subject getting 404 rather than 403, data surviving a restart, production refusing to
  start without a secret, and every log line parsing as JSON.
- **The health-check command**, run verbatim.
- **`dist/index.js` is not the server**, by running it: it prints a CRDT summary and
  exits 0. The Dockerfile's `CMD` comment claims this matters; better to have checked than
  to have asserted it.

What that leaves unverified is stated at the top of `docs/deploy.md` in a table: the image
does not build here, PGlite is not proven under Debian as a non-root user, the volume
ownership is not proven, `tini` is not proven, and `.dockerignore` has been read rather
than exercised. **The first `docker compose up --build` is a test with a real chance of
finding something**, and the document says so rather than implying otherwise.

### Two probes that were wrong before the third was right

Worth recording, because both looked like a broken deployment and neither was.

The first read `body.id` and `body.content`; the API nests its responses under
`document`. The second reused a document id from the first run, got `ALREADY_EXISTS`,
then `DOCUMENT_NOT_FOUND` on read - which is the existence-oracle protection working
correctly, since a _different_ anonymous subject must not see it.

Neither was a bug. Both would have been reported as one if the probe had not been
checked against the API's actual response shape, and "the deployment is broken" is a
conclusion expensive to act on.

### `.env.example` was lying, and now a test says so

It advertised `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and `REDIS_URL`. No code read any of them - Supabase is
deferred by ADR-0006 and pub/sub by ADR-0007 - and it also used `K6_VUS` and
`K6_DURATION` where the harness reads `LOAD_VUS` and `LOAD_DURATION`, which is the exact
naming mistake that once made a benchmark run the wrong length.

Setting one of those and watching the server start normally is convincing, which is what
makes it worse than not listing them at all.

`scripts/env-example.test.ts` now compares the file against the source in **both**
directions and fails on drift either way. Two details worth keeping:

- It asserts it found something (`expect(readByCode.size).toBeGreaterThan(5)`). A scanner
  that silently stops matching empties both sets, every assertion passes, and the test is
  worth nothing.
- `vitest.config.ts` `include` had to widen from `src/**` to include `scripts/**`, and
  `eslint.config.js` `allowDefaultProject` to `scripts/*.test.ts` - not `**`, because
  typescript-eslint rejects it, and the failure names a real performance reason rather
  than being arbitrary.

## The client log was destroying its own anchors

The client operation log capped itself at 50,000 entries by **deleting the oldest**, and
it did that from inside `append` - so every single write could trigger it.

That is not a tuning problem. An RGA insert names the element it anchors to. Deleting a
prefix of the log deletes the elements the surviving operations still refer to.
`Replica.init()` refuses to guess and **throws**, so the document stops opening on the
next page load. It was a hard failure rather than silent divergence, which is the one
mercy.

### The test that passed anyway

The existing coverage asserted **seq contiguity** after pruning. Contiguity is _true_
after a prefix delete - it is contiguity of the counter, not integrity of the history -
and it says nothing at all about whether the anchors still exist.

So the test confirmed the counter was not corrupted while the document was. There is now
a test named `keeps seq contiguous through it, which is why the old test passed` whose
entire job is to make that false negative impossible to re-add by accident.

### What replaced it

Snapshot-and-truncate, reusing the server's machinery rather than writing a second
implementation - `createSnapshot`, `snapshotToOperations` and `snapshotCovers` already
existed and already had ADR-0011 behind them.

Three pieces:

- `Replica.snapshot(retainTombstones)`. On the replica, not the log, because the snapshot
  needs the live document and the log cannot see it. It also records `appliedSeq` itself,
  so a caller cannot pass a stale sequence and get a snapshot that claims coverage it
  does not have.
- `IndexedDbOperationLog.replaceWithSnapshot(...)`. **One transaction** for the writes and
  the deletes. Done separately there is a failure mode that destroys the document: crash
  after the truncate and the log holds a tail whose inserts anchor to elements the
  snapshot would have carried. A browser tab closing mid-compaction is not exotic.
- `Replica.compactLog({ keepAtLeast, unsent })`. Owns the coverage check and refuses
  rather than truncating into something `init()` will throw on.

`append` no longer prunes. Bounding the log is still necessary - it just has to happen
where the document is visible.

### Why `unsent` is a parameter and not a guess

An unsent delete naming a dropped element is an edit that can never be sent and never
applied: silent divergence from the server, invisible until someone reads the document
back. The transport is the only thing that knows what is acknowledged, so it passes its
outbox in. `SyncTransport` grew a `queuedOperations` getter because it only exposed a
_count_, which is not enough.

Compaction is wired into `main.ts` on `onSyncState === 'synced'`, not `onStateChange`. A
socket can be open while operations are still queued, and compacting then drops tombstones
the queued deletes still need.

### Two things the tests found that I had got wrong

**`snapshotText` was a trap.** It concatenates every element including tombstones, so for
a snapshot of `"acd"` carrying the tombstone for `"b"` it returns `"abcd"`. That is correct
for its purpose and wrong for the obvious one. The doc comment now says so, and
`snapshotVisibleText` exists next to it - naming both is cheaper than a comment nobody
reads at the call site.

**Compaction can make a log longer.** A snapshot element is one stored operation; a
carried tombstone is an insert _and_ a delete. So on a document whose history is barely
longer than its text, compaction produces a bigger log. There is a test for that case
alongside the test where it reclaims 902 entries down to 104, because the first thing
anyone would do on seeing the log grow is assume compaction is broken and disable it.

### Assumptions that turned out to be wrong, caught by checking

Three of my own expectations failed and all three were mine, not the code's:

- Clocks start at **1**, not 0.
- `insertAt(offset, 'abcd')` emits **four** operations, one per character - so `insertAt`
  is not "one operation per call".
- `deleteRange(10, 6)` emits **six** delete operations, one per deleted character. My
  "unsent delete" test passed one target and was declined because the other five were not
  declared. The refusal was correct.

The last is the best of the three: the coverage check caught a test that had not declared
enough pending work, which is exactly the bug class compaction exists to prevent. It is
now a test of its own - `declines rather than dropping a tombstone the tail still needs`.

Verified by sabotage too: inverting `truncateBefore`'s key range took the failures from 4
to 6, which confirms the new tests bite. The first sabotage attempt replaced a write's
_content_ rather than deleting the write, so the existence guard correctly passed and
proved nothing - the same mistake as with the load harness, and the second time.

Verified by sabotage too: inverting `truncateBefore`'s key range took the failures from 4
to 6, which confirms the new tests bite. The first sabotage attempt replaced a write's
_content_ rather than deleting the write, so the existence guard correctly passed and
proved nothing - the same mistake as with the load harness, and the second time.

## Phase 6 - End-to-end encryption

The relay never needed to understand an operation to route one (ADR-0007). That is the
property this phase rests on, and it is why the work turned out to be mostly about
_removing_ server capabilities rather than adding a crypto layer.

### The key is in the URL fragment, and that is the whole point

`#k=<base64url, 32 random bytes>`. Browsers do not send the fragment, so the server is not
trusted with the key - it has never been given it. Every alternative is something the
server sees, and "the operator does not read your document" is a materially weaker claim
than "the operator cannot read your document".

The costs are real and were written down before any code: a shared link IS the credential,
there is no recovery, and the key must be exchanged out of band - the same friction
ADR-0012 already records for anonymous subjects.

### What it gives up, stated before building it

Compaction walks the live element set. The text cache replays the log. Both need
plaintext, so **encrypted documents get neither**. Their log grows for the life of the
document, and a cold device replays the whole history.

Before deciding the server could not keep its dedupe, I checked whether correctness
actually depends on it: `#applyInsert` is idempotent
(`if (this.#byKey.has(key)) return`), so a duplicate costs _storage_, not correctness.
That is what makes sending the element key in cleartext acceptable - it leaks per-site
operation counts, which is the same class of metadata the server already had.

### Tests that pass while proving nothing, twice more

The pattern that keeps paying: **break the code, check the test count goes up.**

1. The duplicate-flush guard test called `requestResync()`, which does not flush at all.
   Removing the guard left all 18 tests green. Replaced with a genuine overlap.
2. The `.env.example` drift test would have passed with an empty scanner. It now asserts
   it found something.

Three E2EE design bugs, all found by tests written alongside the code:

- **`site` was not in the AAD.** It is redundant with the element key, and a field present
  in a frame but absent from the AAD is a field an attacker can substitute. A test that
  altered the site caught it. Every cleartext field is bound now.
- **`const batch = this.#outbox` aliased the array.** An operation queued during the
  encryption `await` appeared in `batch` too, so the first batch encrypted and sent it.
  Harmless by luck - both went out in one frame - but timing-dependent rather than
  designed, and `disconnect()` replaces the outbox outright, which would leave `batch`
  pointing at an array nothing else can see.
- **`parseEncryptedFrame` compared the key prefix against `'insert:'`** when the prefix is
  the single letter `i`, so _every_ frame was rejected. The failures looked like a bad
  test fixture rather than a bad comparison.

And a guard that was pointed the wrong way: `appendEncryptedOps` threw when the document
was _already_ encrypted - which is the ordinary case, since every keystroke after the
first one does it. The guard belongs on the plaintext path, which is the one that would
actually mix the two modes.

### The server's one check, described accurately

`parseEncryptedFrame` confirms a frame is SHAPED like a frame. It cannot confirm the
ciphertext decrypts, or that it decrypts to an operation matching the claimed element
key. Those checks belong to the clients holding the key, and `applyEncrypted` therefore
**cannot report `unplaced`** - it has no replica. So an encrypted document's convergence
claim rests entirely on the clients. That is the honest consequence of withholding the
key, and it is written down rather than glossed.

## A 955 MB temp leak that was making the suite flaky

I recorded a flake in a commit message instead of chasing it, which turned out to be the
right call: investigating found a real leak, not a ghost.

The suite left ~38 MB of PGlite data in `%TEMP%` per full run. By the time it was noticed:
25 `pg-*` directories, 25 `collab-static-*` directories, **955 MB**, on a disk that had
drifted to 8.5 GB free. A disk that full is a credible cause of PGlite failing to boot -
which is exactly what the flake looked like: `fetch failed`, five baseline tests failing,
and nothing in the output connecting it to storage.

Three leaks, all the same mistake:

- the PGlite directory was created as a **sibling** of the temp root
  (`join(root, '..', 'pg-<timestamp>')`), so the cleanup that removed the root never
  touched it
- the symlink test's "file outside the root" directory was never removed at all
- its PGlite database lived inside that unremoved directory

The durable fix was the **cleanup**, not the paths. `removeQuietly` swallowed every error
with `.catch(() => undefined)`, which is exactly why a Windows `rm` failing on an open
handle was invisible. `removeTree` now retries, and throws with the path and cause if it
still cannot remove the tree, so a test that cannot clean up after itself fails loudly
instead of accumulating.

Verified: three consecutive runs leave 0 directories in TEMP, where every run previously
left 3. 1.8 GB reclaimed.

## A feature that existed and could not be used

With all twelve phases green I went looking for what was still _unreachable_, and found
it immediately: `generateDocumentKey` was never called from the client.

The encryption work was complete at every layer - crypto, protocol, server, transport -
and a user still could not make an encrypted document. They would have had to generate 32
random bytes, base64url encode them, and hand-append `#k=` to the address bar. A headline
feature that requires console access is a library, not a feature.

Two toolbar buttons and a badge. The lesson worth recording is not "add the buttons" but
**the check that found it**: grepping for an exported function and finding zero call sites.
`generateDocumentKey` was exported, tested, and documented, and nothing in the repository
ever invoked it. Nothing else would have surfaced that.

### One function, because `replaceState` is unforgiving

`history.replaceState` replaces the WHOLE url. Any navigation that writes `?doc=<id>` and
forgets the fragment silently reopens the document UNENCRYPTED - and the server then
refuses it with a message about an encrypted document, for a document the tab created
moments ago.

So "a url for a document always carries its key" is stated in exactly one place,
`documentUrl()`, and every navigation goes through it. The tests use
`readKeyFromFragment` as the oracle rather than asserting on string shape, because the
property that matters is that the url yields the SAME KEY - not that it contains some
particular characters.

That logic was in `main.ts` first, which runs side effects on import, so it could only be
tested by loading the whole application into a DOM. Moving it out also deleted a dead
exported `shareLinkFor` that nothing called.

Both guards verified by sabotage: dropping the fragment from `documentUrl` fails 5 tests,
and stripping the fragment from the copy-link path fails 1.

### Deliberately not a toggle

"Make this encrypted" is irreversible - a document whose log holds ciphertext cannot be
read by anyone without the key, including us - and "make this unencrypted" does not exist
at all. A toggle would imply a round trip that is not there, so the button is hidden once a
document is encrypted rather than disabled. Removing the question is better than greying
it out.

## Log
