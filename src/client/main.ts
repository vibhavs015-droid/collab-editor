/**
 * Browser entry point.
 *
 * ── What changed in Phase 4 ────────────────────────────────────────────────
 * Phase 1 saved text to the server on a debounce. Phase 3 bolted a relay on the
 * side. Neither was offline-first: kill the network and Phase 1 lost the debounce
 * window, Phase 3's relay lost everything it had not forwarded.
 *
 * Now the write path is:
 *
 *   keystroke -> Replica -> IndexedDB       (durable, always)
 *            -> EditorBinding diff         (what the user sees)
 *            -> SyncTransport outbox       (best effort, retried with backoff)
 *            -> server operation log       (authoritative history)
 *
 * The server is a sync optimisation, not part of the write path. Nothing waits for
 * it and nothing is lost when it is absent. That is the whole design, and it is
 * why `Autosave` no longer exists: two independent write paths would mean two
 * sources of truth, and they would eventually disagree.
 *
 * The composition root stays in one module. Everything interesting lives in
 * modules that can be tested without a DOM.
 */

import { ApiError, api, newDocumentId, sessionStore } from './api.js';
import { createEditor, type EditorHandle } from './editor.js';
import { IndexedDbOperationLog } from './storage/indexedDbLog.js';
import { EditorBinding, type BindingAnomaly } from './sync/binding.js';
import { describePeers, resolveSync, type SyncState } from './sync/status.js';
import { SyncTransport, type Baseline, type ConnectionState } from './sync/transport.js';
import type { SiteId } from '../core/clock.js';
import { parseElementId } from '../shared/operation-validation.js';
import type { JsonValue } from '../shared/protocol.js';
import { Replica } from '../core/crdt/replica.js';
import { initialOperations } from '../core/crdt/seed.js';
import {
  snapshotToOperations,
  type DocumentSnapshot,
  type SnapshotElement,
} from '../core/crdt/snapshot.js';

/** Every DOM id the app touches, resolved once so a typo fails loudly. */
function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
}

const els = {
  title: requireElement<HTMLInputElement>('doc-title'),
  editorHost: requireElement<HTMLDivElement>('editor-host'),
  loading: requireElement<HTMLDivElement>('loading'),
  error: requireElement<HTMLDivElement>('error'),
  errorMessage: requireElement<HTMLParagraphElement>('error-message'),
  retry: requireElement<HTMLButtonElement>('retry'),
  newDoc: requireElement<HTMLButtonElement>('new-doc'),
  sync: requireElement<HTMLDivElement>('sync-status'),
  syncText: requireElement<HTMLSpanElement>('sync-status-text'),
  syncDetail: requireElement<HTMLSpanElement>('sync-detail'),
  peerCount: requireElement<HTMLSpanElement>('peer-count'),
  wordCount: requireElement<HTMLSpanElement>('word-count'),
  charCount: requireElement<HTMLSpanElement>('char-count'),
  logDepth: requireElement<HTMLSpanElement>('log-depth'),
};

const SITE_KEY = 'collab-editor:site';

/**
 * Log size at which the client compacts, in entries.
 *
 * 5,000 is chosen from what compaction actually costs and saves. A snapshot element
 * becomes one stored operation, so a log of 5,000 entries on a 1,000-character document
 * costs roughly 10x what the text needs. The threshold is well above a normal working
 * session - a fast typist produces a few thousand keystrokes an hour - so compaction is
 * rare in practice rather than constant, which matters because it rewrites the log.
 */
const COMPACT_THRESHOLD_ENTRIES = 5_000;

/**
 * Operations kept after compaction.
 *
 * A tail, not a floor: this is what a peer that is slightly behind can be sent as a
 * delta rather than a full baseline. 200 is far more than a few seconds of typing for
 * one person.
 */
const COMPACT_KEEP_TAIL = 200;

/**
 * Identity for this browser tab.
 *
 * Persisted so a reload keeps its own history rather than colliding with the
 * previous session's element IDs. Two tabs of the same document must not share a
 * site: their clocks would run in parallel and mint identical IDs for different
 * characters, which is the one failure the CRDT cannot detect for itself.
 */
function resolveSite(): SiteId {
  try {
    const existing = window.localStorage.getItem(SITE_KEY);
    if (existing !== null && existing.length > 0) {
      return existing;
    }

    const minted = newDocumentId();
    window.localStorage.setItem(SITE_KEY, minted);
    return minted;
  } catch {
    // Private browsing, or storage disabled. A per-session site is still correct:
    // it only means a reload starts a fresh identity, and the server catches the
    // replica up by replaying the log rather than by comparing clocks.
    return `s-${newDocumentId()}`;
  }
}

