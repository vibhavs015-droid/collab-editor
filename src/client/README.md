# `src/client`

Browser application. Introduced in **Phase 1**, re-architected in **Phase 4**.

## Contents

| File                      | Phase | Purpose                                                                  |
| ------------------------- | ----- | ------------------------------------------------------------------------ |
| `main.ts`                 | 1, 4  | Composition root: replica, binding, transport, indicator, UI states      |
| `api.ts`                  | 1     | Typed HTTP client. Every function throws `ApiError`; none returns `null` |
| `editor.ts`               | 1, 4  | CodeMirror 6 setup. Undo is delegated to the CRDT, not to `history()`    |
| `storage/indexedDbLog.ts` | 4     | Durable operation log. The source of truth for this device               |
| `sync/binding.ts`         | 4     | CodeMirror ↔ CRDT. Owns the echo guard and the drift repair              |
| `sync/transport.ts`       | 3, 4  | WebSocket client, outbox, jittered backoff, sequence cursor              |
| `sync/status.ts`          | 4     | The indicator's state machine. Total, pure, exhaustively tested          |
| `ui/`                     | 5     | React-free components: conflict notices, document list                   |
| `router/`                 | 5     | Document routes                                                          |

## The write path

```
keystroke → Replica → IndexedDB        durable, always
          → EditorBinding diff         what the user sees
          → SyncTransport outbox       best effort, retried with backoff
```

Nothing on this path waits for the server. There is no autosave step, and there is
no debounce: every operation is durable the moment it is produced.

## Rules

**UI state must reflect reality, not optimism.** If three operations are queued
offline, the indicator says three queued. A sync UI that lies is worse than no
sync UI — it destroys the user's trust in their own edits. `sync/status.ts` exists
so that rule is a tested function rather than a habit.

**Offline is not an error state.** Nothing is lost while disconnected, so offline
renders in the warning colour and not the danger colour, and its detail line says
so explicitly.

**Never mock the wiring you are testing.** The binding's worst bug is an echo loop,
and an echo only exists when the change listener and the dispatch share one view.
`binding.test.ts` therefore drives a real `EditorView` in jsdom.

**The unhappy path is designed, not defaulted.** Empty, loading, error, offline and
conflict states are written in the same pass as the happy path. Adding them later
always produces them looking bolted on.

## Dependencies

| Package             | Why                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codemirror`        | Editor. Its document model is already collaboration-shaped; hand-rolling a text area wastes the phase on caret handling.                         |
| `yjs` / `automerge` | **Not planned.** The CRDT in `src/core` is the project. Using a library would defeat its purpose. Possible reference-only comparison in Phase 6. |
| `vite`              | Dev server and bundler                                                                                                                           |

Dev-only: `jsdom` and `fake-indexeddb`. Both run in Node and exist so the browser
integrations can be tested without a browser.
