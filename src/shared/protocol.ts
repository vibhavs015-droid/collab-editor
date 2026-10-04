/**
 * Sync protocol — transport envelope shared by client and server.
 *
 * Scope note: this file defines the *envelope* only — the shape of the
 * messages that cross the WebSocket boundary. It deliberately does NOT define
 * the CRDT operation types, because those are Phase 2 and guessing their API
 * now would mean rewriting this file the moment the CRDT design changes.
 *
 * Layering:
 *   envelope (this file)  → stable regardless of CRDT design
 *   operation payload     → Phase 2, added behind `Operation` below
 *
 * The envelope is validated at runtime because it crosses a network boundary.
 * TypeScript types are erased at runtime and provide no actual guarantee that
 * an inbound message is well-formed; `parseClientMessage` is what actually
 * protects the server.
 */

/**
 * Every JSON value.
 *
 * The index signature is READ-ONLY and permits `undefined`. That is deliberate:
 * a mutable `{ [key: string]: JsonValue }` cannot accept an interface like
 * `InsertOp`, because TypeScript does not infer index signatures for interfaces
 * and the interface has no mutation methods. A read-only signature accepts any
 * object whose properties are readable as JSON, which is exactly what an
 * operation sent over the wire is.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * An operation as it appears on the wire: opaque JSON.
 *
 * Deliberately NOT imported from src/core. The transport stays independent of the
 * CRDT so the two can be reasoned about separately (ADR-0004). Narrowing to a
 * real operation happens in operation-validation.ts, which is where a cast would
 * otherwise have been needed.
 */
export type Operation = JsonValue;

/** Wire protocol version. Bumped when the envelope shape changes. */
export const PROTOCOL_VERSION = 1;

// ── Client → Server ──────────────────────────────────────────────────────

export interface HelloMessage {
  readonly type: 'hello';
  readonly protocolVersion: number;
  /** Opaque session credential. Phase 5 replaces this with a real JWT. */
  readonly token: string;
  readonly documentId: string;
  /**
   * The highest operation clock this client has already applied.
   * Lets the server decide between sending a delta and a full snapshot.
   */
  readonly lastAppliedSeq: number;
}

export interface SubmitOpsMessage {
  readonly type: 'ops';
  readonly documentId: string;
  readonly ops: readonly Operation[];
}

export interface PresenceMessage {
  readonly type: 'presence';
  readonly documentId: string;
  /** Character offset of the local cursor, if the client has focus. */
  readonly cursor: number | null;
  readonly selectedLength: number;
}

export interface ResyncRequestMessage {
  readonly type: 'resync';
  readonly documentId: string;
  /**
   * Replay everything strictly after this sequence.
   *
   * Carried on the request rather than remembered per connection, because a client
   * may reconnect with a new socket while carrying state from the old one. A
   * server-side cache of cursors would silently lose that state on restart, which
   * is precisely the failure this design exists to prevent.
   */
  readonly sinceSeq: number;
}

export type ClientMessage =
  HelloMessage | SubmitOpsMessage | PresenceMessage | ResyncRequestMessage;

// ── Server → Client ──────────────────────────────────────────────────────

export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly protocolVersion: number;
  /** This client's replica identity for the session. */
  readonly site: string;
  readonly documentId: string;
  /**
   * Operations the client is missing, in sequence order.
   *
   * Sent on the first `hello` of a connection, so a client that has been offline
   * catches up in one frame. Operations the client already applied are never
   * resent: `lastAppliedSeq` is the cursor.
   */
  readonly snapshot: readonly Operation[];
  /** Sequence of the last operation in `snapshot`. Resume from here. */
  readonly seq: number;
}

export interface OpsMessage {
  readonly type: 'ops';
  readonly documentId: string;
  readonly ops: readonly Operation[];
}

/**
 * A baseline the client must adopt, because it is too far behind for a delta.
 *
 * Sent when the client's cursor is below the newest compaction snapshot, so the
 * operations it is missing no longer exist. Applying `ops` alone would produce a
 * document missing everything that was compacted away, and nothing would report an
 * error — the client would look alive and be quietly wrong.
 *
 * The client's obligation, and it is not optional:
 *
 *   1. Flush any unsent operations FIRST. A snapshot replaces the document, so
 *      anything the server has not seen yet would be discarded. That is data loss
 *      the user believes did not happen.
 *   2. REPLACE its replica rather than adding to it.
 *   3. Apply `ops`, which were recorded after the snapshot was taken.
 */
