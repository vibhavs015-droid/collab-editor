/**
 * FEAT-1: saving the document to a file.
 *
 * Emoji are written as `\u{1F600}` escapes throughout, per the project convention for test
 * files. That is not only style here: the exported file must contain the emoji BYTE FOR BYTE,
 * and a literal emoji in the source would make the test's own expectation depend on how this
 * file was saved - which is the thing being checked.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { readFile } from 'node:fs/promises';

import { expect, test } from './fixtures.js';
import { appUrl, editorText, newDocumentId, typeInto, waitForSynced } from './helpers.js';

/** Read a captured download as UTF-8 text. */
async function downloadText(download: { path(): Promise<string> }): Promise<string> {
  return readFile(await download.path(), 'utf8');
}

test.describe('FEAT-1: download the document', () => {
  test('saves the editor text, emoji included, under a filename from the title', async ({
    page,
  }) => {
    const documentId = newDocumentId();
    await page.goto(appUrl(documentId));
    await waitForSynced(page);

    await page.locator('#doc-title').fill('Design notes');
    // An emoji between ordinary characters, which is the case that goes wrong first: it is
    // one CRDT element and two UTF-16 code units, so anything that measures the wrong thing
    // will still pass on a pure-ASCII document.
    await typeInto(page, `before ${'\u{1F600}'} after\nsecond line`);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download-markdown').click(),
    ]);

    expect(await downloadText(download)).toBe(await editorText(page));
    // The sanitisation allows dots, so "Design notes" loses only the space.
    expect(download.suggestedFilename()).toBe('Designnotes.md');
  });

  test('the saved file is the document, not the editor view of it', async ({ page }) => {
    const documentId = newDocumentId();
    await page.goto(appUrl(documentId));
    await waitForSynced(page);

    await typeInto(page, 'alpha');
    await typeInto(page, ' beta');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download-markdown').click(),
    ]);

    // Joined rather than overwritten, so a comparison against the editor catches a file that
    // captured only the last keystroke.
    expect(await downloadText(download)).toBe('alpha beta');
  });

  test('falls back to a usable filename when the title cannot be one', async ({ page }) => {
    const documentId = newDocumentId();
    await page.goto(appUrl(documentId));
    await waitForSynced(page);

    // A title made entirely of characters the filter removes. A file called ".md" is one the
    // user cannot find in their downloads folder afterwards.
    await page.locator('#doc-title').fill('///');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download-markdown').click(),
    ]);

    expect(download.suggestedFilename()).toBe('document.md');
  });

  test('works with no connection, which is when a copy is most wanted', async ({
    page,
    context,
  }) => {
    const documentId = newDocumentId();
    await page.goto(appUrl(documentId));
    await waitForSynced(page);

    await typeInto(page, 'saved before the network went away');

    await context.setOffline(true);
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#download-markdown').click(),
      ]);

      expect(await downloadText(download)).toBe('saved before the network went away');
    } finally {
      await context.setOffline(false);
    }
  });
});
