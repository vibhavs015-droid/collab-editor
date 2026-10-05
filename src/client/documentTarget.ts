/**
 * Which document a page load should open.
 *
 * Extracted from `main.ts` so it can be tested without a DOM, a server, or a document.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

/**
 * Per-browser-profile memory of the document this profile last had open.
 *
 * localStorage, not sessionStorage, and deliberately the opposite lifetime to the CRDT replica
 * id in `main.ts`. This identifies a DOCUMENT, which is shared between tabs; the replica id
 * identifies a CRDT replica, which must not be.
 */
export const LAST_DOCUMENT_KEY = 'collab-editor:last-document';

/**
 * The part of the Storage interface this module needs.
 *
 * Narrowed rather than taking `Storage` so a test can pass a plain object, and so this module
 * has no dependency on the DOM at all. Everything is optional-method tolerant: a browser with
 * storage disabled makes all three throw, and that must degrade rather than break.
 */
export interface DocumentTargetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A document id has to be safe to put in a URL, a WebSocket path and an IndexedDB name.
 *
 * Deliberately the same shape as the check in `main.ts` for `?doc=`, so a value accepted from
 * one is accepted from the other. Two validators that disagree would let a stored id through
 * that a URL would have been rejected for, which is a confusing way to fail.
 */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** True when a string is shaped like a document id. */
export function isDocumentId(value: unknown): value is string {
  return typeof value === 'string' && DOCUMENT_ID_PATTERN.test(value);
}

/**
 * Remember the document this profile has open, so the next bare URL rejoins it.
 *
 * ENCRYPTED DOCUMENTS ARE FORGOTTEN, AND THAT IS LOAD-BEARING.
 *
 * The key for an encrypted document exists only in the URL fragment. A fragment is never sent
 * to the server and is not readable from script or storage after `replaceState`. So there is no
 * way to reopen such a document without the link: remembering it would send the next bare URL to
 * a document nobody holds the key for, which presents as a blank editor and no explanation.
 *
 * `removeItem` rather than "do nothing" matters. If the profile last opened an encrypted
 * document, the plaintext id from before it must not survive as the thing a bare URL reopens,
 * or the user lands on a stale document instead of a new one.
 *
 * @param encrypted whether the document being remembered is end-to-end encrypted.
 */
export function rememberDocument(
  storage: DocumentTargetStorage,
  documentId: string,
  encrypted: boolean,
): void {
  try {
    if (encrypted) {
      storage.removeItem(LAST_DOCUMENT_KEY);
    } else {
      storage.setItem(LAST_DOCUMENT_KEY, documentId);
    }
  } catch {
    // Private browsing, disabled storage, or a quota error.
    //
    // Swallowed deliberately and without logging, because there is nothing the user can do
    // about it and nothing is at risk: the cost is that the next bare URL mints a new document,
    // which is exactly the behaviour that existed before this was added. The document itself
    // is unaffected - this pointer is a convenience, not a record of anything.
  }
}

/**
 * The document this profile last had open, or null when there is none worth reopening.
 *
 * The stored value is validated rather than trusted. It is only ever written by
 * {@link rememberDocument} from a value that was itself validated, but localStorage is
 * user-editable and survives across versions of this code, so treating it as untrusted input
 * costs one regex and removes a whole class of "where did that value come from" bug.
 */
export function recallDocument(storage: DocumentTargetStorage): string | null {
  try {
    const stored = storage.getItem(LAST_DOCUMENT_KEY);

    return isDocumentId(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Resolve which document to open, from a query string and a storage.
 *
 * Priority is URL first, then memory, then a fresh id. The middle step is the whole point of
 * this module:
 *
 * A bare URL used to mean "mint a brand new document", so two tabs opened at `/` resolved to
 * two different documents. Both tabs then reported "Synced" and one collaborator, because each
 * was correctly synchronising with a server that had never heard of the other tab. Nothing was
 * broken; the tabs were simply on different documents, which to anyone watching is
 * indistinguishable from collaboration being broken.
 *
 * A bare URL now means "the document this browser was last on", so opening the app twice shows
 * the same document twice. Starting a fresh document stays an explicit act, via the button.
 *
 * @param query the page's `location.search`, including the leading `?`.
 * @param storage where the last-opened document is remembered.
 * @param mint called only when neither the query nor memory supplies an id. Injected rather
 *   than imported so a test does not need a UUID implementation, and so "no id available" is
 *   an explicit branch rather than an assumption.
 */
export function resolveDocumentId(
  query: string,
  storage: DocumentTargetStorage,
  mint: () => string,
): string {
  const fromQuery = new URLSearchParams(query).get('doc');

  if (isDocumentId(fromQuery)) {
    return fromQuery;
  }

  return recallDocument(storage) ?? mint();
}
