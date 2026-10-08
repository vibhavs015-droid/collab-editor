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

/**
 * Most operations a client puts in one `ops` or `ops-enc` frame.
 *
 * A client that has queued more than this sends several frames in order. One frame per
 * flush would be simpler, but then the largest legitimate frame grows with the length of
 * the offline session, and no frame-size limit on the server could be set that did not
 * eventually reject an honest client. Chunking is what makes MAX_FRAME_BYTES enforceable.
 *
 * Measured with 4-byte characters: about 163 KiB per frame as plaintext and about 386 KiB
 * encrypted.
 */
export const MAX_OPS_PER_FRAME = 1_000;

/**
 * Largest WebSocket message the relay will buffer, in bytes.
 *
 * Without an explicit limit the `ws` library accepts 100 MiB per message and the relay
 * parses it before it knows who sent it. Four MiB is more than twice the largest frame
 * any released client could produce (a full 5,000-operation outbox, encrypted, was about
 * 1.9 MiB) and about ten times a MAX_OPS_PER_FRAME chunk, so no honest client is refused.
 * The relay closes an oversized connection with code 1009.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

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
  /**
   * Optional server-to-client frames this client understands.
   *
   * The same opt-in idea as {@link BatchId}, for the same reason: a client that does not
   * recognise a message type falls through to its "unrecognised frame" handler, so sending an
   * unfamiliar frame is a user-visible error, not a no-op. An absent list means "send me
   * nothing the protocol did not already require", which is what a client from before
   * acknowledgements sent.
   *
   * `ack` is NOT listed here even though new clients support it. It is gated on the client
   * sending a `batchId` instead, because the id IS the thing being acknowledged - asking for one
   * is the opt-in, and it needs no separate declaration to go out of sync.
   */
  readonly capabilities?: readonly Capability[];
}

/** Server-to-client frames a client can declare support for in its `hello`. */
export type Capability = 'ping';

/** Every capability this server knows how to honour. Anything else is dropped on arrival. */
const KNOWN_CAPABILITIES: readonly Capability[] = ['ping'];

/**
 * The server's liveness check.
 *
 * `t` is a token the client must echo. Without it a `pong` that was delayed in a buffer for
 * three minutes would satisfy today's check, and the server would conclude a dead client is
 * alive - which is the exact failure this frame exists to catch. The token makes each pong
 * attributable to a specific ping.
 */
export interface PingMessage {
  readonly type: 'ping';
  readonly t: number;
}

/** The client's answer to a {@link PingMessage}. */
export interface PongMessage {
  readonly type: 'pong';
  /** Echoed verbatim from the ping being answered. */
  readonly t: number;
}

/**
 * Client-chosen identity for one outbound frame, used to acknowledge it.
 *
 * OPTIONAL, and that is the load-bearing word. A client that omits it gets exactly the
 * behaviour that shipped before acknowledgements existed, and never receives an `ack` - which is
 * what makes the whole feature additive rather than a version break. See ADR-0015.
 *
 * A string rather than a number because the value is chosen by the client and must be
 * recognisable after a reconnect, and because the relay treats it as opaque.
 */
export type BatchId = string;

export interface SubmitOpsMessage {
  readonly type: 'ops';
  readonly documentId: string;
  readonly ops: readonly Operation[];
  /** Omit to opt out of acknowledgement. See {@link BatchId}. */
  readonly batchId?: BatchId;
}

/**
 * An encrypted operation, exactly as it appears on the wire and at rest.
 *
 * Declared here rather than imported from `src/core/crypto` on purpose, and for the same
 * reason {@link Operation} is declared locally: the transport must not depend on the
 * CRDT or its crypto layer (ADR-0004). The server's entire job on a frame like this is to
 * check its SHAPE. It cannot check its contents, and pretending otherwise would be the
 * mistake.
 *
 * Duplication risk, stated rather than hidden: `EncryptedOperation` in
 * `src/core/crypto/envelope.ts` has the same fields. Two definitions of a wire shape is
 * a real cost, paid deliberately because sharing the type would make it look like the
 * server validated something it does not. `encryptedFrames.test.ts` asserts the two
 * shapes stay assignable to each other in both directions.
 */
