/**
 * Shared and client code must not import Node builtins the browser bundle stubs.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * `src/shared/subject.ts` had `newSubject()` built on `randomBytes` from `node:crypto`. That
 * is correct on the server. In the browser it is silently broken: Vite replaces `node:crypto`
 * with an empty stub for the client bundle, so the built code reads
 *
 *     function r(){ return (0,t.randomBytes)(16).toString('base64url') }
 *
 * with `t` being `{ exports: {} }`. Calling it throws `randomBytes is not a function`.
 *
 * The caller caught the TypeError and fell back, so the feature it implemented - a durable
 * per-browser identity - was quietly OFF in the only environment it exists for. Nothing
 * reported it. All 901 tests passed, because every one of them runs under Node, where
 * `node:crypto` works perfectly.
 *
 * Found by loading the built page in a real browser and reading `localStorage`.
 *
 * ---------------------------------------------------------------------------
 * WHY A SOURCE SCAN IS THE RIGHT SHAPE FOR THIS
 * ---------------------------------------------------------------------------
 * The failure needs a BROWSER to reproduce, and this suite runs in Node. A unit test cannot
 * see it. What it can do is assert the property that makes it impossible: shared and client
 * modules import nothing the browser cannot provide.
 *
 * So this reads the source rather than executing it. That is normally the weaker kind of test,
 * and it is worth being honest about why it is the right one here - the alternative is no
 * coverage at all until someone opens a browser again.
 *
 * The server is deliberately exempt: `node:crypto`, `node:http` and friends are correct there,
 * and `src/server` never ships to a browser.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { newSubject } from './subject.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Directories whose code is bundled for the browser. */
const BROWSER_DIRS = ['src/shared', 'src/client', 'src/core'];

/**
 * Node builtins that a bundler replaces with an empty stub.
 *
 * The list is not exhaustive - `node:fs`, `node:path`, `node:http` and `node:child_process`
 * are equally unavailable - but it covers the ones plausibly reached for by "I need some
 * randomness or hashing", which is how this happened. A missed builtin means a missed test,
 * not a wrong result, so an incomplete list degrades honestly.
 *
 * `node:buffer` is absent on purpose: it is polyfilled by bundlers and is genuinely usable.
 */
const STUBBED_BUILTINS = [
  'node:crypto',
  'node:fs',
  'node:path',
  'node:os',
  'node:http',
  'node:https',
  'node:net',
  'node:url',
  'node:zlib',
  'node:stream',
  'node:worker_threads',
  'node:child_process',
  'node:cluster',
  'node:dns',
  'node:tls',
];

/**
 * Every .ts file under the given directories that could actually reach a browser.
 *
 * Test files are excluded, and not as a convenience: vitest never bundles them, so they are
 * not part of the client graph. Excluding them also exempts this file, which needs node:fs
 * and node:path to read the source - otherwise the scanner reports itself on every run and
 * trains you to ignore it.
 */
function sourceFiles(dirs: readonly string[]): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);

      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
        found.push(full);
      }
    }
  };

  for (const dir of dirs) {
    walk(resolve(ROOT, dir));
  }

  return found;
}

/**
 * Import specifiers in a file that name a Node builtin.
 *
 * Only real import/export statements and `await import(...)`, so a builtin mentioned in a
 * comment - which this very file does extensively - is not reported. A regex over the whole
 * file would flag every comment and be useless within a day.
 */
function builtinImports(source: string): string[] {
  const specifiers: string[] = [];

  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/gu,
    /\bimport\s+['"]([^'"]+)['"]/gu,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];

      if (specifier !== undefined && STUBBED_BUILTINS.includes(specifier)) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

const files = sourceFiles(BROWSER_DIRS);

describe('code that ships to the browser', () => {
  it('finds the source files it is checking', () => {
    // A scan that matched nothing would pass every assertion below and prove nothing, which
    // is the failure mode this file exists to avoid. Asserting a plausible floor is the only
    // way to tell "clean" from "not looking".
    expect(files.length).toBeGreaterThan(20);
  });

  it('imports nothing a browser bundler stubs out', () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const specifier of builtinImports(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(ROOT, file)} imports ${specifier}`);
      }
    }

    // Named, because "src/shared/subject.ts imports node:crypto" is a fix and "one file has
    // a problem" is not.
    expect(
      offenders,
      `\n${offenders.join('\n')}\n\nUse globalThis.crypto (available in browsers and in Node ` +
        'since v19) instead of node:crypto. The failure this prevents is invisible in Node ' +
        'and only appears in a browser.',
    ).toEqual([]);
  });

  it('uses globalThis.crypto in the one place that needs randomness', () => {
    // Positive counterpart, so the check above cannot be satisfied by deleting the function.
    const subject = readFileSync(resolve(ROOT, 'src/shared/subject.ts'), 'utf8');

    expect(subject).toContain('globalThis.crypto.getRandomValues');
    expect(newSubject()).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });
});
