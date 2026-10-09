/**
 * Metric names, declared once.
 *
 * NOTE ON ENCODING: ASCII only. See the note at the top of src/core/crdt/rga.ts.
 *
 * A typo in a metric name is a silently dead metric. The dashboard says "no data" and
 * the person reading it concludes the thing they were watching never happens, rather
 * than that it was renamed. Central names make that failure loud at typecheck time.
 *
 * Names follow the Prometheus convention: a counter ends in `_total`, a gauge does
 * not.
 */

import type { MetricType, Metrics } from './metrics.js';

export const M = {
  // ── HTTP ────────────────────────────────────────────────────────────────────
  httpRequests: 'http_requests_total',
  httpDuration: 'http_request_duration_seconds',
  httpInFlight: 'http_requests_in_flight',

  // ── WebSocket ───────────────────────────────────────────────────────────────
  wsConnectionsOpened: 'ws_connections_opened_total',
  wsConnectionsClosed: 'ws_connections_closed_total',
  wsConnectionsActive: 'ws_connections_active',
  wsPendingUnauthenticated: 'ws_pending_unauthenticated',
  wsRejected: 'ws_connections_rejected_total',
  wsFramesSent: 'ws_frames_sent_total',
  wsBackpressureDrops: 'ws_backpressure_drops_total',
  helloDuration: 'ws_hello_duration_seconds',

  // ── Operations ──────────────────────────────────────────────────────────────
  opsReceived: 'collab_operations_received_total',
  opsBroadcast: 'collab_operations_broadcast_total',
  opsRejected: 'collab_operations_rejected_total',
  opsUnplaced: 'collab_operations_unplaced_total',
  /**
   * Connections closed for exceeding the per-connection write rate.
   *
   * Counts CONNECTIONS, not operations. The server refuses a whole connection rather than the
   * individual frame, so an operation count here would be a number nobody could reproduce from
   * the log and would move by whatever batch size happened to be refused.
   */
  opsRateLimited: 'collab_ops_rate_limited_total',
  /** Documents that refused a write because they are at the element cap. */
  documentsTooLarge: 'collab_documents_too_large_total',
  replayOps: 'collab_replay_operations_total',
  replayDuration: 'collab_replay_duration_seconds',

  // ── Compaction ──────────────────────────────────────────────────────────────
  compactionRuns: 'collab_compaction_runs_total',
  compactionPruned: 'collab_compaction_operations_pruned_total',
  compactionSkipped: 'collab_compaction_skipped_total',
  logLength: 'collab_log_length',
  logTombstones: 'collab_log_tombstones',

  // ── Auth ────────────────────────────────────────────────────────────────────
  authFailures: 'collab_auth_failures_total',
  sessionsIssued: 'collab_sessions_issued_total',

  // ── Process ─────────────────────────────────────────────────────────────────
  processMemory: 'process_resident_memory_bytes',
} as const;

/**
 * Every metric, with its type, in one place.
 *
 * Declaring types in a single table rather than in two passes is deliberate. An
 * earlier version called `describe` first -- which creates a metric as a counter --
 * and then `ensure`d the same name as a gauge, which the registry correctly refused.
 * The order was the bug; one table makes the order impossible to get wrong.
 */
const METRICS: readonly {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
}[] = [
  // ── HTTP ────────────────────────────────────────────────────────────────────
  {
    name: M.httpRequests,
    type: 'counter',
    help: 'HTTP requests handled, by route template and status class.',
  },
  { name: M.httpInFlight, type: 'gauge', help: 'HTTP requests currently being handled.' },
  { name: M.httpDuration, type: 'histogram', help: 'HTTP request duration in seconds.' },

  // ── WebSocket ───────────────────────────────────────────────────────────────
  { name: M.wsConnectionsOpened, type: 'counter', help: 'WebSocket connections accepted.' },
  { name: M.wsConnectionsClosed, type: 'counter', help: 'WebSocket connections closed.' },
  { name: M.wsConnectionsActive, type: 'gauge', help: 'Authorised WebSocket clients connected.' },
  {
    name: M.wsPendingUnauthenticated,
    type: 'gauge',
    help: 'Sockets connected but not yet authorised. A number that only goes up is an attack.',
  },
  { name: M.wsRejected, type: 'counter', help: 'WebSocket connections refused before admission.' },
  { name: M.wsFramesSent, type: 'counter', help: 'Frames written to clients, by type.' },
  {
    name: M.wsBackpressureDrops,
    type: 'counter',
    help: 'Clients dropped for exceeding the backpressure frame limit.',
  },
  {
    name: M.helloDuration,
    type: 'histogram',
    help: 'Time from socket open to hello being written.',
  },

  // ── Operations ──────────────────────────────────────────────────────────────
  { name: M.opsReceived, type: 'counter', help: 'Operations accepted from clients, by type.' },
  { name: M.opsBroadcast, type: 'counter', help: 'Operations relayed to other clients.' },
  { name: M.opsRejected, type: 'counter', help: 'Operations rejected as malformed.' },
  {
    name: M.opsUnplaced,
    type: 'counter',
    help: 'Operations that could not be placed in the CRDT. Non-zero means peers are diverging.',
  },
  {
    name: M.opsRateLimited,
    type: 'counter',
    help: 'Connections closed for exceeding the per-connection write rate. Zero in normal use.',
  },
  {
    name: M.documentsTooLarge,
    type: 'counter',
    help: 'Writes refused because a document is at its element cap.',
  },
  { name: M.replayOps, type: 'counter', help: 'Operations replayed to catch a client up.' },
  { name: M.replayDuration, type: 'histogram', help: 'Time to catch a client up, in seconds.' },

  // ── Compaction ──────────────────────────────────────────────────────────────
  { name: M.compactionRuns, type: 'counter', help: 'Compaction passes attempted, by outcome.' },
  { name: M.compactionPruned, type: 'counter', help: 'Operations deleted by compaction.' },
  { name: M.compactionSkipped, type: 'counter', help: 'Compaction passes declined, by reason.' },
  { name: M.logLength, type: 'gauge', help: 'Retained operations per document.' },
  { name: M.logTombstones, type: 'gauge', help: 'Tombstoned elements per document.' },

  // ── Auth ────────────────────────────────────────────────────────────────────
  { name: M.authFailures, type: 'counter', help: 'Tokens refused, by reason.' },
  { name: M.sessionsIssued, type: 'counter', help: 'Anonymous sessions minted.' },

  // ── Process ─────────────────────────────────────────────────────────────────
  { name: M.processMemory, type: 'gauge', help: 'Resident set size in bytes.' },
];

/**
 * Declare every metric's type and help text up front.
 *
 * At startup rather than lazily, so a scrape taken before anything has happened still
 * carries the right TYPE line, and so a name used with the wrong type fails at boot
 * rather than in production.
 *
 * Safe to call more than once: every component does, and they must end up sharing one
 * registry without fighting over who declared what.
 */
export function declareMetrics(metrics: Metrics): void {
  for (const metric of METRICS) {
    metrics.ensure(metric.name, metric.type, metric.help);
  }
}
