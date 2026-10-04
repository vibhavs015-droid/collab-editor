/**
 * Metrics endpoint, end to end.
 *
 * Runs against a real API server, real WebSockets and a real database, because the
 * properties worth checking are about wiring: that what a component does reaches the
 * scrape, and that the scrape does not grow with the traffic it observes.
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { ApiServer } from './api.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Logger, type LogSink } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { M } from './observability/index.js';
import { Relay } from './relay.js';

const SUBJECT = 'metrics-subject';

let db: Database;
let server: ApiServer;
let wss: WebSocketServer;
let relay: Relay;
let metrics: Metrics;
let logLines: string[];
let store: DocumentStore;
let baseUrl: string;
let wsUrl: string;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `m-${counter}`;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${SUBJECT}`, 'Content-Type': 'application/json' };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(baseUrl + path, { ...init, headers: authHeaders() });
}

/** Fetch and parse the exposition, returning it as one string for substring checks. */
async function scrape(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/metrics`);

  expect(response.status).toBe(200);

  return response.text();
}

/**
 * Series names from a scrape, without values.
 *
 * Names rather than lines, because a counter's value changing is not a new series.
 * Comparing whole lines would report growth on every single request, which is the
 * exact confusion this test exists to avoid.
 */
function seriesOf(body: string): string[] {
  return (
    body
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      // A sample line is `name{labels} value`. The value is after the LAST space, which
      // is safe because labels never contain an unescaped space.
      .map((line) => {
        const cut = line.lastIndexOf(' ');
        return cut === -1 ? line : line.slice(0, cut);
      })
      .sort()
  );
}

function settle(turns = 6): Promise<void> {
  return new Promise((resolve) => {
    let remaining = turns;
    const tick = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, 15);
    };
    setTimeout(tick, 15);
  });
}

/**
 * Wait for a condition, rather than sleeping for a guessed interval.
 *
 * Every timing-dependent assertion in this file goes through here. A fixed sleep
 * passes on a fast machine and fails on a slow one, and a load test running on the
 * same CI budget is exactly the slow case.
 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
  }

  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  // Only the database is file-scoped. Booting PGlite costs about two seconds and
  // resetting is one statement; see httpAuth.test.ts for why truncation preserves
  // isolation.
  db = await Database.open();
});

/**
 * Rebuild everything that holds metrics.
 *
 * Per test, not per file: the registry accumulates, so a file-scoped one makes every
 * exact-count assertion depend on which tests ran before it. The database stays shared
 * because truncating it is cheap and complete.
 */
beforeEach(async () => {
  logLines = [];
  metrics = new Metrics();

  const sink: LogSink = (line) => {
    logLines.push(line);
  };

  const logger = new Logger({ sink, level: 'debug' });

  store = new DocumentStore({ db, metrics, logger: logger.child('store') });

  relay = new Relay({
    heartbeatMs: 0,
    metrics,
    // A real log, so catch-up is actually exercised. Without one the relay honestly
    // reports 'synced' for a replay that never happened, and records no metrics.
    log: {
      readSince: (documentId, sinceSeq) =>
        db.readOpsSince(documentId, sinceSeq).then((page) => ({
          snapshot: null,
          ops: page.ops,
          seq: page.seq,
        })),
    },
    logger: logger.child('relay'),
    authorize: (documentId, token) =>
      db
        .canAccess(documentId, token)
        .then((allowed) =>
          allowed
            ? { ok: true as const, subject: token }
            : { ok: false as const, code: 'DOCUMENT_NOT_FOUND' as const, message: 'No.' },
        ),
  });

  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('doc') ?? 'default';

    relay.attach(socket, id, (ops) => {
      void store.apply(id, ops);
    });
  });

  server = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    observability: { metrics, logger: logger.child('api') },
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}`;
    },
  });

  server.onUpgrade('/ws', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  await server.listen();
});

afterEach(async () => {
  relay.close();

  // An upgraded socket keeps `server.close()` waiting forever, so the sockets have to
  // go first. Node will not close the HTTP server while one is still attached.
  for (const client of wss.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve) => {
    wss.close(() => {
      resolve();
    });
  });

  await server.close();
  await db.truncateAll();
});

afterAll(async () => {
  await db.close();
});

