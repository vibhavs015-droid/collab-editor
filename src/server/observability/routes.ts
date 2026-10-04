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
