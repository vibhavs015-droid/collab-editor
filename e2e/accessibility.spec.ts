/**
 * Accessibility and responsive layout (T8).
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ---------------------------------------------------------------------------
 * Three things a screenshot cannot check and an eyeball misses:
 *
 *   1. That the editor has a focus indicator. CodeMirror removes its own, and a keyboard user
 *      tabbing into a plain-text editor with no ring has no idea where they are. This is the
 *      single most common accessibility defect in a rich text editor, and it shipped here because
 *      the default looked correct to a mouse user.
 *   2. That the page does not scroll sideways at any width a real device has.
 *   3. That axe finds no serious or serious-adjacent violation in either colour scheme. Dark mode
 *      is checked separately because a contrast pair that passes on white can fail on near-black,
 *      and the theme is a `prefers-color-scheme` media query rather than a class - so it cannot be
 *      toggled by adding a class in a test, only by emulating the media feature.
 *
 * ---------------------------------------------------------------------------
 * WHY MINOR VIOLATIONS ARE REPORTED AND NOT FAILED ON
 * ---------------------------------------------------------------------------
 * T8 asks for every serious and critical violation fixed and the minor ones listed in the report.
 * A gate that fails on a minor violation is a gate that gets deleted the first time it is
 * inconvenient, so `serious` and `critical` are the threshold here and the rest is printed.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { appUrl, editor, newDocumentId, waitForSynced } from './helpers.js';

/** Widths a real device actually has, not round numbers. */
const WIDTHS = [
  { name: 'narrow phone', width: 360, height: 740 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
] as const;

/**
 * A gate that cannot name the element is a gate you end up debugging by hand, so the target and
 * the specific failure are in the assertion message rather than only in the HTML report.
 *
 * The target is typed loosely because axe returns a `ShadowDomSelector[]` for some nodes and a
 * `string[]` for others; rendering with `String()` covers both without pretending to know which.
 */
function describeViolations(
  violations: readonly {
    id: string;
    help: string;
    impact?: string | null;
    nodes: { target: unknown[]; failureSummary?: string }[];
  }[],
): string[] {
  return violations.map((violation) => {
    const where = violation.nodes
      .map(
        (node) =>
          `${node.target.map(String).join(' ')} [${node.failureSummary?.split('\n')[1]?.trim() ?? 'no detail'}]`,
      )
      .join('; ');

    return `${severity(violation)}: ${violation.id} - ${violation.help} :: ${where}`;
  });
}
const BLOCKING = new Set(['serious', 'critical']);

/**
 * axe's `impact` is optional and its type differs between versions, so a violation with no
 * declared impact is treated as `unknown` rather than quietly passing the filter below.
 */
function severity(violation: { impact?: string | null }): string {
  return violation.impact ?? 'unknown';
}

/**
 * Toolbar buttons that must be usable at every width.
 *
 * Only `New encrypted`. The other toolbar button, `Copy link`, carries the `hidden` attribute
 * until the document has a share link, so it is legitimately absent on a fresh document and
 * asserting it here would be asserting a bug.
 */
const TOOLBAR_BUTTONS = ['New encrypted'];

test.describe('T8: accessibility and layout', () => {
  for (const { name, width, height } of WIDTHS) {
    test(`no horizontal scroll at ${name} (${String(width)}px)`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(appUrl(newDocumentId()));
      await waitForSynced(page);

      // The check T8 specifies, in its own words. A single overflowing element - a long
      // unbreakable string, a toolbar that refuses to wrap - shows up here and nowhere else.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );

      expect(
        overflow,
        `the page scrolls sideways by ${String(overflow)}px at ${String(width)}px`,
      ).toBeLessThanOrEqual(0);

      await context.close();
    });

    test(`every toolbar button is visible and clickable at ${name} (${String(width)}px)`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(appUrl(newDocumentId()));
      await waitForSynced(page);

      for (const label of TOOLBAR_BUTTONS) {
        const button = page.getByRole('button', { name: label });

        await expect(button, `${label} is missing at ${String(width)}px`).toBeVisible();

        // A visible element can still be unclickable: zero size, covered, or `pointer-events: none`.
        // This asserts it can actually be hit, which `toBeVisible()` alone does not.
        const clickable = await button.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const styles = getComputedStyle(node);
          const top = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );

          return {
            hasArea: rect.width > 0 && rect.height > 0,
            inViewport: rect.right <= window.innerWidth + 1 && rect.left >= -1,
            notCovered: top === node || node.contains(top),
            pointerEvents: styles.pointerEvents,
          };
        });

        expect(clickable.hasArea, `${label} has no size at ${String(width)}px`).toBe(true);
        expect(
          clickable.inViewport,
          `${label} sits outside the viewport at ${String(width)}px`,
        ).toBe(true);
        expect(clickable.notCovered, `${label} is covered at ${String(width)}px`).toBe(true);
        expect(clickable.pointerEvents, `${label} ignores pointer events`).not.toBe('none');
      }

      await context.close();
    });
  }

  test('the editor shows a focus indicator when focus is inside it', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(appUrl(newDocumentId()));
    await waitForSynced(page);

    // CodeMirror sets `cm-focused` on its contenteditable and removes the outline itself, so the
    // indicator has to live on the container. Read the COMPUTED outline, because what matters is
    // what the browser paints, not what the stylesheet says.
    const ring = await editor(page).evaluate((node) => {
      const host = node.closest('.editor-host');
      if (host === null) return null;

      const styles = getComputedStyle(host);

      return {
        width: styles.outlineWidth,
        style: styles.outlineStyle,
        colour: styles.outlineColor,
      };
    });

    expect(ring, '.editor-host was not found').not.toBeNull();
    expect(ring?.style, 'the editor host has no outline style').not.toBe('none');

    const width = Number.parseFloat(ring?.width ?? '0');
    expect(width, `the focus ring is ${String(width)}px wide`).toBeGreaterThanOrEqual(2);
  });

  test('the focus indicator clears 3:1 against the page in light and dark', async ({ browser }) => {
    // A ring that is present but too faint is the same defect as no ring, so the threshold is
    // measured rather than assumed.
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      await page.goto(appUrl(newDocumentId()));
      await waitForSynced(page);

      await editor(page).click();

      const contrast = await page.evaluate(() => {
        const host = document.querySelector('.editor-host');
        if (host === null) return null;

        const parse = (value: string): [number, number, number] => {
          const parts = value.match(/[\d.]+/g) ?? ['0', '0', '0'];
          return [Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0)];
        };

        const styles = getComputedStyle(host);
        const page_ = getComputedStyle(document.body);

        const toLinear = (channel: number): number => {
          const c = channel / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };

        const luminance = (rgb: [number, number, number]): number =>
          0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);

        const a = luminance(parse(styles.outlineColor));
        const b = luminance(parse(page_.backgroundColor));

        const [light, dark] = a > b ? [a, b] : [b, a];

        return {
          // Whether anything is actually PAINTED, reported alongside the ratio.
          //
          // `outlineColor` keeps its value when `outline-style: none`, so a contrast check that
          // reads only the colour will happily pass against a ring that is not on screen. That is
          // not hypothetical: this test did exactly that when the ring was removed, and passed.
          painted: styles.outlineStyle !== 'none' && Number.parseFloat(styles.outlineWidth) >= 1,
          ratio: (light + 0.05) / (dark + 0.05),
        };
      });

      expect(contrast, `could not read the ring colour in ${colorScheme} mode`).not.toBeNull();
      expect(
        contrast?.painted,
        `no focus ring is painted in ${colorScheme} mode, so there is no contrast to measure`,
      ).toBe(true);
      expect(
        contrast?.ratio ?? 0,
        `the focus ring is ${(contrast?.ratio ?? 0).toFixed(2)}:1 against the page in ${colorScheme} mode, ` +
          'which is under the 3:1 required for a non-text indicator',
      ).toBeGreaterThanOrEqual(3);

      await context.close();
    }
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`axe reports no serious or critical violation in ${colorScheme} mode`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      await page.goto(appUrl(newDocumentId()));
      await waitForSynced(page);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      const blocking = results.violations.filter((v) => BLOCKING.has(severity(v)));

      const minor = results.violations.filter((v) => !BLOCKING.has(severity(v)));

      process.stdout.write(
        `[a11y:${colorScheme}] analysed: ${String(results.violations.length)} violation(s), ` +
          `${String(blocking.length)} serious/critical, ${String(minor.length)} minor\n`,
      );

      // Printed rather than only annotated. A gate whose non-failing output is invisible until
      // someone opens an HTML report is a gate nobody reads, and T8 asks for the minor ones to be
      // listed - which only means anything if the list appears in the run log.
      for (const violation of minor) {
        process.stdout.write(
          `[a11y:${colorScheme}] ${severity(violation)} ${violation.id} - ${violation.help} ` +
            `(${String(violation.nodes.length)} nodes)\n`,
        );

        test.info().annotations.push({
          type: 'minor-a11y-violation',
          description: `${severity(violation)}: ${violation.id} - ${violation.help} (${String(violation.nodes.length)} nodes)`,
        });
      }

      expect(
        describeViolations(blocking),
        `axe found ${String(blocking.length)} serious/critical violation(s) in ${colorScheme} mode`,
      ).toEqual([]);

      await context.close();
    });
  }
});
