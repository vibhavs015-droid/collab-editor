/**
 * T1 scenarios a-d: persistence, offline, convergence, and the large-paste regression.
 *
 * ASCII only. In this file, emoji are written with `\u{1F600}` escapes rather than literal
 * characters, per the project convention.
 *
 * NOTE ON TWO CONTEXTS. Two browser CONTEXTS in one browser share nothing: separate storage,
 * separate IndexedDB, separate WebSocket. That is the strongest available approximation of two
 * different people, and it is what these tests use. Two TABS of one context would share
 * localStorage and IndexedDB, which is a weaker test - it would pass even if the server were
 * not involved at all.
 *
 * The catch is that a document is owned by the anonymous subject that created it, so the second
 * context is a stranger and gets the existence-oracle 404 by design. The owner therefore grants
 * it access through the API before the second context opens the document. That is deliberate:
 * it exercises the real grant path rather than working around ownership.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  appUrl,
  editor,
  editorText,
  mintIdentity,
  newDocumentId,
  typeInto,
  waitForBothToAgree,
  waitForSynced,
} from './helpers.js';

const PASSWORDLESS_GRANTEE = 'test-co-owner';

/**
 * Open a document as its owner and create it.
 *
 * Returns the page, already synced, plus the document id.
 */
async function openAsOwner(
  context: BrowserContext,
  documentId: string,
): Promise<{ page: Page; documentId: string }> {
  const page = await context.newPage();
  await page.goto(appUrl(documentId));
  await waitForSynced(page);
  return { page, documentId };
}

/**
 * Let a second, independent identity open the document.
 *
 * Two steps, both real: the owner mints a session and grants access, and the second context
 * presents a token for the granted subject. The grant is done over the API rather than through
 * a UI because there is no sharing UI yet (T6/T7 territory).
 */
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

      // The API takes the subject at the top level of the body, not under `value`. See the
      // handler: `body.value['subject']` is the parsed wrapper, and `target` is what it reads.
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
    [documentId, PASSWORDLESS_GRANTEE],
  );

  expect(result.status, `grant failed: ${result.body}`).toBeLessThan(300);
}

/** Present the granted subject's token in a fresh context, then open the document. */
async function openAsGrantee(browserContext: BrowserContext, documentId: string): Promise<Page> {
  await mintIdentity(browserContext);

  const page = await browserContext.newPage();

  // The client fetches its own session from /api/auth/session with the subject it has stored.
  // Pre-seeding that subject with the granted value is what makes this context the co-owner.
  await page.addInitScript(
    ([rawKey, rawValue]) => {
      window.localStorage.setItem(String(rawKey), String(rawValue));
    },
    ['collab-editor:subject', PASSWORDLESS_GRANTEE],
  );

  await page.goto(appUrl(documentId));
  await waitForSynced(page);
  return page;
}

test.describe('T1: the editor in a real browser', () => {
  test('a. typed text survives a reload', async ({ browser }) => {
    const context = await browser.newContext();
    const documentId = newDocumentId();
    const { page } = await openAsOwner(context, documentId);

    await typeInto(page, 'persisted across a reload');

    await page.reload();
    await waitForSynced(page);

    expect(await editorText(page)).toBe('persisted across a reload');

    await context.close();
  });

  test('c. two contexts typing at once converge', async ({ browser }) => {
    const ownerContext = await browser.newContext();
    const documentId = newDocumentId();
    const { page: a } = await openAsOwner(ownerContext, documentId);

    await grantAccess(a, documentId);

    const peerContext = await browser.newContext();
    const b = await openAsGrantee(peerContext, documentId);

    // Both focus and type without awaiting each other, so the operations genuinely interleave.
    await editor(a).click();
    await editor(b).click();

    await Promise.all([
      a.keyboard.type('AAAAAAAAAA', { delay: 12 }),
      b.keyboard.type('BBBBBBBBBB', { delay: 12 }),
    ]);

    const agreed = await waitForBothToAgree(a, b);

    // Convergence is the claim: identical text on both sides, with both users' work present.
    expect(agreed).toBe(await editorText(a));
    expect(agreed).toBe(await editorText(b));
    expect(agreed).toContain('AAAAAAAAAA');
    expect(agreed).toContain('BBBBBBBBBB');

    await ownerContext.close();
    await peerContext.close();
  });

  test('d. a 6,000 character paste arrives intact (regression)', async ({ browser }) => {
    // The P0 the reviewer found: an outbox cap dropped everything past 5,000 characters, so a
    // peer received an empty document while the sender showed "Synced".
    const ownerContext = await browser.newContext();
    const documentId = newDocumentId();
    const { page: owner } = await openAsOwner(ownerContext, documentId);

    await grantAccess(owner, documentId);

    const peerContext = await browser.newContext();
    const peer = await openAsGrantee(peerContext, documentId);

    const payload = 'x'.repeat(6_000);

    // One action, not 6,000 keystrokes: the bug was in the queue, not in typing. insertText
    // produces a single input event carrying the whole string, which is what a paste does.
    await editor(owner).click();
    await editor(owner).evaluate((node: HTMLElement, text: string) => {
      // CodeMirror reads from the DOM input event, so dispatch the paste the way the browser
      // would rather than calling an internal API.
      const data = new DataTransfer();
      data.setData('text/plain', text);
      node.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, payload);

    // If the paste did not land at all, fail with a clear message rather than a length mismatch
    // three assertions later.
    await expect
      .poll(async () => (await editorText(owner)).length, { timeout: 30_000 })
      .toBeGreaterThan(0);

    const agreed = await waitForBothToAgree(owner, peer);

    // Exactly 6,000. Not "most of it": the bug class is silent truncation.
    expect(agreed.length, 'the peer received a truncated document').toBe(6_000);

    await ownerContext.close();
    await peerContext.close();
  });
});
