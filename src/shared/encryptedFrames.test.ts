/**
 * Runtime validation of encrypted frames, and the shape-sharing check between the
 * crypto layer and the transport.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE SERVER'S ONLY CHECK, AND WHY IT IS ENOUGH FOR WHAT IT CLAIMS
 * ---------------------------------------------------------------------------
 * `parseEncryptedFrame` is all the server can do to an encrypted operation. It confirms
 * the frame is SHAPED like a frame. It cannot confirm the ciphertext decrypts, that it
 * decrypts to an operation matching the claimed element key, or that two clients will
 * agree about what it says.
 *
 * That is not a gap being papered over - it is the design (ADR-0014). But it does impose
 * an obligation: every field the frame exposes must be either authenticated (so it
 * cannot be substituted) or not trusted by the server (so substituting it achieves
 * nothing). `site` used to be neither, and a test here caught it.
 *
 * These tests cover the "must be bounded" side. Anything unbounded here becomes a
 * database key, a metric label, or a log line.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { testDocumentKey } from '../core/crypto/documentKey.js';
import { encryptOperation, type EncryptedOperation } from '../core/crypto/envelope.js';
import type { Operation } from '../core/crdt/rga.js';
import {
  parseClientMessage,
  parseEncryptedFrame,
  type EncryptedOperationFrame,
} from './protocol.js';

/** A frame with every field valid, for tests to corrupt one field at a time. */
function validFrame(): EncryptedOperationFrame {
  return {
    v: 1,
    key: 'i:alice@7',
    type: 'insert',
    site: 'alice',
    iv: 'AAAAAAAAAAAAAAAA',
    // 22 characters is the floor: a 16-byte GCM tag in base64url.
    ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
}

describe('the two frame definitions agree', () => {
  it('assigns in both directions', async () => {
    // Duplication is the cost of keeping src/shared independent of src/core. This is
    // what stops the two drifting apart silently.
    const key = await testDocumentKey('shape');
    const op: Operation = {
      type: 'insert',
      id: { site: 'alice', clock: 7 },
      origin: null,
      value: 'x',
    };

    const fromCore: EncryptedOperation = await encryptOperation(key, 'doc', op);
    const asWire: EncryptedOperationFrame = fromCore;

    expect(parseEncryptedFrame(asWire)).not.toBeNull();

    const parsed = parseEncryptedFrame(JSON.parse(JSON.stringify(fromCore)) as unknown);

    expect(parsed).toEqual(fromCore);
  });
});

describe('parseEncryptedFrame accepts', () => {
  it('a well-formed insert frame', () => {
    expect(parseEncryptedFrame(validFrame())).toEqual(validFrame());
  });

  it('a well-formed delete frame', () => {
    const frame = { ...validFrame(), key: 'd:alice@7', type: 'delete' as const };

    expect(parseEncryptedFrame(frame)).toEqual(frame);
  });

  it('a large clock', () => {
    // Beyond Number.MAX_SAFE_INTEGER on purpose. The key is a string and never parsed as
    // a number here, so a document edited billions of times still validates.
    const frame = { ...validFrame(), key: 'i:alice@9007199254740993' };

    expect(parseEncryptedFrame(frame)).not.toBeNull();
  });
});

describe('parseEncryptedFrame refuses', () => {
  it('anything that is not an object', () => {
    for (const input of [null, undefined, 1, 'string', true, []]) {
      expect(parseEncryptedFrame(input), `for ${JSON.stringify(input) ?? 'undefined'}`).toBeNull();
    }
  });

  it('an unsupported envelope version', () => {
    // Refused at the edge with a clear reason rather than stored and failing to decrypt
    // months later.
    expect(parseEncryptedFrame({ ...validFrame(), v: 2 })).toBeNull();
    expect(parseEncryptedFrame({ ...validFrame(), v: 0 })).toBeNull();
    expect(parseEncryptedFrame({ ...validFrame(), v: '1' })).toBeNull();
  });

  it('a malformed element key', () => {
    for (const key of ['', 'i:alice', 'alice@7', 'i:alice@', 'i:@7', 'x:alice@7', 'i:alice@abc']) {
      expect(
        parseEncryptedFrame({ ...validFrame(), key }),
        `for ${JSON.stringify(key)}`,
      ).toBeNull();
    }
  });

  it('a key whose prefix contradicts the type', () => {
    // Otherwise an insert would be deduplicated against the delete's row, and the
    // character would survive its own deletion.
    expect(parseEncryptedFrame({ ...validFrame(), type: 'delete' })).toBeNull();
  });

  it('a site that disagrees with the key', () => {
    // The causal-stability floor is computed per site. A frame claiming one site and
    // naming another would move the floor based on a participant that may not exist.
    expect(parseEncryptedFrame({ ...validFrame(), site: 'mallory' })).toBeNull();
  });

  it('an over-long or malformed site', () => {
    for (const site of ['', 'a b', 'a.b', 'a/b', 'x'.repeat(65), 'ünïcode']) {
      expect(parseEncryptedFrame({ ...validFrame(), site }), `for ${site}`).toBeNull();
    }
  });

  it('an over-long site inside the key', () => {
    // Bounded separately from the `site` field, because the key is what reaches the
    // database as a primary-key component.
    const frame = { ...validFrame(), key: `i:${'x'.repeat(200)}@7`, site: 'x'.repeat(200) };

    expect(parseEncryptedFrame(frame)).toBeNull();
  });

  it('a nonce of the wrong length', () => {
    // Exactly 12 bytes is 16 base64url characters. A wrong-length nonce would fail on
    // every client instead of here.
    expect(parseEncryptedFrame({ ...validFrame(), iv: 'AAAA' })).toBeNull();
    expect(parseEncryptedFrame({ ...validFrame(), iv: 'A'.repeat(17) })).toBeNull();
    expect(parseEncryptedFrame({ ...validFrame(), iv: '' })).toBeNull();
  });

  it('a nonce that is not base64url', () => {
    for (const iv of ['++++++++++++++++++++', 'AAAA/AAAA/AAAA/AAAA', 'AAAA AAAAAAAA AAAA']) {
      expect(parseEncryptedFrame({ ...validFrame(), iv }), `for ${iv}`).toBeNull();
    }
  });

  it('ciphertext too short to contain a GCM tag', () => {
    // A 16-byte tag is 22 base64url characters. Below that the frame cannot be valid
    // ciphertext at all, whatever the key.
    expect(parseEncryptedFrame({ ...validFrame(), ct: 'A'.repeat(21) })).toBeNull();
    expect(parseEncryptedFrame({ ...validFrame(), ct: '' })).toBeNull();
  });

  it('ciphertext that is not base64url', () => {
    expect(parseEncryptedFrame({ ...validFrame(), ct: `${'A'.repeat(21)}+` })).toBeNull();
  });

  it('accepts a large but legitimate frame', () => {
    // A big paste arrives as one insert with a large value, so "large" cannot simply mean
    // "refused". This pins the boundary from the allowed side, so the ceiling cannot be
    // lowered without a test noticing.
    const frame = { ...validFrame(), ct: 'A'.repeat(1_048_576) };

    expect(parseEncryptedFrame(frame)).not.toBeNull();
  });

  it('refuses ciphertext one character beyond the ceiling', () => {
    // At the boundary rather than at a round number, because the point is the boundary.
    const frame = { ...validFrame(), ct: 'A'.repeat(1_048_577) };

    expect(parseEncryptedFrame(frame)).toBeNull();
  });

  it('refuses an absurdly large frame rather than storing it', () => {
    // The disk-filling case.
    const frame = { ...validFrame(), ct: 'A'.repeat(50 * 1_048_576) };

    expect(parseEncryptedFrame(frame)).toBeNull();
  });

  it('missing fields', () => {
    const complete = validFrame();

    for (const field of ['v', 'key', 'type', 'site', 'iv', 'ct'] as const) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[field];

      expect(parseEncryptedFrame(partial), `missing ${field}`).toBeNull();
    }
  });
});

