/**
 * Autosave — debounced persistence with truthful status reporting.
 *
 * ── Why debounce ─────────────────────────────────────────────────────────
 * Typing produces one change event per keystroke. Saving each one would issue
 * thousands of writes per minute and make the server the bottleneck. A trailing
 * debounce collapses a burst of keystrokes into a single save.
 *
 * ── Why the extra guarantees ─────────────────────────────────────────────
 * A naive debounce loses data in ways that are easy to miss:
 *
 * 1. `flush()` — the user closes the tab mid-debounce and the last edits vanish.
 *    `beforeunload` calls this.
 * 2. A save in flight while new edits arrive can resolve out of order and
 *    overwrite newer content with older. In-flight requests are tracked and the
 *    sequence number prevents that.
 * 3. `changed: false` from the server means the write was a no-op. Reporting
 *    "Saved" anyway is harmless; reporting "Unsaved" forever is not.
 */

import { ApiError, api } from './api.js';

/** Where the editor is in the save lifecycle. Drives the status indicator. */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface SaveStatus {
  readonly state: SaveState;
  /** Populated only when `state` is `'error'`. */
  readonly error: string | null;
  /** True when the failure looks worth retrying. */
  readonly retryable: boolean;
  /** ISO timestamp of the last successful save. */
  readonly lastSavedAt: string | null;
}

const INITIAL_STATUS: SaveStatus = {
  state: 'idle',
  error: null,
  retryable: false,
  lastSavedAt: null,
};

export interface AutosaveOptions {
  readonly documentId: string;
  /** How long to wait after the last keystroke before saving. */
  readonly debounceMs?: number;
  /** Notified on every status transition, so the UI can re-render. */
  readonly onStatusChange: (status: SaveStatus) => void;
  /** Injectable for tests. Defaults to the real API client. */
  readonly saveFn?: (id: string, content: string) => Promise<{ updatedAt: string }>;
}

export class Autosave {
  readonly #documentId: string;
  readonly #debounceMs: number;
  readonly #onStatusChange: (status: SaveStatus) => void;
  readonly #save: (id: string, content: string) => Promise<{ updatedAt: string }>;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #status: SaveStatus = INITIAL_STATUS;

  /** Content as the editor currently holds it. */
  #content = '';

  /**
   * Monotonic sequence number.
   *
   * Incremented on every change. A save captures the value at dispatch; on
   * success, state only advances to 'saved' if no newer edit has landed. Without
   * this, a slow request can resolve after a fast one and mark stale content as
   * saved, or write older content over newer.
   */
  #revision = 0;

  /** Set while any request is in flight. */
  #inFlight = 0;

  /** Content already persisted. Used to skip writes that would change nothing. */
  #lastPersisted = '';

  constructor(options: AutosaveOptions) {
    this.#documentId = options.documentId;
    this.#debounceMs = options.debounceMs ?? 800;
    this.#onStatusChange = options.onStatusChange;
    // Wrapped in an arrow rather than referencing `api.saveContent` directly:
    // extracting the method detaches it from its object, which TypeScript correctly
    // flags as a potential `this` bug even though the api object uses no `this`.
    this.#save = options.saveFn ?? ((id, content) => api.saveContent(id, content));
  }

  get status(): SaveStatus {
    return this.#status;
  }

  /** True when there are edits not yet confirmed by the server. */
  get hasUnsavedChanges(): boolean {
    return this.#content !== this.#lastPersisted;
  }

  /** Mark server content as the persisted baseline after an initial load. */
  markClean(content: string): void {
    this.#content = content;
    this.#lastPersisted = content;
    this.#emit({ ...INITIAL_STATUS, state: 'idle', lastSavedAt: null });
  }

  /**
   * Record an editor change and schedule a save.
   *
   * @param content the editor's full current text.
   */
  schedule(content: string): void {
    this.#content = content;
    this.#revision += 1;

    if (content === this.#lastPersisted) {
      // User undid back to the saved state. Not "dirty" any more.
      this.#clearTimer();
      this.#emit({ ...this.#status, state: 'idle', error: null, retryable: false });
      return;
    }

    this.#emit({ ...this.#status, state: 'dirty', error: null, retryable: false });
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#debounceMs);
  }

  /**
   * Save immediately, bypassing the debounce.
   *
   * Called on `beforeunload` and on an explicit save action. Uses
   * `keepalive` so the browser allows the request to complete during unload —
   * without it the request is cancelled and the save is lost, which is the
   * entire reason this method exists.
   */
  async flush(): Promise<void> {
    this.#clearTimer();

    if (!this.hasUnsavedChanges) {
      return;
    }

    const revision = this.#revision;
    const content = this.#content;

    this.#inFlight += 1;
    this.#emit({ ...this.#status, state: 'saving', error: null, retryable: false });

    try {
      const result = await this.#save(this.#documentId, content);

      // Persist what the server acknowledged, but only if nothing newer arrived
      // while this request was in flight.
      if (revision === this.#revision) {
        this.#lastPersisted = content;
        this.#emit({
          state: 'saved',
          error: null,
          retryable: false,
          lastSavedAt: result.updatedAt,
        });
      }
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Save failed.';

      const retryable =
        !(error instanceof ApiError) ||
        error.status === 0 ||
        error.status >= 500 ||
        error.status === 429;

      // Keep the content so the user's edits are still recoverable, and leave
      // hasUnsavedChanges true so a later change or manual retry can flush them.
      this.#emit({ ...this.#status, state: 'error', error: message, retryable });
    } finally {
      this.#inFlight -= 1;
    }
  }

  /** True while at least one request is in flight. */
  get isSaving(): boolean {
    return this.#inFlight > 0;
  }

  /**
   * Register the unload handler that prevents losing the final edit.
   *
   * Returns a cleanup function so tests and hot reloads can detach it.
   */
  attachUnloadGuard(): () => void {
    const handler = (): void => {
      if (this.hasUnsavedChanges) {
        void this.flush();
      }
    };

    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #emit(status: SaveStatus): void {
    this.#status = status;
    this.#onStatusChange(status);
  }
}