/** Live state for the open document. */
interface Session {
  readonly documentId: string;
  readonly replica: Replica;
  readonly binding: EditorBinding;
  readonly transport: SyncTransport;
  readonly log: IndexedDbOperationLog;
}

let session: Session | null = null;
let editor: EditorHandle | null = null;
let detachUnloadGuard: (() => void) | null = null;

/**
 * Latest known replication state, folded into the indicator.
 *
 * Mutable and module-level rather than threaded through every callback, because
 * six independent producers write to it and one consumer reads it. Every producer
 * calls `renderSync` immediately after writing, so the two cannot drift.
 */
const syncInputs = {
  connection: 'closed' as ConnectionState,
  pendingOps: 0,
  serverState: null as 'synced' | 'pending' | 'offline' | 'error' | null,
  unplacedOps: 0,
  peers: 0,
};

/**
 * Repaint the indicator.
 *
 * One function, called from every state change. Reading four booleans from the DOM
 * and rendering each independently is how these indicators start lying.
 */
function renderSync(): void {
  const view = resolveSync(syncInputs);

  // Assigned wholesale rather than toggled piecemeal, so a state can never
  // accumulate stale modifier classes.
  els.sync.className = `sync sync--${view.state}`;
  els.syncText.textContent = view.label;
  els.syncDetail.textContent = view.detail;
  els.peerCount.textContent = describePeers(syncInputs.peers);

  // Counted from the replica rather than from IndexedDB: `appliedSeq` is exact,
  // synchronous, and free, whereas `count()` is a round trip that must not run on
  // every keystroke.
  const stored = (session?.replica.appliedSeq ?? -1) + 1;
  els.logDepth.textContent = `${stored} local operation${stored === 1 ? '' : 's'}`;
}

function renderCounts(text: string): void {
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  els.wordCount.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  els.charCount.textContent = `${text.length} ${text.length === 1 ? 'character' : 'characters'}`;
}

/**
 * Which document to open.
 *
 * `?doc=<id>` opens an existing one; otherwise a fresh id is minted. Explicit
 * routing rather than a router dependency: one query parameter does not need one,
 * and Phase 5 introduces routes only when there are several.
 */
function resolveDocumentId(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('doc');

  if (fromQuery && /^[A-Za-z0-9_-]{1,64}$/.test(fromQuery)) {
    return fromQuery;
  }

  return newDocumentId();
}

function showLoading(): void {
  els.loading.hidden = false;
  els.error.hidden = true;
}

function hideAllStates(): void {
  els.loading.hidden = true;
  els.error.hidden = true;
}

/**
 * Render a load failure.
 *
 * Distinguishes "document missing" from "server unreachable" because the correct
 * action differs: create a new document versus retry.
 */
function showError(error: unknown, documentId: string): void {
  els.loading.hidden = true;
  els.error.hidden = false;

  const isApiError = error instanceof ApiError;

  if (isApiError && error.isNotFound) {
    els.errorMessage.textContent =
      'That document does not exist. Start a new one, or check the link.';
  } else if (isApiError && error.status === 0) {
    els.errorMessage.textContent =
      'Cannot reach the server. Check that it is running, then try again.';
  } else {
    els.errorMessage.textContent =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
  }

  els.retry.hidden = isApiError && error.isNotFound;
  els.newDoc.hidden = !(isApiError && error.isNotFound);

  if (!isApiError || !error.isNotFound) {
    // Keep the id so a retry re-attempts the same document rather than minting a
    // new one and silently losing the URL the user has.
    els.retry.dataset['documentId'] = documentId;
  }
}

/**
 * Anomaly reporting.
 *
 * These are bugs, not user errors, so they go to the console rather than the UI.
 * Surfacing them in the interface would tell the user their document is broken when
 * in fact it was repaired correctly; burying them in a log nobody reads would make
 * the next occurrence just as mysterious.
 */
function reportAnomaly(anomaly: BindingAnomaly): void {
  console.warn(`[collab-editor] ${anomaly.kind}: ${anomaly.detail}`);
  console.warn('[collab-editor] CRDT invariants:', session?.replica.checkInvariants() ?? []);
}

/** Tear down the previous session before creating a new one. */
function teardown(): void {
  detachUnloadGuard?.();
  detachUnloadGuard = null;

  session?.transport.dispose();
  session?.binding.detach();
  session?.log.close();
  session = null;

  editor?.destroy();
  editor = null;
}

