# `src/client`

Browser application. Introduced in **Phase 1**.

## Planned contents

| File                             | Phase | Purpose                                              |
| -------------------------------- | ----- | ---------------------------------------------------- |
| `main.ts`                        | 1     | Bootstrap: mount editor, wire transport              |
| `editor/`                        | 1     | CodeMirror 6 setup and configuration                 |
| `editor/extensions/awareness.ts` | 3     | Live cursors for collaborators                       |
| `sync/replica.ts`                | 3     | Owns the local CRDT replica, applies remote ops      |
| `sync/transport.ts`              | 3     | WebSocket client, reconnect with exponential backoff |
| `sync/offlineQueue.ts`           | 4     | Buffer ops while offline, flush on reconnect         |
| `storage/indexedDb.ts`           | 4     | Local persistence of ops                             |
| `ui/SyncStatus.tsx`              | 4     | Truthful offline / pending / synced indicator        |
| `ui/ConflictNotice.ts`           | 4     | Surface merges that lost information                 |
| `router/`                        | 5     | Document routes                                      |

## Rules

**UI state must reflect reality, not optimism.** If three operations are queued
offline, the indicator says three pending. A sync UI that lies is worse than no
sync UI — it destroys the user's trust in their own edits.

**The unhappy path is designed, not defaulted.** Empty, loading, error,
offline, and conflict states are written deliberately in the same pass as the
happy path. Adding them later always produces them looking bolted on.

## Planned dependencies

| Package             | Why                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codemirror`        | Editor. Its document model is already collaboration-shaped; hand-rolling a text area wastes the phase on caret handling.                              |
| `yjs` / `automerge` | **Not planned.** The CRDT in `src/core` is the project. Using a library here would defeat its purpose. Possible reference-only comparison in Phase 6. |
| `vite`              | Dev server and bundler                                                                                                                                |