export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly documentId: string;
  /**
   * Live elements at `seq`, as JSON. An element, never a string: RGA anchors an
   * insert to the element its origin names, so a text-only baseline would leave
   * every subsequent operation unplaceable.
   */
  readonly elements: readonly JsonValue[];
  /** Operations recorded after the snapshot. Usually empty. */
  readonly ops: readonly Operation[];
  /** Cursor to resume from once the snapshot and `ops` are applied. */
  readonly seq: number;
}

export interface PresenceMessageServer {
  readonly type: 'presence';
  readonly documentId: string;
  /** Map of site → cursor offset for every connected client. */
  readonly cursors: Readonly<Record<string, number>>;
}

export interface SyncStateMessage {
  readonly type: 'syncState';
  readonly documentId: string;
  /** Authoritative connection state, so the UI can show a truthful banner. */
  readonly state: 'synced' | 'pending' | 'offline' | 'error';
  readonly pendingOps: number;
  /** Server's current sequence for this document, so the client can resume. */
  readonly seq: number;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly code:
    'BAD_MESSAGE' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'DOCUMENT_NOT_FOUND' | 'INTERNAL';
  readonly message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | OpsMessage
  | SnapshotMessage
  | PresenceMessageServer
  | SyncStateMessage
  | ErrorMessage;

// ── Runtime validation ───────────────────────────────────────────────────

const CLIENT_MESSAGE_TYPES = new Set(['hello', 'ops', 'presence', 'resync']);

/** Narrows an unknown value to an index-signature object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an inbound client message.
 *
 * This is the server's only real defence. Types are erased at runtime, so an
 * unvalidated `JSON.parse` result is effectively `any` — and a WebSocket accepts
 * a payload from anything that can reach the port. Assume hostile input, drop
 * anything unrecognised, and never let a malformed message reach the CRDT.
 *
 * Fields are extracted to locals and narrowed individually rather than guarded
 * in place. TypeScript cannot narrow `obj['key']` across a helper call, so
 * index-access-plus-guard forces casts; extract-then-narrow keeps the types
 * honest and needs no `as` at all.
 *
 * @param raw text frame received from the socket.
 * @returns the parsed message, or `null` if the frame is not a valid message.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const type = parsed['type'];
  if (typeof type !== 'string' || !CLIENT_MESSAGE_TYPES.has(type)) {
    return null;
  }

  const documentId = parsed['documentId'];

  switch (type) {
    case 'hello': {
      const protocolVersion = parsed['protocolVersion'];
      const token = parsed['token'];
      const lastAppliedSeq = parsed['lastAppliedSeq'];

      if (
        typeof documentId !== 'string' ||
        typeof token !== 'string' ||
        typeof protocolVersion !== 'number' ||
        !Number.isFinite(protocolVersion) ||
        typeof lastAppliedSeq !== 'number' ||
        !Number.isFinite(lastAppliedSeq) ||
        // A negative cursor is not "before the beginning of time", it is a client
        // bug. Accepting it would let a malformed value walk back through the
        // whole log one replay at a time.
        lastAppliedSeq < 0
      ) {
        return null;
      }

      return { type, protocolVersion, token, documentId, lastAppliedSeq };
    }

    case 'ops': {
      const ops = parsed['ops'];

      if (typeof documentId !== 'string' || !Array.isArray(ops)) {
        return null;
      }

      return { type, documentId, ops: ops as Operation[] };
    }

    case 'presence': {
      const cursor = parsed['cursor'];
      const selectedLength = parsed['selectedLength'];

      if (
        typeof documentId !== 'string' ||
        typeof selectedLength !== 'number' ||
        !Number.isFinite(selectedLength) ||
        // null is meaningful: it means the client lost focus. Absent is not.
        (cursor !== null && (typeof cursor !== 'number' || !Number.isFinite(cursor))) ||
        !('cursor' in parsed)
      ) {
        return null;
      }

      return { type, documentId, cursor, selectedLength };
    }

    case 'resync': {
      const sinceSeq = parsed['sinceSeq'];

      if (typeof documentId !== 'string') {
        return null;
      }

      // Required, not defaulted. A resync with no cursor would mean "send
      // everything", which is a valid question but never the one being asked, and
      // defaulting it would turn a client bug into an enormous catch-up.
      if (typeof sinceSeq !== 'number' || !Number.isFinite(sinceSeq) || sinceSeq < 0) {
        return null;
      }

      return { type, documentId, sinceSeq };
    }

    default:
      return null;
  }
}
