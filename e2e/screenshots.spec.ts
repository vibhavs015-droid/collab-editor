/**
 * Screenshots at the three widths T8 asks for, in both colour schemes.
 *
 * Run: npx playwright test e2e/screenshots.spec.ts
 * Output: test-results/t8-screenshots/
 *
 * Not an assertion suite. This exists so the three widths can be LOOKED AT, which is the part
 * axe and the overflow check cannot do: they prove nothing is broken, not that the result is
 * usable. A layout can pass every automated check and still put the toolbar somewhere a thumb
 * would not find it.
 *
 * Kept separate from accessibility.spec.ts so the ordinary browser run does not pay for 6 extra
 * page loads, and so a screenshot failure is obviously not an accessibility failure.
 */

import { expect, test } from '@playwright/test';

import { appUrl, newDocumentId, waitForSynced } from './helpers.js';
import { ensureServerUp } from './global-setup.js';

/**
 * Playwright runs spec files in alphabetical order: accessibility, astral, editor, outage,
 * screenshots.
 *
 * `outage.spec.ts` stops the shared server in its `afterAll`, so anything sorted after it starts
 * with no server at all. Every screenshot test failed with ERR_CONNECTION_REFUSED until this was
 * added - and it passed when the file was run on its own, which is exactly the kind of failure that
 * gets blamed on the environment instead of the ordering.
 */
test.beforeEach(async () => {
  await ensureServerUp();
});

const VIEWS = [
  { name: '360-narrow-phone', width: 360, height: 740 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1280-laptop', width: 1280, height: 800 },
] as const;

test.describe('T8: screenshots', () => {
  for (const { name, width, height } of VIEWS) {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`${name} ${colorScheme}`, async ({ browser }, testInfo) => {
        const context = await browser.newContext({
          viewport: { width, height },
          colorScheme,
          // A document with text in it. An empty editor shows only a placeholder and a gutter,
          // which is not what the layout has to survive.
          reducedMotion: 'reduce',
        });

        const page = await context.newPage();
        await page.goto(appUrl(newDocumentId()));
        await waitForSynced(page);

        await page.keyboard.type(
          'The quick brown fox jumps over the lazy dog. ' +
            'A line long enough to show whether the editor wraps rather than scrolls sideways.',
        );

        // Focus the editor, so the focus ring is IN the screenshot. That ring is the thing this
        // task added, and a screenshot that does not show it proves nothing about it.
        await page.locator('.cm-content').click();

        const shot = await page.screenshot({
          fullPage: false,
          path: testInfo.outputPath(`${name}-${colorScheme}.png`),
        });

        expect(
          shot.byteLength,
          'the screenshot is empty, so the page rendered nothing',
        ).toBeGreaterThan(1000);

        await context.close();
      });
    }
  }
});
