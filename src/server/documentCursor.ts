/**
 * Opaque pagination cursors for the document list.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY A CURSOR AND NOT AN OFFSET
 * ---------------------------------------------------------------------------
 * The list is ordered by `updated_at DESC, id DESC`, and documents change while a user pages
 * through it. An offset would skip or repeat rows as that happens: inserting one document at the
 * front pushes everything down by one, so page two with `OFFSET 50` shows a row the user has
 * already seen. A cursor names a position in the ORDER rather than a distance from the start, so
 * it is unaffected by rows appearing before it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TIMESTAMP CARRIES MICROSECONDS
 * ---------------------------------------------------------------------------
 * `documents.updated_at` is a `timestamptz`, which Postgres stores at microsecond resolution, and
 * the column's own comment records that three sequential writes CAN share a timestamp on PGlite.
 *
 * So the cursor must round-trip at the column's precision. JavaScript's `Date` holds
 * *milliseconds*, and `toISOString()` truncates to them - a cursor built from a `Date` would round
 * two rows that differ at the 4th microsecond down to the same value, and the page boundary would
 * then either repeat one of them or skip it entirely. That is the same class of silent pagination
 * bug the ordering tiebreaker was added to fix, one level up.
 *
 * The timestamp therefore travels as the exact text Postgres produced, with its six fractional
 * digits, and is cast back to `timestamptz` for the comparison. Nothing round-trips through JS.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ENCODED AT ALL
 * ---------------------------------------------------------------------------
 * So the client cannot depend on the format, and so a malformed one is rejected rather than
 * interpolated. The contents are NOT a secret and must not be treated as an access control: they
 * are a timestamp and a document id, both of which a caller can already learn. Authorisation
 * lives in the SQL WHERE clause and is unaffected by what a cursor says.
 */

import { DOCUMENT_ID_PATTERN } from './documentIdPattern.js';

/**
 * One page boundary: the last row of the previous page.
 *
 * The next page is every visible document ordered strictly after this pair.
 */
export interface DocumentCursor {
  /** `updated_at` as Postgres wrote it, microseconds included. */
  readonly at: string;
  /** The id of the last row on the previous page, for the tiebreaker. */
  readonly id: string;
}

/**
 * Matches the exact shape Postgres emits: `YYYY-MM-DD HH:MM:SS.ffffffZ`.
 *
 * Deliberately strict. This is attacker-controlled input on its way into a SQL parameter, and a
 * loose check here would be the only thing between a hand-edited cursor and a query the author did
 * not intend. Rejecting anything that is not exactly a Postgres timestamp is the whole defence,
 * and it is cheap: the parameter is bound, never interpolated.
 *
 * The trailing `Z` is required, not optional. It is what makes the cast back to `timestamptz`
 * unambiguous: without it, `::timestamptz` reads the string in the server's session timezone, so a
 * cursor minted from a UTC wall time silently pointed somewhere else. See the tie test in
 * documentCursor.test.ts, which is what found it.
 */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

/**
 * Encode a boundary as an opaque URL-safe token.
 *
 * JSON rather than a delimiter-joined string, because a document id may legally contain any
 * character the id pattern allows, and `|` is not among the exclusions. A delimiter would make the
 * encoding's safety depend on a character that only happens to be absent.
 */
export function encodeDocumentCursor(cursor: DocumentCursor): string {
  return Buffer.from(JSON.stringify({ at: cursor.at, id: cursor.id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * Decode a token, or null when it is not one this server issued.
 *
 * Null rather than a thrown error, because "not a cursor" is an ordinary outcome for a client
 * holding a stale or hand-edited value, and the caller turns it into a 400 with a message that
 * says which.
 *
 * Never partially trusts the payload. Both fields are checked against their patterns, and the
 * object is checked for extra keys, so a cursor cannot smuggle anything past the shape check and
 * into a query built from it.
 */
export function decodeDocumentCursor(raw: string): DocumentCursor | null {
  // Length bound before decoding. base64 of a small JSON object is tens of bytes; a megabyte-long
  // cursor is a client bug or an attempt to make the server allocate, and either way is not a
  // cursor. 512 is generous for `{"at":"2026-01-01 00:00:00.000000","id":"<64 chars>"}`.
  if (raw.length === 0 || raw.length > 512) {
    return null;
  }

  let parsed: unknown;

  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const keys = Object.keys(parsed);

  if (keys.length !== 2 || !keys.includes('at') || !keys.includes('id')) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const at = record['at'];
  const id = record['id'];

  if (typeof at !== 'string' || !TIMESTAMP_PATTERN.test(at)) {
    return null;
  }

  if (typeof id !== 'string' || !DOCUMENT_ID_PATTERN.test(id)) {
    return null;
  }

  return { at, id };
}

/** Bounds T6 specifies for `limit`. */
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Validate a `limit` query parameter.
 *
 * @returns the page size, or null when the caller supplied something out of range. Out of range
 *   is a 400 rather than a silent clamp, because a client asking for 500 and being given 100
 *   cannot tell that its pagination is wrong.
 */
export function parsePageSize(raw: string | null): number | null {
  if (raw === null) {
    return DEFAULT_PAGE_SIZE;
  }

  // Reject anything that is not plain digits before Number(), so `1e2`, `0x10`, ` 5`, `5.0` and
  // `Infinity` are all refused rather than quietly accepted by JavaScript's coercion rules.
  if (!/^\d{1,9}$/u.test(raw)) {
    return null;
  }

  const value = Number(raw);

  if (value < MIN_PAGE_SIZE || value > MAX_PAGE_SIZE) {
    return null;
  }

  return value;
}