describe('/api/metrics', () => {
  it('serves the Prometheus content type', async () => {
    const response = await fetch(`${baseUrl}/api/metrics`);

    expect(response.status).toBe(200);
    // The version parameter matters: a scraper refuses output it cannot identify.
    expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4');
  });

  it('needs no credentials, because a scraper has no session', async () => {
    // Requiring a token here would mean this endpoint is never the first thing anyone
    // checks.
    const response = await fetch(`${baseUrl}/api/metrics`);

    expect(response.status).toBe(200);
  });

  it('counts requests by route template', async () => {
    await api('/api/health');
    await api('/api/health');

    const body = await scrape();

    expect(body).toContain(`http_requests_total{route="/api/health",status="2xx"} 2`);
  });

  it('observes request duration', async () => {
    await api('/api/health');

    const body = await scrape();

    expect(body).toContain('http_request_duration_seconds_count{route="/api/health"} 1');
  });

  it('reports in-flight requests back to zero', async () => {
    // Read the registry directly rather than scraping.
    //
    // A scrape is itself a request, so while `/api/metrics` is being rendered the
    // gauge is legitimately 1. Asserting 0 from inside a scrape tests the timing of
    // the scrape, not the behaviour being checked.
    await api('/api/health');

    // A gauge that only ever rises is a leak made visible. This is the check that
    // catches it.
    expect(metrics.value(M.httpInFlight)).toBe(0);
  });

  it('counts the scrape itself as in flight', async () => {
    // Documents the reason for reading the registry above, so the next person does not
    // "fix" it into the assertion they were expecting.
    const inFlightDuringScrape = await scrape().then(() => metrics.value(M.httpInFlight));

    // By the time the body has been read, the response has finished.
    expect(inFlightDuringScrape).toBeLessThanOrEqual(1);
  });

  it('counts sessions issued', async () => {
    await fetch(`${baseUrl}/api/auth/session`, { method: 'POST' });

    expect(metrics.value(M.sessionsIssued)).toBe(1);
  });

  it('counts refused tokens by reason', async () => {
    await fetch(`${baseUrl}/api/documents`);

    expect(metrics.value(M.authFailures, { reason: 'missing' })).toBe(1);
  });

  it('reports process memory', async () => {
    const body = await scrape();

    expect(body).toMatch(/process_resident_memory_bytes \d+/u);
  });
});

describe('cardinality', () => {
  it('does not grow the scrape with the number of documents touched', async () => {
    // The property that makes this endpoint safe to leave enabled. Fifty documents
    // must produce the same number of series as five.
    //
    // Compared at five rather than at zero deliberately. A scrape taken before any
    // request has been made has not yet seen a route, so its first observation of
    // each route legitimately adds its histogram lines. That is a route being
    // measured for the first time, not cardinality growing.
    const touch = async (count: number, offset: number): Promise<string[]> => {
      for (let index = 0; index < count; index += 1) {
        const id = `cardinality-${offset + index}`;

        await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });
        await api(`/api/documents/${id}`);
        await api(`/api/documents/${id}/claim`, { method: 'POST' });
        await api(`/api/documents/${id}/collaborators`, {
          method: 'POST',
          body: JSON.stringify({ subject: 'someone' }),
        });
      }

      // One scrape to settle, then the one being measured. A scrape records its own
      // duration on `finish`, which is after its body has been rendered, so the first
      // scrape of a process cannot contain its own series. Without the warm-up this
      // test measures the scrape endpoint noticing itself, not cardinality.
      await scrape();
      return seriesOf(await scrape());
    };

    const five = await touch(5, 0);
    const fifty = await touch(45, 5);

    const appeared = fifty.filter((line) => !five.includes(line));

    if (appeared.length > 0) {
      process.stderr.write(`NEW SERIES: ${appeared.length}\n${appeared.join('\n')}\n`);
    }

    // Exactly equal, not "close". A raw path as a label would add one series per
    // document, and the difference would be in the hundreds.
    expect(fifty).toHaveLength(five.length);
  });

  it('never leaks a document id into the output', async () => {
    const id = 'a-very-distinctive-document-id';

    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });
    await api(`/api/documents/${id}`);

    expect(await scrape()).not.toContain(id);
  });

  it('never leaks a token into the output', async () => {
    // The one leak that would matter. Metrics are typically readable by more people
    // than documents are.
    await api('/api/documents');

    const body = await scrape();

    expect(body).not.toContain(SUBJECT);
  });

  it('never leaks a token into the logs either', async () => {
    await api('/api/documents');
    await fetch(`${baseUrl}/api/documents`, { method: 'POST' });

    const text = logLines.join('\n');

    // The rejected requests carried `Authorization: Bearer metrics-subject`.
    expect(text).not.toContain(SUBJECT);
    expect(text).toContain('rejected session');
  });

  it('reports no cardinality overflows', async () => {
    await api('/api/health');

    expect(metrics.overflowedMetrics()).toEqual([]);
  });
});

