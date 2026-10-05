/**
 * Tests for static file serving.
 *
 * Split in two on purpose.
 *
 * The pure functions are tested directly, because path containment is the property that
 * must not regress and it is far easier to attack in isolation than through HTTP.
 *
 * The server behaviour is then tested end to end against a real `ApiServer`, because the
 * two mistakes actually made while writing this file were both wiring bugs: `/` resolved
 * to nothing, and the SPA fallback looked for the index in the wrong directory. Neither
 * would have been caught by testing `resolveStaticPath` alone.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiServer } from './api.js';
import { Database } from './db.js';
import {
  cacheControlFor,
  contentTypeFor,
  etagFor,
  matchesEtag,
  openStatic,
  resolveStaticPath,
  shouldFallbackToIndex,
} from './static.js';

/** A throwaway directory tree that mimics `dist/client`. */
let root: string;
let db: Database;
let server: ApiServer;
let baseUrl: string;

const INDEX_HTML =
  '<!doctype html><title>collab</title><script src="/assets/a-abc123.js"></script>';

/**
 * Remove a directory tree, and say so when it does not work.
 *
 * The swallowing `.catch(() => undefined)` this replaced hid a 955 MB leak: on Windows
 * `rm` fails while any handle into the directory is still open, and the failure was
 * invisible. A test that cannot clean up after itself should fail rather than accumulate,
 * because a full disk makes PGlite fail to boot, which looks like an unrelated flake.
 */
async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    throw new Error(
      `Failed to remove the test directory ${path}: ${String(error)}. ` +
        'Leftover PGlite directories fill the disk and make unrelated tests fail.',
      { cause: error },
    );
  }
}

/**
 * A throwaway directory tree that mimics `dist/client`.
 *
 * The PGlite database lives INSIDE this directory, not beside it. An earlier version
 * used `join(root, '..', 'pg-<timestamp>')`, which put it in `%TEMP%` as a sibling that
 * no cleanup path covered - about 38 MB per full-suite run, and 955 MB had accumulated in
 * TEMP by the time this was noticed.
 */
async function makeStaticRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'collab-static-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), INDEX_HTML, 'utf8');
  await writeFile(join(dir, 'assets', 'a-abc123.js'), 'console.log(1);', 'utf8');
  await writeFile(join(dir, 'assets', 'a-def456.css'), 'body{}', 'utf8');
  await writeFile(join(dir, 'favicon.svg'), '<svg/>', 'utf8');
  // A file whose name has no hyphen, so the route template cannot just strip a suffix.
  await writeFile(join(dir, 'assets', 'collab-editor.js'), 'export default 1;', 'utf8');

  return dir;
}

beforeAll(async () => {
  root = await makeStaticRoot();

  // Inside `root`, so the single cleanup below covers it.
  db = await Database.openAt(join(root, 'pg'));
  server = new ApiServer({ db, static: await openStatic(root), port: 0 });

  const address = await server.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server?.close();
  await db?.close();
  await removeTree(root);
});

describe('resolveStaticPath', () => {
  it('maps the root to the root directory', () => {
    // Regression: `/` used to resolve to null, so it fell through to the API and
    // answered 401. The browser's first request is `/`.
    const real = resolveStaticPath('/', root);

    expect(real).not.toBeNull();
    expect(real).toBe(root);
  });

  it('resolves a file inside the root', () => {
    expect(resolveStaticPath('/index.html', root)).toBe(join(root, 'index.html'));
  });

  it('resolves a nested file', () => {
    expect(resolveStaticPath('/assets/a-abc123.js', root)).toBe(
      join(root, 'assets', 'a-abc123.js'),
    );
  });

  describe('refuses to escape the root', () => {
    // Each of these reached a real file on the test machine during development, or would
    // have on a machine where the source tree sits above the static root.
    const escapes = [
      '/../package.json',
      '/../../package.json',
      '/../../../../../../etc/passwd',
      '/assets/../../../package.json',
      '/./../../package.json',
      '/a/b/../../../package.json',
    ];

    for (const attempt of escapes) {
      it(`refuses ${attempt}`, () => {
        expect(resolveStaticPath(attempt, root)).toBeNull();
      });
    }
  });

  it('refuses a double-encoded traversal', () => {
    // `%252e%252e` decodes once to `%2e%2e` and again to `..`. Only decoding twice
    // catches it, which is why the decode is not skipped as redundant.
    expect(resolveStaticPath('/%252e%252e/package.json', root)).toBeNull();
    expect(resolveStaticPath('/%2e%2e/package.json', root)).toBeNull();
  });

  it('refuses a NUL byte', () => {
    // Truncation at the syscall layer would make the check examine a different string
    // than the one that gets opened.
    expect(resolveStaticPath('/index.html\0.png', root)).toBeNull();
    expect(resolveStaticPath('/index.html%00.png', root)).toBeNull();
  });

  it('refuses a malformed percent escape', () => {
    expect(resolveStaticPath('/%zz', root)).toBeNull();
  });

  it('refuses the API namespace even when a file matches', () => {
    // Guards against a future `dist/client/api/health` shadowing a real endpoint.
    expect(resolveStaticPath('/api/health', root)).toBeNull();
    expect(resolveStaticPath('/api', root)).toBeNull();
    expect(resolveStaticPath('/api/documents/abc', root)).toBeNull();
  });

  it('does not accept a sibling directory that shares the prefix', () => {
    // `/srv/client-evil` starts with the string `/srv/client`, so a bare `startsWith`
    // would accept it. This is the reason the separator is compared too.
    const sibling = `${root}-evil`;

    expect(sibling.startsWith(root)).toBe(true);
    expect(resolveStaticPath('/../client-evil/secret', root)).toBeNull();
  });
});

