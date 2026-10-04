# Benchmarks

Measured, not estimated. Every number below came from a run whose raw output is committed
alongside it, and every run's method is stated so it can be repeated or disputed.

Reproduce with:

```bash
node scripts/load/run.mjs connect      --vus 50 --repeat 3
node scripts/load/run.mjs edit         --vus 20 --duration 20s --repeat 3
node scripts/load/run.mjs reconnect    --vus 10 --duration 15s --repeat 3
node scripts/load/run.mjs divergence   --vus 25 --duration 20s --repeat 3
```

Raw output for each run is in [`benchmarks/`](./benchmarks/).

---

## Why every scenario runs three times

The first version of this file reported one run per scenario. Running each scenario three
times instead, on the same machine in the same session, produced this:

| Metric                   | Single run | Three runs | Spread    |
| ------------------------ | ---------- | ---------- | --------- |
| `connect` handshake p95  | 212 ms     | 245 ms     | **±3%**   |
| `reconnect` catch-up p95 | 31.1 ms    | 25.3 ms    | **±22%**  |
| `edit` send rate         | 1,411/s    | 1,282/s    | **±19%**  |
| `edit` fan-out rate      | 17,876/s   | 5,214/s    | **±120%** |

Latency percentiles are stable. Throughput is not — and the fan-out figure moved by more
than a factor of two between runs.

So the rule here is: **never quote one run.** Every table below reports the **median of
three runs with the observed min–max range**, and the range is part of the claim, not
noise to be hidden. A figure with no range attached is not a measurement; it is a story
about one afternoon.

The `edit` fan-out spread is worth understanding rather than shrugging at. Fan-out is
`operations × (clients − 1)`, so it depends on how many clients happen to be connected at
the same moment during a 20-second window. k6 starts and stops sessions as iterations
complete; if a run happens to hold 20 clients concurrently it broadcasts ~12× more
operations than a run whose clients stagger. That is a property of the workload, not a bug
in the relay, and it is why fan-out is reported as a ratio range rather than a headline
number.

---

## Read this before the numbers

**These are not production-representative throughput figures, and presenting them as such
would be dishonest.** Four specific reasons:

1. **The database is PGlite**, an in-process WASM build of PostgreSQL running on the same
   thread as the server. There is no network hop to a separate database, and no connection
   pool. Real deployments use a networked Postgres or Supabase, which changes both latency
   and the cost of a write by an order of magnitude.
2. **One server process, one Node thread.** The relay and the CRDT share an event loop with
   the database. Nothing here measures horizontal scaling, and the single-process design
   (ADR-0007) means there is no fan-out across instances to measure yet.
3. **The machine is shared.** A laptop also running a browser, several chat clients and a
   media player. The runs below were taken with roughly 3 GB of 16 GB free. During an
   earlier attempt the machine had 700 MB free and the server could not start at all. These
   numbers are not corrected for contention and should not be treated as a ceiling.
4. **No network latency between client and server.** Both run on loopback. A real
   deployment adds round-trip time to every operation, and websocket fan-out cost changes
   character entirely at 50 ms RTT.

What these numbers _are_ good for: showing the relay, the CRDT and the compaction path
behave correctly under concurrency, and giving a baseline to detect regressions against.

---

## Environment

|          |                                          |
| -------- | ---------------------------------------- |
| CPU      | Intel Core i5-12500H, 16 logical cores   |
| RAM      | 15.6 GB (shared with other applications) |
| OS       | Windows 11 Home                          |
| Node     | v24.16.0                                 |
| k6       | v2.3.0                                   |
| Database | PGlite 0.5.8, in-process WASM            |
| Runs     | 3 per scenario, 12 total                 |

**Authentication was required for every run.** The harness refuses to measure a server that
reports `"auth": "open"`, and k6 mints real HS256 tokens with
[`scripts/load/lib/auth.js`](../scripts/load/lib/auth.js). A benchmark against an
unauthenticated server measures a different system than the deployed one.

**Server-side counters are cumulative** across the three runs, because one server process
serves all of them. Figures quoted as a single run's value are the difference between the
third run's snapshot and the second's.

---

## Results

### 1. `connect` — handshake under a connection ramp

50 concurrent connections ramping over 20 s, three times.

| Metric               | Median     | Range       |
| -------------------- | ---------- | ----------- |
| Handshakes completed | 3,732      | 3,532–3,778 |
| Throughput           | 187/s      | —           |
| Duration avg         | 131 ms     | —           |
| Duration p50         | 133 ms     | —           |
| Duration p95         | **245 ms** | 237–252 ms  |
| Refusals             | **0**      | —           |
| Failed checks        | **0**      | —           |

