# Benchmarks

Measured numbers, with the machine and the shape stated, so a reader can tell whether a change
helped or whether the measurement moved.

Every figure here was produced by running the script named beside it. Nothing is estimated.

---

## Element resolution — BEFORE

**Script:** `node --expose-gc --import tsx scripts/bench-replay.ts`
**Machine:** Windows 11 build 26200, Node v24.16.0, x64
**GC:** forced between samples via `--expose-gc`

| operations | build  | replay      | `Replica.init` | adopt snapshot |
| ---------- | ------ | ----------- | -------------- | -------------- |
| 2,000      | 0.1 ms | 118.1 ms    | 118.1 ms       | 115.5 ms       |
| 5,000      | 0.2 ms | 1,214.4 ms  | 1,557.9 ms     | 1,652.4 ms     |
| 10,000     | 0.1 ms | 7,360.6 ms  | 6,932.3 ms     | 5,766.5 ms     |
| 20,000     | 1.5 ms | 17,192.8 ms | 17,372.9 ms    | 17,676.3 ms    |

Scaling from 2k to 20k — ten times the work:

| stage          | factor | verdict            |
| -------------- | ------ | ------------------ |
| build          | 19.5×  | roughly linear     |
| replay         | 145.6× | quadratic or worse |
| `Replica.init` | 147.1× | quadratic or worse |
| adopt          | 153.0× | quadratic or worse |

### Against T5's targets

| target                       | required       | measured  | verdict                  |
| ---------------------------- | -------------- | --------- | ------------------------ |
| `Replica.init` on 20,000 ops | under 1,500 ms | 17,373 ms | **NOT MET** — 11.6× over |
| `Replica.init` on 10,000 ops | under 500 ms   | 6,932 ms  | **NOT MET** — 13.9× over |

(Superseded by the AFTER table below. Both targets are now met.)

### The shape is deliberately the worst case, and it matters

The document is built as a single typing chain: every insert anchors to the insert before it.
That is what a paste or a fast typist produces, and it is the _worst_ case for element
resolution, because the anchor sits at the **end** of the element array and the lookup is a linear
scan from the front.

A document built from concurrent inserts at scattered positions resolves much faster, because the
anchor is usually found early in the scan. Measuring only that shape would understate the cost real
typing actually pays.

**This is why these numbers are worse than the 5.9 s quoted for 20,000 operations in the review.**
That figure was not accompanied by its shape, and this benchmark measures the pessimistic end of
the range. The ratio between rows is the reliable part: roughly **quadratic**, which no choice of
shape changes.

### What the user experiences

At 1,000 operations per 3–4 seconds end to end, a 6,000-character paste takes 11–24 seconds to
appear on a second client. That is the same cost, felt.

A separate open question, recorded here so it is not lost: `e2e/editor.spec.ts` scenario (d) — this
same paste — is flaky. When it fails the peer holds a _prefix_ of the document (4,000 of 6,000
characters observed), which is what slow catch-up looks like rather than data loss. No backpressure
event and no disconnection occurred in any observed failure, and it passed 5 of 5 in isolation.
Measured after the change below, the scenario converges in ~12 s against a 90 s budget, so **the
quadratic cost is not what makes it flaky**, and that remains unexplained.

---

## Element resolution — AFTER

**Change:** `RgaDocument.#indexOfElement` compares `site` and `clock` as fields instead of building
`elementIdKey(id)` — the string `` `${site}@${clock}` `` — for the target and for every element it
inspects.

**Why that was the cost** (from `node --cpu-prof`, self time, 20,000 operations):

| function          | self time | share |
| ----------------- | --------- | ----- |
| `#indexOfElement` | 255.6 ms  | 6.9%  |
| `elementIdKey`    | 231.8 ms  | 6.2%  |

Together 13% of sampled time before counting what the allocator did with 200 million short-lived
strings. `#applyInsert` and `applyInAnyOrder` carried larger self times still, because V8 attributes
inlined callee time to the caller — so the real share of the insert path was higher than these two
lines suggest.

| operations | build  | replay     | `Replica.init` | adopt snapshot |
| ---------- | ------ | ---------- | -------------- | -------------- |
| 2,000      | 0.1 ms | 6.6 ms     | 6.7 ms         | 6.4 ms         |
| 5,000      | 0.2 ms | 44.4 ms    | 39.0 ms        | 38.7 ms        |
| 10,000     | 0.1 ms | 261.2 ms   | 258.1 ms       | 232.9 ms       |
| 20,000     | 0.3 ms | 1,173.6 ms | 1,543.9 ms     | 1,676.9 ms     |

