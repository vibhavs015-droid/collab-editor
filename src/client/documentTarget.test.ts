/**
 * A bare URL must mean "the document this browser was last on".
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  LAST_DOCUMENT_KEY,
  isDocumentId,
  recallDocument,
  rememberDocument,
  resolveDocumentId,
  type DocumentTargetStorage,
} from './documentTarget.js';

/** An in-memory Storage, with a switch for the "storage is unavailable" case. */
function fakeStorage(seed: Record<string, string> = {}, broken = false): DocumentTargetStorage {
  const map = new Map(Object.entries(seed));

  if (broken) {
    // Every method throws, which is what a quota error or disabled storage looks like.
    return {
      getItem() {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem() {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem() {
        throw new DOMException('denied', 'SecurityError');
      },
    };
  }

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const MINTED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('a bare URL reopens the last document', () => {
  it('is the behaviour the user reported as broken', () => {
    // Two tabs opened at `/` resolved to two different documents, so typing in one appeared
    // in neither. Both tabs said "Synced" and reported a collaborator, because each was
    // correctly talking to a server that had never heard of the other tab.
    const storage = fakeStorage();
    const tab1 = resolveDocumentId('', storage, () => MINTED);
    rememberDocument(storage, tab1, false);

    const tab2 = resolveDocumentId('', storage, () => 'a-completely-different-document');

    expect(tab2).toBe(tab1);
    // The point of the test: the mint function is not even reached for the second tab.
    expect(tab2).not.toBe('a-completely-different-document');
  });

  it('mints a document when there is nothing remembered', () => {
    expect(resolveDocumentId('', fakeStorage(), () => MINTED)).toBe(MINTED);
  });

  it('lets the URL win over memory', () => {
    // Someone pasted a link. That link is what they asked for, and memory must not override it.
    const storage = fakeStorage({ [LAST_DOCUMENT_KEY]: 'the-one-i-was-on' });

    expect(resolveDocumentId('?doc=the-one-they-linked', storage, () => MINTED)).toBe(
      'the-one-they-linked',
    );
  });

  it('ignores a malformed id in the URL and falls back to memory', () => {
    const storage = fakeStorage({ [LAST_DOCUMENT_KEY]: 'the-good-one' });

    // A URL is attacker-controllable in the weakest sense that a person can edit their own
    // address bar, so it gets the same validation as everything else.
    for (const bad of ['', 'has space', 'x'.repeat(100), 'quote"inject', '<script>', 'a/b']) {
      expect(resolveDocumentId(`?doc=${encodeURIComponent(bad)}`, storage, () => MINTED)).toBe(
        'the-good-one',
      );
    }
  });

  it('ignores a corrupted remembered id', () => {
    const storage = fakeStorage({ [LAST_DOCUMENT_KEY]: 'not a valid id' });

    expect(resolveDocumentId('', storage, () => MINTED)).toBe(MINTED);
  });
});

describe('encrypted documents are never remembered', () => {
  it('forgets the current one rather than leaving it', () => {
    const storage = fakeStorage();

    rememberDocument(storage, 'a-plaintext-doc', false);
    expect(recallDocument(storage)).toBe('a-plaintext-doc');

    // An encrypted document's key lives only in the URL fragment, which cannot be read back.
    // Reopening it from memory would present a blank editor with no way to explain why.
    rememberDocument(storage, 'an-encrypted-doc', true);

    expect(recallDocument(storage)).toBeNull();
  });

  it('does not resurrect the plaintext document from before it', () => {
    // The bug `removeItem` rather than "do nothing" prevents: opening an encrypted document
    // after a plaintext one would otherwise leave the plaintext id as what a bare URL reopens,
    // so the user silently lands on a stale document instead of a new one.
    const storage = fakeStorage();

    rememberDocument(storage, 'older-plaintext-doc', false);
    rememberDocument(storage, 'the-encrypted-doc', true);

    expect(resolveDocumentId('', storage, () => MINTED)).toBe(MINTED);
    expect(resolveDocumentId('', storage, () => MINTED)).not.toBe('older-plaintext-doc');
  });
});

describe('storage being unavailable', () => {
  it('still resolves, by minting', () => {
    // Private browsing and disabled storage are ordinary, not exceptional. The cost is that a
    // bare URL mints a new document each time, which is the behaviour from before this existed.
    expect(resolveDocumentId('', fakeStorage({}, true), () => MINTED)).toBe(MINTED);
  });

  it('does not throw from remember', () => {
    const storage = fakeStorage({}, true);

    expect(() => {
      rememberDocument(storage, 'some-doc', false);
      rememberDocument(storage, 'some-doc', true);
    }).not.toThrow();
  });

  it('recalls null rather than throwing', () => {
    expect(recallDocument(fakeStorage({}, true))).toBeNull();
  });

  it('still honours a URL, because the URL needs no storage', () => {
    expect(resolveDocumentId('?doc=from-the-url', fakeStorage({}, true), () => MINTED)).toBe(
      'from-the-url',
    );
  });
});

describe('isDocumentId', () => {
  it('accepts what the URL check accepts and rejects the rest', () => {
    for (const good of ['a', MINTED, 'A-b_c-1', 'x'.repeat(64)]) {
      expect(isDocumentId(good), good).toBe(true);
    }

    for (const bad of ['', 'x'.repeat(65), 'has space', 'a/b', 'a?b', 'a#b', '../etc', 42, null]) {
      expect(isDocumentId(bad), String(bad)).toBe(false);
    }
  });
});
