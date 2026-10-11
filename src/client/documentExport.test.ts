import { describe, expect, it } from 'vitest';

import { exportBlob, exportFilename } from './documentExport.js';

describe('exportFilename', () => {
  it('keeps a title that is already safe', () => {
    expect(exportFilename('Design notes')).toBe('Designnotes.md');
    expect(exportFilename('v1.2_final-draft')).toBe('v1.2_final-draft.md');
  });

  it('strips characters that are not in the allowed set', () => {
    // The point of the filter: the result is one path component, whatever was typed.
    expect(exportFilename('a/b')).toBe('ab.md');
    expect(exportFilename('a\\b')).toBe('ab.md');
    expect(exportFilename('..')).toBe('document.md');
    expect(exportFilename('a:b*c?d')).toBe('abcd.md');
  });

  it('falls back rather than producing an unusable name', () => {
    expect(exportFilename('')).toBe('document.md');
    expect(exportFilename('   ')).toBe('document.md');
    // Survives a character-class filter, but names a file no user can find.
    expect(exportFilename('...')).toBe('document.md');
    expect(exportFilename('.hidden')).toBe('hidden.md');
  });

  it('caps the length', () => {
    const long = 'a'.repeat(200);
    const name = exportFilename(long);

    // 80 characters plus the extension.
    expect(name).toBe(`${'a'.repeat(80)}.md`);
  });

  it('reduces a non-ASCII title rather than passing it through', () => {
    // Deliberate. The character class is what keeps this a single safe component.
    expect(exportFilename('Notes')).toBe('Notes.md');
    expect(exportFilename('a\u00e9b')).toBe('ab.md');
  });
});

describe('exportBlob', () => {
  it('carries the document text', async () => {
    const blob = exportBlob('hello');

    expect(await blob.text()).toBe('hello');
  });

  it('preserves emoji exactly', async () => {
    // The content is never reduced. Only the FILENAME is sanitised, and a document
    // that lost its emoji on the way out would be a worse bug than a long filename.
    const text = 'a\u{1f600}b\nsecond line';
    const blob = exportBlob(text);

    expect(await blob.text()).toBe(text);
  });

  it('declares plain text, not markdown', () => {
    // The extension names the file for other tools; declaring it as Markdown would
    // invite a viewer to render text that was never authored as Markdown.
    expect(exportBlob('x').type).toBe('text/plain;charset=utf-8');
  });
});
