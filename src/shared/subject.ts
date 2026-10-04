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
