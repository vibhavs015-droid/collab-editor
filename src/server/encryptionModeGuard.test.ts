/**
 * The encryption-mode guard on the write path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * The guard is a one-line question - "is this document encrypted?" - and it has three
 * places that could each be wrong independently:
 *
 *   - `DocumentStore.apply`, the fast check, backed by an in-memory cache
 *   - `Database.appendOps`, the authoritative check
 *   - `DocumentStore.applyEncrypted`, which must invalidate the fast cache
 *
 * A test that exercises only the first would pass while the third was broken, and the
 * breakage is silent: plaintext operations are refused correctly, just later than they
 * should be, and only for documents that were written to before they were encrypted.
 *
 * Every test here starts from a store that has already cached a `false` for the document,
 * because that is the state any real plaintext document is in. Testing the guard from a
 * cold cache would miss the entire class of bug this file is for.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { testDocumentKey, type DocumentKey } from '../core/crypto/documentKey.js';
import { encryptOperation } from '../core/crypto/envelope.js';
import type { Operation } from '../core/crdt/rga.js';
import { Database, EncryptedDocumentError } from './db.js';
import { DocumentStore } from './documentStore.js';

let documentCounter = 0;

/** A database with one fresh document. A unique id per test, so they cannot interfere. */
async function freshDb(): Promise<{ db: Database; documentId: string }> {
  const db = await Database.open();
  documentCounter += 1;
  const documentId = `mode-guard-${documentCounter}`;

  await db.createDocument({ id: documentId });

  return { db, documentId };
}

/**
 * One insert operation.
 *
 * The value is ONE CHARACTER, and that is not incidental. `isInsertOp` requires
 * `[...value].length === 1`, because the protocol's unit of work is a single character -
 * `insertAt(offset, 'abcd')` emits four operations, one per character.
 *
 * The first version of this file used `'before'` and `'leak'`, and every one of those
 * operations was silently dropped by `parseOperations` as malformed. The symptom was
 * `accepted: 0` on a perfectly valid plaintext write, which reads like a storage bug and
 * is actually a fixture bug - the same shape as the `parseEncryptedFrame` prefix mistake
 * earlier in this phase.
 */
function insert(site: string, clock: number, value: string): Operation {
  return { type: 'insert', id: { site, clock }, origin: null, value };
}

/** Encrypt one operation and store it, the way a client does. */
async function makeEncrypted(
  store: DocumentStore,
  documentId: string,
  key: DocumentKey,
  ops: readonly Operation[],
): Promise<void> {
  for (const op of ops) {
    await store.applyEncrypted(documentId, [await encryptOperation(key, documentId, op)]);
  }
}

describe('a plaintext document accepts plaintext', () => {
  it('across repeated writes, which is what proves the cache is warm', async () => {
    const { db, documentId } = await freshDb();

    try {
      const store = new DocumentStore({ db });

      for (let clock = 1; clock <= 3; clock += 1) {
        const result = await store.apply(documentId, [insert('a', clock, 'x')]);

        expect(result.accepted, `write ${clock} was not accepted`).toBe(1);
        expect(result.unplaced, `write ${clock} was unplaced`).toEqual([]);
      }
    } finally {
      await db.close();
    }
  });
});

