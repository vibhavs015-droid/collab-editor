/**
 * T1 scenarios e and f: the UTF-16 regression and the sync indicator.
 *
 * Emoji are written as `\u{1F600}` escapes throughout, per the project convention for test
 * files. That matters here beyond style: the whole point of this scenario is that an emoji is
 * ONE character to the CRDT and TWO UTF-16 code units to the editor, and a literal emoji in the
 * source would make the test's own arithmetic depend on how the file was saved.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import {
  appUrl,
  editorText,
  mintIdentity,
  newDocumentId,
  placeCaretAtOffset,
  typeInto,
  waitForBothToAgree,
  waitForSynced,
} from './helpers.js';

const SMILE = '\u{1F600}';
const GRANTEE = 'test-co-owner';

async function grantAccess(page: Page, documentId: string): Promise<void> {
  const result = await page.evaluate(
    async ([rawId, rawSubject]) => {
      const id = String(rawId);
      const subject = String(rawSubject);
      const own = localStorage.getItem('collab-editor:subject');
      // Typed, because `no-unsafe-member-access` is a project rule and an untyped
      // `r.json()` would make every later property access an `any` in disguise.
      const session = (await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: own }),
      }).then((r) => r.json())) as { token: string };

      const granted = await fetch(`/api/documents/${id}/collaborators`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ subject }),
      });

      return { status: granted.status, body: await granted.text() };
    },
    [documentId, GRANTEE],
  );

  expect(result.status, `grant failed: ${result.body}`).toBeLessThan(300);
}

async function openPair(
  browser: Browser,
): Promise<{ a: Page; b: Page; close: () => Promise<void> }> {
  const ownerContext: BrowserContext = await browser.newContext();
  const documentId = newDocumentId();

  const a = await ownerContext.newPage();
  await a.goto(appUrl(documentId));
  await waitForSynced(a);

  await grantAccess(a, documentId);

  const peerContext: BrowserContext = await browser.newContext();
  await mintIdentity(peerContext);

  const b = await peerContext.newPage();
  await b.addInitScript(
    ([rawKey, rawValue]) => {
      window.localStorage.setItem(String(rawKey), String(rawValue));
    },
    ['collab-editor:subject', GRANTEE],
  );
  await b.goto(appUrl(documentId));
  await waitForSynced(b);

  return {
    a,
    b,
    close: async () => {
      await ownerContext.close();
      await peerContext.close();
    },
  };
}

test.describe('T1: astral characters', () => {
  test('e. editing next to an emoji converges, and Backspace removes only the emoji', async ({
    browser,
  }) => {
    const { a, b, close } = await openPair(browser);

    // "a", emoji, "b" - three CRDT elements, four UTF-16 code units.
    await typeInto(a, `a${SMILE}b`);
    await expect.poll(() => editorText(b), { timeout: 30_000 }).toBe(`a${SMILE}b`);

    // Place the caret BETWEEN the emoji and the "b".
    //
    // MEASURED, and this is the part that is easy to get wrong: CodeMirror's ArrowRight moves
    // by GRAPHEME, not by UTF-16 code unit. In "a<emoji>b" the caret goes
    //   1 press  -> a|<emoji>b
    //   2 presses -> a<emoji>|<b
    //   3 presses -> a<emoji>b|
    // so two presses is between the emoji and the b, even though that is editor offset 3 in
    // UTF-16 units. The first draft of this test pressed three times, landed after the b, and
    // produced "a<emoji>bX" - a test failure caused by the test's own arithmetic, not by the
    // application.
    //
    // The bug this guards is real: before patch 0001 an edit placed here landed at CRDT element
    // index 3 instead of 2, and the divergence was invisible because both screens showed what
    // the user typed while the replicas disagreed underneath.
    await placeCaretAtOffset(a, 2);
    await a.keyboard.type('X', { delay: 10 });

    const agreed = await waitForBothToAgree(a, b);
    expect(agreed).toBe(`a${SMILE}Xb`);
    expect(agreed.length, 'measured in UTF-16 units').toBe(5);

    // Backspace removes the character BEFORE the caret, which here is the emoji. So the
    // expected result is "aXb": the emoji is gone and the X survives.
    //
    // That is the regression. Before patch 0001 the deletion spanned the emoji and also removed
    // the character after it, broadcasting two delete operations for one Backspace - so this
    // would have produced "ab".
    //
    // (The first draft of this test asserted `a<emoji>b`, on the reasoning that Backspace
    // "removes the emoji and keeps the b". That is Delete, not Backspace. The failure is the
    // test being wrong about which key does what, and the assertion is corrected here rather
    // than loosened.)
    await placeCaretAtOffset(a, 2);
    await a.keyboard.press('Backspace');

    const afterDelete = await waitForBothToAgree(a, b);
    expect(afterDelete, 'Backspace removed the emoji and something else').toBe('aXb');
    expect([...afterDelete].length, 'surviving code points').toBe(3);

    await close();
  });
});
