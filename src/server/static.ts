/**
 * Static file serving for the built client.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The production build emits `dist/client`, and until this module existed nothing
 * served it. `npm run dev` worked because Vite's dev server proxied to the API;
 * production had no equivalent, so a deployed instance answered `401` for `/` and the
 * application could not load at all. Discovered by starting the built server and
 * requesting `/` rather than by reading the routing table, which is the usual way
 * this class of gap survives to a deploy.
 *
 * ---------------------------------------------------------------------------
 * SECURITY: WHY THIS IS PUBLIC
 * ---------------------------------------------------------------------------
 * Static assets are served WITHOUT authentication, deliberately. A browser cannot
 * present a bearer token when fetching the HTML shell, and the shell is what obtains
 * the token. Putting this behind auth would make the application unable to start.
 *
 * That is only acceptable because this module never reads a document. Everything under
 * the root is a build artifact: HTML, JavaScript, CSS, icons. There is no user content
 * here to disclose, so an unauthenticated 200 leaks nothing that matters. Document
 * content is never written into this directory, and `PGLITE_DATA_DIR` must not point
 * into it. That invariant is asserted in the Dockerfile, where the two directories are
 * separate mounts.
 *
 * `/api/` is never handled here. Those routes all pass through authentication, and this
 * module refuses any path beginning with `/api/` even if a matching file exists, so a
 * future `dist/client/api/...` cannot shadow a real endpoint.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { securityHeaders, type CspMode } from './securityHeaders.js';

/**
 * Content types, keyed by extension.
 *
 * An explicit map rather than a dependency. The set is short and closed, which is the
 * property that matters: a lookup table cannot be surprised by an unfamiliar extension,
 * and an unknown extension is served as `application/octet-stream`, never guessed at.
 */
const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

/** One year, in seconds. Only applied to content-hashed files. */
const IMMUTABLE_MAX_AGE = 31_536_000;

/** Extensions considered a final path segment rather than a client-side route. */
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/u;

export interface StaticOptions {
  /** Absolute or relative directory holding the built client. */
  readonly root: string;
  /**
   * Absolute path the root was resolved to, used to prove containment.
   *
   * Computed once at construction rather than per request, because resolving a path is
   * cheap but `realpath` is a syscall and this runs on every asset fetch.
   */
  readonly realRoot: string;
  /**
   * Report violations only, or refuse them.
   *
   * Part of the options rather than a module constant because the two modes have different
   * risks and an operator must be able to choose between them without a rebuild: enforcing a
   * policy that is wrong for the deployed assets breaks the page, while reporting only cannot
   * protect anything on its own.
   *
   * Defaults to 'enforce'. See resolveCspMode for why the instructions' report-only-first
   * rollout does not make report-only the permanent default.
   */
  readonly cspMode: CspMode;
}

/**
 * Resolve the static root and prove it is a directory.
 *
 * Throws on anything unusable rather than silently serving nothing, because "the deploy
 * looks healthy and every user sees a blank page" is a much worse failure than a refusal
 * to start.
 */
export async function openStatic(
  root: string,
  cspMode: CspMode = 'enforce',
): Promise<StaticOptions> {
  const realRoot = await realpath(resolve(root));

  const info = await stat(realRoot);

  if (!info.isDirectory()) {
    throw new Error(`static root is not a directory: ${root}`);
  }

  return { root, realRoot, cspMode };
}

/**
 * How many times a path is percent-decoded before the traversal check runs.
 *
 * More than one, because a single pass turns `%252e%252e` into `%2e%2e`, which is a
 * perfectly ordinary directory name and passes straight through.
 *
 * Bounded rather than until-stable, because a caller controls how far it goes. Three
 * passes is well past anything a browser or proxy produces, and anything deeper is not a
 * request.
 */
const MAX_DECODE_PASSES = 3;

/**
 * Percent-decode until stable or the bound is reached.
 *
 * @returns null when any pass fails. A path that cannot be decoded is not a path, and
 *   guessing at what was meant is how traversal checks get bypassed.
 */
export function decodeFully(pathname: string): string | null {
  let current = pathname;

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string;

    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }

    if (next === current) {
      return current;
    }

    current = next;
  }

  return current;
}

