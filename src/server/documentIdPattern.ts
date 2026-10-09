/**
 * The one definition of what a document id may contain.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * Shared rather than repeated, because this pattern is a validation rule and a rule that exists in
 * two places is a rule that will be tightened in one of them. Both the request handlers that
 * accept an id from a client and the pagination cursor, which carries one, must agree exactly on
 * what an id looks like.
 *
 * Kept in its own module so that the cursor can validate without importing the API server, which
 * would drag the whole request pipeline in behind it and risk an import cycle.
 */

/**
 * 1 to 64 characters of ASCII letters, digits, underscore and hyphen.
 *
 * Underscore and hyphen rather than nothing, because these ids appear in a URL path and in
 * localStorage, and a wider alphabet would need escaping in one of them. No dots, slashes or
 * colons, so an id can never be mistaken for a path segment or a scheme.
 */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
