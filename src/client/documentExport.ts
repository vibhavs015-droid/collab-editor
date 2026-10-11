/**
 * Saving the current document to a file.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 * Same reasoning as `shareLink.ts`, and for the same reason: `main.ts` runs side
 * effects on import, so a function worth testing cannot live there. The filename
 * rule below is the part with edge cases in it, and edge cases need tests, so it is
 * pure and it is here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILENAME IS SANITISED AT ALL
 * ---------------------------------------------------------------------------
 * The title is typed by a person and goes straight into a `download` attribute,
 * which the browser turns into a suggested filename on the user's own disk. Two
 * consequences, one cosmetic and one not:
 *
 *   - A title containing a path separator would otherwise be at the mercy of the
 *     browser's path handling. Stripping every character outside a conservative
 *     set means the name cannot be anything but a single filename component.
 *   - A title that sanitises to nothing at all would produce a file called `.md`,
 *     which on several platforms is not a name a user can find again. Hence the
 *     fallback rather than the empty string.
 *
 * Non-ASCII titles lose their non-ASCII characters. That is deliberate, not an
 * oversight: the character class is what keeps the result a single safe path
 * component, and a title written in Japanese or emoji would otherwise be the one
 * case that could produce a name the filesystem rejects. The document CONTENT is
 * untouched - only the filename is reduced.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

/** Longest filename we will suggest, in characters. */
const MAX_FILENAME_LENGTH = 80;

/** Used when the title sanitises away to nothing. */
const FALLBACK_FILENAME = 'document';

/**
 * The filename to save the document under, derived from its title.
 *
 * @param title the document title, exactly as the user typed it. May be empty,
 *   may contain anything.
 *
 * @returns a single filename component ending in `.md`, never empty and never
 *   starting with a dot.
 *
 * Leading dots are stripped as well as the characters themselves. A title of
 * `..` passes a character-class filter unchanged, and while a browser will not
 * write outside the download directory over it, a file the user cannot see in
 * their downloads folder is not a useful result.
 */
export function exportFilename(title: string): string {
  const safe = title
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, MAX_FILENAME_LENGTH)
    .replace(/^\.+/, '');

  return `${safe === '' ? FALLBACK_FILENAME : safe}.md`;
}

/**
 * The bytes to save.
 *
 * A `text/plain` type rather than `text/markdown`, deliberately: the document is
 * plain text, and declaring it as Markdown would invite a viewer to render it,
 * which is not what this file is for. The `.md` extension is what names the file
 * for other tools.
 *
 * @param text the replica text, which is the document.
 */
export function exportBlob(text: string): Blob {
  return new Blob([text], { type: 'text/plain;charset=utf-8' });
}

/**
 * Hand the document to the browser as a download.
 *
 * @param doc the document to create the click in, passed in rather than read
 *   from a global so this stays testable without one.
 * @param text the replica text.
 * @param title the document title, which becomes the filename.
 *
 * The object URL is revoked immediately after the click. A download is queued by
 * the click itself, not by the URL staying alive, so revoking synchronously is
 * safe - and not revoking leaks the whole document in memory for the life of the
 * page. The anchor is removed for the same reason. Neither is left behind.
 */
export function startDownload(doc: Document, text: string, title: string): void {
  const url = URL.createObjectURL(exportBlob(text));
  const anchor = doc.createElement('a');

  anchor.href = url;
  anchor.download = exportFilename(title);
  anchor.hidden = true;

  doc.body.append(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}
