/**
 * Route template tests.
 *
 * These exist to defend one property above all others: the number of distinct outputs
 * is bounded by the number of rules, not by the number of requests. A property test
 * checks it directly rather than trusting a list of examples.
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../../core/rng.js';
import { isApiPath } from '../static.js';
import { routeTemplate, statusClass } from './routes.js';

describe('routeTemplate', () => {
  it('recognises the fixed routes', () => {
    expect(routeTemplate('/api/health')).toBe('/api/health');
    expect(routeTemplate('/api/auth/session')).toBe('/api/auth/session');
    expect(routeTemplate('/api/metrics')).toBe('/api/metrics');
    expect(routeTemplate('/api/documents')).toBe('/api/documents');
    expect(routeTemplate('/ws')).toBe('/ws');
  });

  it('collapses a document id into one template', () => {
    // The whole point. Two ids must produce the same string.
    expect(routeTemplate('/api/documents/aaa')).toBe('/api/documents/:id');
    expect(routeTemplate('/api/documents/bbb')).toBe('/api/documents/:id');
    expect(routeTemplate('/api/documents/aaa')).toBe(routeTemplate('/api/documents/bbb'));
  });

  it('collapses a subject into one template', () => {
    expect(routeTemplate('/api/documents/aaa/collaborators')).toBe(
      '/api/documents/:id/collaborators',
    );
    expect(routeTemplate('/api/documents/aaa/collaborators/bob')).toBe(
      '/api/documents/:id/collaborators/:subject',
    );
  });

  it('recognises the claim route', () => {
    expect(routeTemplate('/api/documents/aaa/claim')).toBe('/api/documents/:id/claim');
  });

  it('folds an unknown path into a single series', () => {
    // Anything unrecognised becomes one string, so a crawler probing random URLs adds
    // exactly one series rather than thousands.
    expect(routeTemplate('/api')).toBe('other');
    expect(routeTemplate('')).toBe('other');
    expect(routeTemplate('/a/b?c=1')).toBe('other');
    expect(routeTemplate('/%2e%2e/x')).toBe('other');
  });

  it('labels a probed path as the shell when the shell is what answers', () => {
    // `/etc/passwd` was `other` before static serving, because nothing answered it and it
    // fell through to a 401. Now the static handler serves the app shell for any
    // extensionless path, so `/index.html` is what actually happened. A crawler gets one
    // series, which is the property that matters, and it is an accurate one.
    expect(routeTemplate('/etc/passwd')).toBe('/index.html');
    expect(routeTemplate('/wp-admin/setup-config.php')).toBe('other');
  });

  it('labels the app shell as such', () => {
    // `/` used to be `other`, because before static serving nothing answered it. Now the
    // server serves index.html for it and every client-side route, so labelling it
    // `other` would group the app shell in with genuine 404s and 401s.
    expect(routeTemplate('/')).toBe('/index.html');
    expect(routeTemplate('/documents/abc123')).toBe('/index.html');
    expect(routeTemplate('/documents/abc123/edit')).toBe('/index.html');
  });

  it('does not label a path the shell would not have served', () => {
    // A label claims a response happened. These end in a 401 or a 404, so calling them
    // `/index.html` would make the metric describe something that never occurred.
    expect(routeTemplate('/assets/missing.js')).not.toBe('/index.html');
    expect(routeTemplate('/weird.thing')).not.toBe('/index.html');
    expect(routeTemplate('/has spaces/there')).not.toBe('/index.html');
  });

  it('collapses the content hash out of an asset name', () => {
    // Vite names bundles `index-<hash>.js`. One series per hash would be one dead series
    // per deploy, forever.
    expect(routeTemplate('/assets/index-CdCt3Z4e.js')).toBe('/assets/index-*.js');
    expect(routeTemplate('/assets/index-Bx91aA2f.js')).toBe('/assets/index-*.js');
    expect(routeTemplate('/assets/index-CdCt3Z4e.css')).toBe('/assets/index-*.css');
  });

  it('never labels an API path as the static shell', () => {
    // Regression: the shell rule matched any plain path, so `/api/documents/a/b/c`
    // answered 401 while reporting itself as `/index.html`. That merges every
    // unauthenticated API call into the same series as a successful page load.
    expect(routeTemplate('/api/documents/a/b/c')).toBe('other');
    expect(routeTemplate('/api/nonsense')).toBe('other');
    expect(routeTemplate('/api/health/extra')).toBe('other');
  });

  it('agrees with the static resolver about what counts as an API path', () => {
    // `/api` without the trailing slash is the exact case that drifted: the resolver
    // refused it, the template did not, and a 401 for `/api` was reported as a page load.
    // The two now share one predicate, and this asserts they still behave the same.
    for (const path of ['/api', '/api/', '/api/health', '/api/documents/x']) {
      expect(routeTemplate(path), `for ${path}`).not.toBe('/index.html');
    }

    // The two paths that legitimately ARE the shell, listed separately because putting
    // them in the loop above is what made this test wrong the first time.
    expect(routeTemplate('/')).toBe('/index.html');
    expect(routeTemplate('/documents/abc')).toBe('/index.html');

    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/')).toBe(true);
    expect(isApiPath('/api/health')).toBe(true);
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/documents/abc')).toBe(false);
  });

  it('collapses the trailing segment of an unhashed-looking name too', () => {
    // Not every asset is hashed and there is no way to tell a hash from an ordinary word
    // by shape. Over-collapsing costs one series; under-collapsing a hashed asset leaves a
    // dead series per deploy, permanently.
    expect(routeTemplate('/assets/collab-editor.js')).toBe('/assets/collab-*.js');
  });

  it('refuses to template an asset name carrying unusual characters', () => {
    // The bound is what matters. A name outside the safe charset gets `other` rather than
    // a template that embeds whatever the caller sent.
    expect(routeTemplate('/assets/a b.js')).toBe('other');
    expect(routeTemplate('/assets/a"b.js')).toBe('other');
    expect(routeTemplate('/assets/a}b{js')).toBe('other');
    expect(routeTemplate('/assets/a,b.js')).toBe('other');
    expect(routeTemplate('/assets/noextension')).toBe('other');
  });

  it('does not let extra path segments impersonate a known route', () => {
    expect(routeTemplate('/api/documents/a/collaborators/b/c')).toBe('other');
  });

  it('is bounded, for any input', () => {
    // The property, checked rather than asserted. Every template must be one of a
    // known finite set; a regex written carelessly can leak a second one.
    const allowed = new Set([
      '/api/health',
      '/api/auth/session',
      '/api/metrics',
      '/api/documents',
      '/api/documents/:id',
      '/api/documents/:id/collaborators',
      '/api/documents/:id/collaborators/:subject',
      '/api/documents/:id/claim',
      '/ws',
      '/index.html',
      '/assets/index-*.js',
      '/assets/index-*.css',
      'other',
    ]);

    const random = mulberry32(0x5eed);

    for (let trial = 0; trial < 2_000; trial += 1) {
      const segments = 1 + Math.floor(random() * 5);
      const parts: string[] = [];

      for (let index = 0; index < segments; index += 1) {
        const length = 1 + Math.floor(random() * 12);
        let part = '';

        for (let char = 0; char < length; char += 1) {
          // A deliberately hostile alphabet: path separators, url syntax, and
          // characters that would break a Prometheus label if they leaked through.
          const alphabet = 'abcXYZ019-_.:/?#%[]@!\u00e9';
          part += alphabet[Math.floor(random() * alphabet.length)] ?? 'a';
        }

        parts.push(part);
      }

      expect(allowed.has(routeTemplate(`/${parts.join('/')}`)), `for /${parts.join('/')}`).toBe(
        true,
      );
    }
  });

  it('never returns something containing a path separator beyond the known ones', () => {
    // A template that still contains caller-supplied text would defeat the cap in the
    // registry, which is the backstop rather than the fix.
    const random = mulberry32(0xabcd);

    for (let trial = 0; trial < 500; trial += 1) {
      const id = `doc${Math.floor(random() * 1e9).toString(36)}`;
      expect(routeTemplate(`/api/documents/${id}`)).toBe('/api/documents/:id');
    }
  });
});

describe('statusClass', () => {
  it('buckets by class', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(301)).toBe('3xx');
    expect(statusClass(401)).toBe('4xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
    expect(statusClass(503)).toBe('5xx');
  });

  it('handles the impossible case without inventing a class', () => {
    // A status below 200 does not happen, but if it did it must not be reported as a
    // success.
    expect(statusClass(0)).toBe('other');
    expect(statusClass(-1)).toBe('other');
  });

  it('is bounded', () => {
    const allowed = new Set(['2xx', '3xx', '4xx', '5xx', 'other']);

    for (let status = 0; status <= 600; status += 1) {
      expect(allowed.has(statusClass(status))).toBe(true);
    }
  });
});