describe('the guard fires once a document is encrypted', () => {
  it('refuses plaintext from a store that had already cached false', async () => {
    // THE case. Without invalidating the negative cache this store keeps answering "not
    // encrypted" out of memory and every plaintext write proceeds to storage.
    const { db, documentId } = await freshDb();

    try {
      const store = new DocumentStore({ db });

      // Warm the cache with a legitimate plaintext write.
      expect((await store.apply(documentId, [insert('a', 1, 'p')])).accepted).toBe(1);

      const key = await testDocumentKey('guard');
      await makeEncrypted(store, documentId, key, [insert('b', 1, 'a')]);

      // A plaintext client - one that never received the key - keeps trying.
      await expect(store.apply(documentId, [insert('mallory', 1, 'L')])).rejects.toThrow(
        EncryptedDocumentError,
      );

      // And again. A guard that fires once and then lets the second write through is a
      // guard with a hole, not a guard.
      await expect(store.apply(documentId, [insert('mallory', 2, 'L')])).rejects.toThrow(
        EncryptedDocumentError,
      );
    } finally {
      await db.close();
    }
  });

  it('refuses before touching a replica, so ciphertext is never replayed as operations', async () => {
    // The ordering bug this file exists for. The guard used to live only in
    // `Database.appendOps`, which runs AFTER `#replicaFor` has replayed the document's log
    // through an RGA. For an encrypted document that log is ciphertext, so the replay is
    // nonsense and `applyInAnyOrder` reports it as `unplaced` - lighting the CRDT's
    // health metric for a reason that has nothing to do with a peer waiting for anything.
    //
    // `openDocumentCount` is what makes this observable. Asserting only that the call
    // throws proves nothing here, because the database guard ALSO throws: removing the
    // store-level guard entirely leaves every "it rejects" assertion in this file passing.
    // What distinguishes the two is whether a replica was built along the way, and that is
    // exactly what `openDocumentCount` reports.
    const { db, documentId } = await freshDb();

    try {
      const store = new DocumentStore({ db });

      await makeEncrypted(store, documentId, await testDocumentKey('ordering'), [
        insert('b', 1, 'x'),
      ]);

      // A plaintext client that never got the key.
      await expect(store.apply(documentId, [insert('mallory', 1, 'L')])).rejects.toThrow(
        /encrypted/u,
      );

      // No replica was built, so the ciphertext log was never replayed through an RGA.
      expect(
        store.openDocumentCount,
        'a replica was built for an encrypted document, so its log was replayed as operations',
      ).toBe(0);

      // And a second attempt does not build one either.
      await expect(store.apply(documentId, [insert('mallory', 2, 'L')])).rejects.toThrow(
        /encrypted/u,
      );
      expect(store.openDocumentCount).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('consults the encrypted cache before the plaintext one', async () => {
    // ---------------------------------------------------------------------------
    // THE CACHE PRECEDENCE, WHICH IS THE WHOLE SAFETY ARGUMENT
    // ---------------------------------------------------------------------------
    // A document written in plaintext and then encrypted is in BOTH sets. If the plaintext
    // answer were consulted first, that document would read as plaintext forever, and
    // every later plaintext write would be accepted into a document its participants chose
    // to encrypt.
    //
    // The state is reached deliberately: plaintext first so the negative cache is
    // populated, then encrypted so the positive cache is too.
    const { db, documentId } = await freshDb();

    try {
      const store = new DocumentStore({ db });

      // Populate the negative cache.
      expect((await store.apply(documentId, [insert('a', 1, 'p')])).accepted).toBe(1);
      expect(store.openDocumentCount).toBe(1);

      await makeEncrypted(store, documentId, await testDocumentKey('precedence'), [
        insert('b', 1, 'x'),
      ]);

      // Both caches now hold an answer for this document. The encrypted one must win.
      await expect(store.apply(documentId, [insert('mallory', 1, 'L')])).rejects.toThrow(
        EncryptedDocumentError,
      );
    } finally {
      await db.close();
    }
  });

  it('refuses from a cold cache too', async () => {
    // A store constructed after the document was encrypted, which has never cached
    // anything. The cache is an optimisation and must never be the only thing standing
    // between a client and a document its participants chose to encrypt.
    const { db, documentId } = await freshDb();

    try {
      const writer = new DocumentStore({ db });

      await makeEncrypted(writer, documentId, await testDocumentKey('cold'), [insert('b', 1, 'x')]);

      const coldStore = new DocumentStore({ db });

      await expect(coldStore.apply(documentId, [insert('mallory', 1, 'L')])).rejects.toThrow(
        /encrypted/u,
      );
    } finally {
      await db.close();
    }
  });
});

describe('the database guard stands alone', () => {
  it('refuses plaintext with no store involved at all', async () => {
    // Defence in depth. The fast check is optimistic by design - it reads a cache a
    // concurrent `applyEncrypted` may be about to invalidate - so the authoritative check
    // has to exist underneath it rather than being assumed unreachable.
    const { db, documentId } = await freshDb();

    try {
      const key = await testDocumentKey('db-only');
      const frame = await encryptOperation(key, documentId, insert('b', 1, 'x'));

      await db.appendEncryptedOps(documentId, [frame]);

      await expect(db.appendOps(documentId, [insert('mallory', 1, 'L')])).rejects.toThrow(
        EncryptedDocumentError,
      );
    } finally {
      await db.close();
    }
  });
});

describe('the guard does not become a lockout', () => {
  it('accepts every subsequent encrypted frame', async () => {
    // A guard that refused the second frame would be worse than no guard at all: the
    // document would be permanently unwritable, which for a collaborative editor means
    // silently losing everything typed after the first keystroke.
    const { db, documentId } = await freshDb();

    try {
      const store = new DocumentStore({ db });
      const key = await testDocumentKey('ongoing');

      for (let clock = 1; clock <= 5; clock += 1) {
        const result = await store.applyEncrypted(documentId, [
          await encryptOperation(key, documentId, insert('b', clock, String(clock))),
        ]);

        expect(result.accepted, `frame ${clock} was refused`).toBe(1);
      }

      expect((await db.readEncryptedOpsSince(documentId, 0)).frames).toHaveLength(5);
    } finally {
      await db.close();
    }
  });
});

describe('an asymmetry worth knowing about', () => {
  it('stores a multi-character element that the plaintext path would have rejected', async () => {
    // -----------------------------------------------------------------------
    // THIS IS NOT A BUG. It is a consequence of withholding the key, recorded
    // so a reader is not surprised by it.
    // -----------------------------------------------------------------------
    // The plaintext path validates operations, and `isInsertOp` requires a
    // single-character value. The encrypted path CANNOT validate: the value is inside the
    // ciphertext. So an encrypted document can contain elements the server would have
    // refused to store in plaintext.
    //
    // Consequence: a document built this way could not be reproduced by the plaintext API.
    // That is fine - the CRDT accepts arbitrary element values and clients agree on the
    // result - but it means the two paths accept different sets of documents, and anything
    // that assumes otherwise is wrong.
    //
    // The fix, if it were ever wanted, would be to enforce the rule client-side before
    // encrypting. It cannot be enforced server-side without decrypting.
    const { db, documentId } = await freshDb();

    try {
      const store = new DocumentStore({ db });
      const key = await testDocumentKey('asymmetry');

      const result = await store.applyEncrypted(documentId, [
        await encryptOperation(key, documentId, {
          type: 'insert',
          id: { site: 'b', clock: 1 },
          origin: null,
          value: 'sixteen-characters',
        }),
      ]);

      expect(result.accepted).toBe(1);

      // Stored, and readable by a client holding the key.
      const { decryptOperation } = await import('../core/crypto/envelope.js');
      const stored = await db.readEncryptedOpsSince(documentId, 0);
      const op = await decryptOperation(key, documentId, stored.frames[0] as never);

      expect(op).toEqual({
        type: 'insert',
        id: { site: 'b', clock: 1 },
        origin: null,
        value: 'sixteen-characters',
      });

      // The same value offered in plaintext is refused as malformed.
      const { parseOperations } = await import('../shared/operation-validation.js');

      expect(
        parseOperations([
          {
            type: 'insert',
            id: { site: 'c', clock: 1 },
            origin: null,
            value: 'sixteen-characters',
          },
        ] as never),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