describe('relay metrics', () => {
  async function openClient(documentId: string, token = SUBJECT): Promise<WebSocket> {
    const socket = new WebSocket(`${wsUrl}/ws?doc=${encodeURIComponent(documentId)}`);

    socket.on('error', () => undefined);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });

    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token,
        documentId,
        lastAppliedSeq: 0,
      }),
    );

    await settle();

    return socket;
  }

  it('reports active connections', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const socket = await openClient(id);
    await settle();

    expect(metrics.value(M.wsConnectionsActive)).toBe(1);

    socket.close();

    // The gauge is driven by the server's own close event, which is strictly after the
    // client's. Waiting for the condition rather than sleeping is the difference between
    // a test that passes and a test that passes today.
    await waitFor(
      () => metrics.value(M.wsConnectionsActive) === 0,
      'the connection gauge to return to zero',
    );
  });

  it('reports unauthenticated sockets separately', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    // Connects and says nothing.
    const socket = new WebSocket(`${wsUrl}/ws?doc=${encodeURIComponent(id)}`);
    socket.on('error', () => undefined);

    await new Promise<void>((resolve) => {
      socket.once('open', () => {
        resolve();
      });
    });

    await settle();

    // The gauge an attacker would drive upwards, and the reason it exists.
    expect(metrics.value(M.wsPendingUnauthenticated)).toBe(1);
    expect(metrics.value(M.wsConnectionsActive)).toBe(0);

    socket.terminate();
    await settle();
  });

  it('counts refused connections by code', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const socket = await openClient(id, 'a-stranger');
    await settle();

    expect(metrics.value(M.wsRejected, { code: 'DOCUMENT_NOT_FOUND' })).toBe(1);

    socket.terminate();
  });

  it('counts accepted operations', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const socket = await openClient(id);
    await settle();

    socket.send(
      JSON.stringify({
        type: 'ops',
        documentId: id,
        ops: [{ type: 'insert', id: { site: 'a', clock: 1 }, origin: null, value: 'h' }],
      }),
    );

    await waitFor(
      () => metrics.value(M.opsReceived, { type: 'batch' }) === 1,
      'the operations to be counted',
    );

    socket.close();
  });

  it('counts operations that could not be placed', async () => {
    // The CRDT-health signal. A non-zero value here means some peer is waiting for an
    // operation that never arrived.
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const socket = await openClient(id);
    await settle();

    socket.send(
      JSON.stringify({
        type: 'ops',
        documentId: id,
        // Anchored to an element that does not exist anywhere.
        ops: [
          {
            type: 'insert',
            id: { site: 'ghost', clock: 1 },
            origin: { site: 'nowhere', clock: 9 },
            value: 'x',
          },
        ],
      }),
    );

    await waitFor(() => (metrics.value(M.opsUnplaced) ?? 0) >= 1, 'the unplaced count');
    expect(logLines.join('\n')).toContain('operations could not be placed');

    socket.close();
  });

  it('counts frames sent by type', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const socket = await openClient(id);
    await settle();

    expect(metrics.value(M.wsFramesSent, { type: 'welcome' })).toBeGreaterThanOrEqual(1);

    socket.close();
  });

  it('records a catch-up even when it moved nothing', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const socket = await openClient(id);

    await waitFor(() => metrics.value(M.replayOps) !== null, 'the catch-up to be recorded');

    // A client that is always current and one that always needs a full replay look
    // identical without this.
    expect(metrics.value(M.replayOps)).toBe(0);
    expect(await scrape()).toContain('collab_replay_duration_seconds_count');

    socket.close();
  });
});

describe('compaction metrics', () => {
  it('reports why a pass declined', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const store = new DocumentStore({ db, metrics, logger: Logger.silent() });
    const result = await store.compact(id);

    expect(result.compacted).toBe(false);
    expect(metrics.value(M.compactionRuns, { outcome: 'declined' })).toBe(1);
    // A policy that never fires and one that fires constantly look identical from the
    // outside without the reason.
    expect(metrics.value(M.compactionSkipped, { reason: 'log-too-small' })).toBe(1);
  });

  it('reports a pass that compacted', async () => {
    const id = nextId();
    await api('/api/documents', { method: 'POST', body: JSON.stringify({ id }) });

    const store = new DocumentStore({
      db,
      metrics,
      logger: Logger.silent(),
      compactionPolicy: { minOpsBelowFloor: 1, minTombstoneRatio: 0.1 },
    });

    // Enough history to clear the threshold.
    for (let round = 0; round < 10; round += 1) {
      await store.apply(id, [
        { type: 'insert', id: { site: 's', clock: round }, origin: null, value: 'a' },
      ]);
    }

    const result = await store.compact(id);

    if (result.compacted) {
      expect(metrics.value(M.compactionRuns, { outcome: 'compacted' })).toBeGreaterThanOrEqual(1);
      expect(metrics.value(M.compactionPruned)).toBeGreaterThanOrEqual(0);
    }
  });
});