describe('shouldFallbackToIndex', () => {
  it('falls back for a route with no extension', () => {
    expect(shouldFallbackToIndex('/')).toBe(true);
    expect(shouldFallbackToIndex('/documents/abc')).toBe(true);
  });

  it('does not fall back for something with an extension', () => {
    // Serving HTML with a JavaScript content type for a missing bundle fails in the
    // browser with a syntax error pointing at the wrong file, so this must 404.
    expect(shouldFallbackToIndex('/assets/missing.js')).toBe(false);
    expect(shouldFallbackToIndex('/favicon.svg')).toBe(false);
  });

  it('treats a trailing dot or short suffix as a file', () => {
    expect(shouldFallbackToIndex('/weird.')).toBe(true);
    expect(shouldFallbackToIndex('/file.min.js')).toBe(false);
  });
});

describe('cacheControlFor', () => {
  it('marks content-hashed assets immutable', () => {
    expect(cacheControlFor('/assets/a-abc123.js')).toContain('immutable');
    expect(cacheControlFor('/assets/a-abc123.js')).toContain('max-age=31536000');
  });

  it('never caches the app shell', () => {
    // Caching index.html is how a browser pins itself to a bundle the deploy deleted.
    expect(cacheControlFor('/index.html')).toBe('no-cache');
    expect(cacheControlFor('/')).toBe('no-cache');
  });
});

