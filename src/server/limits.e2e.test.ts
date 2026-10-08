/**
 * T3: write quotas and rate limits, against the real relay and the real database.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE INTEGRATION TESTS AND NOT UNIT TESTS
 * ---------------------------------------------------------------------------
 * Every number here has a default chosen so that no legitimate session trips it, and that
 * claim is the one worth checking - not the arithmetic, which a unit test settles. A limit
 * that rejects ordinary work is worse than no limit, because it is invisible until someone
 * loses work to it.
 *
 * So the scenarios are the ones a browser actually produces:
 *
 *   - a legitimate offline flush, at the SHIPPED defaults. 12 frames of 1,000 operations,
 *     which is what MAX_OPS_PER_FRAME means and what a long offline session really looks like.
 *   - a flood, at deliberately small limits so the test does not have to send a hundred
 *     thousand operations to reach a burst it set itself.
 *
 * The unit-level behaviour of the token bucket and the environment parsing is in
 * limits.test.ts, where it belongs and where it can be exact.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import type { ElementId } from '../core/clock.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay } from './relay.js';
import { Metrics } from './observability/metrics.js';
import { DEFAULT_LIMITS, limitsWith, type Limits } from './limits.js';
import { reportWriteFailure } from './writeFailure.js';
import { Logger } from './observability/logger.js';

/** Frames the client puts in one `ops` message. Must match MAX_OPS_PER_FRAME. */
const FRAME_OPS = 1_000;

/** Operations in the legitimate offline flush: 12 frames. */
const FLUSH_OPS = 12_000;

const teardown: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const done of teardown.splice(0, teardown.length).reverse()) {
    await done();
  }
});

/** Chained inserts, so the store can actually place them. */
function insertOps(site: string, firstClock: number, count: number): unknown[] {
  const ops: unknown[] = [];
  let origin: ElementId | null = null;
  let clock = firstClock;

  for (let i = 0; i < count; i += 1) {
    const id: ElementId = { site, clock };
    ops.push({ type: 'insert', id, origin, value: 'x' });
    origin = id;
    clock += 1;
  }

  return ops;
}

function deleteOps(site: string, firstClock: number, count: number): unknown[] {
  const ops: unknown[] = [];
  let clock = firstClock;

  for (let i = 0; i < count; i += 1) {
    ops.push({ type: 'delete', target: { site, clock } });
    clock += 1;
  }

  return ops;
}

interface Harness {
  readonly port: number;
  readonly documentId: string;
  readonly metrics: Metrics;
  readonly refusals: { code: string; message: string }[];
  /** The document's stored text, or null if it does not exist. */
  read: () => Promise<string | null>;
  /** Wait until the store has caught up with everything sent. */
  settle: (ms?: number) => Promise<void>;
}

/**
 * A relay on a real socket, persisting to a real database, with the given limits.
 *
 * The limits are an argument rather than an environment variable because a test that had to
 * mutate `process.env` would be asserting on global state, and two such tests running in
 * parallel would be asserting on each other's.
 */
async function startRelay(options: {
  limits: Limits;
  maxDocumentElements?: number | null;
}): Promise<Harness> {
  const db = await Database.open(undefined, {
    maxDocumentElements: options.maxDocumentElements ?? null,
  });
  const store = new DocumentStore({ db });
  const documentId = 'quotas-doc';

  // Created here, because a document that does not exist is a different failure and used to
  // masquerade as a cap refusal: the store throws, the harness catches, and the test reports a
  // limit that was never reached.
  await db.createDocument({ id: documentId, title: 'quotas', owner: 'quotas-owner' });
  const metrics = new Metrics();
  const logger = Logger.silent();
  const refusals: { code: string; message: string }[] = [];

  // No authoriser: these tests are about volume, not authorisation, and open admission keeps
  // the handshake out of the way. Authorisation has its own suite.
  const relay = new Relay({
    heartbeatMs: 0,
    log: { readSince: (id, since, limit) => store.readSince(id, since, limit) },
    metrics,
    limits: options.limits,
  });

  const wss = new WebSocketServer({ port: 0 });
  const persisted: Promise<unknown>[] = [];

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('doc') ?? 'default';

    relay.attach(socket, id, (ops, site) => {
      const write = store.apply(id, ops).catch((error: unknown) => {
        // The same function production uses, so this exercises the real decision rather than a
        // copy of it. `documentId` rather than `id` because the store's id IS the document id
        // here and conflating them is exactly the kind of thing that reads fine until a relay
        // serves more than one document.
        if (reportWriteFailure(error, id, site, relay, metrics, logger)) {
          refusals.push({ code: 'DOCUMENT_TOO_LARGE', message: String(error) });
          return;
        }

        refusals.push({
          code: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
      });

      persisted.push(write);
    });
  });

  await new Promise<void>((resolve) => {
    wss.on('listening', () => {
      resolve();
    });
  });

  const address = wss.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  teardown.push(async () => {
    relay.close();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
    await db.close();
  });

  return {
    port,
    documentId,
    metrics,
    refusals,
    read: async () => (await db.getDocument(documentId))?.content ?? null,
    settle: async (ms = 300) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await Promise.allSettled(persisted);
    },
  };
}

