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
appear on a second client. That is the same cost, felt. It is also why the browser test
`e2e/editor.spec.ts` scenario (d) is flaky: its 90-second convergence budget has almost no margin
on a loaded machine, and when it fails the peer holds a _prefix_ of the document (4,000 of 6,000
characters observed), which is what slow catch-up looks like rather than data loss. No
backpressure event and no disconnection occurred in any observed failure, and the test passed 5 of
5 times when run in isolation.

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
