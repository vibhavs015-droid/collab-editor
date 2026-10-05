/**
 * Building the URL a document is shared by.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * It is pure, and it was sitting in `main.ts`, which runs side effects on import - it
 * reads `window.location`, wires listeners and opens a document. A function worth testing
 * cannot live somewhere that can only be tested by loading the whole application into a
 * DOM, so it moved here.
 *
 * The bug this prevents is specific: `history.replaceState` replaces the WHOLE url. Writing
 * `?doc=<id>` and forgetting the fragment strips the key, which reopens the document
 * UNENCRYPTED - and the server then refuses it with a message about an encrypted document,
 * for a document the tab created moments ago. Every navigation here therefore carries
 * both halves, and these two functions are the only places that construct such a URL.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { keyFragment, type DocumentKey } from '../core/crypto/documentKey.js';

/**
 * Relative URL for a document, carrying the key when there is one.
 *
 * @param documentId the document to open.
 * @param key the document's key, or null for an unencrypted document.
 *
 * @returns a string suitable for `history.replaceState` and for copying to the clipboard.
 *   Relative rather than absolute so it works identically on `localhost` and on a
 *   deployed origin, with no configuration for either.
 */
export async function documentUrl(documentId: string, key: DocumentKey | null): Promise<string> {
  const base = `?doc=${encodeURIComponent(documentId)}`;

  return key === null ? base : `${base}${await keyFragment(key)}`;
}

/**
 * Absolute link to share, including the origin.
 *
 * Separate from {@link documentUrl} because the two are used in different places and
 * conflating them is how a share button ends up handing someone a relative URL that
 * resolves against whatever page they paste it into.
 *
 * @param origin `window.location.origin`, passed in rather than read from `window` so
 *   this stays a pure function.
 */
export async function shareLink(
  origin: string,
  documentId: string,
  key: DocumentKey | null,
): Promise<string> {
  return `${origin}/${await documentUrl(documentId, key)}`;
}

/**
 * The link to put on the clipboard, from a location-like object.
 *
 * For the current page this is just `window.location.href`, which already contains the
 * fragment. The function exists so the rule is stated once: for an ENCRYPTED document the
 * link IS the credential, so it must be copied with its fragment intact. Stripping the
 * fragment - which `URL.origin + pathname` would do - produces a link that looks valid
 * and cannot read anything.
 */
export function currentShareLink(location: { readonly href: string }): string {
  return location.href;
}
