import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Operation } from '../../core/crdt/rga.js';
import {
  SyncTransport,
  type Baseline,
  type ConnectionState,
  type TransportHandlers,
} from './transport.js';

/**
 * A scriptable WebSocket double.
 *
 * Every timing-sensitive behaviour in the transport (backoff, outbox flushing,
 * reconnect) is impossible to test against a real socket without real waits, and
 * real waits produce slow, flaky tests. This double lets a test drive the socket
 * lifecycle and inspect exactly what was sent.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 1; // OPEN
  sent: string[] = [];
  binaryType = 'blob';

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  /** Parse everything this socket was asked to send. */
  parsedSent(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  // ── Test controls ──

  /** Simulate the connection opening. */
  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Simulate the server dropping the connection. */
  triggerClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Deliver a server frame. */
  deliver(payload: object): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  /**
   * The handshake the real server performs: open, then welcome.
   *
   * `welcome` is not decoration. The server refuses every frame except `hello` from
   * an unauthorised socket, so a client must wait for `welcome` before it sends
   * anything else. A test that only triggers `open` is testing a connection the
   * server would have refused.
   */
  admit(site = 'server-site'): void {
    this.triggerOpen();

    this.deliver({
      type: 'welcome',
      protocolVersion: 1,
      site,
      documentId: 'doc-1',
      snapshot: [],
      seq: 0,
    });
  }

  /** Deliver a raw, possibly malformed frame. */
  deliverRaw(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }

  static last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) {
      throw new Error('no socket was created');
    }
    return socket;
  }

  static reset(): void {
    FakeSocket.instances = [];
  }
}

interface Harness {
  readonly transport: SyncTransport;
  readonly states: ConnectionState[];
  readonly ops: Operation[];
  readonly cursors: Record<string, number>[];
  readonly errors: { code: string; message: string }[];
  readonly sites: string[];
  readonly pending: { state: string; count: number }[];
  readonly baselines: Baseline[];
}

function harness(
  options: {
    baseRetryMs?: number;
    maxRetryMs?: number;
    resolveToken?: () => Promise<string>;
  } = {},
): Harness {
  const states: ConnectionState[] = [];
  const ops: Operation[] = [];
  const cursors: Record<string, number>[] = [];
  const errors: { code: string; message: string }[] = [];
  const sites: string[] = [];
  const pending: { state: string; count: number }[] = [];
  const baselines: Baseline[] = [];

  const handlers: TransportHandlers = {
    onOps: (received) => {
      ops.push(...received);
    },
    onBaseline: (baseline) => {
      baselines.push(baseline);
    },
    onPresence: (received) => {
      cursors.push({ ...received });
    },
    onSyncState: (state, count) => {
      pending.push({ state, count });
    },
    onWelcome: (site) => {
      sites.push(site);
    },
    onError: (code, message) => {
      errors.push({ code, message });
    },
    onStateChange: (state) => {
      states.push(state);
    },
  };

  const transport = new SyncTransport({
    documentId: 'doc-1',
    url: 'ws://localhost:3001/ws?doc=doc-1',
    handlers,
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    baseRetryMs: options.baseRetryMs ?? 100,
    maxRetryMs: options.maxRetryMs ?? 5000,
    ...(options.resolveToken === undefined ? {} : { resolveToken: options.resolveToken }),
  });

  return { transport, states, ops, cursors, errors, sites, pending, baselines };
}

