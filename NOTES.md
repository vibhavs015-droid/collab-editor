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

- Compaction runs only when `store.compact()` is called. There is no trigger yet —
  no timer, no threshold check on the write path. Deliberately left as an explicit
  call so the policy is testable and so the relay can decide when.
- Peer cursors are self-reported and unverified. A buggy client claiming to have
  applied a sequence it has not would let the server prune too far.
- A peer below the floor must be served a snapshot, which the protocol does not yet
  do. `readSince` still assumes a contiguous log. Until that lands, compaction
  would break a peer that had been away long enough — so the feature is not wired
  into the relay yet, deliberately.

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
had been **red the whole time**: `listDocuments > returns newest first` — expected
`b`, received `a`.

Two things were wrong and both mattered.

**The code.** `ORDER BY updated_at DESC` is not a total order. Two documents
written in the same clock tick tie, and Postgres returns tied rows in whatever
order the heap gives it. Fixed with `id DESC` as an explicit tiebreaker, because a
list endpoint whose order changes between identical calls cannot be paginated
against.

**The test, which was the worse problem.** It created `a`, saved `a`, then created
`b` — so the assertion only held if the save and the second insert landed in
different clock ticks. On a slow laptop they did. On a fast CI runner they did
not.

The lesson is not "add a tiebreaker". It is that **a test which passes locally and
fails in CI for timing reasons has proved nothing**, and that I was verifying
locally and assuming CI agreed. Checking CI after a push is part of the loop, not
an optional extra. Two new tests now cover it: one asserts a tied-timestamp list
is stable across repeated identical calls, one asserts the tiebreaker itself.

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
    whole-file diffs that look like real changes and are not.
