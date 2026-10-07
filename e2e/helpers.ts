/**
 * Shared helpers for the browser scenarios.
 *
 * The interesting part of this file is {@link appUrl}. A bare URL mints a NEW document per
 * page load, so opening two contexts at "/" puts them on two different documents and every
 * collaboration test silently tests nothing. Two contexts must be given one explicit document
 * id.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

/** The CodeMirror editing surface. */
export function editor(page: Page): Locator {
  return page.locator('.cm-content');
}

/** Text currently rendered in the editor, with CodeMirror's trailing newline removed. */
export async function editorText(page: Page): Promise<string> {
  return (await editor(page).innerText()).replace(/\n$/u, '');
}

/** The sync indicator's visible label, for example "Synced" or "Offline - 3 queued". */
export async function syncState(page: Page): Promise<string> {
  return (await page.locator('#sync-status-text').textContent())?.trim() ?? '';
}

/** Wait until the app has connected and caught up. */
export async function waitForSynced(page: Page): Promise<void> {
  await page.locator('.cm-content').waitFor({ state: 'visible' });
  await expect.poll(() => syncState(page), { timeout: 30_000 }).toBe('Synced');
}

/**
 * A URL for a document both contexts can share.
 *
 * The id is supplied by the caller precisely because `/` mints a new one every time. See the
 * note at the top of this file.
 */
export function appUrl(documentId: string): string {
  return `/?doc=${documentId}`;
}

/** A fresh random document id, matching the server's pattern. */
export function newDocumentId(): string {
  return crypto.randomUUID();
}

/**
 * Focus the editor and type, one real key press per character.
 *
 * `locator.type` and `fill` are both wrong here. `fill` sets the value directly and bypasses
 * CodeMirror's input handling, so no CRDT operation is ever produced; `type` is used instead
 * because it dispatches real key events, which is the only thing that exercises the binding.
 */
export async function typeInto(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.type(text, { delay: 4 });
}

/** Type text into the middle of the existing content, at an element offset. */
export async function typeAtOffset(page: Page, offset: number, text: string): Promise<void> {
  await editor(page).click();
  await placeCaretAtOffset(page, offset);
  await page.keyboard.type(text, { delay: 4 });
}

/**
 * Move the caret `steps` graphemes from the start of the line.
 *
 * ---------------------------------------------------------------------------
 * THE UNIT IS A GRAPHEME, NOT A UTF-16 CODE UNIT, AND THAT IS MEASURED
 * ---------------------------------------------------------------------------
 * The parameter is named `steps` rather than `offset` because "offset" is exactly the wrong word
 * and using it here produced a failing test that looked like an application bug.
 *
 * In "a<emoji>b", CodeMirror's ArrowRight moves as follows - verified by driving the real
 * editor and reading the caret position back:
 *
 *     1 press   ->  a|<emoji>b
 *     2 presses ->  a<emoji>|<b
 *     3 presses ->  a<emoji>b|
 *
 * The emoji occupies TWO UTF-16 code units, so position 2 in that table is also offset 3 by the
 * other coordinate system. A caller reasoning in code units presses three times, lands after
 * the `b`, and the test fails on an assertion that the application was right about.
 *
 * Two of the three coordinate systems in this project collide here, which is the entire reason
 * patch 0001 existed:
 *   - the CRDT counts one element per Unicode code point
 *   - CodeMirror counts UTF-16 code units
 *   - ArrowRight steps by grapheme
 */
export async function placeCaretAtOffset(page: Page, steps: number): Promise<void> {
  await page.keyboard.press('Home');
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('ArrowRight');
  }
}

/**
 * Wait until both pages show exactly the same text, and return it.
 *
 * Convergence is the claim being tested, so this never returns a value the pages merely
 * happened to share for one poll - it keeps polling until they agree, and fails with the last
 * observed lengths if they never do.
 */
export async function waitForBothToAgree(a: Page, b: Page): Promise<string> {
  let last = 'never polled';
  await expect
    .poll(
      async () => {
        const [left, right] = await Promise.all([editorText(a), editorText(b)]);
        last = `${left.length} vs ${right.length}`;
        return left === right ? left : `differing (${last})`;
      },
      // `message` must be a plain string, so it cannot report the latest lengths. The failure
      // text below therefore carries them, which is where a reader looks anyway.
      { timeout: 45_000, message: `the two pages never converged; last lengths ${last}` },
    )
    .not.toMatch(/^differing/u);

  // Re-read rather than returning the poll's value: the poll's success value is the agreed
  // text, but reading it again keeps this honest if the assertion above is ever loosened.
  return editorText(a);
}

/**
 * Give a context its own identity, so two contexts are two anonymous users.
 *
 * This is the cross-browser case. Each context has separate storage, so it mints its own
 * subject, so it is a stranger to the other's document and would normally be refused with the
 * existence-oracle 404. Tests that need two independent identities call this and then grant
 * access deliberately.
 *
 * `addInitScript` is the mechanism because a context's storage must be cleared before ANY page
 * in it runs; doing it after `newPage()` would be too late, because the app has already read
 * and written storage by then.
 */
export async function mintIdentity(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.localStorage.removeItem('collab-editor:subject');
    window.localStorage.removeItem('collab-editor:last-document');
    window.sessionStorage.removeItem('collab-editor:site');
  });
}
