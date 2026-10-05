/**
 * Document encryption tests.
 *
 * These run against real WebCrypto, in Node. A mock would prove nothing: the properties
 * worth checking here - that a wrong key fails authentication, that a moved ciphertext
 * fails, that a reused frame still round-trips - are properties of AES-GCM itself, and a
 * mock that returned the plaintext would pass all of them while proving nothing.
 *
 * The tests that actually matter for the feature are the negative ones. A round-trip test
 * passes with `return JSON.parse(input)`, which is exactly the shape of a broken
 * implementation.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import type { Operation } from '../crdt/rga.js';
import {
  DOCUMENT_KEY_BYTES,
  DocumentKeyError,
  encodeKeyForFragment,
  exportDocumentKey,
  fromBase64Url,
  generateDocumentKey,
  hasKeyInFragment,
  importDocumentKey,
  keyFragment,
  readKeyFromFragment,
  testDocumentKey,
  toBase64Url,
} from './documentKey.js';
import {
  DecryptionError,
  ENVELOPE_VERSION,
  decryptOperation,
  decryptOperations,
  elementKeyOf,
  encryptOperation,
  encryptOperations,
  frameMatchesOperation,
} from './envelope.js';

const DOC = 'doc-1';

/**
 * Decode base64url to a byte string, for comparing before and after a mutation.
 *
 * Written with the same `atob`/`btoa` primitives the envelope module uses rather than
 * imported from it, because those helpers are private to that module. Duplicating four lines
 * is cheaper than widening a module's public surface to serve a test, and using the same
 * primitives means the two sides cannot disagree about what the encoding means.
 */
function decodeBase64Url(text: string): string {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const withPadding = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=');

  return atob(withPadding);
}