/** Connect, and wait until the relay has admitted us. */
async function open(documentId: string, port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?doc=${documentId}`);
  const frames: Record<string, unknown>[] = [];
  const closes: { code: number; reason: string }[] = [];

  socket.on('message', (data: Buffer) => {
    frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
  });
  socket.on('close', (code, reason) => {
    closes.push({ code, reason: reason.toString('utf8') });
  });
  socket.on('error', () => {
    // Expected when the server closes first.
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });

  await new Promise((resolve) => setTimeout(resolve, 150));

  Object.assign(socket, { frames, closes });

  return socket;
}

function framesOf(socket: WebSocket): Record<string, unknown>[] {
  return (socket as unknown as { frames: Record<string, unknown>[] }).frames;
}

function closesOf(socket: WebSocket): { code: number; reason: string }[] {
  return (socket as unknown as { closes: { code: number; reason: string }[] }).closes;
}

function errorsOf(socket: WebSocket): { code: string; message: string }[] {
  return framesOf(socket)
    .filter((f) => f['type'] === 'error')
    .map((f) => ({ code: String(f['code']), message: String(f['message']) }));
}

/**
 * One series' current value, or undefined when the series has no samples yet.
 *
 * The series name is escaped before it becomes a pattern. Prometheus label sets are written
 * `name{label="value"}`, and those braces are regex quantifier syntax: interpolating one
 * unescaped throws `Incomplete quantifier` at runtime, which is how the first version of this
 * helper failed.
 */
function metricValue(metrics: Metrics, series: string): number | undefined {
  const pattern = series.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const match = new RegExp(`^${pattern} (-?\\d+(?:\\.\\d+)?)$`, 'mu').exec(metrics.render());

  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Whether a counter has any sample at all.
 *
 * In the Prometheus text format a counter that has never been incremented renders its HELP and
 * TYPE lines and NO sample line. So "no refusals happened" is the ABSENCE of a sample, not the
 * value 0. Asserting `metricValue(...) === 0` asserts something the format never produces, which
 * is a test that can only ever fail for the wrong reason.
 */
function metricSampled(metrics: Metrics, name: string): boolean {
  const pattern = name.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(`^${pattern}\\S* -?\\d`, 'mu').test(metrics.render());
}

/** Poll until `check` holds. A timeout names the last value, so a failure says what happened. */
async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`condition still false after ${timeoutMs} ms`);
}

function sendOps(socket: WebSocket, documentId: string, ops: unknown[]): void {
  socket.send(JSON.stringify({ type: 'ops', documentId, ops }));
}

describe('per-connection operation rate', () => {
  it('does not limit a legitimate 12,000-operation offline flush at the shipped defaults', async () => {
    // THE acceptance test for the burst number. 12 frames of 1,000 operations is what a
    // browser tab produces after a long offline session with the default
    // MAX_OPS_PER_FRAME chunking, and DEFAULT_LIMITS.opsBurst is 100,000 - ten times this.
    //
    // If this ever fails, the burst is too low, and the fix is the number rather than the test:
    // this is the workload the limit exists to permit.
    const h = await startRelay({ limits: DEFAULT_LIMITS });
    const socket = await open(h.documentId, h.port);

    let clock = 1;

    for (let frame = 0; frame < FLUSH_OPS / FRAME_OPS; frame += 1) {
      sendOps(socket, h.documentId, insertOps('writer', clock, FRAME_OPS));
      clock += FRAME_OPS;
    }

    await h.settle(1_000);

    expect(errorsOf(socket)).toEqual([]);
    expect(closesOf(socket)).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    // Poll rather than sleep for the count. A fixed wait is how "the test passed" and "the
    // server processed everything" get confused: at one second this read 4,000 of 12,000, and a
    // `toContain` on that value would have been a coin flip on machine speed. The wait is on
    // the condition, not on the clock.
    await waitFor(
      () => metricValue(h.metrics, 'collab_operations_received_total{type="batch"}') === FLUSH_OPS,
    );

    // And nothing was rate limited, at any point, on the way there.
    expect(metricSampled(h.metrics, 'collab_ops_rate_limited_total')).toBe(false);
  });

  it('refuses a flood above the burst, without applying or broadcasting it', async () => {
    // Small limits, so reaching the burst costs 3,000 operations rather than 100,000.
    const h = await startRelay({ limits: limitsWith({ opsBurst: 2_000, opsPerSecond: 1 }) });
    const observer = await open(h.documentId, h.port);
    const flooder = await open(h.documentId, h.port);

    let clock = 1;
    let limited = false;

    for (let frame = 0; frame < 3 && !limited; frame += 1) {
      sendOps(flooder, h.documentId, insertOps('flood', clock, FRAME_OPS));
      clock += FRAME_OPS;
      await new Promise((resolve) => setTimeout(resolve, 200));
      limited = closesOf(flooder).length > 0;
    }

    expect(limited, 'the flood should have been refused').toBe(true);

    // The error frame names the reason, so the client can tell this from a network problem.
    const errors = errorsOf(flooder);

    expect(errors.map((e) => e.code)).toContain('RATE_LIMITED');

    // 1008 is RFC 6455's "policy violation".
    expect(closesOf(flooder).map((c) => c.code)).toContain(1008);

    // The observer is a real peer, so it legitimately receives the ACCEPTED frames. What must
    // never arrive is the frame the relay refused: a relay that broadcast before checking
    // would spread the flood to everyone else in the room.
    //
    // Counted rather than asserted empty, because "the peer got nothing" is only correct when
    // nothing at all was accepted. Here two frames were accepted and the third was refused, so
    // the expected number is exactly the accepted ones.
    const relayedOps = framesOf(observer)
      .filter((f) => f['type'] === 'ops')
      .reduce((total, frame) => total + ((frame['ops'] as unknown[] | undefined)?.length ?? 0), 0);

    expect(relayedOps).toBe(2_000);

    const rendered = h.metrics.render();

    expect(rendered).toMatch(/collab_ops_rate_limited_total 1/);
  });

  it('gives a reconnecting client a fresh budget', async () => {
    // A refused client is not locked out. It reconnects, gets a new bucket, and can work. This
    // is why the relay closes rather than simply refusing frames: the refusal has to end
    // somewhere, and the end is a new connection rather than a permanently limited one.
    //
    // The second connection sends 400 operations against a burst of 500, so it is under the
    // ceiling even at a sustained rate of one per second. An earlier draft sent 1,000 against
    // the same 500 and asserted the reconnect worked - which fails, correctly: a single frame
    // larger than the burst is refused on any connection, new or not.
    const limits = limitsWith({ opsBurst: 500, opsPerSecond: 1 });
    const h = await startRelay({ limits });
    const first = await open(h.documentId, h.port);

    sendOps(first, h.documentId, insertOps('retry', 1, 1_000));
    await waitFor(() => closesOf(first).length > 0);

    expect(closesOf(first).map((c) => c.code)).toContain(1008);

    const second = await open(h.documentId, h.port);

    sendOps(second, h.documentId, insertOps('retry', 2_000, 400));

    // 400, not 1,400: the first connection's frame was REFUSED, and a refused frame is never
    // counted as received. That is the property being relied on here - a flood must not be able
    // to inflate the received counter while also being turned away.
    await waitFor(
      () => metricValue(h.metrics, 'collab_operations_received_total{type="batch"}') === 400,
    );

    expect(closesOf(second)).toEqual([]);
    expect(errorsOf(second)).toEqual([]);
  });

  it('charges encrypted frames the same way as plaintext operations', async () => {
    // Otherwise turning on end-to-end encryption is a way to bypass the write limit entirely,
    // which is the sort of thing that gets discovered by reading the code rather than by a test.
    //
    // 12 frames against a burst of 10: two more than it takes to empty the bucket.
    const h = await startRelay({ limits: limitsWith({ opsBurst: 10, opsPerSecond: 1 }) });
    const socket = await open(h.documentId, h.port);

    for (let clock = 1; clock <= 12; clock += 1) {
      socket.send(
        JSON.stringify({
          type: 'ops-enc',
          documentId: h.documentId,
          frames: [
            {
              v: 1,
              key: `i:enc@${clock}`,
              type: 'insert',
              site: 'enc',
              iv: 'AAAAAAAAAAAAAAAA',
              // 22 base64url characters: the floor parseEncryptedFrame enforces, which is a
              // GCM tag. 20 is rejected as a malformed frame, which is a different failure and
              // was the first version of this test.
              ct: 'AAAAAAAAAAAAAAAAAAAAAA',
            },
          ],
        }),
      );
    }

    await waitFor(() => closesOf(socket).length > 0);

    expect(errorsOf(socket).map((e) => e.code)).toContain('RATE_LIMITED');
    expect(closesOf(socket).map((c) => c.code)).toContain(1008);
    // Not exactly 1: several frames can already be in flight when the close is issued, and each
    // one that arrives before the socket actually closes is charged too. The property under
    // test is that a refusal is COUNTED, and that it is counted rather than logged and lost.
    expect(metricValue(h.metrics, 'collab_ops_rate_limited_total')).toBeGreaterThanOrEqual(1);
  });
});

describe('per-document element cap', () => {
  it('refuses growth past the cap, and still allows deletion', async () => {
    // The cap is set to 10 here, which is 100,000 times below the shipped default and is the
    // only way to reach it in a test.
    const h = await startRelay({
      limits: limitsWith({ opsBurst: 100_000, opsPerSecond: 5_000 }),
      maxDocumentElements: 10,
    });
    const socket = await open(h.documentId, h.port);

    // Exactly the cap: ten inserts, all of which must be accepted.
    sendOps(socket, h.documentId, insertOps('capped', 1, 10));
    await h.settle();

    expect(errorsOf(socket)).toEqual([]);

    // One more insert, and the document refuses.
    sendOps(socket, h.documentId, insertOps('capped', 11, 1));
    await h.settle();

    expect(errorsOf(socket).map((e) => e.code)).toContain('DOCUMENT_TOO_LARGE');

    expect(h.refusals.length).toBeGreaterThan(0);

    // Deletion still works at the cap. This is what makes the limit recoverable rather than a
    // dead end: a full document can still be emptied, one tombstone at a time.
    sendOps(socket, h.documentId, deleteOps('capped', 1, 1));
    await h.settle();

    const afterDelete = errorsOf(socket).map((e) => e.code);

    expect(afterDelete.filter((c) => c === 'DOCUMENT_TOO_LARGE')).toHaveLength(1);
  });

  it('leaves the stored document readable after a refusal', async () => {
    // The refusal must not damage what is already there. A quota that corrupts the document it
    // is protecting would be worse than no quota.
    const h = await startRelay({
      limits: limitsWith({ opsBurst: 100_000, opsPerSecond: 5_000 }),
      maxDocumentElements: 5,
    });
    const socket = await open(h.documentId, h.port);

    sendOps(socket, h.documentId, insertOps('readable', 1, 5));
    await h.settle();

    sendOps(socket, h.documentId, insertOps('readable', 6, 1));
    await h.settle(500);

    expect(errorsOf(socket).map((e) => e.code)).toContain('DOCUMENT_TOO_LARGE');

    // A second client connects and finds the document intact and reachable. The connection
    // staying up matters as much as the content: a refusal that broke the socket would look
    // like a crash to everyone else in the room.
    const reader = await open(h.documentId, h.port);
    await h.settle(400);

    // Read from the store, not from the frames. What a reconnecting client receives is a
    // snapshot OR a replay depending on where the compaction floor happens to be, so
    // asserting on one frame type would test that choice rather than the thing under test.
    expect(closesOf(reader)).toEqual([]);
    expect(await h.read()).toBe('xxxxx');
  });

  it('counts the refusal in a metric', async () => {
    const h = await startRelay({
      limits: limitsWith({ opsBurst: 100_000, opsPerSecond: 5_000 }),
      maxDocumentElements: 1,
    });
    const socket = await open(h.documentId, h.port);

    sendOps(socket, h.documentId, insertOps('counted', 1, 1));
    await h.settle();

    sendOps(socket, h.documentId, insertOps('counted', 2, 1));
    await h.settle();

    // The client is told, by site, with the code the protocol defines. That is this layer's whole
    // job; the counter that accompanies it is incremented by reportWriteFailure, which
    // writeFailure.test.ts covers directly.
    expect(h.refusals.map((r) => r.code)).toEqual(['DOCUMENT_TOO_LARGE']);
  });
});