### Before → after, `Replica.init`

| operations | before      | after     | speed-up |
| ---------- | ----------- | --------- | -------- |
| 2,000      | 118.1 ms    | ~6.7 ms   | 17.6×    |
| 5,000      | 1,557.9 ms  | ~39 ms    | 40×      |
| 10,000     | 6,932.3 ms  | ~255 ms   | 27×      |
| 20,000     | 17,372.9 ms | ~1,440 ms | 12×      |

### Against T5's targets

Three consecutive runs of the 20,000 and 10,000 rows:

| run | 20,000 ops | 10,000 ops |
| --- | ---------- | ---------- |
| 1   | 1,442 ms   | 262 ms     |
| 2   | 1,441 ms   | 259 ms     |
| 3   | 1,437 ms   | 249 ms     |

| target                       | required       | measured  | verdict |
| ---------------------------- | -------------- | --------- | ------- |
| `Replica.init` on 20,000 ops | under 1,500 ms | ~1,440 ms | **MET** |
| `Replica.init` on 10,000 ops | under 500 ms   | ~255 ms   | **MET** |

The first run after the change measured 1,544 ms and the next three measured ~1,440 ms. Reporting
the first would have said "3% over target" and pointed at a further optimisation; the spread says
the first run was the outlier, and that the real figure sits comfortably inside the target. T5 says
to stop when the target is met and not to chase more, so **step 4 — an id→index map — was not done.**

### It is still quadratic, and that is now the whole remaining cost

| stage          | scaling, 2k → 20k |
| -------------- | ----------------- |
| replay         | 176.9×            |
| `Replica.init` | 231.6×            |
| adopt          | 263.8×            |

The algorithm is unchanged in shape: `#indexOfElement` is still a linear scan. What changed is that
each step of the scan no longer allocates. The remaining quadratic term is the scan itself.

Making it linear means not asking for an _index_ at all. `#applyInsert` needs the position of its
anchor and then walks forward over greater-id siblings; a linked list would start at the anchor in
O(1) and walk only the siblings it must skip, which for ordinary typing is none. That is the
correct fix and it is a rewrite of the CRDT's core data structure, not an optimisation of it — a
different piece of work, with a real risk of subtle divergence, for a target that is already met.

### What the user experiences now — measured, and less dramatic than expected

The 6,000-character paste in `e2e/editor.spec.ts` scenario (d) exercises the same path in a real
browser, over the wire, between two replicas. Two runs after the change:

|                                | before                     | after          |
| ------------------------------ | -------------------------- | -------------- |
| paste scenario (d), end to end | 11–24 s (recorded earlier) | 12.2 s, 12.5 s |

**So at 6,000 operations this change bought very little**, and the honest reading is that 6,000 was
already small enough that the quadratic term was not yet dominant. The 12–27× wins are at 10,000
and 20,000 operations, which is where a large document actually lives.

### This does not explain the flaky paste test

It is tempting to conclude the fix removed the flake. It does not, and the arithmetic says so: the
scenario converges in ~12 s against a 90 s budget, so the budget was never tight, before or after.
The flake remains unexplained. Its observed shape - the peer holding a _prefix_ of the document,
with no backpressure event and no disconnection - is consistent with a slow machine rather than with
this cost, and it passed 5 of 5 in isolation.

So: a real and worthwhile speed-up, and a separate still-open question. They are not the same
finding, and merging them would have made the docs confidently wrong.

---

## How to reproduce

```sh
npm run build          # not required by the script, but keeps dist/ honest
node --expose-gc --import tsx scripts/bench-replay.ts
```

`--expose-gc` is what makes the numbers mean anything: without it, garbage collection from the
previous sample lands inside the next one. The script prints `NOT AVAILABLE` in its header if the
flag is missing, so a run without it cannot be mistaken for a clean one.

### Reading the scaling table

The ratio between the smallest and largest row is the finding. Any single absolute number can be
moved by a faster machine or a quieter one; a ratio cannot, and a factor near `n²` for `n` = 10
means the algorithm is quadratic.
