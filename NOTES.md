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

- [ ] Phase 1: CodeMirror 6 vs. hand-rolled editor? Leaning CodeMirror — its
      document model is already collaboration-shaped.
- [ ] Phase 2: Per-user undo without undoing a collaborator's work is the
      genuinely hard part of RGA. Budget time.
- [ ] Phase 2: Should deletion be tombstone-only, or can we garbage-collect
      tombstones once causally stable?
- [ ] Phase 3: Server-authoritative fanout vs. peer-to-peer WebRTC? Server is
      simpler; P2P removes the offline problem but adds NAT traversal.
- [ ] Phase 5: Which observability stack — OpenTelemetry + Grafana, or just
      structured logs plus Prometheus?
- [ ] Phase 6: Benchmark suite vs. end-to-end encryption as the differentiator.
      Pick one.

---

## Log

- **Phase 0** — Toolchain, strict TS, CI, and the `(site, clock)` element ID
  primitive with a total-order test. 27 tests passing, 97.6% statement
  coverage, 100% branch coverage, zero dependency vulnerabilities.

  Friction encountered and recorded above: a signed-zero test bug, the
  TypeScript 7 peer-dependency wall, `@eslint/js` versioning, and
  type-aware ESLint not seeing config files. All four are normal first-day
  problems; writing them down is faster than rediscovering them later.
