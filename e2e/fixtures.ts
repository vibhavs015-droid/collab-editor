/**
 * The `test` object the browser specs use.
 *
 * ---------------------------------------------------------------------------------
 * WHY THIS INSTEAD OF PLAIN `test` FROM '@playwright/test'
 * ---------------------------------------------------------------------------------
 * The instructions for T2 require confirming ZERO Content-Security-Policy violations across
 * all six T1 scenarios. There are eleven pages across those six scenarios and they are created
 * ad hoc, from contexts opened inside each spec rather than from the built-in `page` fixture.
 * A per-spec assertion would have to be written eleven times, and any scenario added later
 * would silently be the one not checked.
 *
 * So the check is an auto fixture over `browser`: it wraps `newContext`, and every page in
 * every context gets the `securitypolicyviolation` listener attached before its first
 * navigation. An `afterEach` then asserts on every page the test opened. Forgetting to check
 * is no longer possible, which matters for a control whose whole value is being applied
 * everywhere.
 *
 * The alternative - reading Playwright's `console` events - is what the instructions say, and
 * it does not work under `Content-Security-Policy-Report-Only`: the browser does not block the
 * load, so the console stays quiet whether or not the policy was violated. That is the reason
 * the listener is registered on the document event instead. See watchCspViolations in
 * helpers.ts.
 *
 * ---------------------------------------------------------------------------------
 * WHY THE SNAPSHOT IS TAKEN AT close() AND NOT IN afterEach
 * ---------------------------------------------------------------------------------
 * The specs close their contexts at the end of each test, which is correct hygiene. An
 * afterEach that then called `page.evaluate` got, on all six scenarios:
 *
 *     Error: page.evaluate: Target page, context or browser has been closed
 *
 * which is a check that fails for a reason that has nothing to do with the policy. So
 * `close()` is wrapped too, and the violations are read into a snapshot at the moment the page
 * is still alive. afterEach then asserts on the snapshot, falling back to a live read only for
 * a page whose context was never closed.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';

import { cspViolations, watchCspViolations, type CspViolation } from './helpers.js';

/**
 * Violations per page, captured while the page was still open.
 *
 * A Map rather than an array because a snapshot can only be taken once per page: reading again
 * after the close would fail, and overwriting a good snapshot with a failed one would turn a
 * passing check into an error.
 */
const snapshots = new Map<Page, CspViolation[]>();

/** Pages opened during the current test, in creation order. */
const openPages: Page[] = [];

export const test = base.extend<{ watchedBrowser: Browser }>({
  watchedBrowser: [
    async ({ browser }, use) => {
      const original = browser.newContext.bind(browser);

      // `newContext` is overloaded in Playwright. These wrappers keep the widened overloads
      // and simply delegate, so a spec calling `newContext({ viewport })` still typechecks.
      browser.newContext = async (options?: BrowserContextOptions) => {
        const context = await original(options);

        const originalNewPage = context.newPage.bind(context);
        const originalClose = context.close.bind(context);

        context.newPage = async (...pageArgs: Parameters<BrowserContext['newPage']>) => {
          const page = await originalNewPage(...pageArgs);

          // Registered before the caller's first goto, which is the only order that catches
          // violations raised while the bundle evaluates. The listener itself lives in
          // helpers.ts so there is one copy of it, not one per caller.
          await watchCspViolations(page);

          openPages.push(page);
          return page;
        };

        // Snapshot BEFORE closing, because afterwards the page cannot be asked anything.
        context.close = async (...closeArgs: Parameters<BrowserContext['close']>) => {
          for (const page of context.pages()) {
            if (!snapshots.has(page)) {
              snapshots.set(page, await readViolations(page));
            }
          }

          return originalClose(...closeArgs);
        };

        return context;
      };

      await use(browser);
    },
    // Only used for its side effect on `browser`; the specs keep taking `browser` themselves.
    { auto: true },
  ],
});

/**
 * Read the page's violation log, or report that it could not be read.
 *
 * The catch is not cosmetic. A page that throws here would otherwise look exactly like a page
 * with no violations, and "no violations" is the outcome the whole check exists to produce -
 * so the one case that must never be confused with success is handled explicitly.
 */
async function readViolations(page: Page): Promise<CspViolation[]> {
  try {
    return await cspViolations(page);
  } catch {
    return [
      {
        directive: 'unreadable',
        blocked:
          'the violation log could not be read from this page, so the CSP check did NOT run; ' +
          'this is a harness failure, not a clean result',
      },
    ];
  }
}

test.afterEach(async () => {
  const pages = openPages.splice(0, openPages.length);

  for (const page of pages) {
    const violations = snapshots.get(page) ?? (await readViolations(page));

    expect(
      violations,
      `Content-Security-Policy violations:\n${violations
        .map((v) => `  ${v.directive} blocked ${v.blocked}`)
        .join('\n')}`,
    ).toEqual([]);
  }

  snapshots.clear();
});

export { expect };
