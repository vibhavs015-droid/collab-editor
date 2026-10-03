# 0002 — Single package, not a monorepo

**Status:** Accepted
**Date:** 2026-10-03
**Phase:** Structural, applies from Phase 1

## Context

By Phase 5 this repository holds four distinct things:

- a browser application (CodeMirror 6 editor)
- a Node.js WebSocket + HTTP server
- pure CRDT logic shared between them
- a k6 load-test suite (not part of the npm package at all)

The conventional answer for multiple deployables is an npm workspaces monorepo
with one package per deployable.

## Decision

**One npm package, one `node_modules`.** Layout:

```
src/
  core/     pure CRDT logic — no I/O, no DOM, no Node APIs
  shared/   types and protocol definitions used by both sides
  server/   WebSocket + HTTP, Node APIs only
  client/   browser code, DOM APIs only
scripts/
  load/     k6 scripts, outside the npm package
```

Client code is bundled by Vite. Server code runs directly on Node. Both are
type-checked by the same `tsconfig.json`.

## Rationale

**The interviewer-facing reason.** This is a solo project. A monorepo introduces
build orchestration, cross-package resolution, and version management — all of
which are infrastructure problems that say nothing about CRDTs. A reviewer
asking about this project wants to discuss conflict resolution, not workspace
hoisting.

**The engineering reason.** There are no independent publishable artefacts. The
server and client ship together and always share one version of the protocol
types. Splitting them into packages adds a version boundary that buys nothing
here and risks the two halves disagreeing about the wire format — the exact
class of bug that is miserable to debug.

**Isolation is achieved by directory convention plus lint rules, not by package
boundaries.** `src/core` is pure logic and fully testable in milliseconds with
no mocks, which is only possible because it never touches I/O.

## Consequences

**Good**

- One `npm install`, one lockfile, no resolution problems
- Type sharing is trivial — one compiler, one set of types
- Far less to explain, and every line is defensible

**Bad**

- `tsconfig.json` must include both `DOM` and Node lib types, so it cannot
  fully prevent server code from touching `window`. Mitigated by ESLint
  overrides applying browser-globals rules per directory (see
  [`eslint.config.js`](../../eslint.config.js)).
- Client-only dependencies land in the same `node_modules` as server ones. Vite
  tree-shakes them out of the browser bundle, so this costs disk, not bytes.
- k6 scripts cannot import from `src/` directly, because k6 runs on its own Go
  runtime. The load suite therefore drives the server over HTTP rather than
  calling internals. This is a feature: it tests what users actually hit.

## Revisit if

The client and server ever need genuinely independent release cadences, or a
second consumer (e.g. a mobile app) needs to share `core`. At that point
`core` becomes a published package and this ADR is superseded.

Node and browser types are kept honest by lint configuration rather than by the
package system. That trade is only sound while this is one small repository —
which is the condition this ADR asserts.
