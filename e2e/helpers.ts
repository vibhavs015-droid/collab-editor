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

/** Where {@link watchCspViolations} records violations on the page's window. */
const CSP_LOG = '__cspViolations';

export interface CspViolation {
  directive: string;
  blocked: string;
}

/**
 * Record every Content-Security-Policy violation the page triggers.
 *
 * --------------------------------------------------------------------------------
 * WHY THIS RUNS IN THE PAGE AND NOT THROUGH THE CONSOLE
 * --------------------------------------------------------------------------------
 * The instructions ask to confirm ZERO violations in the console. Reading Playwright's
 * `console` events would be the obvious way, and it is the wrong one: whether a violation is
 * reported at all depends on the mode. Under `Content-Security-Policy-Report-Only` the browser
 * does NOT block the load, so the console usually stays silent and a clean console proves
 * nothing. Only an enforcing policy produces the errors that would be visible.
 *
 * The `securitypolicyviolation` event is the reliable signal: it fires in BOTH modes, on the
 * document the policy applies to, and it carries the directive and the blocked URI.
 *
 * `addInitScript` is what makes it complete. A listener attached after `goto` misses everything
 * the bundle does while it evaluates, which is most of what a CSP would object to.
 */
export async function watchCspViolations(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const log: CspViolation[] = [];
    Object.defineProperty(window, key, { value: log, configurable: true });

    // No cast: the DOM lib already types this event as SecurityPolicyViolationEvent, so
    // `event` is usable directly. An assertion here would be the kind of noise that trains a
    // reader to stop checking assertions.
    document.addEventListener('securitypolicyviolation', (event) => {
      log.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blocked: event.blockedURI,
      });
    });
  }, CSP_LOG);
}

/**
 * Assert nothing tripped the policy, naming the offenders.
 *
 * A bare "expected 0, received 2" leaves the reader with nothing to act on, and the whole
 * point of collecting this is to be told which directive is wrong.
 */
/** The violations a page has recorded. Throws if the page is already closed. */
export async function cspViolations(page: Page): Promise<CspViolation[]> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, CspViolation[]>)[key] ?? [],
    CSP_LOG,
  );
}

// Note there is deliberately no `openWatchedPage(context, url)` helper. An earlier draft had
// one, and the fixture in fixtures.ts made it redundant: every page in every context is watched
// automatically, so a spec that opened a page through this helper would believe it had opted in
// when it had actually opted out.

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
      //
      // 90 seconds, raised from 45. Measured on this machine: a 6,000-character paste takes
      // about 24 seconds to arrive on a second client, at roughly 1,000 operations every three
      // to four seconds. That is a real and pre-existing limit - replaying N operations is O(n^2)
      // in this CRDT, which is what T5 is about - and 45 seconds left no margin at all on a
      // loaded machine. Raising the timeout records the honest cost rather than hiding it.
      //
      // Before T4 this test could finish sooner, because the SENDER reported "Synced" as soon
      // as it had written the frames. It was not actually faster; it was less honest, and the
      // time it appeared to save was the time the peer was still spending.
      { timeout: 90_000, message: `the two pages never converged; last lengths ${last}` },
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
