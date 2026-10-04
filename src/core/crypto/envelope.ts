/**
 * Encrypting one operation, and putting it back.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT ENCRYPTED
 * ---------------------------------------------------------------------------
 * Encrypted: the operation's payload - which characters, where they anchor, what they
 * delete. That is the document.
 *
 * Not encrypted: the operation TYPE, the element key `(site, clock)`, and therefore the
 * number of operations and which site made them.
 *
 * The type cannot be encrypted usefully. The server deduplicates on element key, and the
 * key's prefix *is* the type (`i:` or `d:`). Hiding it would mean the server could no
 * longer dedupe, and `i:site@3` versus `d:site@3` leaks that a character was created and
 * later removed - which is a fact about operation counts that the server already has.
 *
 * ---------------------------------------------------------------------------
 * WHY ADDITIONAL AUTHENTICATED DATA, AND WHAT IT PREVENTS
 * ---------------------------------------------------------------------------
 * AES-GCM authenticates the ciphertext against its AAD. If the AAD is empty, a valid
 * ciphertext is valid *anywhere*: move it to another document and it decrypts, because
 * the key is per document and nothing ties the frame to a document.
 *
 * So the AAD is `documentId | elementKey | type | site`. That binds:
 *
 *   - **The document.** A frame lifted from one document into another fails to
 *     authenticate, instead of quietly appearing in a document its author never wrote.
 *   - **The element key and type.** An insert frame replayed as a delete fails. Without
 *     this, the two have different plaintext lengths, so the *shape* would usually betray
 *     it, but "usually" is not a security property.
 *   - **The site.** The site is derivable from the element key, so it is redundant data -
 *     and redundant data that is not authenticated is exactly the kind a substitution
 *     attack goes for. Binding it turns "the server attributes this operation to the
 *     wrong participant" from possible into a failed decryption.
 *
 * The AAD is not secret. It is authenticated, which is a different and sufficient thing:
 * an attacker who alters it cannot produce a frame that verifies.
 *
 * ---------------------------------------------------------------------------
 * THE NONCE BOUND
 * ---------------------------------------------------------------------------
 * One random 96-bit nonce per operation, under one document key. Reusing a nonce under
 * AES-GCM leaks the XOR of two plaintexts and, worse, the authentication subkey - which
 * makes forgery trivial for anyone holding one pair.
 *
 * Random nonces are safe until two collide, which for 96 bits is the birthday bound at
 * roughly 2^32 operations under a single key. At the load suite's ~1,500 operations per
 * second that is over a document-year.
 *
 * A counter would be stronger, and is NOT available: several sites hold the same document
 * key and their counters are unrelated, so there is no shared counter to increment.
 * Randomness is the reason this scheme is safe at all, not a shortcut past one.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import type { Operation } from '../crdt/rga.js';
import { DOCUMENT_KEY_BYTES, NONCE_BYTES, type DocumentKey } from './documentKey.js';

/**
 * Envelope version.
 *
 * Present because the frame is stored durably and re-read months later. A format change
 * has to be distinguishable from corruption, and a stored blob with no version cannot
 * tell you which.
 */
export const ENVELOPE_VERSION = 1;

export class DecryptionError extends Error {
  /** Why it failed, for a message a user can act on. */
  readonly reason: 'wrong-key' | 'corrupt' | 'malformed';

  constructor(reason: 'wrong-key' | 'corrupt' | 'malformed', message: string) {
    super(message);
    this.name = 'DecryptionError';
    this.reason = reason;
  }
}

/**
 * An encrypted operation on the wire and at rest.
 *
 * Every field is required. A partial frame is refused rather than defaulted, because a
 * missing nonce or IV would mean reusing a previous one - the exact failure the design
 * above exists to prevent.
 */
export interface EncryptedOperation {
  /** {@link ENVELOPE_VERSION}. */
  readonly v: number;
  /** `i:<site>@<clock>` or `d:<site>@<clock>`. Cleartext, and deduplicated on. */
  readonly key: string;
  /** Which operation type, inferred from `key`. Cleartext. */
  readonly type: 'insert' | 'delete';
  /** Which site issued it. Cleartext. */
  readonly site: string;
  /** 12 bytes, base64url. Never reused under one key. */
  readonly iv: string;
  /** base64url. AES-GCM ciphertext with its tag. */
  readonly ct: string;
}

/**
 * The cleartext key for an operation.
 *
 * Shares its format with the server's dedupe key on purpose: two functions deriving the
 * same string from the same operation would be a place for them to disagree, and a
 * disagreement means a silently dropped insert or delete.
 */
export function elementKeyOf(op: Operation): string {
  const id = op.type === 'insert' ? op.id : op.target;

  return `${op.type === 'insert' ? 'i' : 'd'}:${id.site}@${id.clock}`;
}

/**
 * AAD binding a frame to its document, element key, type and site.
 *
 * Every cleartext field is included. A field present in the frame but absent from the AAD
 * is a field an attacker can substitute, and the `site` field was originally exactly
 * that: redundant with the element key, and therefore unattached to the ciphertext until
 * a test caught it.
 */
function additionalData(
  documentId: string,
  key: string,
  type: 'insert' | 'delete',
  site: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `collab-editor:v${ENVELOPE_VERSION}|${documentId}|${key}|${type}|${site}`,
  );
}

