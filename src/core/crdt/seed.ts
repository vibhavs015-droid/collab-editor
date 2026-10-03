/**
 * Turning a plain string into CRDT operations.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * A CRDT replica can only apply operations; it cannot "load text". Every path
 * that starts from plain text needs the same deterministic conversion:
 *
 *   - a document created before the operation log existed, backfilled at boot
 *   - a document created by the HTTP API, which takes text rather than ops
 *   - a test that wants a known starting document
 *
 * ── Why determinism matters ────────────────────────────────────────────────
 * The conversion must produce the SAME element IDs for the same text every time
 * it runs, on any machine, in any order. Two clients that independently convert
 * the same initial text must converge, not produce the text twice. That means:
 *
 *   - the site id is derived from the content, not generated
 *   - clocks are assigned in document order, starting from 1
 *
 * A fresh `RgaDocument(site)` already satisfies both, because its clock starts
 * at zero and increments per insertion. Routing through it rather than
 * hand-rolling the loop is what guarantees the two never drift apart.
 *
 * ASCII only. See the encoding note in rga.ts.
 */

import type { SiteId } from '../clock.js';
import { RgaDocument } from './rga.js';
import type { InsertOp } from './rga.js';

/**
 * Operations that insert a document's initial text.
 *
 * @param documentId the document the text belongs to. The seed site is derived
 *   from it rather than passed in, because that derivation is the whole safety
 *   property: two callers must never convert two batches of text under the same
 *   site, or the second batch's clocks would collide with the first's and its
 *   characters would be discarded as duplicates.
 * @returns an empty array for empty text, so callers can treat "no operations"
 *   and "empty document" as the same case without a special branch.
 */
export function initialOperations(documentId: string, text: string): InsertOp[] {
  if (text === '') {
    return [];
  }

  return new RgaDocument(seedSiteFor(documentId)).insertAt(0, text);
}

/**
 * Deterministic site id for text that predates the operation log.
 *
 * A content hash would be the obvious choice, and it is wrong here: two different
 * documents with identical bodies would then share element IDs, and a client
 * moving between them would see the second document's text appear in the first.
 * Keying on the document id keeps every document's seed space separate.
 *
 * FNV-1a rather than a cryptographic hash because this needs to be short,
 * deterministic, and dependency-free. Collisions across document ids are
 * harmless in practice: a collision would let two documents share a seed site,
 * and the server, which is the only writer, still sequences them separately.
 */
export function seedSiteFor(documentId: string): SiteId {
  return `seed-${fnv1a(documentId).toString(36)}`;
}

/** 32-bit FNV-1a. Not cryptographic; see the note above. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    // charCodeAt, not codePointAt: site ids are ASCII document ids, and mixing
    // surrogate halves would make the result depend on encoding.
    hash ^= input.charCodeAt(index);
    // 16777619 = FNV prime. Math.imul keeps the multiply in 32 bits; the plain
    // `*` operator would produce a float and silently lose the top bits.
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}