function encodeBase64Url(bytes: string): string {
  return btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Flip the high bit of one BYTE of a base64url string.
 *
 * @param byteIndex which decoded byte to alter, counted from the start. Must address a real
 *   byte: positions in the padding-only tail have no byte to flip.
 *
 * @returns the same string with that byte changed, guaranteed to decode differently.
 *
 * Byte-indexed rather than character-indexed on purpose. Flipping a base64 CHARACTER is not
 * guaranteed to change the decoded bytes, because a trailing group carries fewer significant
 * bits than it has characters: a 2-character tail has 4 significant bits and 2 ignored, a
 * 3-character tail has 2 significant bits and 4 ignored. A mutation touching only an ignored
 * bit decodes to the identical bytes, and AES-GCM then legitimately succeeds.
 *
 * That is not hypothetical. The previous version of the tampering test flipped the
 * second-to-last character, and on CI it produced
 * `promise resolved "{ type: 'insert', ... }" instead of rejecting` - a security test
 * reporting that tampering had been accepted when nothing had actually been tampered with. It
 * also means that test could have passed while proving nothing about most positions.
 *
 * Working in bytes removes the possibility rather than hoping about it.
 */
function tamper(base64url: string, byteIndex: number): string {
  const decoded = decodeBase64Url(base64url);

  if (byteIndex < 0 || byteIndex >= decoded.length) {
    throw new Error(
      `byteIndex ${byteIndex} is outside a ${decoded.length}-byte ciphertext. ` +
        'Positions in the padding-only tail have no byte to flip.',
    );
  }

  const original = decoded.charCodeAt(byteIndex);
  const mutated =
    decoded.slice(0, byteIndex) +
    String.fromCharCode(original ^ 0b1000_0000) +
    decoded.slice(byteIndex + 1);

  // Assert the invariant where it is used rather than trusting the arithmetic.
  if (mutated === decoded) {
    throw new Error(`tamper(${byteIndex}) did not change the decoded bytes`);
  }

  return encodeBase64Url(mutated);
}

function insert(
  site: string,
  clock: number,
  value: string,
  originClock: number | null = null,
): Operation {
  return {
    type: 'insert',
    id: { site, clock },
    origin: originClock === null ? null : { site, clock: originClock },
    value,
  };
}

function del(site: string, clock: number): Operation {
  return { type: 'delete', target: { site, clock } };
}

describe('key encoding', () => {
  it('round-trips raw key bytes through base64url', () => {
    const bytes = new Uint8Array(256);

    for (let index = 0; index < 256; index += 1) {
      bytes[index] = index;
    }

    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it('produces a URL-safe encoding', () => {
    // Every byte value, so the alphabet is fully exercised: standard base64 would emit
    // `+`, `/` and `=`, all of which need escaping inside a fragment.
    const bytes = new Uint8Array(256);

    for (let index = 0; index < 256; index += 1) {
      bytes[index] = index;
    }

    const encoded = toBase64Url(bytes);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded).not.toContain('=');
  });

  it('rejects a key of the wrong length instead of importing a weaker one', async () => {
    // AES-128 would import successfully and silently halve the security. The error is the
    // whole point.
    await expect(importDocumentKey(new Uint8Array(16))).rejects.toThrow(DocumentKeyError);
    await expect(importDocumentKey(new Uint8Array(31))).rejects.toThrow(DocumentKeyError);
    await expect(importDocumentKey(new Uint8Array(33))).rejects.toThrow(DocumentKeyError);
    await expect(importDocumentKey(new Uint8Array(0))).rejects.toThrow(DocumentKeyError);
  });

  it('generates keys of the documented length', async () => {
    const key = await generateDocumentKey();

    expect((await exportDocumentKey(key)).length).toBe(DOCUMENT_KEY_BYTES);
  });

  it('generates a different key every time', async () => {
    const first = toBase64Url(await exportDocumentKey(await generateDocumentKey()));
    const second = toBase64Url(await exportDocumentKey(await generateDocumentKey()));

    expect(first).not.toBe(second);
  });
});

describe('the URL fragment', () => {
  it('round-trips a key through a fragment', async () => {
    const key = await generateDocumentKey();
    const fragment = await keyFragment(key);
    const recovered = await readKeyFromFragment(fragment);

    expect(recovered).not.toBeNull();
    expect(await exportDocumentKey(recovered as NonNullable<typeof recovered>)).toEqual(
      await exportDocumentKey(key),
    );
  });

  it('accepts a fragment with or without the leading hash', async () => {
    // `location.hash` includes it and `URLSearchParams` input usually does not, so both
    // forms have to work or every caller has to remember to strip one.
    const key = await generateDocumentKey();
    const encoded = await encodeKeyForFragment(key);

    expect(await readKeyFromFragment(`#k=${encoded}`)).not.toBeNull();
    expect(await readKeyFromFragment(`k=${encoded}`)).not.toBeNull();
  });

  it('reports no key for an empty fragment', async () => {
    // This is how an unencrypted document is opened, so it is a normal answer.
    expect(await readKeyFromFragment('')).toBeNull();
    expect(await readKeyFromFragment('#')).toBeNull();
    expect(hasKeyInFragment('')).toBe(false);
  });

  it('ignores fragment parameters that are not the key', async () => {
    // A client-routing fragment must not look like a broken key.
    expect(await readKeyFromFragment('#tab=writing')).toBeNull();
    expect(hasKeyInFragment('#tab=writing')).toBe(false);
  });

  it('fails loudly on a malformed key rather than reporting no key', async () => {
    // Reporting "no key" for a corrupt one would leave the caller reading ciphertext it
    // cannot decrypt, with no indication why.
    await expect(readKeyFromFragment('#k=not!valid!base64')).rejects.toThrow(DocumentKeyError);
  });

  it('fails loudly on a correctly-encoded key of the wrong length', async () => {
    await expect(readKeyFromFragment(`#k=${toBase64Url(new Uint8Array(8))}`)).rejects.toThrow(
      DocumentKeyError,
    );
  });
});

describe('encrypt and decrypt', () => {
  it('round-trips an insert', async () => {
    const key = await testDocumentKey();
    const op = insert('alice', 1, 'x');

    expect(await decryptOperation(key, DOC, await encryptOperation(key, DOC, op))).toEqual(op);
  });

  it('round-trips a delete', async () => {
    const key = await testDocumentKey();
    const op = del('alice', 1);

    expect(await decryptOperation(key, DOC, await encryptOperation(key, DOC, op))).toEqual(op);
  });

  it('round-trips a multi-character value and every field of the operation', async () => {
    const key = await testDocumentKey();
    const op = insert('site-42', 9_999, 'the quick brown fox', 8_000);

    const recovered = await decryptOperation(key, DOC, await encryptOperation(key, DOC, op));

    expect(recovered).toEqual(op);
    expect(recovered.type === 'insert' ? recovered.value : '').toBe('the quick brown fox');
  });

  it('round-trips a batch in order', async () => {
    const key = await testDocumentKey();
    const ops = [insert('a', 1, 'h'), insert('a', 2, 'e', 1), del('a', 1)];
    const frames = await encryptOperations(key, DOC, ops);

    expect(await decryptOperations(key, DOC, frames)).toEqual(ops);
  });

  it('produces different ciphertext each time, even for the same operation', async () => {
    // Random nonces. If this ever became deterministic it would leak that two people
    // typed the same thing, which is a far subtler leak than it sounds.
    const key = await testDocumentKey();
    const op = insert('alice', 1, 'x');

    const first = await encryptOperation(key, DOC, op);
    const second = await encryptOperation(key, DOC, op);

    expect(first.ct).not.toBe(second.ct);
    expect(first.iv).not.toBe(second.iv);
  });

  it('carries no plaintext in the frame', async () => {
    // The property the feature exists for, asserted directly rather than inferred from a
    // round-trip. A distinctive string, so a substring search is decisive.
    const key = await testDocumentKey();
    const secret = 'CONFIDENTIAL-PHRASE-9c1f';
    const frame = await encryptOperation(key, DOC, insert('alice', 1, secret));

    expect(frame.ct).not.toContain('CONFIDENTIAL');
    expect(frame.ct).not.toContain('9c1f');
    expect(JSON.stringify(frame)).not.toContain(secret);
  });

  it('keeps the operation type and site in the clear, as designed', async () => {
    // Not an accident, and tested so a future change has to notice it is changing the
    // leak rather than quietly altering it.
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 7, 'x'));

    expect(frame.type).toBe('insert');
    expect(frame.site).toBe('alice');
    expect(frame.key).toBe('i:alice@7');
  });

  it('derives the same element key the server dedupes on', () => {
    // One function, two consumers. If these ever disagreed, an insert would be silently
    // dropped as a duplicate delete or the other way round.
    expect(elementKeyOf(insert('alice', 7, 'x'))).toBe('i:alice@7');
    expect(elementKeyOf(del('alice', 7))).toBe('d:alice@7');
  });

  it('stamps the version', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    expect(frame.v).toBe(ENVELOPE_VERSION);
  });
});