/**
 * Is this path part of the HTTP API?
 *
 * Exported and used by BOTH the static resolver and the metric route template, because
 * the two have to agree exactly. They disagreed once already: the resolver refused `/api`
 * and `/api/...` while the template only excluded `/api/`, so a 401 for `/api` was
 * labelled `/index.html` and merged into the same series as a successful page load.
 *
 * One definition, two callers. A duplicated predicate between a security check and an
 * observability label is a disagreement waiting to happen.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Map a request path to a file inside the root, or null when it must not be served.
 *
 * The containment check is the whole point of this function. Two independent guards,
 * because either alone has a hole:
 *
 *   1. No `..` segment survives decoding, catching `/../../etc/passwd` and every encoded
 *      variant of it.
 *   2. The resolved path is compared against the real root as a *prefix with a
 *      separator*, catching what segment analysis misses — notably a symlink whose target
 *      lies outside the root, and the Windows-specific case where a path segment is a
 *      short name (`PROGRA~1`) or uses an alternate separator.
 *
 * The prefix check compares against `realRoot + sep`, so `/srv/client-evil` is not
 * accepted as being inside `/srv/client`.
 */
export function resolveStaticPath(pathname: string, realRoot: string): string | null {
  // Refuse the API namespace outright. Without this, a file that happened to land at
  // `dist/client/api/health` would shadow a real endpoint.
  if (isApiPath(pathname)) {
    return null;
  }

  // A NUL byte truncates the path at the syscall layer on some platforms, which turns a
  // traversal check into a check of a different string than the one that gets opened.
  if (pathname.includes('\0')) {
    return null;
  }

  // The URL parser leaves percent-encoding in `pathname`, so decoding is needed. Repeated,
  // because `/%252e%252e/x` decodes once to `/%2e%2e/x` and again to `/../x`.
  const decoded = decodeFully(pathname);

  if (decoded === null || decoded.includes('\0')) {
    return null;
  }

  // Reject any `..` segment outright, BEFORE normalising.
  //
  // Not a redundant belt to the containment check below: `normalize('/../package.json')`
  // returns `\package.json` on Windows, because `..` at the root of a rooted path is
  // dropped rather than preserved. The result is safely inside the root, so no escape is
  // possible -- but the request is silently rewritten to a different file instead of
  // refused, which is the wrong answer for a malformed request and hides a probe in the
  // access log. Refusing it also means this check and the containment check are testing
  // different things rather than the same thing twice.
  //
  // Split on both separators: a Windows path can legally contain either.
  if (decoded.split(/[/\\]/u).some((segment) => segment === '..')) {
    return null;
  }

  const relative = normalize(decoded).replace(/^[/\\]+/u, '');

  // The root itself is a legitimate target. `/` is the common case and must resolve to
  // the root directory, which the caller's directory branch then turns into index.html.
  // Treating it as "nothing to serve" made `/` fall through to the API and answer 401,
  // which is exactly the failure this module was written to fix.
  if (relative === '' || relative === '.') {
    return realRoot;
  }

  const candidate = resolve(realRoot, relative);

  // The backstop for everything the segment check cannot see: a symlink, or a Windows
  // short name such as `PROGRA~1`, where the segment is innocent but the target is not.
  if (!candidate.startsWith(realRoot + sep)) {
    return null;
  }

  return candidate;
}

/**
 * Decide whether a missing file should fall back to `index.html`.
 *
 * Only for extensionless paths. A request for `/assets/missing.js` is a broken build
 * reference and must 404 rather than return HTML with a JavaScript content type, which
 * fails in the browser with a syntax error pointing at the wrong file entirely.
 *
 * That distinction is the difference between a diagnosable deployment and a confusing
 * one, so it is worth the two lines.
 */
export function shouldFallbackToIndex(pathname: string): boolean {
  return !HAS_EXTENSION.test(pathname);
}

/**
 * Cache-Control for a served path.
 *
 * `immutable` only for content-hashed files. Vite writes `assets/index-<hash>.js`, where
 * the hash changes whenever the content does, so those can be cached forever. `index.html`
 * is the opposite: it names the current asset, so caching it is how a browser pins itself
 * to a deleted bundle after a deploy.
 */
export function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) {
    return `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`;
  }

  return 'no-cache';
}

/**
 * A strong ETag over size and modification time.
 *
 * Deliberately not a content hash. Hashing every asset on every request would turn the
 * hot path into a full read of the file, and size+mtime changes exactly when the bytes
 * change. Weak by the specification's own definition, and it is labelled as such so a
 * cache does not treat it as byte-exact.
 */
export function etagFor(size: number, modifiedMs: number): string {
  const digest = createHash('sha1')
    .update(`${size.toString(16)}:${Math.floor(modifiedMs).toString(16)}`)
    .digest('base64url')
    .slice(0, 16);

  return `W/"${digest}"`;
}

/** Content type for a path, defaulting to a safe binary type. */
export function contentTypeFor(pathname: string): string {
  return CONTENT_TYPES.get(extname(pathname).toLowerCase()) ?? 'application/octet-stream';
}

