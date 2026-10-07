# The browser tests, and what they cost to get right

946 source-level tests passed while the application never once sent a typed character to the
server. This file records why that was possible, what the first browser tests got wrong, and
which measurement each correction rests on.

## The gap the suite could not see

Every unit and integration test drives a function directly. That makes them fast, precise, and
blind to one specific class of failure: a component that works correctly and is never invoked,
or two correct components that were never wired to each other.

This project produced four such bugs in a row. Each was invisible to a fully green suite:

- `exportLocalChanges` returned operations and left broadcasting to the caller, and the caller
  discarded the result. The editor worked, the local log was correct, the indicator said
  "Synced", and the server had never heard of the document.
- The session endpoint minted a new anonymous subject on every load, so a reload silently lost
  access to every document the browser had opened.
- The CRDT site id lived in `localStorage`, so two tabs were two replicas claiming one identity
  and the server deduplicated one tab's edits away.
- The update listener returned early on `!docChanged`, and a cursor movement produces no
  document change, so presence was never sent.

A seam is only observable from above one of its halves. That is the whole argument for these
tests, and it is why they drive the real built server rather than a mock.

## Two coordinate systems, three units

The emoji scenario exists because three different coordinate systems meet at the editor boundary,
and confusing them produces a test failure that looks like an application bug:

| Layer             | Unit                       |
| ----------------- | -------------------------- |
| CRDT element      | one per Unicode code point |
| CodeMirror offset | UTF-16 code unit           |
| `ArrowRight`      | one grapheme               |

In `"a<emoji>b"` the caret sits at UTF-16 offset 3 between the emoji and the `b`, but it takes
**two** `ArrowRight` presses to get there. Measured, not assumed:

```
1 press   ->  a|<emoji>b
2 presses ->  a<emoji>|<b
3 presses ->  a<emoji>b|
```

The first draft of the test pressed three times, landed after the `b`, and produced
`"a<emoji>bX"`. That was the test's arithmetic being wrong, not the application.

The same draft then asserted that Backspace over an emoji yields `"a<emoji>b"`, on the reasoning
that it "removes the emoji and keeps the b". That describes Delete. Backspace removes the
character _before_ the caret, so `"a<emoji>Xb"` correctly becomes `"aXb"` - one element removed,
the `X` surviving. Both assertions were wrong about the editor, and both were corrected rather
than loosened.

## `setOffline` is not an outage

The first draft of the outage scenarios used `context.setOffline(true)`. It failed, and the
failure is the interesting part: the sync indicator read `"Synced"` throughout, because the
operations typed while "offline" had **reached the server**.

Measured across three mechanisms, none of which disconnects an ESTABLISHED WebSocket in
Chromium:

| Mechanism                                                | Ops typed while "offline" reached the server |
| -------------------------------------------------------- | -------------------------------------------- |
| `context.setOffline(true)`                               | yes                                          |
| CDP `Network.emulateNetworkConditions { offline: true }` | yes                                          |
| `routeWebSocket` with the relay stopped                  | yes                                          |

`GET /api/documents/<id>` came back with the text in all three cases. A test written against any
of them would pass with offline handling deleted entirely - it asserts nothing.

So `e2e/global-setup.ts` owns the server process and stops it for real. Two consequences worth
stating:

- **A PID file, not `globalThis`.** globalSetup runs in the runner's process and spec files run
  in workers. The first attempt stored a handle on `globalThis` and every outage spec failed with
  "the e2e server handle is missing; globalSetup did not run" while the server logs proved
  globalSetup had run.
- **`stop` and `start` are separate calls.** The assertion between them - that the peer did _not_
  receive the work - is the entire point. A helper that restarted immediately would erase it.

## Production mode, real auth

The first server start failed:

```
JWT_SECRET is required when NODE_ENV=production
```

That is the server working correctly: open auth in production is the failure where the app looks
healthy and every document is readable by anyone. The tests now supply a real HS256 secret and
run the way production does. Each browser context still mints its own anonymous subject, so two
contexts are still strangers and the ownership rules still apply - which is why the specs grant
the second context access explicitly instead of working around ownership.

## Proving the regression tests bite

Both review patches were temporarily reverted, and the corresponding scenario failed:

| Reverted                  | Scenario                 | Result                                  |
| ------------------------- | ------------------------ | --------------------------------------- |
| 0002 (outbox cap)         | d, 6,000-character paste | failed: `the two pages never converged` |
| 0001 (UTF-16 translation) | e, emoji                 | failed: `the two pages never converged` |

Both reverts are scripted so they are exactly reproducible, and both are restored from a
byte-for-byte backup rather than an inverse edit.

One trap is worth recording, because it is the same trap T1 exists to close. The first version of
the 0001 revert replaced the two conversion calls and left `const textBefore = replica.text` in
place. Typecheck rejected it as an unused variable, **the build failed**, `dist/` kept the
patched code, and the test passed against the code it was supposed to be attacking. A green test
proving nothing is worse than a red one, because it removes the reason to look.

## Configuration, and why `rootDir` was not widened

The specs are covered by `tsconfig.e2e.json`, not the main config, and `npm run typecheck` runs
both. Two things tried along the way are recorded because they look reasonable and are wrong:

- **Adding `e2e` to the main `include`** compiles cleanly but breaks the image. `rootDir` is
  `"src"`, so widening it moved the output to `dist/src/server/index.js`, and the Dockerfile
  asserts `test -f /app/dist/server/index.js`. Reverted; `dist/` now contains exactly
  `client`, `core`, `server`, `shared`.
- **Setting `allowDefaultProject` on the eslint block** emptied the _global_ list, because those
  two options are not scoped by `files` in flat config, and made `eslint.config.js` itself
  unlintable.

## What is not covered

- **Firefox and WebKit.** Chromium only. Playwright is configured for one project because the
  engine-specific behaviour that matters here is the WebSocket disconnection semantics, and
  Chromium is where they were measured.
- **Visual regression.** The specs assert text, convergence and indicator state. Nothing compares
  pixels, so a purely cosmetic regression passes.
- **Real network loss.** The outage is a stopped process, which produces a TCP RST. A half-open
  connection that silently drops packets is not reproduced, and the protocol has no application
  level ping, so nothing on either side would notice it promptly. That is a real gap and it
  belongs with T4, which is the task about detecting a socket that dies after `send()`.
