# Benchmarks

Measured, not estimated. Every number below came from a run whose raw output is
committed alongside it, and every run's method is stated so it can be repeated or
disputed.

Reproduce with:

```bash
node scripts/load/run.mjs connect      --vus 50
node scripts/load/run.mjs edit         --vus 20 --duration 20s
node scripts/load/run.mjs reconnect    --vus 10 --duration 15s
node scripts/load/run.mjs divergence   --vus 25 --duration 20s
```

Raw output for each run is in [`benchmarks/`](./benchmarks/).

---

## Read this before the numbers

**These are not production-representative throughput figures, and presenting them as
such would be dishonest.** Four specific reasons:

1. **The database is PGlite**, an in-process WASM build of PostgreSQL running on the
   same thread as the server. There is no network hop to a separate database, and no
   connection pool. Real deployments use a networked Postgres or Supabase, which changes
   both latency and the cost of a write by an order of magnitude.
2. **One server process, one Node thread.** The relay and the CRDT share an event loop
   with the database. Nothing here measures horizontal scaling, and the single-process
   design (ADR-0007) means there is no fan-out across instances to measure yet.
3. **The machine was shared.** A laptop also running a browser, several chat clients and
   a media player. During one attempt the machine had 700 MB of 16 GB free and the
   server could not start at all; the runs below were taken when it had roughly 4.7 GB
   free. Numbers from a contended machine are pessimistic and noisy, and I have not
   tried to correct for that.
4. **No network latency between client and server.** Both run on loopback. A real
   deployment adds round-trip time to every operation, and websocket fan-out cost
   changes character entirely at 50 ms RTT.

What these numbers _are_ good for: showing the relay, the CRDT and the compaction path
behave correctly under concurrency, and giving a baseline to detect regressions against.

---

## Environment

|              |                                                        |
| ------------ | ------------------------------------------------------ |
| CPU          | Intel Core i5-12500H, 16 logical cores                 |
| RAM          | 15.6 GB (shared with other applications)               |
| OS           | Windows 11 Home                                        |
| Node         | v24.16.0                                               |
| k6           | v2.3.0                                                 |
| Database     | PGlite 0.5.8, in-process WASM                          |
| Server build | `0d54dea`, `NODE_ENV=production`, `AUTH_MODE=required` |

**Authentication was required for every run.** The harness refuses to measure a server
that reports `"auth": "open"`, and k6 mints real HS256 tokens with
[`scripts/load/lib/auth.js`](../scripts/load/lib/auth.js). A benchmark against an
unauthenticated server measures a different system than the deployed one.

---

## Results

### 1. `connect` — handshake under a connection ramp

50 concurrent connections ramping over 20 s.

| Metric               | Value                  |
| -------------------- | ---------------------- |
| Handshakes completed | **4,086**              |
| Throughput           | 202/s                  |
| Duration avg         | 121 ms                 |
| Duration p50         | 124 ms                 |
| Duration p95         | **212 ms**             |
| Refusals             | **0**                  |
| Checks               | 4,088 passed, 0 failed |

The server independently recorded `ws_connections_opened_total 4086` — the same number
the client counted. That cross-check is the reason to trust it: a load generator that
merely believed its own handshakes succeeded would agree with itself just as happily.

Handshake latency includes the server's authorisation check, because that check _is_ the
handshake. Timing from TCP open instead would report the connection setup and call it a
result.

### 2. `edit` — sustained concurrent typing

20 clients in one room, each typing in bursts. Every operation one client sends is
fanned out to the others, so this measures relay fan-out, not just throughput.

| Metric                        | Value                     |
| ----------------------------- | ------------------------- |
| Sessions                      | 338                       |
| Operations sent               | **42,345**                |
| Send rate                     | **1,411 ops/s**           |
| Operations received (fan-out) | **536,602**               |
| Fan-out rate                  | **17,876 ops/s**          |
| Fan-out ratio                 | **12.7x**                 |
| Deletes                       | 8,574 (20% of operations) |
| Unplaced operations           | **0**                     |
| Malformed frames              | **0**                     |
| Checks                        | 340 passed, 0 failed      |

Compaction, under real concurrent load:

|                                                             |        |
| ----------------------------------------------------------- | ------ |
| Operations pruned                                           | 2,745  |
| Passes that compacted                                       | 1      |
| Passes that declined                                        | 23     |
| — because the log was too small                             | 4      |
| — **because a snapshot would have dropped live operations** | **19** |

Catch-up during the same run: 339 clients replayed 501,061 operations, mean 31 ms, every
one of them under 100 ms.