In the final run the server independently recorded `ws_connections_opened_total 3778` — the
identical number the client counted. That cross-check is the reason to trust any of this: a
load generator that merely believed its own handshakes succeeded would agree with itself
just as happily.

Handshake latency includes the server's authorisation check, because that check _is_ the
handshake. Timing from TCP open instead would report the connection setup and call it a
result.

The p95 spread of 15 ms across three runs of a 245 ms measurement is the best evidence in
this file that the latency figures mean something.

### 2. `edit` — sustained concurrent typing

20 clients in one room, each typing in bursts. Every operation one client sends is fanned
out to the others, so this measures relay fan-out, not just throughput.

| Metric                        | Median                    | Range              |
| ----------------------------- | ------------------------- | ------------------ |
| Sessions                      | 307                       | 239–356            |
| Operations sent               | **38,465**                | 29,975–44,605      |
| Send rate                     | **1,282 ops/s**           | 999–1,485 ops/s    |
| Operations received (fan-out) | 156,470                   | 93,795–602,992     |
| Fan-out rate                  | 5,214 ops/s               | 3,126–20,081 ops/s |
| Deletes                       | 7,827 (20% of operations) | —                  |
| Unplaced operations           | **0**                     | —                  |
| Malformed frames              | **0**                     | —                  |
| Failed checks                 | **0**                     | —                  |

Compaction in the final run, under real concurrent load:

|                                                  |        |
| ------------------------------------------------ | ------ |
| Operations pruned                                | 6,879  |
| Refused: **snapshot would drop live operations** | **12** |
| Refused: log too small                           | 4      |

Catch-up during that run: 308 clients replayed the log, mean 19.1 ms.

That last row is ADR-0011 working. Twelve times the server wanted to compact and refused,
because connected peers had not yet caught up and pruning below them would have forced a
full-baseline resync. The floor held under load.

### 3. `reconnect` — churn

10 clients that connect, write, vanish abruptly, wait a second, then return declaring a zero
cursor — the worst case a real client can present.

| Metric        | Median         | Range        |
| ------------- | -------------- | ------------ |
| Reconnects    | **150**        | 149–150      |
| Readmitted    | **149 (100%)** | —            |
| Refusals      | **0**          | —            |
| Catch-up avg  | 10.2 ms        | —            |
| Catch-up p50  | 4 ms           | —            |
| Catch-up p95  | **25.3 ms**    | 22.0–35.6 ms |
| Failed checks | **0**          | —            |

A client that cannot get back in after a blip is a data-loss bug wearing a latency costume,
so this scenario asserts a 100% readmission rate rather than reporting one as a percentage.

Reconnects are 150, 149 and 150 — deterministic, because the scenario dictates them
(10 VUs × 15 s, one reconnect per second) rather than letting load decide. That
determinism is the point: a benchmark whose own schedule drifts is measuring its scheduler.

### 4. `divergence` — correctness under contention

25 clients, 30% deletes, every client deleting elements it has _observed from other
clients_. That is what produces genuine ordering conflicts rather than each client tidying
up after itself.

| Metric                                            | Median          | Range             |
| ------------------------------------------------- | --------------- | ----------------- |
| Sessions                                          | 216             | 175–384           |
| Operations sent                                   | **43,360**      | 35,200–76,870     |
| Send rate                                         | **1,398 ops/s** | 1,135–2,477 ops/s |
| Deletes                                           | 10,491 (30%)    | —                 |
| **Unplaced operations**                           | **0**           | —                 |
| Malformed frames                                  | **0**           | —                 |
| Highest element clock observed by any client, p95 | 200             | —                 |
| Failed checks                                     | **0**           | —                 |

`collab_operations_unplaced_total` is the number this whole file exists for. An operation
that cannot be placed is an operation some peer is still waiting for; if it never arrives
that peer stays silently behind. A latency benchmark reports success while documents
quietly diverge underneath it. This one cannot.

**But k6 cannot verify convergence, and that is deliberate.**

k6 runs on its own JavaScript runtime and cannot import this package's TypeScript. Checking
convergence inside k6 would mean writing a second RGA in JavaScript — a second, separately
wrong implementation of the algorithm under test, disagreeing for reasons that have nothing
to do with the real CRDT. That mistake has been avoided throughout this project, including
in one test that hand-derived CRDT ordering and was wrong.

