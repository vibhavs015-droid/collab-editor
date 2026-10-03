# `scripts/load`

k6 load-test scripts. Introduced in **Phase 5**.

## Why these live outside `src/`

k6 runs on its own Go-based runtime. It cannot import TypeScript from this
package, so the load suite drives the system over the network exactly as a real
user would.

That constraint is a feature: it tests the actual deployed surface rather than
calling internals with mocks, so it catches protocol and serialisation bugs that
an in-process test cannot.

## Planned scripts

| Script          | Phase | Scenario                                                    |
| --------------- | ----- | ----------------------------------------------------------- |
| `connect.js`    | 5     | Connection ramp, handshake latency                          |
| `edit.js`       | 5     | Sustained typing simulation, ops per second                 |
| `reconnect.js`  | 5     | Churn — clients dropping and returning                      |
| `divergence.js` | 5     | **Correctness under load** — assert replicas still converge |

`divergence.js` is the important one. A load test that only measures latency
will happily report success while documents are diverging underneath. This script
drives concurrent load and then verifies every client ends with identical state.

## Conventions

- Every script accepts a seed and writes it into the summary, so a result is
  reproducible.
- Output to `docs/benchmarks/`, never into `dist/`.
- Keep `VUS` and duration configurable via environment variables (see
  `.env.example`) so CI can run a smoke-sized version.
