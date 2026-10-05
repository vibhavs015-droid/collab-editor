/**
 * Share-link construction.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FRAGMENT IS THE WHOLE POINT, AND WHY IT IS TESTED THIS HARD
 * ---------------------------------------------------------------------------
 * The encryption feature is reachable only through the URL. `history.replaceState`
 * replaces the WHOLE url, so any navigation that writes `?doc=<id>` and forgets the
 * fragment silently reopens the document UNENCRYPTED - and the server then refuses it with
 * a message about an encrypted document, for a document the tab created moments ago.
 *
 * That failure is silent, user-hostile, and easy to reintroduce. So the rule "a URL for a
 * document always carries its key" is stated in exactly one place and tested here against
 * the ways it could be got wrong.
 *
 * The tests use `readKeyFromFragment` as the oracle rather than asserting on string shape,
 * because the property that matters is that the produced URL yields the SAME KEY - not that
 * it contains some particular characters.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  exportDocumentKey,
  generateDocumentKey,
  readKeyFromFragment,
  testDocumentKey,
} from '../core/crypto/documentKey.js';
import { currentShareLink, documentUrl, shareLink } from './shareLink.js';

/** The fragment part of a url, as the browser would report it. */
function fragmentOf(url: string): string {
  const index = url.indexOf('#');

  return index === -1 ? '' : url.slice(index);
}

describe('documentUrl', () => {
  it('produces a query-only url for an unencrypted document', async () => {
    expect(await documentUrl('notes', null)).toBe('?doc=notes');
  });

  it('carries the key in the fragment', async () => {
    const key = await testDocumentKey('share');
    const url = await documentUrl('notes', key);

    expect(url.startsWith('?doc=notes#k=')).toBe(true);
  });

  it('produces a url that yields the SAME key back', async () => {
    // The oracle. Asserting the url "looks right" would pass for a fragment holding
    // something that is not a key at all, which is the actual bug this guards.
    const key = await testDocumentKey('round-trip');
    const url = await documentUrl('notes', key);
    const recovered = await readKeyFromFragment(fragmentOf(url));

    expect(recovered).not.toBeNull();
    expect(await exportDocumentKey(recovered as NonNullable<typeof recovered>)).toEqual(
      await exportDocumentKey(key),
    );
  });

  it('survives a round trip through a real URL parser', async () => {
    // `?doc=` and `#k=` are different namespaces in a URL, and this is the parser the
    // browser actually uses.
    const key = await testDocumentKey('parsed');
    const url = new URL(`https://example.test/${await documentUrl('notes', key)}`);
    const recovered = await readKeyFromFragment(url.hash);

    expect(recovered).not.toBeNull();
    expect(await exportDocumentKey(recovered as NonNullable<typeof recovered>)).toEqual(
      await exportDocumentKey(key),
    );
  });

  it('encodes a document id that needs it', async () => {
    // An id with a space would otherwise produce a url the browser truncates at the
    // space, silently opening a DIFFERENT document.
    const url = await documentUrl('two words', null);

    expect(url).toBe('?doc=two%20words');
    expect(new URL(`https://example.test/${url}`).searchParams.get('doc')).toBe('two words');
  });

  it('carries no key when there is none', async () => {
    expect(await documentUrl('notes', null)).not.toContain('#');
    expect(fragmentOf(await documentUrl('notes', null))).toBe('');
  });
});

describe('shareLink', () => {
  it('is absolute, so a pasted link works anywhere', async () => {
    // A relative link resolves against whatever page it is pasted into, which for a
    // shared document means somebody's browser instead of the server.
    const link = await shareLink('https://collab.example', 'notes', null);

    expect(link).toBe('https://collab.example/?doc=notes');
  });

  it('includes the fragment for an encrypted document', async () => {
    const key = await testDocumentKey('absolute');
    const link = await shareLink('https://collab.example', 'notes', key);
    const recovered = await readKeyFromFragment(fragmentOf(link));

    expect(recovered).not.toBeNull();
  });

  it('preserves a non-default port', async () => {
    // `origin` includes the port, so a local link is not silently pointed at production.
    const link = await shareLink('http://localhost:3001', 'notes', null);

    expect(link).toBe('http://localhost:3001/?doc=notes');
  });
});

describe('currentShareLink', () => {
  it('keeps the fragment, because the link IS the credential', () => {
    // Stripping the fragment - which `origin + pathname` would do - produces a link that
    // looks valid and cannot read anything. That is the specific mistake this guards.
    const href = 'https://collab.example/?doc=notes#k=abc123';

    expect(currentShareLink({ href })).toBe(href);
    expect(currentShareLink({ href })).toContain('#k=');
  });
});

describe('keys are per document', () => {
  it('generates a different key every time', async () => {
    // Two "New encrypted" clicks must not produce two documents readable with one link.
    const first = await documentUrl('a', await generateDocumentKey());
    const second = await documentUrl('b', await generateDocumentKey());

    expect(fragmentOf(first)).not.toBe(fragmentOf(second));
  });

  it('two documents never share a key', async () => {
    const keys = await Promise.all([generateDocumentKey(), generateDocumentKey()]);
    const encoded = await Promise.all(keys.map((key) => exportDocumentKey(key)));

    expect(encoded[0]).not.toEqual(encoded[1]);
  });
});