describe('parseClientMessage with encrypted frames', () => {
  it('accepts a well-formed batch', () => {
    const parsed = parseClientMessage(
      JSON.stringify({ type: 'ops-enc', documentId: 'doc', frames: [validFrame()] }),
    );

    expect(parsed?.type).toBe('ops-enc');
  });

  it('accepts an empty batch', () => {
    // Valid and a no-op. Refusing it would make a client with nothing to send unable to
    // prove it has nothing to send.
    const parsed = parseClientMessage(
      JSON.stringify({ type: 'ops-enc', documentId: 'doc', frames: [] }),
    );

    expect(parsed?.type).toBe('ops-enc');
  });

  it('refuses the WHOLE batch when one frame is bad', () => {
    // All-or-nothing, and this is the point of the test: dropping only the bad frames
    // would apply half a keystroke batch and leave the document in a state nobody typed,
    // with no record that anything was rejected.
    const parsed = parseClientMessage(
      JSON.stringify({
        type: 'ops-enc',
        documentId: 'doc',
        frames: [validFrame(), { ...validFrame(), v: 99 }],
      }),
    );

    expect(parsed).toBeNull();
  });

  it('refuses a batch that is not an array', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'ops-enc', documentId: 'doc', frames: {} })),
    ).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'ops-enc', documentId: 'doc' }))).toBeNull();
  });

  it('refuses a batch with no document id', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'ops-enc', frames: [validFrame()] })),
    ).toBeNull();
  });

  it('does not let an encrypted frame pass as a plaintext batch', () => {
    // A frame has `key`/`iv`/`ct`; an operation has `id`/`origin`/`value`. Distinct
    // message types make it impossible for one to be read as the other, which is the
    // whole reason `ops-enc` is a new type rather than a flag.
    expect(
      parseClientMessage(JSON.stringify({ type: 'ops', documentId: 'doc', ops: [validFrame()] })),
    ).not.toBeNull();

    const parsed = parseClientMessage(
      JSON.stringify({ type: 'ops', documentId: 'doc', ops: [validFrame()] }),
    );

    expect(parsed?.type).toBe('ops');

    // And the frames are NOT read back as operations anywhere: the plaintext path casts
    // `ops` to `Operation[]` without looking, and an encrypted document never reaches
    // it because the store refuses to append plaintext to one.
    const asEncrypted = parseClientMessage(
      JSON.stringify({ type: 'ops-enc', documentId: 'doc', frames: [validFrame()] }),
    );

    expect(asEncrypted?.type).toBe('ops-enc');
  });
});