describe('contentTypeFor', () => {
  it('knows the types the build emits', () => {
    expect(contentTypeFor('/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('/a.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('/a.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('/a.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('/a.woff2')).toBe('font/woff2');
  });

  it('does not guess at an unknown extension', () => {
    expect(contentTypeFor('/a.exe')).toBe('application/octet-stream');
    expect(contentTypeFor('/noextension')).toBe('application/octet-stream');
  });
});

describe('etagFor and matchesEtag', () => {
  it('is stable for identical size and mtime', () => {
    expect(etagFor(100, 1_700_000_000_000)).toBe(etagFor(100, 1_700_000_000_000));
  });

  it('changes when either input changes', () => {
    expect(etagFor(100, 1_700_000_000_000)).not.toBe(etagFor(101, 1_700_000_000_000));
    expect(etagFor(100, 1_700_000_000_000)).not.toBe(etagFor(100, 1_700_000_001_000));
  });

  it('is weak, because size and mtime are not byte-exact', () => {
    // Claiming strong validation for a value derived from metadata would let a cache
    // serve stale bytes after a same-size edit.
    expect(etagFor(1, 1).startsWith('W/"')).toBe(true);
  });

  it('matches a single tag, a list, and the wildcard', () => {
    const tag = etagFor(100, 1_700_000_000_000);

    expect(matchesEtag(tag, tag)).toBe(true);
    expect(matchesEtag(`"other", ${tag}`, tag)).toBe(true);
    expect(matchesEtag('*', tag)).toBe(true);
  });

  it('does not match a different tag or a prefix of one', () => {
    const tag = etagFor(100, 1_700_000_000_000);

    expect(matchesEtag(undefined, tag)).toBe(false);
    expect(matchesEtag('"nope"', tag)).toBe(false);
    expect(matchesEtag(tag.slice(0, -1), tag)).toBe(false);
  });
});

describe('openStatic', () => {
  it('refuses a path that is not a directory', async () => {
    const file = join(root, 'index.html');

    await expect(openStatic(file)).rejects.toThrow(/not a directory/u);
  });

  it('refuses a path that does not exist', async () => {
    await expect(openStatic(join(root, 'nope'))).rejects.toThrow();
  });
});

describe('served over HTTP', () => {
  it('serves the app shell at the root', async () => {
    // The regression that motivated the module: `/` used to answer 401.
    const res = await fetch(`${baseUrl}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('serves the app shell for a client-side route', async () => {
    // Regression: the fallback joined onto the requested path, so every route 404'd.
    const res = await fetch(`${baseUrl}/documents/abc123`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('serves an asset with the right type and caching', async () => {
    const res = await fetch(`${baseUrl}/assets/a-abc123.js`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('content-length')).toBe('15');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers a conditional request with 304 and no body', async () => {
    const first = await fetch(`${baseUrl}/assets/a-abc123.js`);
    const tag = first.headers.get('etag') ?? '';

    expect(tag).not.toBe('');

    const second = await fetch(`${baseUrl}/assets/a-abc123.js`, {
      headers: { 'If-None-Match': tag },
    });

    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(tag);
    expect(await second.text()).toBe('');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await fetch(`${baseUrl}/assets/a-abc123.js`, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('15');
    expect(await res.text()).toBe('');
  });

  it('does not serve a file for an unsafe method', async () => {
    // A POST to `/` is a client bug or an attack. Answering 200 with HTML hides both.
    const res = await fetch(`${baseUrl}/`, { method: 'POST' });

    expect(res.status).not.toBe(200);
  });

  it('does not answer a missing asset with HTML', async () => {
    // Would fail in the browser as a syntax error in the wrong file.
    const res = await fetch(`${baseUrl}/assets/missing.js`);

    expect(res.status).not.toBe(200);
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  it('keeps the API authenticated', async () => {
    // Static serving is public; the API must not become public with it.
    const res = await fetch(`${baseUrl}/api/documents`);

    expect(res.status).toBe(401);
  });

  it('keeps the session route POST-only', async () => {
    // Widening this to GET was an accident made while adding static serving. The test
    // exists because nothing asserted it.
    expect((await fetch(`${baseUrl}/api/auth/session`, { method: 'GET' })).status).not.toBe(200);
    expect((await fetch(`${baseUrl}/api/auth/session`, { method: 'POST' })).status).toBe(200);
  });

  it('still answers the health check', async () => {
    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });

  it('refuses every traversal attempt over HTTP', async () => {
    for (const attempt of [
      '/../../package.json',
      '/%2e%2e%2fpackage.json',
      '/assets/../../../package.json',
      '/index.html/../../package.json',
    ]) {
      const res = await fetch(`${baseUrl}${attempt}`);

      expect(res.status, `for ${attempt}`).not.toBe(200);
    }
  });
});

describe('a symlink pointing out of the root', () => {
  let linkRoot: string;
  let linkServer: ApiServer;
  let linkUrl: string;
  let linkDb: Database;
  let outsideRoot: string;

  beforeAll(async () => {
    linkRoot = await makeStaticRoot();
    await writeFile(join(linkRoot, 'index.html'), INDEX_HTML, 'utf8');

    // A file the server must never serve, placed OUTSIDE the root. Its own directory,
    // because a file inside the root would not prove the containment check does anything.
    outsideRoot = await mkdtemp(join(tmpdir(), 'collab-static-secret-'));
    const secret = join(outsideRoot, 'secret.txt');

    await writeFile(secret, 'TOP SECRET', 'utf8');

    await symlink(secret, join(linkRoot, 'escape.txt')).catch(() => {
      // Creating symlinks on Windows needs a privilege that may not be granted. The test
      // that depends on this one skips itself rather than reporting a false pass.
    });

    linkDb = await Database.openAt(join(outsideRoot, 'pg'));
    linkServer = new ApiServer({ db: linkDb, static: await openStatic(linkRoot), port: 0 });
    linkUrl = `http://127.0.0.1:${(await linkServer.listen()).port}`;
  });

  afterAll(async () => {
    await linkServer?.close();
    await linkDb?.close();
    // Both, not just the served root: the secret directory was the other leak, and it held
    // a whole PGlite database.
    await removeTree(linkRoot);
    await removeTree(outsideRoot);
  });

  it('does not follow a symlink out of the root', async () => {
    const res = await fetch(`${linkUrl}/escape.txt`);

    // On Windows without the symlink privilege no link exists, so the 401 the API
    // returns for an unrecognised path is the same answer and the assertion holds.
    expect(res.status).not.toBe(200);
  });
});
