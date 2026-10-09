/**
 * Runtime validation for CRDT operations.
 *
 * -- Why this file exists --------------------------------------------------
 * ADR-0004 established the split: the transport validates the message envelope,
 * the CRDT validates operations. But that left a gap. Operations arrive as
 * `JsonValue` because the wire format knows nothing about their structure, and
 * casting them to `Operation` with `as` is a lie TypeScript correctly refuses.
 *
 * This is the missing second half of that split: real type guards that narrow
 * unknown data to `Operation`, so nothing downstream has to pretend.
 *
 * -- Why the guards take `unknown` ------------------------------------------
 * Not `JsonValue`. `Operation` is an interface, so it has no index signature and
 * is not assignable to `JsonValue`; a predicate returning `Operation` could not
 * narrow a `JsonValue` parameter. Accepting `unknown` is also the honest model
 * for genuinely untrusted input: `JSON.parse` returns `any`, and a frame from
 * the network is not JSON-typed data in any meaningful sense.
 *
 * -- What it rejects -------------------------------------------------------
 * Everything a hostile or buggy peer could send:
 * - wrong `type` discriminator
 * - missing or malformed `site` / `clock` on an element id
 * - a negative or non-finite clock
 * - a malformed `origin`
 * - a `value` that is not exactly one character
 * - a `target` that is not an element id
 *
 * A partially-shaped object is the dangerous case. `{ type: 'insert', id: {} }`
 * survives a naive `Array.isArray` check and then breaks deep inside the CRDT,
 * where the stack trace points at merge logic instead of at the bad frame.
 */

import type { ElementId } from '../core/clock.js';
import type { DeleteOp, InsertOp, Operation } from '../core/crdt/rga.js';
import type { JsonValue } from './protocol.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clock must be a non-negative integer. Both JSON and Postgres allow junk here. */
function isClock(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate an element id.
 *
 * `site` must be non-empty and `clock` a non-negative integer. Both matter: an
 * empty site would collide with every other empty site, and a negative clock
 * breaks the monotonic ordering the whole CRDT depends on.
 */
function isElementId(value: unknown): value is { site: string; clock: number } {
  return (
    isRecord(value) &&
    typeof value['site'] === 'string' &&
    value['site'].length > 0 &&
    isClock(value['clock'])
  );
}

/**
 * Validate an insert operation.
 *
 * `origin` is `null` (document start) or a valid element id. Anything else is
 * rejected, because guessing a position would silently misplace text.
 *
 * `value` must be exactly one character. The CRDT treats each element as atomic,
 * and a multi-character value would break the one-anchor-per-character chaining
 * that keeps typed order intact.
 */
function isInsertOp(value: unknown): value is InsertOp {
  if (!isRecord(value) || value['type'] !== 'insert') {
    return false;
  }

  if (!isElementId(value['id'])) {
    return false;
  }

  const origin = value['origin'];
  if (origin !== null && !isElementId(origin)) {
    return false;
  }

  const text = value['value'];
  if (typeof text !== 'string') {
    return false;
  }

  // Count code points, not UTF-16 units, so one emoji counts as one character.
  return [...text].length === 1;
}

/** Validate a delete operation. */
function isDeleteOp(value: unknown): value is DeleteOp {
  return isRecord(value) && value['type'] === 'delete' && isElementId(value['target']);
}

/** True when `value` is a well-formed operation. */
export function isOperation(value: unknown): value is Operation {
  return isInsertOp(value) || isDeleteOp(value);
}

/**
 * Narrow a batch of untrusted values to operations, dropping anything invalid.
 *
 * Dropping rather than throwing is deliberate at this boundary: one malformed
 * operation must not discard a batch that also contains valid ones, and a client
 * cannot reject a batch it never receives.
 *
 * @returns the valid operations, in their original order.
 */
export function parseOperations(ops: readonly JsonValue[]): Operation[] {
  const parsed: Operation[] = [];

  for (const op of ops) {
    if (isOperation(op)) {
      parsed.push(op);
    }
  }

  return parsed;
}

/**
 * Narrow an element id for use as a CRDT anchor.
 *
 * Present so callers holding untrusted id-shaped data can obtain a typed one
 * without a cast.
 */
export function parseElementId(value: unknown): ElementId | null {
  return isElementId(value) ? { site: value.site, clock: value.clock } : null;
}
