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
    expect(routeTemplate('/etc/passwd')).toBe('other');
    expect(routeTemplate('/api')).toBe('other');
    expect(routeTemplate('/')).toBe('other');
    expect(routeTemplate('')).toBe('other');
  });

  it('does not let extra path segments impersonate a known route', () => {
    expect(routeTemplate('/api/documents/a/b/c')).toBe('other');
    expect(routeTemplate('/api/health/extra')).toBe('other');
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