So the work is split:

- `divergence.js` generates contention and reads the server's verdict.
- [`loadConvergence.test.ts`](../src/server/loadConvergence.test.ts) verifies convergence
  using the **real** `Replica` class, over a real relay, with real authorisation.

### 5. Convergence, verified properly

24 replicas, each inserting and deleting simultaneously for 60 rounds, every operation
travelling through authorisation, the relay, the broadcast path, the durable log and the
store's validation.

| Metric                 | Value            |
| ---------------------- | ---------------- |
| Replicas contending    | **24**           |
| Rounds each            | 60               |
| Replicas that diverged | **0**            |
| Invariant violations   | **0**            |
| Final document length  | > 100 characters |

Plus an order-independence check: the same 200-operation set applied in four deterministic
shuffles produced one identical document.

This is the claim that matters. The seeded fuzzer proves convergence for random operation
sets; this proves it for operations that actually crossed every stage that could drop or
reorder them.

---

## What is not measured

Stated rather than left to be discovered:

- **Database performance.** PGlite in-process, no network hop. See above.
- **Horizontal scaling.** One process, one thread. The single-process design means there is
  nothing to scale out yet; that is Phase 6 work.
- **Network conditions.** Loopback only. No packet loss, no latency, no reordering.
- **Large documents.** Every run starts from an empty document. A 200,000-character document
  would exercise the RGA's tree structure, which short documents never touch.
- **Compaction at steady state.** Compaction runs on a write counter, so these runs
  exercised it opportunistically. A long soak would show whether the log stays bounded over
  hours rather than seconds.
- **Client-side rendering.** The load suite measures the server. CodeMirror's cost per
  keystroke is not in any of these numbers.
- **Slow or hostile networks.** Jittered backoff (ADR-0008) is unit-tested against a fake
  clock. It has never been observed against a real one losing packets.

---

## Reproducing, and the traps

`scripts/load/README.md` documents the k6-specific pitfalls found while building this
suite. They are recorded because each one produced a **plausible, wrong benchmark** rather
than an obvious failure:

- k6's `sleep` takes **seconds**, so `sleep(1000)` is a thousand seconds and a teardown that
  used it timed out looking like a measured failure.
- `WebSocket.open` no longer exists in k6 v2; the export is a bare `connect`.
- `k6/ws` sockets have no `readyState`, so a `readyState === 1` guard silently dropped every
  operation and the run reported one burst per client.
- Timers registered inside a k6 websocket callback do not fire, and `sleep()` inside one
  stops after a single iteration. Bursts are driven by incoming frames instead.
- **`K6_*` is k6's configuration namespace.** A custom `K6_DURATION` silently overrode the
  scenario's own duration and produced a run of the wrong length.
- `connect()` blocks for the socket's lifetime, so any scenario that does not close
  explicitly hangs its VU, and everything recorded after the call records nothing.

### The harness refuses to report a number it cannot justify

Three checks run after every scenario, and each exists because its absence produced a clean
exit and a meaningless number:

1. **Samples were recorded.** A k6 script whose default function throws on every iteration
   exits 0, because thresholds on an absent metric are silently ignored.
2. **Iterations completed.** `setup()` runs its own checks, and those alone were enough to
   satisfy the first guard while every scenario iteration hung.
3. **Every expected artifact exists.** Added after restructuring the harness for `--repeat`
   silently dropped the server-metrics write. All four runs still printed
   `[load] k6 exit code 0` and wrote a result JSON that referenced a file which was never
   created. A run that reports success while losing its own evidence is worse than one that
   fails, because the documentation goes on citing the missing file.

### Two bugs this suite found in the product

The load suite is not only a measurement tool. Twice it has found real defects that unit
tests missed:

- **`grantAccess` reported a repeated grant as a failure.** The database returned a boolean,
  and `ON CONFLICT DO NOTHING` returns no row, so a grant that already existed looked
  exactly like a grant that was refused. The API mapped both to 400. Running `setup()`
  against a warm database — which `--repeat` does — re-granted access that was already
  there and failed a check. A client retrying a grant because it never saw the response hit
  the identical case and was told its successful request was malformed. Now a
  [`GrantResult`](../../src/server/db.ts) union distinguishes `granted`, `already-granted`,
  `no-document`, `invalid-subject` and `not-owner`, and the endpoint is idempotent.
- **Compaction refusals were invisible.** Nothing asserted the stability floor held, so the
  metric that matters most under load was only ever read by eye.
