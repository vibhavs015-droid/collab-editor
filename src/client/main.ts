/**
 * Browser entry point.
 *
 * Wires the editor, the API, and autosave together, and owns every UI state
 * transition. Kept as one module because it is the composition root — the
 * interesting logic lives in `editor.ts` and `autosave.ts`, both unit-tested
 * without a DOM.
 */

import { ApiError, api, newDocumentId } from './api.js';
import { Autosave, type SaveStatus } from './autosave.js';
import { createEditor, type EditorHandle } from './editor.js';

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
  saveStatus: requireElement<HTMLDivElement>('save-status'),
  saveStatusText: requireElement<HTMLSpanElement>('save-status-text'),
  saveNow: requireElement<HTMLButtonElement>('save-now'),
  wordCount: requireElement<HTMLSpanElement>('word-count'),
  charCount: requireElement<HTMLSpanElement>('char-count'),
  lastSaved: requireElement<HTMLSpanElement>('last-saved'),
};

let editor: EditorHandle | null = null;
let autosave: Autosave | null = null;
let detachUnloadGuard: (() => void) | null = null;

/**
 * Resolve which document to open.
 *
 * `?doc=<id>` opens an existing one; otherwise a fresh id is minted. Explicit
 * routing rather than a router dependency — one query parameter does not need
 * one, and Phase 5 introduces routes only when there are several.
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
 * Distinguishes "document missing" from "server unreachable" because the
 * correct action differs: create a new document versus retry.
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

function renderSaveStatus(status: SaveStatus): void {
  // `className` is assigned wholesale rather than toggled piecemeal, so a state
  // can never accumulate stale modifier classes.
  const classes = ['status'];
  let text: string;

  switch (status.state) {
    case 'idle':
      classes.push('status--idle');
      text = status.lastSavedAt ? 'Saved' : 'Ready';
      break;
    case 'dirty':
      classes.push('status--dirty');
      text = 'Unsaved changes';
      break;
    case 'saving':
      classes.push('status--saving');
      text = 'Saving…';
      break;
    case 'saved':
      classes.push('status--saved');
      text = 'Saved';
      break;
    case 'error':
      classes.push('status--error');
      text = status.error ?? 'Save failed';
      break;
  }

  els.saveStatus.className = classes.join(' ');
  els.saveStatusText.textContent = text;
  els.saveNow.disabled = status.state === 'saving';

  if (status.lastSavedAt) {
    const when = new Date(status.lastSavedAt);
    els.lastSaved.textContent = Number.isNaN(when.getTime())
      ? ''
      : `Last saved ${when.toLocaleTimeString()}`;
  } else {
    els.lastSaved.textContent = '';
  }
}

function renderCounts(text: string): void {
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
  els.wordCount.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  els.charCount.textContent = `${text.length} ${text.length === 1 ? 'character' : 'characters'}`;
}

/** Tear down previous wiring before creating a new one. */
function teardown(): void {
  detachUnloadGuard?.();
  detachUnloadGuard = null;
  autosave = null;
  editor?.destroy();
  editor = null;
}

async function openDocument(documentId: string): Promise<void> {
  teardown();
  showLoading();

  try {
    let record;

    try {
      record = await api.getDocument(documentId);
    } catch (error) {
      // A brand-new id has no document yet. Creating it here keeps "open a URL,
      // start typing" working without a separate create step in the UI.
      if (error instanceof ApiError && error.isNotFound) {
        record = await api.createDocument(documentId, 'Untitled');
      } else {
        throw error;
      }
    }

    editor = createEditor({
      parent: els.editorHost,
      initialContent: record.content,
      documentTitle: record.title,
      onChange: (text) => {
        renderCounts(text);
        autosave?.schedule(text);
      },
    });

    autosave = new Autosave({
      documentId,
      onStatusChange: renderSaveStatus,
    });
    autosave.markClean(record.content);

    // Without this, closing the tab during the debounce window loses the final
    // edit. This is the single highest-value line in the file.
    detachUnloadGuard = autosave.attachUnloadGuard();

    els.title.value = record.title;
    renderCounts(record.content);
    renderSaveStatus(autosave.status);
    hideAllStates();

    editor.focus();
  } catch (error) {
    showError(error, documentId);
  }
}

async function startNewDocument(): Promise<void> {
  const id = newDocumentId();
  window.history.replaceState({}, '', `?doc=${id}`);
  await openDocument(id);
}

function wireEvents(): void {
  els.retry.addEventListener('click', () => {
    const id = els.retry.dataset['documentId'] ?? resolveDocumentId();
    void openDocument(id);
  });

  els.newDoc.addEventListener('click', () => {
    void startNewDocument();
  });

  els.saveNow.addEventListener('click', () => {
    void autosave?.flush();
  });

  els.title.addEventListener('change', () => {
    const title = els.title.value.trim() || 'Untitled';
    void api.renameDocument(resolveDocumentId(), title).catch(() => {
      // A failed rename is not worth interrupting typing over; the autosave
      // indicator still reflects content state truthfully.
    });
  });

  // Cmd/Ctrl+S would otherwise trigger the browser's "save page" dialog, which
  // is meaningless here and leaves the user thinking something was saved.
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void autosave?.flush();
    }
  });
}

wireEvents();

const initialId = resolveDocumentId();
window.history.replaceState({}, '', `?doc=${initialId}`);
void openDocument(initialId);
