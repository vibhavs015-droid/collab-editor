# 0006 — PGlite for local and CI, Supabase for production

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** 1

## Context

The project needs PostgreSQL in three places: on a laptop during development, in
CI to run the test suite, and hosted in production. Each environment has
different constraints.

A native PostgreSQL install was attempted first and is not viable on this
machine: winget's download is blocked by a network policy (HTTP 403), and Docker
— the usual containerised alternative — requires WSL2, which needs a reboot.
Neither is a property of the project; both are properties of the environment.

## Decision

**PGlite for development and CI.** PostgreSQL compiled to WebAssembly, running
in-process. Phase 5 switches production to Supabase by changing a connection
string and swapping the driver calls in one file.

## Rationale

**It is genuinely PostgreSQL.** PGlite is the actual Postgres engine compiled to
WASM — same parser, same planner, same SQL semantics. It is not SQLite wearing a
Postgres schema. The SQL written against it is the SQL that runs in production,
which is the property that matters: a portability mistake cannot hide.

**Setup cost is zero.** No admin rights, no password, no Windows service, no
manual restart after a reboot. The failure mode that matters most here is the
project silently not running because a local service is stopped, and this design
removes that failure mode entirely.

**CI is identical to local.** No service container, no health-wait step, no
version drift between environments. The same tests run the same way everywhere,
so a green run locally means something.

**The alternative is genuinely worse, not merely different.** A native install
that needs admin rights and a Windows service makes the project break for reasons
unrelated to the code. Adopting it purely for familiarity would trade real
reliability for cosmetic similarity to production.

## Consequences

**Good**

- `npm install && npm test` works on any machine with Node, with no setup
- CI needs no database service and no readiness wait
- Identical SQL across all three environments
- Zero risk of "works on my machine"

**Bad**

- ~3.7 MB gzipped WASM payload, loaded once at server start. Irrelevant for a
  single-user server, would matter under horizontal scale
- Single-writer. PGlite is one process with one connection — fine here, but it
  rules out multi-process access to the same data directory
- The production migration is real work in Phase 5, not a config flip. `pg` and
  PGlite share SQL but not their APIs
- Slower than native Postgres. The suite runs in about two minutes, which is
  acceptable now and needs revisiting when Phase 2's fuzz tests arrive

## Alternatives rejected

| Option                                  | Why rejected                                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native PostgreSQL                       | Install blocked by network policy on this machine; requires admin rights and a Windows service, so the project breaks for reasons unrelated to the code.                                                                          |
| Docker Compose                          | Requires Docker Desktop and WSL2, which needs a reboot. Viable on many machines, not this one.                                                                                                                                    |
| Supabase from Phase 1                   | Requires an account and a cloud round trip in tests. A network failure would fail the suite for reasons unrelated to the code.                                                                                                    |
| `node:sqlite`                           | Built in, zero install — but SQLite is a different engine with different type, constraint, and concurrency semantics. Testing against SQLite and deploying to Postgres guarantees a class of bug that only appears in production. |
| PGlite everywhere, including production | Single-writer and no horizontal scale. Fine for Phase 1, not for Phase 5.                                                                                                                                                         |

## Revisit if

CI runtime becomes a problem once Phase 2's fuzz tests land. The likely move is
`fileParallelism: true`, which this ADR deliberately trades away today — see the
comment in `vitest.config.ts` explaining which way that trade goes.
