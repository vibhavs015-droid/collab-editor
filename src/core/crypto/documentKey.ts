/**
 * Document keys, and how they travel in a URL fragment.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FRAGMENT
 * ---------------------------------------------------------------------------
 * The fragment is the part of a URL after `#`, and browsers do not send it in the HTTP
 * request. It is not in the request line, not in a header, and not in `Referer` when
 * navigating from this page.
 *
 * That means a server *cannot* be handed the key, rather than being trusted not to read
 * it. Nothing to subpoena, nothing to configure, nothing for a future operator change to
 * leak. Every other option - a header, a query parameter, a key stored server-side - is
 * something the server has.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KEY IS RAW RANDOM BYTES AND NOT A PASSWORD
 * ---------------------------------------------------------------------------
 * This is not a password, so there is no human to choose it and nothing to guess. A
 * 32-byte key from `crypto.getRandomValues` is the full security of the document, and it
 * is the only input to key derivation. Deriving from a passphrase would add a wordlist
 * attack that a random key simply does not have.
 *
 * The cost is that a key cannot be remembered, only copied. A lost link is a lost
 * document. ADR-0014 records that as an accepted consequence rather than hiding it.
 *
 * ---------------------------------------------------------------------------
 * WHY base64url AND NOT base64
 * ---------------------------------------------------------------------------
 * The key sits inside a URL. Standard base64 uses `+`, `/` and `=`, all of which either
 * change the URL's meaning or need escaping in a fragment. base64url is URL-safe by
 * construction.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

/** Parameter name in the fragment. Short, because links get pasted into chats. */
export const KEY_FRAGMENT_PARAM = 'k';

/** AES-GCM key length in bytes. */
export const DOCUMENT_KEY_BYTES = 32;

/** AES-GCM nonce length in bytes, fixed by the specification at 96 bits. */
export const NONCE_BYTES = 12;

export class DocumentKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentKeyError';
  }
}

/**
 * Base64url encode, without padding.
 *
 * Implemented rather than pulled from a library because `btoa` is unavailable in Node
 * and `Buffer` is unavailable in the browser, and this runs in both.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  // btoa is present in browsers and in Node 16+, so this covers both without a shim.
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Inverse of {@link toBase64Url}. */
export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const withPadding = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=');

  let binary: string;

  try {
    binary = atob(withPadding);
  } catch {
    throw new DocumentKeyError('The key in the link is not valid base64url.');
  }

  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * A document key.
 *
 * Wraps a `CryptoKey` so it cannot be confused with a JWT signing key or any other
 * secret in the process, and so a non-key cannot be passed where one is expected.
 */
export interface DocumentKey {
  /** AES-GCM. `encrypt`/`decrypt` only; the key is never extractable from here. */
  readonly cryptoKey: CryptoKey;
}

/** WebCrypto, or a clear error rather than a confusing `undefined is not a function`. */
function webCrypto(): Crypto {
  if (typeof globalThis.crypto === 'undefined' || globalThis.crypto.subtle === undefined) {
    throw new DocumentKeyError(
      'WebCrypto is unavailable. Document encryption needs https, or Node 22 or newer.',
    );
  }

  return globalThis.crypto;
}

/**
 * AES-GCM parameters, in one place.
 *
 * The `length: 256` is stated rather than inferred because `generateKey` accepts 128,
 * 192 and 256, and the default is not 256. Getting that wrong would quietly halve the
 * security of every document.
 */
const AES_PARAMS: AesKeyGenParams = { name: 'AES-GCM', length: 256 };

/** A fresh random key for a new document. */
export async function generateDocumentKey(): Promise<DocumentKey> {
  const cryptoKey = await webCrypto().subtle.generateKey(AES_PARAMS, true, ['encrypt', 'decrypt']);

  return { cryptoKey };
}

/**
 * Import raw key bytes.
 *
 * @throws DocumentKeyError when the length is wrong. Importing a 16-byte key would
 *   succeed and produce AES-128, which is a silent downgrade rather than an error.
 */
export async function importDocumentKey(raw: Uint8Array): Promise<DocumentKey> {
  if (raw.length !== DOCUMENT_KEY_BYTES) {
    throw new DocumentKeyError(
      `A document key is ${DOCUMENT_KEY_BYTES} bytes; this one is ${raw.length}.`,
    );
  }

  const cryptoKey = await webCrypto().subtle.importKey(
    'raw',
    raw as unknown as BufferSource,
    AES_PARAMS,
    true,
    ['encrypt', 'decrypt'],
  );

  return { cryptoKey };
}

/**
 * Export the raw bytes, for putting in a link.
 *
 * Requires the key to be extractable, which is why `generateDocumentKey` and
 * `importDocumentKey` both pass `true`. The key lives in a URL the user can copy, so
 * extractability is the point; a non-extractable key would be more secure and useless.
 */
export async function exportDocumentKey(key: DocumentKey): Promise<Uint8Array> {
  const raw = await webCrypto().subtle.exportKey('raw', key.cryptoKey);

  return new Uint8Array(raw);
}

/**
 * The value to put in the fragment.
 *
 * @returns the raw key encoded, not a full fragment, so callers can build whatever
 *   fragment shape they need without parsing one back apart.
 */
export async function encodeKeyForFragment(key: DocumentKey): Promise<string> {
  return toBase64Url(await exportDocumentKey(key));
}

/**
 * Build the fragment for a share link.
 *
 * Separate from {@link encodeKeyForFragment} because "the key" and "the whole fragment"
 * are different things, and a caller that needs both should not hand-assemble the
 * `#k=` prefix and hope it matches the parser.
 */
export async function keyFragment(key: DocumentKey): Promise<string> {
  return `#${KEY_FRAGMENT_PARAM}=${await encodeKeyForFragment(key)}`;
}

/**
 * Read a key out of a URL fragment.
 *
 * @returns null when there is no key parameter. That is the "this document is not
 *   encrypted" answer, and it is a normal outcome rather than an error - a link without a
 *   fragment is how an unencrypted document is opened.
 * @throws DocumentKeyError when a key IS present but unusable, because silently
 *   treating a broken key as "no key" would serve a caller ciphertext it cannot read.
 */
export async function readKeyFromFragment(fragment: string): Promise<DocumentKey | null> {
  // Tolerate a leading '#', so callers can pass `location.hash` unmodified.
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;

  if (raw === '') {
    return null;
  }

  const params = new URLSearchParams(raw);
  const encoded = params.get(KEY_FRAGMENT_PARAM);

  if (encoded === null || encoded === '') {
    // Other fragment parameters are not an error; they may belong to client routing.
    return null;
  }

  return importDocumentKey(fromBase64Url(encoded));
}

/** Whether a fragment carries a document key. */
export function hasKeyInFragment(fragment: string): boolean {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;

  if (raw === '') {
    return false;
  }

  const encoded = new URLSearchParams(raw).get(KEY_FRAGMENT_PARAM);

  return encoded !== null && encoded !== '';
}

/**
 * A key for tests, derived from a fixed label.
 *
 * Deterministic on purpose: a test that needs a key twice needs the same one both times,
 * or an assertion about "the wrong key" could accidentally use the right one.
 *
 * **Not for development data you care about.** It is derived from a public label through
 * SHA-256 with no secret, so anyone who knows the label knows the key.
 */
export async function testDocumentKey(label = 'collab-editor-test'): Promise<DocumentKey> {
  const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(label);
  const digest = await webCrypto().subtle.digest('SHA-256', bytes);

  return importDocumentKey(new Uint8Array(digest));
}