export interface EncryptedOperationFrame {
  /** Envelope version. Must equal the client's; anything else is refused. */
  readonly v: number;
  /**
   * Cleartext element key, `i:<site>@<clock>` or `d:<site>@<clock>`.
   *
   * Cleartext so the server can dedupe without decrypting. The type is the first
   * character, which is why an insert and a delete of the same element need different
   * keys - otherwise the delete would look like a redelivered insert and the character
   * would survive its own deletion.
   */
  readonly key: string;
  readonly type: 'insert' | 'delete';
  /** Cleartext, so the causal-stability floor can be computed without decrypting. */
  readonly site: string;
  /** 12 bytes, base64url, never reused under one key. */
  readonly iv: string;
  /** AES-GCM ciphertext with its tag, base64url. */
  readonly ct: string;
}

/**
 * Encrypted operations on their way in.
 *
 * A separate message type rather than a flag on {@link SubmitOpsMessage}, so no code
 * path can handle `ops` and forget to handle `frames`. A message carrying either would
 * need every handler to branch, and one forgotten branch is a document that silently
 * stops syncing.
 */
export interface SubmitEncryptedOpsMessage {
  readonly type: 'ops-enc';
  readonly documentId: string;
  readonly frames: readonly EncryptedOperationFrame[];
  /** Omit to opt out of acknowledgement. See {@link BatchId}. */
  readonly batchId?: BatchId;
}

/**
 * The server has processed one outbound frame: it is durably stored, not merely received.
 *
 * ---------------------------------------------------------------------------
 * WHY "PROCESSED" AND NOT "RECEIVED"
 * ---------------------------------------------------------------------------
 * An acknowledgement that fires when the frame is read rather than when it is stored would fix
 * nothing. The failure T4 measures is precisely a frame the relay had in hand and then lost -
 * the process died between reading the socket and committing - and an ack sent on receipt would
 * tell the client its edit was safe at exactly that moment.
 *
 * So the relay sends this after the store has settled, and sends nothing at all if the store
 * failed. The client resends, which is safe because persistence is idempotent.
 *
 * Sent only in response to a frame that carried a {@link BatchId}, so a client from before this
 * message existed never sees a frame it does not understand. A client that does not recognise
 * `ack` calls its "unrecognised frame" handler, which would otherwise surface to the user as an
 * error on every keystroke.
 */
