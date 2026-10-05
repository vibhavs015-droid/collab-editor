/**
 * What a subject is.
 *
 * One rule, in one place, used by both the token verifier and the database layer.
 *
 * It lives here rather than in auth.ts because it is not an authentication concern.
 * A subject reaches a database key and a collaborator list as well as a token
 * claim, and validating it only on the token path leaves the other two open to
 * whatever text a caller sends.
 *
 * NOTE ON ENCODING: ASCII only. See the note at the top of src/core/crdt/rga.ts.
 */

/**
 * The shape a subject must have.
 *
 * Conservative on purpose. A subject is an opaque identifier that gets compared for
 * equality, stored in a primary key, and eventually rendered next to a document.
 * Nothing about it needs to look like anything, so nothing is allowed to.
 *
 * Excludes whitespace, quotes, semicolons and non-ASCII. Not because a
 * parameterised query would be defeated by them -- it would not -- but because a
 * value that reaches a primary key should not need a second layer of defence, and
 * one that reaches the DOM should not be able to carry markup.
 */
export const SUBJECT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

/** Longest acceptable subject. Matches the pattern, named for readable messages. */
export const MAX_SUBJECT_LENGTH = 128;

export function isValidSubject(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT_PATTERN.test(value);
}

/** Message shared by every rejection, so the client sees one explanation. */
export const SUBJECT_RULE_MESSAGE =
  'Subject must be 1-128 characters of A-Z, a-z, 0-9, underscore, dot, colon or hyphen.';

/** Generate a fresh, unguessable subject. */
export function newSubject(): string {
  // 128 bits, base64url. A subject is an identifier, not a secret, so this does not need to
  // be a UUID; it needs to be collision-free and unguessable enough that guessing one is not
  // an attack.
  //
  // WEB CRYPTO, NOT `node:crypto`, and that is not a style preference.
  //
  // This function used `randomBytes` from `node:crypto`, which is correct on the server and
  // silently broken in the browser: Vite replaces `node:crypto` with an empty stub for the
  // client bundle, so the call throws `randomBytes is not a function`. The browser code that
  // called it caught the TypeError and fell back, so durable identity was quietly OFF in the
  // one environment it exists for - and 901 tests passed, because every one of them ran under
  // Node where `node:crypto` works.
  //
  // `globalThis.crypto.getRandomValues` exists in both: browsers have had it for years, and
  // Node has had a global Web Crypto since v19. One implementation, no bundler stub, no
  // environment branch. `btoa` is likewise global in both.
  //
  // The lesson generalises past this function: SHARED code must not import a Node builtin the
  // browser bundle stubs, and the failure is invisible until it runs in a browser. See
  // shared/browserSafety.test.ts, which now asserts it mechanically.
  const bytes = new Uint8Array(16);

  globalThis.crypto.getRandomValues(bytes);

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
