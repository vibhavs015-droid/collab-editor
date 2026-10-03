# Documentation

Two distinct kinds of writing, deliberately kept separate. Mixing them is how
docs become useless.

| Where                         | What it records                                                       | Audience                    |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------- |
| [`NOTES.md`](../NOTES.md)     | Running log: what confused me, what I tried, small friction           | Future me, mid-project      |
| [`adr/`](./adr)               | Formal decisions: option considered, option chosen, why, consequences | Reviewers, interviewers     |
| [`benchmarks/`](./benchmarks) | Measured numbers, with the method used to obtain them                 | Anyone claiming performance |

## Why ADRs exist

The code shows _what_ was built. It cannot show what was **rejected**, or why.

That judgement is the highest-signal thing in this project. A reviewer looking at
a sharded KV store cannot tell whether you chose it deliberately or wandered into
it. An ADR makes the reasoning visible — and reasoning is what senior engineers
are actually paid for.

The corpus this project was designed against said it directly:

> _"Senior+ level thinking revolves around knowing when to simplify systems."_
> _"The irony of the question is that senior level thinking aims to produce a level of system simplicity that would give the appearance of junior architecture."_

An ADR is how you prove you were making those calls rather than collecting
complexity.

## Current decisions

| #                                                             | Decision                                                            | Status   |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](./adr/0001-local-first-architecture.md)                | Local-first: device is authoritative, server is a sync optimisation | Accepted |
| [0002](./adr/0002-single-package-layout.md)                   | Single package, not an npm workspaces monorepo                      | Accepted |
| [0003](./adr/0003-element-identity-site-clock.md)             | Element identity is `(site, clock)`, ordered with a total order     | Accepted |
| [0004](./adr/0004-envelope-vs-payload-validation.md)          | Transport validates message shape; the CRDT validates operations    | Accepted |
| [0005](./adr/0005-codemirror-not-handrolled.md)               | CodeMirror 6 for editing; the CRDT stays hand-written               | Accepted |
| [0006](./adr/0006-pglite-for-local-and-ci.md)                 | PGlite (real Postgres, WASM) for local and CI; Supabase in prod     | Accepted |
| [0007](./adr/0007-server-is-a-relay-not-a-merge-authority.md) | Server relays; it never merges                                      | Accepted |
| [0008](./adr/0008-jittered-backoff-for-reconnection.md)       | Jittered exponential backoff for reconnection                       | Accepted |

## Writing a new ADR

Copy [`adr/0000-template.md`](./adr/0000-template.md), number it, fill it in,
and add a row to the table above. Write it when the decision is made — not later,
when the memory of the alternatives has faded.