export interface StaticResult {
  /** 200 or 304. Anything else means "not mine", and the caller moves on. */
  readonly status: 200 | 304;
  readonly pathname: string;
}

/**
 * Serve one request from the static root.
 *
 * @returns what it served, or null when the path is not a static request. Null is not an
 *   error: it means the request belongs to a different handler, which the caller decides.
 */
export async function serveStatic(
  options: StaticOptions,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<StaticResult | null> {
  // Only safe methods. A POST to `/` must not return HTML; it is either a client bug or
  // an attack, and answering it with a 200 would hide both.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return null;
  }

  const target = resolveStaticPath(pathname, options.realRoot);

  if (target === null) {
    return null;
  }

  const candidate = await statOrNull(target);
  const isDirectory = candidate?.isDirectory() ?? false;

  let file: string;
  let servedPath: string;

  if (candidate === null || isDirectory) {
    if (!shouldFallbackToIndex(pathname)) {
      return null;
    }

    // The app shell lives at the ROOT, not at the requested path.
    //
    // Joining onto `target` would look for `/documents/abc/index.html`, which does not
    // exist, so every client-side route would 404. This is the difference between an SPA
    // that routes and one that does not.
    file = join(options.realRoot, 'index.html');
    servedPath = '/index.html';
  } else {
    file = target;
    servedPath = pathname;
  }

  const info = candidate === null || isDirectory ? await statOrNull(file) : candidate;

  if (info === null || !info.isFile()) {
    return null;
  }

  // Re-prove containment on the file that is actually about to be opened. The index
  // fallback can escape the earlier check if `index.html` were a symlink pointing out.
  const realFile = await realpath(file).catch(() => null);

  if (
    realFile === null ||
    !realFile.startsWith(options.realRoot + sep) ||
    realFile === options.realRoot
  ) {
    return null;
  }

  const etag = etagFor(info.size, info.mtimeMs);

  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(realFile),
    'Cache-Control': cacheControlFor(servedPath),
    ETag: etag,
    // Not `X-Content-Type-Options: nosniff` alone: the header is right, but the real
    // protection against a mislabelled asset is the explicit content type above.
    'X-Content-Type-Options': 'nosniff',
    'Last-Modified': new Date(info.mtimeMs).toUTCString(),
    // CSP, frame-ancestors, and the rest. The reason this matters HERE specifically is the
    // end-to-end encryption key: it lives in the URL fragment, which the browser never sends,
    // but any script running in this page can read it out of `location.hash`. There is no
    // injection sink today, so this is the net for the day one is added - it decides what an
    // injected script may load and exfiltrate. See securityHeaders.ts.
    ...securityHeaders(options.cspMode),
  };

  // Conditional request. A 304 still needs the validators, which is why headers are built
  // before this branch rather than inside the 200 path.
  //
  // The security headers go on the 304 too. They are not body-specific, and a cached response
  // that keeps its ETag but loses its CSP is a response that a browser may reuse without ever
  // re-applying the policy.
  if (matchesEtag(req.headers['if-none-match'], etag)) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': headers['Cache-Control'],
      ...securityHeaders(options.cspMode),
    });
    res.end();
    return { status: 304, pathname: servedPath };
  }

  headers['Content-Length'] = String(info.size);

  // HEAD is answered with identical headers and no body, per RFC 9110. Range requests
  // are not implemented: a video or a large asset would want them, and this application
  // ships none, so a full 200 is honest rather than a partial implementation.
  res.writeHead(200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return { status: 200, pathname: servedPath };
  }

  await new Promise<void>((done) => {
    const stream = createReadStream(realFile);

    stream.on('error', () => {
      // Headers are already sent, so there is nothing to say to the client. Ending the
      // response is the only correct action; throwing here would be an unhandled
      // rejection on a socket the client is already watching.
      res.end();
      done();
    });

    stream.on('end', () => done());
    stream.pipe(res);
  });

  return { status: 200, pathname: servedPath };
}

/**
 * Compare an `If-None-Match` header against the current ETag.
 *
 * Handles the list form and the wildcard, because both are common and both are cheap:
 * a proxy rewriting a request can add entries, and `*` is what a browser sends after a
 * hard reload. A weak comparison is correct here, which is what the `W/` prefix signals.
 */
export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }

  const value = Array.isArray(header) ? header.join(', ') : header;

  if (value.trim() === '*') {
    return true;
  }

  return value.split(',').some((candidate) => candidate.trim() === etag);
}

/** `stat` that reports absence as null instead of throwing. */
async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