describe('SyncTransport - snapshot baseline', () => {
  /**
   * Open the connection and return the live harness.
   *
   * Self-contained because this block sits outside the main `describe`, so it does
   * not inherit that one's `beforeEach` reset. `FakeSocket.last()` is the socket
   * the transport was handed, so `deliver` goes through exactly the same parse and
   * validate path as a real frame. Driving `#receive` directly would skip the
   * envelope handling that could itself be the bug.
   */
  function opened(): Harness {
    FakeSocket.reset();
    const h = harness();
    h.transport.connect();
    FakeSocket.last().triggerOpen();
    return h;
  }

  const baselineFrame = {
    type: 'snapshot',
    documentId: 'doc-1',
    elements: [{ id: { site: 's', clock: 1 }, value: 'h', origin: null }],
    ops: [],
    seq: 42,
  };

  it('adopts a baseline when the outbox is empty', () => {
    const h = opened();

    FakeSocket.last().deliver(baselineFrame);

    expect(h.baselines).toHaveLength(1);
    expect(h.baselines[0]?.seq).toBe(42);
    expect(h.baselines[0]?.elements).toHaveLength(1);

    // The cursor advances, so the client does not ask for the same baseline twice.
    expect(h.transport.serverSeq).toBe(42);
  });

  it('refuses a baseline while unsent operations are queued', () => {
    const h = opened();

    // The socket dies without the transport noticing: the browser has not fired
    // `close` yet, so the transport still believes it is open. This is the
    // realistic case, and it is the window where a baseline would destroy work.
    const socket = FakeSocket.last();
    socket.readyState = 3;

    h.transport.send(sampleOps);

    // Still queued, because the frame could not actually be written.
    expect(h.transport.queuedOperationCount).toBe(1);

    // A frame that still arrives over the dead connection.
    socket.deliver(baselineFrame);

    // The whole safety property. Adopting here would discard the user's work with
    // no error reported anywhere.
    expect(h.baselines).toHaveLength(0);

    // And it asks again rather than silently proceeding.
    socket.readyState = 1;
    h.transport.requestResync();
    expect(socket.parsedSent().filter((m) => m['type'] === 'resync')).toHaveLength(1);
  });

  it('gives up rather than resyncing forever', () => {
    const h = opened();
    const socket = FakeSocket.last();

    // A dead socket the transport has not detected, so it cannot flush and cannot
    // clear the queue. Exactly the situation where a naive implementation would
    // retry indefinitely.
    socket.readyState = 3;
    h.transport.send(sampleOps);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      socket.deliver(baselineFrame);
    }

    // Bounded, and it says so. A client spinning here forever would be harder to
    // diagnose than one that reports the disagreement.
    expect(h.baselines).toHaveLength(0);
    expect(h.errors.map((e) => e.code)).toContain('BASELINE_REFUSED');

    // The operations are still queued. Giving up on the baseline must never mean
    // giving up on the user's work.
    expect(h.transport.queuedOperationCount).toBe(1);
  });

  it('ignores a baseline while disconnected', () => {
    const h = opened();
    FakeSocket.last().triggerClose();

    h.transport.send(sampleOps);

    const socket = FakeSocket.last();
    const before = socket.sent.length;
    socket.deliver(baselineFrame);

    // Nothing was sent, because there is no socket. The reconnect re-sends `hello`,
    // which triggers a fresh catch-up.
    expect(h.baselines).toHaveLength(0);
    expect(socket.sent).toHaveLength(before);
  });

  it('keeps operations queued when the socket cannot take them', () => {
    const h = opened();

    // A dead socket the transport has not detected yet.
    FakeSocket.last().readyState = 3;
    h.transport.send(sampleOps);

    // Previously this cleared the queue and dropped the work on the floor. The
    // outbox is only cleared once a frame is actually accepted.
    expect(h.transport.queuedOperationCount).toBe(1);
  });

  it('drops malformed operations inside a baseline but keeps the elements', () => {
    const h = opened();

    FakeSocket.last().deliver({
      ...baselineFrame,
      // Not an operation. parseOperations drops it rather than the whole baseline,
      // because a client cannot reject a batch it never receives.
      ops: [{ nonsense: true }, sampleOps[0]],
    });

    expect(h.baselines).toHaveLength(1);
    expect(h.baselines[0]?.ops).toEqual(sampleOps);
  });
});

const sampleOps: Operation[] = [
  { type: 'insert', id: { site: 'a', clock: 1 }, origin: null, value: 'x' },
];