/** WebSocket URL for a document, derived from the page origin. */
function socketUrlFor(documentId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?doc=${encodeURIComponent(documentId)}`;
}

/**
 * Replace this device's document with a server baseline.
 *
 * ── Why this replaces rather than merges ────────────────────────────────────
 * The transport only calls this once the outbox is empty, so everything the user
 * typed is already on the server and present in the baseline. Applying the baseline
 * on top of the existing document would double it.
 *
 * ── Why the editor is rebuilt rather than patched ───────────────────────────
 * The whole document changes. CodeMirror's change set is built by diffing the old
 * and new element snapshots, which is exactly the machinery in `binding.ts`, so the
 * reset goes through the same path as any other remote change rather than growing
 * a second one.
 */
async function adoptBaseline(replica: Replica, baseline: Baseline): Promise<void> {
  try {
    // The elements arrived as untrusted JSON. Validating them here is what lets a
    // malformed baseline be refused rather than producing a corrupt document.
    const snapshot = parseSnapshotElements(baseline.elements);

    if (snapshot === null) {
      reportAnomaly({
        kind: 'unplaced-operations',
        detail: 'server baseline was malformed; keeping the local document',
      });
      return;
    }

    await replica.resetTo(snapshotToOperations(snapshot));

    // Anything recorded after the snapshot was taken.
    const tail = replica.applyRemote(baseline.ops);

    if (tail.length > 0) {
      reportAnomaly({
        kind: 'unplaced-operations',
        detail: `${tail.length} post-baseline operation(s) could not be placed`,
      });
    }

    syncInputs.unplacedOps = 0;
    renderSync();
  } catch (error) {
    // A failed baseline must not leave the editor and the CRDT disagreeing. The
    // binding repairs the editor from the CRDT on the next change, and the CRDT is
    // authoritative because its operation log is durable.
    reportAnomaly({
      kind: 'unplaced-operations',
      detail: `could not adopt the server baseline: ${String(error)}`,
    });
  }
}

/**
 * Validate inbound snapshot elements.
 *
 * @returns the elements as a snapshot, or `null` if any one of them is malformed.
 *   All-or-nothing on purpose: a partially-applied baseline is a corrupt document.
 */
function parseSnapshotElements(raw: readonly JsonValue[]): DocumentSnapshot | null {
  const elements: SnapshotElement[] = [];

  for (const value of raw) {
    if (!isRecord(value)) {
      return null;
    }

    const id = parseElementId(value['id']);
    const text = value['value'];

    if (id === null || typeof text !== 'string' || [...text].length !== 1) {
      return null;
    }

    const origin = value['origin'];

    if (origin !== null && origin !== undefined) {
      const parsedOrigin = parseElementId(origin);
      if (parsedOrigin === null) {
        return null;
      }

      elements.push({ id, value: text, origin: parsedOrigin });
      continue;
    }

    elements.push({ id, value: text, origin: null });
  }

  return { seq: 0, elements };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Seed a replica from the server's text cache.
 *
 * Applied as operations under a site derived from the document id, so two clients
 * that independently seed the same document produce identical element IDs. Merging
 * them is then a no-op rather than a doubling of the text, which is what would
 * happen if each client seeded under its own site.
 */
function seedFromServer(replica: Replica, documentId: string, content: string): void {
  if (content === '') {
    return;
  }

  replica.applyRemote(initialOperations(documentId, content));
}

/** Fetch the server's view of a document and adopt anything this device lacks. */
async function adoptServerContent(replica: Replica, documentId: string): Promise<string> {
  try {
    const record = await api.getDocument(documentId);
    seedFromServer(replica, documentId, record.content);
    return record.title;
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) {
      // A fresh id has no document yet. Creating it here keeps "open a URL, start
      // typing" working without a separate create step in the UI.
      const created = await api.createDocument(documentId, 'Untitled');
      return created.title;
    }

    throw error;
  }
}

async function openDocument(documentId: string): Promise<void> {
  teardown();
  showLoading();

  const log = new IndexedDbOperationLog({ databaseName: `collab-editor:${documentId}` });
  const replica = new Replica({
    site: resolveSite(),
    log,
    onOperations: () => {
      // The binding owns broadcast. This callback exists because the port requires
      // one, and a second subscriber would mean two answers to "what do we send".
    },
  });

  try {
    // Replay before anything else. Until this resolves the document is empty, and an
    // edit made against an empty document would conflict with the log on the next
    // load.
    await replica.init();

    // The server's text cache is consulted only to fill a gap. It is NOT
    // authoritative: the local operation log is, and letting the cache overwrite
    // real local work is precisely the data loss this design exists to prevent.
    if (replica.text === '') {
      els.title.value = await adoptServerContent(replica, documentId);
    }

    // The editor, the binding and the transport reference each other: the editor
    // reports changes, the binding turns them into operations, and the operations
    // go to a transport the binding does not know about. They are therefore wired
    // through closures over bindings assigned a few lines apart.
    //
    // This is safe, not merely convenient: no closure here runs until all three
    // exist. The editor cannot dispatch before it is constructed, and the
    // transport's handlers cannot fire before `connect()`. Every reference resolves
    // after its declaration, so no temporal dead zone is entered.
    let binding: EditorBinding | null = null;
    let transport: SyncTransport | null = null;

    editor = createEditor({
      parent: els.editorHost,
      initialContent: replica.text,
      documentTitle: els.title.value,
      onChange: (text) => {
        renderCounts(text);
        renderSync();
      },
      onDocChange: (changes) => binding?.exportLocalChanges(changes) ?? [],
    });

    binding = new EditorBinding({
      view: editor.view,
      replica,
      onLocalOperations: (ops) => transport?.send(ops),
      onAnomaly: reportAnomaly,
    });

    transport = new SyncTransport({
      documentId,
      url: socketUrlFor(documentId),
      // Resolved on every connect, not once at startup. A session token expires, and
      // the only moment it is read is the handshake -- so re-resolving there means
      // expiry never becomes something the transport has to notice. See
      // #sendHello.
      resolveToken: async () => (await sessionStore.ensure()).token,
      handlers: {
        onOps: (ops) => {
          const result = binding.applyRemote(ops);

          if (result.unplaced.length > 0) {
            syncInputs.unplacedOps += result.unplaced.length;
            renderSync();

            // An operation anchored to something this client has never seen will
            // never apply on its own. Asking for the log is the only recovery.
            transport?.requestResync();
          } else {
            syncInputs.unplacedOps = 0;
          }
        },
        onPresence: (cursors) => {
          syncInputs.peers = Object.keys(cursors).length;
          renderSync();
        },
        onSyncState: (state, pendingOps) => {
          syncInputs.serverState = state;
          syncInputs.pendingOps = pendingOps;
          renderSync();

          // Compaction only makes sense once there is nothing in flight. While the
          // outbox holds operations, the local log is the only record of them.
          //
          // `onSyncState` rather than `onStateChange`: 'synced' is a statement about
          // the outbox being empty, which is a sync fact. A socket can be open while
          // operations are still queued, and compacting then would drop tombstones the
          // queued deletes still need.
          if (state === 'synced') {
            void maybeCompactLog();
          }
        },
        onBaseline: (baseline) => {
          // The server says this device is below the compaction floor, so the
          // operations it is missing no longer exist. Adopt the baseline and then
          // apply whatever was recorded after it.
          void adoptBaseline(replica, baseline);
        },
        // The site id is informational. The local site drives element IDs, because a
        // server-assigned id would change on every reconnect and break this client's
        // own clock history.
        onWelcome: () => undefined,
        onError: (code, message) => {
          console.warn(`[collab-editor] server error ${code}: ${message}`);
          renderSync();
        },
        onStateChange: (state) => {
          syncInputs.connection = state;
          syncInputs.pendingOps = transport?.queuedOperationCount ?? 0;
          renderSync();
        },
      },
    });

    session = { documentId, replica, binding, transport, log };

    syncInputs.connection = 'closed';
    syncInputs.pendingOps = 0;
    syncInputs.serverState = null;
    syncInputs.unplacedOps = 0;
    syncInputs.peers = 0;

    /**
     * Replace the local log's history with a snapshot, when it is worth doing.
     *
     * ---------------------------------------------------------------------------
     * WHY IT IS NOT AUTOMATIC ON EVERY WRITE
     * ---------------------------------------------------------------------------
     * `IndexedDbOperationLog.append` used to enforce a hard cap by deleting the oldest
     * entries. That is unsafe: an RGA insert names the element it anchors to, so
     * deleting a prefix deletes the elements the surviving operations still refer to,
     * and the next page load throws in `Replica.init()` rather than opening the document.
     *
     * Compaction is the safe version, because it replaces what it drops with a snapshot
     * that carries those elements forward with their original ids. Same idea as the
     * server's compaction, on the client's own log.
     *
     * ---------------------------------------------------------------------------
     * WHY IT WAITS FOR AN EMPTY OUTBOX
     * ---------------------------------------------------------------------------
     * The outbox is the list of operations the server has not seen. Those operations
     * are still in the local log and nowhere else, so the snapshot has to carry the
     * tombstones they reference. Refusing to compact while any exist is simpler than
     * computing which ones matter, and it can only ever delay compaction by a keystroke.
     */
    async function maybeCompactLog(): Promise<void> {
      if (session === null || transport === null) {
        return;
      }

      const unsent = transport.queuedOperations;

      if (unsent.length > 0) {
        return;
      }

      try {
        // A cheap count, not a load. `compactLog` reads the whole log, and doing that on
        // every sync to discover there is nothing to do would be the expensive part.
        if ((await log.count()) < COMPACT_THRESHOLD_ENTRIES) {
          return;
        }

        const result = await replica.compactLog({
          keepAtLeast: COMPACT_KEEP_TAIL,
          unsent,
        });

        if (result.committed) {
          console.info(
            `[collab-editor] compacted the local log: ` +
              `${result.operationsBefore} -> ${result.operationsAfter} operations`,
          );
          renderCounts(replica.text);
        }
      } catch (error) {
        // Compaction is an optimisation. A storage failure must not surface as a broken
        // editor, and the log is still correct without it - just longer than ideal.
        console.warn('[collab-editor] local log compaction skipped', error);
      }
    }

    binding.start();
    editor.bindHistory({
      undo: () => binding?.undo() ?? false,
      redo: () => binding?.redo() ?? false,
    });

    renderCounts(replica.text);
    renderSync();
    hideAllStates();

    detachUnloadGuard = attachUnloadGuard(transport);
    transport.connect();
    editor.focus();
  } catch (error) {
    // A failure here leaves a replica and a log behind. Tear them down so a retry
    // starts from a clean session rather than layering a second editor on the first.
    teardown();
    showError(error, documentId);
  }
}

async function startNewDocument(): Promise<void> {
  const id = newDocumentId();
  window.history.replaceState({}, '', `?doc=${id}`);
  await openDocument(id);
}

/**
 * Push anything queued as the page goes away.
 *
 * This is about latency, not loss. Everything is already in the local log, so a
 * failed flush costs nothing but a slightly later arrival for peers. Worth doing
 * anyway, because a user who types and immediately closes the tab expects their
 * last words to be there when they reopen.
 *
 * A WebSocket send during unload is best effort; the browser may drop it. That is
 * stated rather than hidden, because claiming a guarantee here would be false.
 */
function attachUnloadGuard(transport: SyncTransport): () => void {
  const onUnload = (): void => {
    transport.flushNow();
  };

  window.addEventListener('pagehide', onUnload);

  return () => {
    window.removeEventListener('pagehide', onUnload);
  };
}

function wireEvents(): void {
  els.retry.addEventListener('click', () => {
    const id = els.retry.dataset['documentId'] ?? resolveDocumentId();
    void openDocument(id);
  });

  els.newDoc.addEventListener('click', () => {
    void startNewDocument();
  });

  els.title.addEventListener('change', () => {
    const title = els.title.value.trim() || 'Untitled';
    // Fire and forget. A failed rename is not worth interrupting typing over, and the
    // sync indicator already tells the truth about replication.
    void api.renameDocument(resolveDocumentId(), title).catch(() => undefined);
  });

  // Cmd/Ctrl+S would otherwise trigger the browser's "save page" dialog, which is
  // meaningless here and leaves the user thinking something was saved. What this app
  // saves is the operation log, and that happens on every keystroke already.
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      els.syncDetail.textContent = 'Every keystroke is already stored locally';
    }
  });
}

/**
 * Dev-time visibility into the replica.
 *
 * Exposed because the interesting questions about this app ("are we converged",
 * "what does the log hold") are only answerable from the console, and a project
 * about a CRDT should make the CRDT inspectable.
 */
declare global {
  interface Window {
    collabEditor?: {
      replica: () => Replica | null;
      text: () => string;
      state: () => SyncState;
      invariants: () => string[];
      seed: (content: string) => void;
      resync: () => void;
    };
  }
}

window.collabEditor = {
  replica: () => session?.replica ?? null,
  text: () => session?.replica.text ?? '',
  state: () => resolveSync(syncInputs).state,
  invariants: () => session?.replica.checkInvariants() ?? [],
  // Deliberately exposed. Rebuilding a document from text is the escape hatch for a
  // replica that has genuinely diverged, and hiding it would mean shipping no way
  // out of that state.
  seed: (content: string) => {
    if (session) {
      seedFromServer(session.replica, session.documentId, content);
    }
  },
  resync: () => session?.transport.requestResync(),
};

wireEvents();

const initialId = resolveDocumentId();
window.history.replaceState({}, '', `?doc=${initialId}`);
void openDocument(initialId);