export interface AckMessage {
  readonly type: 'ack';
  readonly batchId: BatchId;
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
  | HelloMessage
  | SubmitOpsMessage
  | SubmitEncryptedOpsMessage
  | PresenceMessage
  | ResyncRequestMessage
  | PongMessage;

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

/**
 * Encrypted operations on their way out.
 *
 * The mirror of {@link SubmitEncryptedOpsMessage}, and separate for the same reason: a
 * client handling `ops` must not be handed `frames` by a union it silently ignores.
 */
export interface EncryptedOpsMessage {
  readonly type: 'ops-enc';
  readonly documentId: string;
  readonly frames: readonly EncryptedOperationFrame[];
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

/**
 * Why a request failed.
 *
 * Named rather than numeric, and a closed set, so a client can branch on the
 * reason instead of parsing a sentence. The wire protocol and the HTTP API share
 * it: the same condition produces the same code on both, which is what lets the
 * client handle one failure the same way regardless of transport.
 *
 * The two quota codes are here rather than being HTTP-only, because they are the ones a client
 * has to be able to REASON about rather than just display. `RATE_LIMITED` means "you are going
 * too fast; back off", which is actionable and transient. `DOCUMENT_TOO_LARGE` means "this
 * document cannot grow any further", which is permanent for that document but still leaves
 * deletion working. A client that cannot tell those two apart will retry the second forever.
 */
export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'DOCUMENT_NOT_FOUND'
  | 'DOCUMENT_TOO_LARGE'
  | 'TITLE_TOO_LONG'
  | 'INTERNAL';

export interface ErrorMessage {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | OpsMessage
  | EncryptedOpsMessage
  | SnapshotMessage
  | PresenceMessageServer
  | SyncStateMessage
  | AckMessage
  | PingMessage
  | ErrorMessage;

// ── Runtime validation ───────────────────────────────────────────────────

const CLIENT_MESSAGE_TYPES = new Set(['hello', 'ops', 'ops-enc', 'presence', 'resync', 'pong']);

/**
 * Envelope version the server speaks.
 *
 * Duplicated from `src/core/crypto/envelope.ts` for the same reason as
 * {@link EncryptedOperationFrame}: the transport does not depend on the crypto layer.
 * Checked here so a frame from a newer client is refused at the edge with a clear reason
 * instead of being stored and failing to decrypt months later.
 */
const SUPPORTED_ENVELOPE_VERSION = 1;

/** base64url, unpadded. */
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/**
 * Largest ciphertext accepted, in base64url characters.
 *
 * 1 MiB of base64url is roughly 750 KiB of plaintext, which is far larger than any single
 * operation this application produces - a keystroke, or one paste. It exists because this
 * string becomes a database row and a metric label, and an unbounded one from a hostile
 * client is a very cheap way to fill a disk.
 *
 * Not a defence against a determined attacker on its own: a thousand legal-looking 1 MiB
 * frames is still a gigabyte. It is one bound among several, and the honest description
 * is "silly values are refused", not "the server is protected from large messages".
 */
const MAX_CIPHERTEXT_CHARS = 1_048_576;

/**
 * Element key shape, `i:<site>@<clock>` or `d:<site>@<clock>`.
 *
 * Bounded because this string becomes a database primary-key component and is echoed in
 * metrics. An unbounded site name from a hostile client would be a very cheap way to
 * store megabytes per operation.
 */
const ELEMENT_KEY_PATTERN = /^[id]:[A-Za-z0-9_-]{1,64}@[0-9]{1,19}$/u;

/** Narrows an unknown value to an index-signature object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one encrypted frame's shape.
 *
 * This is the server's ONLY check on an encrypted frame, and it is worth being precise
 * about what that means: the server can confirm the frame is shaped like a frame and
 * nothing more. It cannot confirm the ciphertext decrypts, that it decrypts to an
 * operation belonging to the claimed element key, or that two clients will agree on what
 * it says.
 *
 * Those checks belong to the clients that hold the key, and they are real: a client that
 * receives a frame it cannot decrypt reports it rather than applying it. What the server
 * owes is that such a frame does not corrupt storage or impersonate a different element.
 *
 * @returns the frame, or null if it is not shaped like one.
 */
export function parseEncryptedFrame(raw: unknown): EncryptedOperationFrame | null {
  if (!isRecord(raw)) {
    return null;
  }

  const version = raw['v'];
  const key = raw['key'];
  const type = raw['type'];
  const site = raw['site'];
  const iv = raw['iv'];
  const ct = raw['ct'];

  if (typeof version !== 'number' || version !== SUPPORTED_ENVELOPE_VERSION) {
    return null;
  }

  if (typeof key !== 'string' || !ELEMENT_KEY_PATTERN.test(key)) {
    return null;
  }

  if (type !== 'insert' && type !== 'delete') {
    return null;
  }

  // The key's prefix IS the type: `i` for insert, `d` for delete. A frame whose two
  // disagree would be deduplicated against the wrong row, so it is refused here rather
  // than trusted.
  //
  // The prefix is the single letter, NOT the word. An earlier version compared against
  // `'insert:'`, which never matches a key that begins `i:` - so every frame was
  // rejected, and the tests that exercised this function all failed in a way that looked
  // like a bad fixture rather than a bad comparison.
  const prefix = type === 'insert' ? 'i' : 'd';

  if (!key.startsWith(`${prefix}:`)) {
    return null;
  }

  if (typeof site !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(site)) {
    return null;
  }

  // The site must match the one inside the key, or the causal-stability floor would be
  // computed against a different participant than the one that wrote the operation.
  if (!key.startsWith(`${prefix}:${site}@`)) {
    return null;
  }

  // Exactly 12 bytes is 16 base64url characters, which is what AES-GCM requires. Checked
  // as a length because the server cannot decode and re-measure the nonce meaningfully,
  // and a wrong-length nonce would fail on every client instead of here.
  if (typeof iv !== 'string' || !BASE64URL.test(iv) || iv.length !== 16) {
    return null;
  }

  // Ciphertext: base64url, and long enough to hold a GCM tag. The floor is deliberately
  // low - an empty insert is a legal operation - but a frame below a tag's worth of bytes
  // cannot be valid ciphertext at all. The ceiling bounds what one frame can cost.
  if (
    typeof ct !== 'string' ||
    !BASE64URL.test(ct) ||
    ct.length < 22 ||
    ct.length > MAX_CIPHERTEXT_CHARS
  ) {
    return null;
  }

  return { v: version, key, type, site, iv, ct };
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
      const capabilities = parsed['capabilities'];

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

      // Optional, but every element has to be a known capability. An unrecognised one is
      // dropped rather than refused: a newer client may declare capabilities this server does
      // not implement, and refusing the handshake over that would make the two versions
      // incompatible rather than merely less capable. This is the same rule as `batchId` -
      // accept the shape, keep only what is understood.
      const known = KNOWN_CAPABILITIES.filter((capability) =>
        Array.isArray(capabilities) ? capabilities.includes(capability) : false,
      );

      return known.length > 0
        ? { type, protocolVersion, token, documentId, lastAppliedSeq, capabilities: known }
        : { type, protocolVersion, token, documentId, lastAppliedSeq };
    }