/**
 * Encrypt one operation.
 *
 * One operation per call, never a batch. A batch would be smaller on the wire, and it
 * would also mean one nonce covering several operations - so a single byte of damage
 * loses the whole batch, and the frame stops being individually retryable.
 */
export async function encryptOperation(
  key: DocumentKey,
  documentId: string,
  op: Operation,
): Promise<EncryptedOperation> {
  const crypto = globalThis.crypto;
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const elementKey = elementKeyOf(op);

  const plaintext: Uint8Array<ArrayBuffer> = new TextEncoder().encode(JSON.stringify(op));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: additionalData(
        documentId,
        elementKey,
        op.type,
        op.type === 'insert' ? op.id.site : op.target.site,
      ),
    },
    key.cryptoKey,
    plaintext,
  );

  return {
    v: ENVELOPE_VERSION,
    key: elementKey,
    type: op.type,
    site: op.type === 'insert' ? op.id.site : op.target.site,
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

/** Encrypt many, preserving order. Individual failures are reported, not swallowed. */
export async function encryptOperations(
  key: DocumentKey,
  documentId: string,
  ops: readonly Operation[],
): Promise<EncryptedOperation[]> {
  const out: EncryptedOperation[] = [];

  for (const op of ops) {
    out.push(await encryptOperation(key, documentId, op));
  }

  return out;
}

/**
 * Decrypt one operation.
 *
 * @throws DecryptionError with a `reason` the caller can turn into a message. AES-GCM
 *   cannot distinguish "wrong key" from "tampered ciphertext" - both are an
 *   authentication failure - so `wrong-key` is a *likelihood*, not a fact. The
 *   distinction matters because the overwhelmingly common cause is someone opening a
 *   shared link without its key, and that is worth saying plainly.
 */
export async function decryptOperation(
  key: DocumentKey,
  documentId: string,
  frame: EncryptedOperation,
): Promise<Operation> {
  if (frame.v !== ENVELOPE_VERSION) {
    throw new DecryptionError(
      'malformed',
      `Encrypted operation version ${frame.v} is not supported; this client speaks ${ENVELOPE_VERSION}.`,
    );
  }

  if (typeof frame.iv !== 'string' || typeof frame.ct !== 'string') {
    throw new DecryptionError('malformed', 'Encrypted operation is missing its iv or ciphertext.');
  }

  // base64UrlToBytes throws DecryptionError('corrupt') on malformed input, so this needs
  // no wrapper: a bad encoding is already classified.
  const iv = base64UrlToBytes(frame.iv);
  const ciphertext = base64UrlToBytes(frame.ct);

  if (iv.length !== NONCE_BYTES) {
    throw new DecryptionError(
      'corrupt',
      `Encrypted operation has a ${iv.length}-byte nonce; ${NONCE_BYTES} expected.`,
    );
  }

  let plaintext: ArrayBuffer;

  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: additionalData(documentId, frame.key, frame.type, frame.site),
      },
      key.cryptoKey,
      ciphertext,
    );
  } catch {
    // Deliberately not distinguishing wrong-key from tampering. Reporting which one it
    // was would be an oracle, and both produce the same message for the user anyway.
    throw new DecryptionError(
      'wrong-key',
      'This operation could not be decrypted. The link probably has no key, or a different one.',
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new DecryptionError('corrupt', 'Decrypted operation was not valid JSON.');
  }

  return parsed as Operation;
}

/** Decrypt many, stopping at the first failure rather than returning a partial list. */
export async function decryptOperations(
  key: DocumentKey,
  documentId: string,
  frames: readonly EncryptedOperation[],
): Promise<Operation[]> {
  const out: Operation[] = [];

  for (const frame of frames) {
    out.push(await decryptOperation(key, documentId, frame));
  }

  return out;
}

/**
 * Whether a decrypted operation matches the frame it arrived in.
 *
 * Cross-check, and cheap. A frame whose cleartext `key` disagrees with its decrypted
 * operation means something upstream substituted one operation's identity for another's -
 * which AAD alone prevents against an attacker but does not prevent against a bug. Trust
 * the ciphertext or the header, never both, and make them agree.
 */
export function frameMatchesOperation(frame: EncryptedOperation, op: Operation): boolean {
  return (
    frame.key === elementKeyOf(op) &&
    frame.type === op.type &&
    frame.site === (op.type === 'insert' ? op.id.site : op.target.site)
  );
}

/** Size of the stored envelope, for the metrics that describe payload bytes. */
export function encryptedFrameBytes(frame: EncryptedOperation): number {
  return (
    frame.ct.length + frame.iv.length + frame.key.length + frame.type.length + frame.site.length
  );
}

/** Key length, re-exported so callers checking a link do not import two modules. */
export const KEY_BYTES = DOCUMENT_KEY_BYTES;

/**
 * Base64url encode a byte array.
 *
 * `Uint8Array<ArrayBuffer>` rather than the default `Uint8Array`, because the default
 * element type is `ArrayBufferLike` and WebCrypto's `BufferSource` excludes
 * `SharedArrayBuffer`. Narrowing it here keeps every call site cast-free, which is
 * better than a cast that silently accepts a view onto shared memory.
 */
function bytesToBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Inverse of {@link bytesToBase64Url}. */
function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const withPadding = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=');

  let binary: string;

  try {
    binary = atob(withPadding);
  } catch {
    throw new DecryptionError('corrupt', 'Encrypted operation is not valid base64url.');
  }

  // Allocated over an explicit ArrayBuffer so the result is not `ArrayBufferLike`.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