describe('what must NOT decrypt', () => {
  it('rejects the wrong key', async () => {
    const frame = await encryptOperation(
      await testDocumentKey('alice'),
      DOC,
      insert('alice', 1, 'x'),
    );

    await expect(decryptOperation(await testDocumentKey('bob'), DOC, frame)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('says the likely cause, since a missing key is the common case', async () => {
    // Opening a shared link without its fragment is overwhelmingly the real failure, and
    // "this link has no key" is a message a user can act on.
    const frame = await encryptOperation(await testDocumentKey('alice'), DOC, insert('a', 1, 'x'));

    const error = await decryptOperation(await testDocumentKey('bob'), DOC, frame).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DecryptionError);
    expect((error as DecryptionError).reason).toBe('wrong-key');
  });

  it('rejects a frame moved to a different document', async () => {
    // The reason the AAD is not empty. Same key, valid ciphertext, wrong document.
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'secret'));

    await expect(decryptOperation(key, 'doc-2', frame)).rejects.toThrow(DecryptionError);
  });

  it('rejects a frame whose element key was altered', async () => {
    // Without AAD on the key, this would decrypt to a perfectly valid operation with the
    // wrong identity - and the server would dedupe it against the wrong row.
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    await expect(decryptOperation(key, DOC, { ...frame, key: 'i:mallory@1' })).rejects.toThrow(
      DecryptionError,
    );
  });

  it('rejects a frame whose type was swapped from insert to delete', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    await expect(
      decryptOperation(key, DOC, { ...frame, type: 'delete', key: 'd:alice@1' }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a frame whose site was altered', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    await expect(decryptOperation(key, DOC, { ...frame, site: 'mallory' })).rejects.toThrow(
      DecryptionError,
    );
  });

  it('rejects tampered ciphertext', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    await expect(decryptOperation(key, DOC, { ...frame, ct: tamper(frame.ct, 0) })).rejects.toThrow(
      DecryptionError,
    );
  });

  it('rejects tampering anywhere in the ciphertext, not only at the start', async () => {
    // ---------------------------------------------------------------------------
    // WHY THIS TEST EXISTS: A MUTATION THAT SOMETIMES CHANGES NOTHING
    // ---------------------------------------------------------------------------
    // The original version flipped the second-to-last base64url character. That is not
    // guaranteed to alter the decoded bytes:
    //
    //   - base64 encodes 3 bytes as 4 characters, and a trailing group of 2 characters
    //     carries 4 significant bits with 2 ignored
    //   - a trailing group of 3 characters carries 2 significant bits with 4 ignored
    //
    // So 'A' (000000) -> 'B' (000001) alters only an IGNORED bit, the decode yields the
    // identical bytes, and AES-GCM legitimately succeeds. The test then failed on CI with
    // `promise resolved "{ type: 'insert', ... }" instead of rejecting` - a security test
    // reporting that tampering was accepted, when in truth nothing had been tampered with.
    //
    // The lesson is the uncomfortable one: the mutation was wrong, not the crypto, and the
    // failure looked exactly like a security defect. It also means this test could have
    // passed while proving nothing about most positions in the string.
    //
    // `tamper` now flips the high bit of a specific BYTE, so the decoded bytes are
    // guaranteed to differ, and this test checks the first, last and middle to prove the
    // guarantee holds at every position class rather than only where it happened to work.
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    // 3 bytes per 4 base64url characters, rounded down: never the padding-only tail.
    const byteCount = Math.floor((frame.ct.length * 3) / 4);
    const positions = [0, 1, Math.floor(byteCount / 2), byteCount - 2, byteCount - 1];

    for (const byteIndex of [...new Set(positions)].filter((index) => index >= 0)) {
      const flipped = tamper(frame.ct, byteIndex);

      // The precondition matters: if the mutation did not change the bytes, the assertion
      // below would be testing nothing while appearing to pass.
      expect(decodeBase64Url(flipped), `byte ${byteIndex} did not change`).not.toBe(
        decodeBase64Url(frame.ct),
      );

      await expect(
        decryptOperation(key, DOC, { ...frame, ct: flipped }),
        `tampering at byte ${byteIndex} was accepted`,
      ).rejects.toThrow(DecryptionError);
    }
  });

  it('rejects a truncated ciphertext', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    await expect(
      decryptOperation(key, DOC, { ...frame, ct: frame.ct.slice(0, 4) }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects an unsupported version rather than guessing', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    const error = await decryptOperation(key, DOC, { ...frame, v: 99 }).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as DecryptionError).reason).toBe('malformed');
  });

  it('rejects a frame with no iv or ciphertext', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    await expect(
      decryptOperation(key, DOC, { ...frame, iv: undefined as unknown as string }),
    ).rejects.toThrow(DecryptionError);
    await expect(
      decryptOperation(key, DOC, { ...frame, ct: undefined as unknown as string }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a frame whose nonce is the wrong length', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    const error = await decryptOperation(key, DOC, {
      ...frame,
      iv: toBase64Url(new Uint8Array(8)),
    }).catch((thrown: unknown) => thrown);

    expect((error as DecryptionError).reason).toBe('corrupt');
  });

  it('rejects a frame whose base64url is malformed', async () => {
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    const error = await decryptOperation(key, DOC, { ...frame, ct: '!!!not base64!!!' }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DecryptionError);
    expect(['corrupt', 'wrong-key']).toContain((error as DecryptionError).reason);
  });

  it('is not decryptable with a different nonce than the one used', async () => {
    // Proves the nonce is actually bound into the frame rather than ignored.
    const key = await testDocumentKey();
    const frame = await encryptOperation(key, DOC, insert('alice', 1, 'x'));

    await expect(
      decryptOperation(key, DOC, { ...frame, iv: toBase64Url(new Uint8Array(12)) }),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('frameMatchesOperation', () => {
  it('accepts an honest frame', async () => {
    const key = await testDocumentKey();
    const op = insert('alice', 1, 'x');
    const frame = await encryptOperation(key, DOC, op);

    expect(frameMatchesOperation(frame, op)).toBe(true);
  });

  it('rejects a frame whose identity disagrees with its plaintext', async () => {
    // A cross-check against a bug rather than an attacker. AAD stops an attacker; this
    // stops a substituted operation from being accepted with the wrong identity.
    const key = await testDocumentKey();
    const op = insert('alice', 1, 'x');

    expect(
      frameMatchesOperation({ ...(await encryptOperation(key, DOC, op)), key: 'i:eve@1' }, op),
    ).toBe(false);
    expect(
      frameMatchesOperation({ ...(await encryptOperation(key, DOC, op)), type: 'delete' }, op),
    ).toBe(false);
    // The site was redundant with the element key and therefore unattached to the
    // ciphertext until a test found it. Now bound, so a substituted site is caught twice:
    // by the AAD, and by this cross-check.
    expect(
      frameMatchesOperation({ ...(await encryptOperation(key, DOC, op)), site: 'eve' }, op),
    ).toBe(false);
  });
});

describe('the guarantee that matters', () => {
  it('two people with the key converge; one without it learns nothing', async () => {
    // The whole feature, end to end in miniature. Two distinctive strings so the "no
    // plaintext on the wire" check is decisive - an earlier version asserted that the
    // derivable fields did not contain the letter 'i', which fails because "insert"
    // contains one. That assertion would have passed while proving nothing.
    const key = await testDocumentKey();
    const eavesdropper = await testDocumentKey('server');
    const first = 'ZEBRAFISH';
    const second = 'PLATYPUS';

    const ops: Operation[] = [insert('alice', 1, first), insert('alice', 2, second, 1)];

    const onWire: string[] = [];

    for (const op of ops) {
      const frame = await encryptOperation(key, DOC, op);

      onWire.push(JSON.stringify(frame));

      // Everything the server can read off this frame without the key.
      const derivable = JSON.stringify({
        v: frame.v,
        key: frame.key,
        type: frame.type,
        site: frame.site,
        iv: frame.iv,
        ct: frame.ct,
      });

      expect(derivable).not.toContain(first);
      expect(derivable).not.toContain(second);
      // Metadata it does leak, asserted so the test states the boundary rather than
      // implying there is none.
      expect(derivable).toContain('alice');

      await expect(decryptOperation(eavesdropper, DOC, frame)).rejects.toThrow(DecryptionError);
    }

    const recovered = await decryptOperations(
      key,
      DOC,
      onWire.map((text) => JSON.parse(text) as never),
    );

    expect(recovered).toEqual(ops);
    expect(recovered[0]?.type === 'insert' ? recovered[0].value : '').toBe(first);
  });
});
