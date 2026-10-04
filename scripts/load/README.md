# `scripts/load`

k6 load-test suite. Introduced in **Phase 5**.

Results, with the method and the traps: [`../docs/benchmarks.md`](../docs/benchmarks.md).

## Why these live outside `src/`

k6 runs on its own Go-based runtime. It cannot import TypeScript from this package, so
the load suite drives the system over the network exactly as a real user would.

That constraint is a feature: it tests the actual deployed surface rather than calling
internals with mocks, so it catches protocol and serialisation bugs that an in-process
test cannot.

It also has a sharp edge. Verifying _convergence_ inside k6 would mean writing a second
RGA in JavaScript — a second, separately wrong implementation of the algorithm under
test. So convergence is verified separately, by
[`../../src/server/loadConvergence.test.ts`](../../src/server/loadConvergence.test.ts),
which uses the real `Replica` class.

## Running

```bash
node scripts/load/run.mjs <scenario> [--vus N] [--duration D] [--build]
```

| Scenario     | What it measures                                        |
| ------------ | ------------------------------------------------------- |
| `connect`    | Handshake latency under a connection ramp               |
| `edit`       | Sustained concurrent typing; relay fan-out cost         |
| `reconnect`  | Churn — clients dropping out and returning              |
| `divergence` | Correctness under contention; the server's CRDT verdict |

`run.mjs` starts a server in `NODE_ENV=production` with authentication **required**,
runs k6, captures the server's own `/api/metrics` afterwards, and stops the server.
That last part is the point: the server's counters are what say whether the relay kept
up, as opposed to whether the clients felt fast.

Output goes to `docs/benchmarks/`, never into `dist/`.

## Getting k6

k6 is a single binary and is not committed. It unpacks to `.tools/`, which is gitignored:

```bash
mkdir -p .tools
curl -L -o k6.zip https://github.com/grafana/k6/releases/latest/download/k6-v2.3.0-windows-amd64.zip
unzip -q k6.zip -d .tools/k6
```

`run.mjs` prefers `.tools/k6/` over whatever is on `PATH`, so a recorded benchmark names
the exact version that produced it. A result from "whatever k6 happens to be installed"
is not reproducible.

## The traps

Each of these produced a **plausible, wrong benchmark** rather than an obvious failure.
They are listed because that is the dangerous shape of bug.

| Trap                                                            | What happened                                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sleep()` takes **seconds**                                     | `sleep(1000)` meant a thousand seconds. The teardown timed out and the run was reported as a script exception — a failure of the harness that looked like a failure of the system                           |
| `WebSocket.open` is gone in k6 v2                               | The export is a bare `connect`. The old name gives `Cannot read property 'open' of undefined` on the first iteration                                                                                        |
| `k6/ws` sockets have no `readyState`                            | A `readyState === 1` guard silently dropped **every operation**. The run reported one burst per client and no server-side broadcast, which reads exactly like a server that accepted a batch and went quiet |
| Timers do not fire inside a websocket callback                  | Neither `setInterval` nor `setTimeout`. Bursts are driven by incoming frames instead, which is also a better model of typing                                                                                |
| `sleep()` inside a websocket callback stops after one iteration | The same shape of failure as the timers: one burst, then silence                                                                                                                                            |
| **`K6_*` is k6's configuration namespace**                      | A custom `K6_DURATION` silently overrode the scenario's own duration. All custom knobs are now `LOAD_*`                                                                                                     |
| `connect()` blocks for the socket's lifetime                    | A scenario that does not close explicitly hangs its VU, and **everything recorded after the call records nothing** — a metric reported as `0 out of 0` rather than as a number                              |

## What the harness checks after every run

Both of these produced a clean exit code while measuring nothing, which is worse than a
visible failure:

1. **Samples were recorded.** A k6 script whose default function throws on every
   iteration exits 0, because thresholds on an absent metric are silently ignored.
2. **Iterations completed.** `setup()` runs its own checks, and those alone were enough
   to satisfy the first guard while every scenario iteration hung.

It also refuses to run at all against a server that reports `"auth": "open"`.

## Authorisation

Every run sends **real signed HS256 tokens**, minted by
[`lib/auth.js`](./lib/auth.js) using k6's own crypto module. Two reasons, and the second
matters more:

- The benchmark measures the HMAC verification cost every real request pays.
- It exercises the same authorisation path production uses, so a load test cannot pass
  against a server that has quietly stopped checking anything.

k6's `hmac` has no raw-bytes mode and returns a base64 _string_, so base64url is
produced by swapping the URL-unsafe characters and stripping padding. Getting that wrong
yields a well-formed token with a signature the server will never accept — which looks
exactly like "the load test is just slow".

## One shared identity

Sessions are anonymous, so a different subject really is a different person, and a
document created by one subject is not readable by any other. Giving each VU its own
identity made every handshake fail with `DOCUMENT_NOT_FOUND` — the authorisation layer
working exactly as designed.

`setup()` therefore creates the document as the owner and **grants** a shared editing
subject access, which is the collaborator case the ownership model exists for. Every VU
then shares one identity, as every browser tab of one person's document would.

## Conventions

- Every script is configurable through `LOAD_*` environment variables. Never `K6_*`.
- Element ids are unique per VU. Two clients sharing a site id would mint colliding ids
  and corrupt the document, which shows up as divergence rather than as a load number.
- Deletes only ever target elements the sending client created, except in
  `divergence.js`, where targeting observed foreign elements is the entire point.
- `--build` forces a rebuild. Otherwise an existing `dist/` is reused, because `tsc` plus
  `vite build` is the most memory-hungry thing in this project and repeating it before
  every load run makes the harness fail on a busy machine for reasons unrelated to the
  measurement.