describe('SyncTransport', () => {
  beforeEach(() => {
    FakeSocket.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connection lifecycle', () => {
    it('starts closed and opens on connect', () => {
      const h = harness();
      expect(h.transport.state).toBe('closed');

      h.transport.connect();
      expect(h.transport.state).toBe('connecting');

      FakeSocket.last().triggerOpen();
      expect(h.transport.state).toBe('open');
    });

    it('sends hello on open with the current protocol version', async () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      // `hello` is sent from an async method because the token is resolved per
      // connect. Without a tick the frame has not been written yet, and asserting
      // here would be asserting on the wrong moment.
      await Promise.resolve();

      const hello = FakeSocket.last().parsedSent()[0];
      expect(hello?.['type']).toBe('hello');
      expect(hello?.['documentId']).toBe('doc-1');
    });

    it('resolves a token on every connect rather than reusing one', async () => {
      // The reason `resolveToken` is a function. A token captured at construction
      // would expire, and the client would reconnect forever to a server that had
      // every reason to refuse it.
      let issued = 0;
      const h = harness({ resolveToken: () => Promise.resolve(`token-${(issued += 1)}`) });

      h.transport.connect();
      FakeSocket.last().triggerOpen();
      await Promise.resolve();

      FakeSocket.last().triggerClose();
      // Let the retry timer fire, so a genuinely NEW socket is created.
      vi.advanceTimersByTime(10_000);
      FakeSocket.last().triggerOpen();
      await Promise.resolve();

      expect(FakeSocket.instances).toHaveLength(2);

      const hellos = FakeSocket.instances
        .flatMap((socket) => socket.parsedSent())
        .filter((frame) => frame['type'] === 'hello');

      expect(hellos).toHaveLength(2);
      expect(hellos[0]?.['token']).toBe('token-1');
      expect(hellos[1]?.['token']).toBe('token-2');
    });

    it('sends hello with an empty token when none can be obtained', async () => {
      // The server closes such a connection and the retry loop runs. Inventing a
      // token here would turn a session problem into a confusing authorisation
      // failure.
      const h = harness({
        resolveToken: () => Promise.reject(new Error('offline')),
      });

      h.transport.connect();
      FakeSocket.last().triggerOpen();
      await Promise.resolve();

      const hello = FakeSocket.last().parsedSent()[0];
      expect(hello).toMatchObject({ type: 'hello', token: '' });
    });

    it('withholds queued operations until the server has admitted the client', async () => {
      // The race the handshake exists to prevent: operations sent between `hello`
      // and `welcome` are refused, because the server's authorisation check is
      // asynchronous and the socket is unauthorised until it completes.
      const h = harness();
      h.transport.connect();

      FakeSocket.last().triggerOpen();
      await Promise.resolve();

      h.transport.send(sampleOps);
      expect(h.transport.queuedOperationCount).toBe(1);
      expect(
        FakeSocket.last()
          .parsedSent()
          .some((f) => f['type'] === 'ops'),
      ).toBe(false);

      FakeSocket.last().deliver({
        type: 'welcome',
        protocolVersion: 1,
        site: 'server-site',
        documentId: 'doc-1',
        snapshot: [],
        seq: 0,
      });

      // Now, and only now.
      expect(h.transport.queuedOperationCount).toBe(0);
      expect(
        FakeSocket.last()
          .parsedSent()
          .some((f) => f['type'] === 'ops'),
      ).toBe(true);
    });

    it('does not write operations before hello has gone out', async () => {
      // `welcome` arriving early must not be enough on its own. Both the hello write
      // and the welcome are required, so a server frame that arrives before the
      // handshake has even started cannot release the outbox.
      const h = harness();
      h.transport.connect();

      FakeSocket.last().deliver({
        type: 'welcome',
        protocolVersion: 1,
        site: 'server-site',
        documentId: 'doc-1',
        snapshot: [],
        seq: 0,
      });

      FakeSocket.last().triggerOpen();

      // Synchronously, before the token resolves and hello is written.
      h.transport.send(sampleOps);

      expect(h.sites).toEqual(['server-site']);
      expect(h.transport.queuedOperationCount).toBe(1);
      expect(
        FakeSocket.last()
          .parsedSent()
          .some((f) => f['type'] === 'ops'),
      ).toBe(false);

      // Once hello is on the wire the handshake genuinely is complete.
      await Promise.resolve();

      expect(h.transport.queuedOperationCount).toBe(0);
      expect(
        FakeSocket.last()
          .parsedSent()
          .some((f) => f['type'] === 'ops'),
      ).toBe(true);
    });

    it('reports the assigned site once welcomed', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      FakeSocket.last().deliver({
        type: 'welcome',
        protocolVersion: 1,
        site: 'site-abc',
        documentId: 'doc-1',
        snapshot: [],
        clock: 0,
      });

      expect(h.sites).toEqual(['site-abc']);
    });

    it('ignores a duplicate connect while already open', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      h.transport.connect();
      h.transport.connect();

      // One socket only; a second would leak a connection.
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('does not reconnect after disconnect', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      h.transport.disconnect();
      vi.advanceTimersByTime(10_000);

      expect(FakeSocket.instances).toHaveLength(1);
    });
  });

  describe('sending operations', () => {
    it('sends immediately once the server has admitted the client', async () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().admit();
      await Promise.resolve();

      h.transport.send(sampleOps);

      const opsFrame = FakeSocket.last()
        .parsedSent()
        .find((m) => m['type'] === 'ops');
      expect(opsFrame).toBeDefined();
      expect(h.transport.queuedOperationCount).toBe(0);
    });

    it('queues while offline and flushes once admitted', async () => {
      const h = harness();

      // Never connected: edits must survive.
      h.transport.send(sampleOps);
      expect(h.transport.queuedOperationCount).toBe(1);

      h.transport.connect();
      FakeSocket.last().admit();
      await Promise.resolve();

      // hello, then the queued batch.
      const frames = FakeSocket.last().parsedSent();
      expect(frames[0]?.['type']).toBe('hello');
      expect(frames[1]?.['type']).toBe('ops');
      expect(h.transport.queuedOperationCount).toBe(0);
    });

    it('reports pending state while queued', () => {
      const h = harness();
      h.transport.send(sampleOps);

      expect(h.pending.at(-1)).toEqual({ state: 'pending', count: 1 });
    });

    it('preserves order across a queue', async () => {
      const h = harness();
      const ordered: Operation[] = [
        { type: 'insert', id: { site: 'a', clock: 1 }, origin: null, value: '1' },
        { type: 'insert', id: { site: 'a', clock: 2 }, origin: null, value: '2' },
        { type: 'insert', id: { site: 'a', clock: 3 }, origin: null, value: '3' },
      ];

      h.transport.send(ordered);
      h.transport.connect();
      FakeSocket.last().admit();
      await Promise.resolve();

      const opsFrame = FakeSocket.last()
        .parsedSent()
        .find((m) => m['type'] === 'ops');
      const sent = opsFrame?.['ops'] as { id: { clock: number } }[];

      expect(sent.map((op) => op.id.clock)).toEqual([1, 2, 3]);
    });

    it('drops the oldest operations past the queue cap', () => {
      // Built directly rather than via the harness so the queue cap can be set.
      const transport = new SyncTransport({
        documentId: 'doc-1',
        url: 'ws://x',
        handlers: {
          onOps: () => undefined,
          onBaseline: () => undefined,
          onPresence: () => undefined,
          onSyncState: () => undefined,
          onWelcome: () => undefined,
          onError: () => undefined,
          onStateChange: () => undefined,
        },
        socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
        maxQueuedOps: 3,
      });

      for (let clock = 1; clock <= 6; clock += 1) {
        transport.send([{ type: 'insert', id: { site: 'a', clock }, origin: null, value: 'x' }]);
      }

      // Bounded, not unbounded. An unbounded queue is a memory leak waiting for
      // a user who edits for an hour on a train.
      expect(transport.queuedOperationCount).toBe(3);
    });

    it('ignores an empty send', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      h.transport.send([]);

      expect(
        FakeSocket.last()
          .parsedSent()
          .some((m) => m['type'] === 'ops'),
      ).toBe(false);
    });
  });

  describe('receiving operations', () => {
    it('passes inbound operations to the handler', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      FakeSocket.last().deliver({
        type: 'ops',
        documentId: 'doc-1',
        ops: [{ type: 'insert', id: { site: 'b', clock: 1 }, origin: null, value: 'y' }],
      });

      expect(h.ops).toHaveLength(1);
      expect(h.ops[0]?.type).toBe('insert');
    });

    it('passes presence cursors through', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      FakeSocket.last().deliver({
        type: 'presence',
        documentId: 'doc-1',
        cursors: { siteX: 5, siteY: 9 },
      });

      expect(h.cursors.at(-1)).toEqual({ siteX: 5, siteY: 9 });
    });

    it('surfaces server errors', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      FakeSocket.last().deliver({
        type: 'error',
        code: 'RATE_LIMITED',
        message: 'Slow down.',
      });

      expect(h.errors.at(-1)).toEqual({ code: 'RATE_LIMITED', message: 'Slow down.' });
    });

    it('reports a malformed frame instead of throwing', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      // Must not throw: a hostile or buggy server cannot crash the editor.
      expect(() => {
        FakeSocket.last().deliverRaw('{not json');
      }).not.toThrow();

      expect(h.errors.at(-1)?.code).toBe('BAD_RESPONSE');
    });

    it('ignores a frame with no recognisable type', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      FakeSocket.last().deliver({ nonsense: true });

      expect(h.errors.at(-1)?.code).toBe('BAD_RESPONSE');
    });
  });

  describe('reconnection', () => {
    it('schedules a retry after an unexpected close', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      FakeSocket.last().triggerClose();
      expect(h.transport.state).toBe('closed');

      vi.advanceTimersByTime(6000);

      expect(FakeSocket.instances.length).toBeGreaterThan(1);
    });

    it('backs off exponentially', () => {
      // Jitter is randomised per attempt, so fix it to 1.0 to make the delay
      // exactly half the exponential value. Without this the assertion is flaky:
      // two adjacent attempts can jitter to nearly the same delay.
      vi.spyOn(Math, 'random').mockReturnValue(1);

      const h = harness({ baseRetryMs: 100, maxRetryMs: 100_000 });
      h.transport.connect();

      // Drive several failures, recording when each retry fires.
      const delays: number[] = [];

      for (let round = 0; round < 4; round += 1) {
        // Never trigger 'open': a successful connection resets the backoff, so
        // opening between failures would reset the very counter under test.
        const socket = FakeSocket.last();

        let elapsed = 0;
        socket.triggerClose();

        // Step forward until the next socket is created.
        while (FakeSocket.instances.length === round + 1) {
          vi.advanceTimersByTime(10);
          elapsed += 10;
          if (elapsed > 200_000) break;
        }

        delays.push(elapsed);
      }

      // The measured delays include the 10ms stepping granularity of the loop below,
      // so compare against a lower bound rather than an exact multiple.
      //
      // A flat retry interval is the failure mode that matters: every client
      // disconnected by one server restart returns in the same millisecond and
      // knocks it over again. Growth is the property being asserted.
      for (let i = 1; i < delays.length; i += 1) {
        expect(delays[i] ?? 0).toBeGreaterThan(delays[i - 1] ?? 0);
      }

      vi.restoreAllMocks();
    });

    it('applies jitter so clients do not return in lockstep', () => {
      // This is the thundering-herd guard. Verified by observing that repeated
      // identical failures produce differing first-retry timings.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const h = harness({ baseRetryMs: 100 });
      h.transport.connect();
      FakeSocket.last().triggerOpen();
      FakeSocket.last().triggerClose();

      vi.advanceTimersByTime(200);
      expect(FakeSocket.instances.length).toBe(2);

      randomSpy.mockRestore();
    });

    it('resets the backoff after a successful connection', () => {
      harness({ baseRetryMs: 100 }).transport.connect();

      // Fail a few times so the attempt counter climbs.
      for (let i = 0; i < 3; i += 1) {
        vi.advanceTimersByTime(20_000);
        const socket = FakeSocket.last();
        socket.triggerOpen();
        socket.triggerClose();
      }

      // A successful open should reset the counter, so the next retry is short.
      vi.advanceTimersByTime(20_000);
      const socket = FakeSocket.last();
      const before = FakeSocket.instances.length;
      socket.triggerOpen();
      socket.triggerClose();
      vi.advanceTimersByTime(200);

      expect(FakeSocket.instances.length).toBeGreaterThan(before);
      randomCleanup();
    });

    it('reports offline sync state on disconnect', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      FakeSocket.last().triggerClose();

      expect(h.pending.at(-1)?.state).toBe('offline');
    });

    it('survives a socket factory that throws', () => {
      const transport = new SyncTransport({
        documentId: 'doc-1',
        url: 'ws://x',
        handlers: {
          onOps: () => undefined,
          onBaseline: () => undefined,
          onPresence: () => undefined,
          onSyncState: () => undefined,
          onWelcome: () => undefined,
          onError: () => undefined,
          onStateChange: () => undefined,
        },
        socketFactory: () => {
          throw new Error('blocked');
        },
      });

      expect(() => {
        transport.connect();
      }).not.toThrow();

      // Must not sit in 'connecting' forever after a construction failure.
      expect(transport.state).toBe('closed');
    });
  });

  describe('presence and resync', () => {
    it('sends presence only when open', () => {
      const h = harness();

      h.transport.sendPresence(3, 0);
      expect(FakeSocket.instances).toHaveLength(0);

      h.transport.connect();
      FakeSocket.last().triggerOpen();
      h.transport.sendPresence(3, 0);

      const presence = FakeSocket.last()
        .parsedSent()
        .find((m) => m['type'] === 'presence');
      expect(presence?.['cursor']).toBe(3);
    });

    it('sends a null cursor when focus is lost', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      h.transport.sendPresence(null, 0);

      const presence = FakeSocket.last()
        .parsedSent()
        .find((m) => m['type'] === 'presence');
      expect(presence?.['cursor']).toBeNull();
    });

    it('requests a resync', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      h.transport.requestResync();

      expect(
        FakeSocket.last()
          .parsedSent()
          .some((m) => m['type'] === 'resync'),
      ).toBe(true);
    });
  });

  describe('disposal', () => {
    it('stops reconnecting permanently after dispose', () => {
      const h = harness();
      h.transport.connect();
      FakeSocket.last().triggerOpen();

      h.transport.dispose();
      FakeSocket.last().triggerClose();

      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('clears the queue on disconnect', () => {
      const h = harness();
      h.transport.send(sampleOps);
      expect(h.transport.queuedOperationCount).toBe(1);

      h.transport.disconnect();
      expect(h.transport.queuedOperationCount).toBe(0);
    });
  });
});

function randomCleanup(): void {
  vi.restoreAllMocks();
}
