/**
 * T1 scenarios b and f, the two that need a genuine server outage.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE STOP THE SERVER RATHER THAN CALLING `setOffline`
 * ---------------------------------------------------------------------------
 * Measured, not assumed. With `context.setOffline(true)`, with CDP
 * `Network.emulateNetworkConditions {offline: true}`, and with `routeWebSocket`, an ESTABLISHED
 * WebSocket in Chromium stays connected. In every one of those cases, keystrokes typed while
 * "offline" still arrived at the server, and `/api/documents/<id>` returned the text.
 *
 * A test written against those APIs asserts nothing: it would pass while the client was fully
 * online, and it would keep passing if offline handling were deleted entirely. The first draft
 * of scenario (b) did exactly that and failed on a real assertion - the indicator read
 * "Synced" the whole time - which is how the discrepancy was found.
 *
 * So the server process is genuinely stopped and restarted. See e2e/global-setup.ts.
 */

import { expect, test, type Page } from '@playwright/test';

import { appUrl, editor, editorText, newDocumentId, syncState, waitForSynced } from './helpers.js';
import { startServer, stopServer, teardownServer } from './global-setup.js';

/** Grant the co-owner identity access, so a second context is not a stranger. */
async function grantAccess(page: Page, documentId: string, subject: string): Promise<void> {
  const result = await page.evaluate(
    async ([rawId, rawSubject]) => {
      const id = String(rawId);
      const subjectValue = String(rawSubject);
      const own = localStorage.getItem('collab-editor:subject');

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
        body: JSON.stringify({ subject: subjectValue }),
      });

      return { status: granted.status, body: await granted.text() };
    },
    [documentId, subject],
  );

  expect(result.status, `grant failed: ${result.body}`).toBeLessThan(300);
}

test.describe('T1: a real outage', () => {
  test('b. typing during an outage reaches a second, independent context', async ({ browser }) => {
    const GRANTEE = 'e2e-co-owner-b';
    const ownerContext = await browser.newContext();
    const documentId = newDocumentId();

    const owner = await ownerContext.newPage();
    await owner.goto(appUrl(documentId));
    await waitForSynced(owner);

    await grantAccess(owner, documentId, GRANTEE);

    const peerContext = await browser.newContext();
    const peer = await peerContext.newPage();
    await peer.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(String(key), String(value));
      },
      ['collab-editor:subject', GRANTEE],
    );
    await peer.goto(appUrl(documentId));
    await waitForSynced(peer);

    // The outage is real: the process is gone, so nothing can be delivered.
    await stopServer();

    await editor(owner).click();
    await owner.keyboard.type('written while the server was gone', { delay: 20 });

    // The indicator must show that work is pending. Without it a user has no way to know their
    // edit is not on the server yet.
    await expect
      .poll(() => syncState(owner), { timeout: 45_000 })
      .toMatch(/queued|offline|pending/iu);

    // The local copy must still hold the text: offline-first means the edit is already applied
    // locally, whatever the network is doing.
    expect(await editorText(owner)).toContain('written while the server was gone');

    // The peer cannot have it, because the server never received it.
    expect(await editorText(peer)).not.toContain('written while the server was gone');

    await startServer();

    // After the outage the queued work must arrive at the peer, with no user action beyond
    // reconnecting.
    await expect
      .poll(async () => (await editorText(peer)).includes('written while the server was gone'), {
        timeout: 90_000,
      })
      .toBe(true);

    await expect.poll(() => syncState(owner), { timeout: 60_000 }).toBe('Synced');

    await ownerContext.close();
    await peerContext.close();
  });

  test('f. the indicator shows a pending state during an outage and returns to Synced', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(appUrl(newDocumentId()));
    await waitForSynced(page);

    expect(await syncState(page)).toBe('Synced');

    await stopServer();

    await editor(page).click();
    await page.keyboard.type('queued during the outage', { delay: 20 });

    await expect
      .poll(() => syncState(page), { timeout: 45_000 })
      .toMatch(/queued|offline|pending/iu);

    // The editor itself must be unaffected by the outage.
    expect(await editorText(page)).toContain('queued during the outage');
    expect(await editor(page).isVisible()).toBe(true);

    await startServer();

    // And it must come back to Synced on its own.
    await expect.poll(() => syncState(page), { timeout: 60_000 }).toBe('Synced');

    // The local log must reflect the flushed work rather than silently dropping it.
    const depth = await page.locator('#log-depth').textContent();
    expect(depth ?? '').toMatch(/\d+ local operations?/u);

    await context.close();
  });

  test.afterAll(async () => {
    await teardownServer();
  });
});