That last line is ADR-0011 working. Nineteen times the server wanted to compact and
refused, because connected peers had not yet caught up and pruning below them would have
forced a full-baseline resync. The floor held under load.

### 3. `reconnect` — churn

10 clients that connect, write, vanish abruptly, wait a second, then return declaring a
zero cursor — the worst case a real client can present.

| Metric       | Value                |
| ------------ | -------------------- |
| Reconnects   | **150**              |
| Readmitted   | **150 (100%)**       |
| Refusals     | **0**                |
| Catch-up avg | 9.1 ms               |
| Catch-up p50 | 5 ms                 |
| Catch-up p95 | **31.1 ms**          |
| Checks       | 152 passed, 0 failed |

A client that cannot get back in after a blip is a data-loss bug wearing a latency
costume, so this scenario asserts a 100% readmission rate rather than reporting one as
a percentage.

### 4. `divergence` — correctness under contention

25 clients, 30% deletes, every client deleting elements it has _observed from other
clients_. That is what produces genuine ordering conflicts rather than each client
tidying up after itself.

| Metric                                            | Value                |
| ------------------------------------------------- | -------------------- |
| Sessions                                          | 384                  |
| Operations sent                                   | **76,870**           |
| Send rate                                         | **2,478 ops/s**      |
| Deletes                                           | 23,123 (30%)         |
| **Unplaced operations**                           | **0**                |
| Malformed frames                                  | **0**                |
| Highest element clock observed by any client, p95 | 198                  |
| Checks                                            | 386 passed, 0 failed |

`collab_operations_unplaced_total` is the number this whole file exists for. An operation
that cannot be placed is an operation some peer is still waiting for; if it never arrives
that peer stays silently behind. A latency benchmark reports success while documents
quietly diverge underneath it. This one cannot.

**But k6 cannot verify convergence, and that is deliberate.**

k6 runs on its own JavaScript runtime and cannot import this package's TypeScript.
Checking convergence inside k6 would mean writing a second RGA in JavaScript — a second,
separately wrong implementation of the algorithm under test, disagreeing for reasons that
have nothing to do with the real CRDT. That mistake has been avoided throughout this
project, including in one test that hand-derived CRDT ordering and was wrong.

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

Plus an order-independence check: the same 200-operation set applied in four
deterministic shuffles produced one identical document.

This is the claim that matters. The seeded fuzzer proves convergence for random
operation sets; this proves it for operations that actually crossed every stage that
could drop or reorder them.

---

## What is not measured

Stated rather than left to be discovered:

- **Database performance.** PGlite in-process, no network hop. See above.
- **Horizontal scaling.** One process, one thread. The single-process design means there
  is nothing to scale out yet; that is Phase 6 work.
- **Network conditions.** Loopback only. No packet loss, no latency, no reordering.
- **Large documents.** Every run starts from an empty document. A 200,000-character
  document would exercise the RGA's tree structure, which short documents never touch.
- **Compaction at steady state.** Compaction runs on a write counter, so these runs
  exercised it opportunistically. A long soak would show whether the log stays bounded
  over hours rather than seconds.
- **Client-side rendering.** The load suite measures the server. CodeMirror's cost per
  keystroke is not in any of these numbers.

---

## Reproducing, and the traps

`scripts/load/README.md` documents the k6-specific pitfalls found while building this
suite. They are recorded because each one produced a **plausible, wrong benchmark** rather
than an obvious failure:

- k6's `sleep` takes **seconds**, so `sleep(1000)` is a thousand seconds and a teardown
  that used it timed out looking like a measured failure.
- `WebSocket.open` no longer exists in k6 v2; the export is a bare `connect`.
- `k6/ws` sockets have no `readyState`, so a `readyState === 1` guard silently dropped
  every operation and the run reported one burst per client.
- Timers registered inside a k6 websocket callback do not fire, and `sleep()` inside one
  stops after a single iteration. Bursts are driven by incoming frames instead.
- **`K6_*` is k6's configuration namespace.** A custom `K6_DURATION` silently overrode
  the scenario's own duration and produced a run of the wrong length.
- `connect()` blocks for the socket's lifetime, so any scenario that does not close
  explicitly hangs its VU, and everything recorded after the call records nothing.

The harness itself checks two things after every run, because both of these produced
clean exits while measuring nothing:

1. **Samples were recorded.** A k6 script whose default function throws on every
   iteration exits 0, because thresholds on an absent metric are silently ignored.
2. **Iterations completed.** `setup()` runs its own checks, and those alone were enough
   to satisfy the first guard while every scenario iteration hung.