    case 'pong': {
      const t = parsed['t'];

      // A `pong` the client cannot be matched to a `ping` is not a liveness signal, so an
      // unparseable one is refused rather than treated as an answer.
      if (typeof t !== 'number' || !Number.isFinite(t)) {
        return null;
      }

      return { type, t };
    }

    case 'ops': {
      const ops = parsed['ops'];
      const batchId = parsed['batchId'];

      if (typeof documentId !== 'string' || !Array.isArray(ops)) {
        return null;
      }

      // Optional, but if it is present it must be a string. A number, or an object, would be
      // echoed back verbatim in the `ack`, so the type has to be checked rather than trusted -
      // and the length is bounded because the relay stores nothing but does echo it.
      if (batchId !== undefined && (typeof batchId !== 'string' || batchId.length > 128)) {
        return null;
      }

      return batchId === undefined
        ? { type, documentId, ops: ops as Operation[] }
        : { type, documentId, ops: ops as Operation[], batchId };
    }

    case 'ops-enc': {
      const frames = parsed['frames'];
      const batchId = parsed['batchId'];

      if (typeof documentId !== 'string' || !Array.isArray(frames)) {
        return null;
      }

      if (batchId !== undefined && (typeof batchId !== 'string' || batchId.length > 128)) {
        return null;
      }

      const validated: EncryptedOperationFrame[] = [];

      for (const raw of frames) {
        const frame = parseEncryptedFrame(raw);

        // All-or-nothing. Dropping only the bad frames would apply half a keystroke
        // batch and leave the document in a state nobody typed, with no record that
        // anything was rejected. A frame this client cannot use makes the whole message
        // unusable, so the whole message goes.
        if (frame === null) {
          return null;
        }

        validated.push(frame);
      }

      return batchId === undefined
        ? { type, documentId, frames: validated }
        : { type, documentId, frames: validated, batchId };
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
