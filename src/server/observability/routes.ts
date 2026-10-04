/**
 * Route templates for metric labels.
 *
 * NOTE ON ENCODING: ASCII only. See the note at the top of src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SMALL AND WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * `requests_total{path="/api/documents/8f2c1a..."}` creates one time series per
 * document. Forty documents is forty series for one endpoint; a crawler creates
 * thousands. The registry then holds them in memory forever, scrapes get slower, and
 * the monitoring system falls over while the application is fine.
 *
 * Replacing the dynamic segments with `:id` collapses all of them into one series.
 *
 * The cap in metrics.ts is the backstop for someone adding a raw path by accident.
 * This file is the actual fix: it means nobody has to.
 */

import { isApiPath } from '../static.js';

/**
 * Collapse a request path into a fixed template.
 *
 * Every rule here is a fixed string, so the number of possible outputs is bounded by
 * the number of rules rather than by the number of requests. An unrecognised path
 * becomes `other`, which is one series, not a series per unknown URL.
 */
export function routeTemplate(path: string): string {
  if (path === '/api/health') {
    return '/api/health';
  }

  if (path === '/api/auth/session') {
    return '/api/auth/session';
  }

  if (path === '/api/metrics') {
    return '/api/metrics';
  }

  if (path === '/api/documents') {
    return '/api/documents';
  }

  if (/^\/api\/documents\/[^/]+\/collaborators$/u.test(path)) {
    return '/api/documents/:id/collaborators';
  }

  if (/^\/api\/documents\/[^/]+\/collaborators\/[^/]+$/u.test(path)) {
    return '/api/documents/:id/collaborators/:subject';
  }

  if (/^\/api\/documents\/[^/]+\/claim$/u.test(path)) {
    return '/api/documents/:id/claim';
  }

  if (/^\/api\/documents\/[^/]+$/u.test(path)) {
    return '/api/documents/:id';
  }

  // The WebSocket upgrade path, which never reaches the request handler but is worth
  // knowing about when a proxy refuses it.
  if (path === '/ws') {
    return '/ws';
  }

  // Built client assets. These MUST be collapsed or the metric cardinality is a
  // deployment disaster rather than an accident: Vite names every bundle
  // `index-<hash>.js`, so one series per asset means one series per deploy, and those
  // series never go stale because nothing ever requests the old hash again. A year of
  // deploys is a year of dead time series the registry holds forever.
  //
  // The charset check is what keeps this bounded. Without it, a filename containing
  // anything unusual produces a template containing that unusual thing, and a probe
  // asking for `/assets/x` + 2000 distinct suffixes is 2000 series. Bounded is the whole
  // requirement, so an unrecognisable name is `other` rather than a new shape.
  if (path.startsWith('/assets/')) {
    const name = path.slice('/assets/'.length);

    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/u.test(name)) {
      return 'other';
    }

    // Drop the final `-<segment>` before the extension.
    //
    // Always, including for a name that happens not to be hashed. `index-CdCt3Z4e.js` and
    // `index-Bx91aA2f.js` must collapse, and there is no way to tell a hash from an
    // ordinary word by shape alone. Over-collapsing `collab-editor.js` with
    // `collab-other.js` costs one distinguishable series; under-collapsing a hashed asset
    // leaves a dead series per deploy, permanently. That trade is not close.
    return `/assets/${name.replace(/-[^-]*\./u, '-*.')}`;
  }

  // The app shell. `/` and every client-side route resolve to index.html, so they are one
  // series however many documents a user visits.
  //
  // Two restrictions, both about the label telling the truth rather than about bounding
  // the output.
  //
  // The `/api/` exclusion is not optional. An API path that matched this shape would be
  // labelled `/index.html` while the response was a 401, putting every unauthenticated
  // API call in the same series as a successful page load. `resolveStaticPath` refuses
  // `/api/` too, and this has to agree with it.
  //
  // The shape restriction keeps out anything with a file extension or an unusual
  // character: those end in a 401 or 404, not a page, and a label describing the wrong
  // response is worse than `other`.
  if (path === '/') {
    return '/index.html';
  }

  if (!isApiPath(path) && /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(path)) {
    return '/index.html';
  }

  return 'other';
}

/**
 * Label a status code.
 *
 * Bucketed rather than exact. A raw 404 and a raw 500 are different stories, but
 * "some 4xx" versus "some 5xx" is the question anyone actually asks of an error rate,
 * and exact codes make every dashboard need a filter.
 */
export function statusClass(status: number): string {
  if (status >= 500) {
    return '5xx';
  }

  if (status >= 400) {
    return '4xx';
  }

  if (status >= 300) {
    return '3xx';
  }

  if (status >= 200) {
    return '2xx';
  }

  return 'other';
}
