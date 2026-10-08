/**
 * Relay-level acknowledgement behaviour (ADR-0015).
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TESTED HERE AND WHY IT IS NOT JUST IN writeDurability.test.ts
 * ---------------------------------------------------------------------------
 * `writeDurability.test.ts` proves the END-TO-END behaviour with a real database, which is the
 * claim that matters. This file pins down the three properties that make it work, at the layer
 * where they are decided:
 *
 *   1. no `ack` for a frame that did not ask for one - the compatibility guarantee, and the
 *      reason `PROTOCOL_VERSION` did not have to move
 *   2. no `ack` before the store settles, and none at all if the store fails
 *   3. the encrypted path behaves identically
 *
 * Property 2 is the one that is easy to get subtly wrong and impossible to see: an `ack` sent
 * when the frame is read rather than when it is stored would make every test in this file pass
 * and leave the original bug completely intact.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { Relay } from './relay.js';
import type { ServerMessage } from '../shared/protocol.js';

const teardown: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const done of teardown.splice(0, teardown.length).reverse()) {
    await done();
  }
});

interface Harness {
  readonly connect: () => Promise<Client>;
  /** Handed to `relay.attach`; replaced per test. */
  persist: (ops: readonly unknown[]) => void | Promise<void>;
}

interface Client {
  readonly received: () => ServerMessage[];
  send: (message: object) => void;
  waitFor: (predicate: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
  close: () => void;
}

async function startHarness(): Promise<Harness> {
  // A mutable object rather than a `readonly` field assigned after construction: the relay needs
  // to reach `persist` before any socket exists, and a reassigned `readonly` is a lie the
  // compiler is right to refuse.
  const state: { persist: (ops: readonly unknown[]) => void | Promise<void> } = {
    // Synchronous by default: the common case, and the one that must still produce an ack.
    persist: () => undefined,
  };

  const relay = new Relay({ heartbeatMs: 0 });
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });

  await new Promise<void>((resolve) => {
    wss.on('listening', () => {
      resolve();
    });
  });

  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    relay.attach(socket, url.searchParams.get('doc') ?? 'default', (ops) => {
      return state.persist(ops);
    });
  });

  teardown.push(async () => {
    relay.close();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  });

  const harness: Harness = {
    // A getter/setter pair rather than a plain field. The relay reads `state.persist` from
    // inside its connection handler, so a test assigning `h.persist = ...` has to reach
    // `state` - and a plain property would replace the harness field while the relay kept
    // calling the original. That is a silent no-op in every test that overrides it, which is
    // exactly the two tests that most needed to override it.
    get persist() {
      return state.persist;
    },
    set persist(value: (ops: readonly unknown[]) => void | Promise<void>) {
      state.persist = value;
    },
    connect: async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?doc=ack-doc`);
      const inbox: ServerMessage[] = [];
      const waiters: ((m: ServerMessage) => boolean)[] = [];

      socket.on('message', (data: Buffer) => {
        const parsed = JSON.parse(data.toString('utf8')) as ServerMessage;

        inbox.push(parsed);

        // NOT `waiters.shift()`. A waiter must survive every frame that does not match it,
        // because the interesting cases here are exactly "b5 arrives before b6" - and a
        // shift() consumes the waiter on the first non-matching frame and then silently
        // forgets it, which is a test that times out for no visible reason.
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (waiters[i]?.(parsed) === true) {
            waiters.splice(i, 1);
          }
        }
      });

      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve();
        });
        socket.once('error', reject);
      });

      // No authoriser is configured, so the relay admits on connect and sends `welcome`.
      const client: Client = {
        received: () => inbox,
        send: (message) => {
          socket.send(JSON.stringify(message));
        },
        waitFor: (predicate, timeoutMs = 5_000) =>
          new Promise<ServerMessage>((resolve, reject) => {
            const found = inbox.findIndex(predicate);

            if (found >= 0) {
              resolve(inbox[found] as ServerMessage);
              return;
            }

            const timer = setTimeout(() => {
              reject(
                new Error(
                  `no matching frame within ${timeoutMs} ms; saw ${JSON.stringify(
                    inbox.map((m) => m.type),
                  )}`,
                ),
              );
            }, timeoutMs);

            waiters.push((m) => {
              clearTimeout(timer);

              if (predicate(m)) {
                resolve(m);
                return true;
              }

              return false;
            });
          }),
        close: () => {
          socket.close();
        },
      };

      return client;
    },
  };

  return harness;
}

const OPS = [{ type: 'insert', id: { site: 's', clock: 1 }, origin: null, value: 'x' }];

describe('acknowledgements (ADR-0015)', () => {
  it('acknowledges a frame that asked for one', async () => {
    const h = await startHarness();
    const c = await h.connect();

    c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS, batchId: 'b1' });

    const ack = await c.waitFor((m) => m.type === 'ack');

    expect(ack).toEqual({ type: 'ack', batchId: 'b1' });
  });

  it('sends NOTHING to a client that did not ask', async () => {
    // The compatibility guarantee, and the reason no version bump was needed: an old client
    // sends no batchId, gets no ack, and therefore never sees a frame type it cannot parse.
    const h = await startHarness();
    const c = await h.connect();

    c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS });

    // Long enough that a message sent after the write would have arrived.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(c.received().filter((m) => m.type === 'ack')).toEqual([]);
    expect(c.received().map((m) => m.type)).not.toContain('ack');
  });

  it('waits for the store to settle before acknowledging', async () => {
    // THE test that distinguishes "stored" from "received".
    //
    // Acknowledging on receipt would make every other test here pass and leave the original
    // data-loss bug exactly as it was, so this one asserts on ordering rather than on presence.
    const h = await startHarness();
    let release: () => void = () => undefined;
    let stored = false;

    h.persist = () =>
      new Promise<void>((resolve) => {
        release = () => {
          stored = true;
          resolve();
        };
      });

    const c = await h.connect();

    c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS, batchId: 'b2' });

    // Give the relay ample time to have acknowledged if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(stored, 'the store was never called').toBe(false);
    expect(
      c.received().filter((m) => m.type === 'ack'),
      'acknowledged before storing',
    ).toEqual([]);

    release();

    const ack = await c.waitFor((m) => m.type === 'ack');

    expect(ack).toEqual({ type: 'ack', batchId: 'b2' });
  });

  it('sends no acknowledgement when the store fails', async () => {
    // The client's only signal that a write failed is its absence. An ack sent anyway would be
    // the bug this whole change exists to remove.
    //
    // ALSO: nothing may escape as an unhandled rejection. A rejection that reaches Node
    // unhandled terminates the process by default, so a failing store would take the server down
    // rather than refusing one write - and this is the path WITH a batchId, which is why it
    // caught a leak the no-batchId path did not.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      const h = await startHarness();

      h.persist = () => Promise.reject(new Error('the disk is full'));

      const c = await h.connect();

      c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS, batchId: 'b3' });

      // Long enough for Node to have decided this was unhandled and acted on it.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(c.received().filter((m) => m.type === 'ack')).toEqual([]);
      expect(
        unhandled,
        `the store rejection escaped as an unhandled rejection: ${String(unhandled[0])}`,
      ).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('survives a store rejection on a frame that asked for no acknowledgement', async () => {
    // ---------------------------------------------------------------------------
    // A REAL BUG THIS FILE DID NOT CATCH, found by the production smoke test.
    // ---------------------------------------------------------------------------
    // `#persistThenAcknowledge` used to `return` early for a frame with no batchId, leaving the
    // store's promise with no rejection handler at all. The production smoke client is a raw
    // WebSocket, so it sends no batchId; its store call rejected; the unhandled rejection
    // terminated the server with exit 1 part-way through a run that had passed every check up
    // to that point.
    //
    // The earlier tests missed it because they all send a batchId, which took the other branch.
    // So this one deliberately does not.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      const h = await startHarness();

      h.persist = () => Promise.reject(new Error('the disk is full'));

      const c = await h.connect();

      // No batchId: an old client, which is exactly the population that hits this branch.
      c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS });

      // Long enough for Node to have decided this was unhandled and acted on it.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(
        unhandled,
        `the store rejection escaped as an unhandled rejection: ${String(unhandled[0])}`,
      ).toEqual([]);

      // And the relay is still serving: the connection that failed is not the process. The
      // store has to be repaired first, because while it keeps rejecting there is correctly no
      // acknowledgement to wait for.
      h.persist = () => undefined;

      c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS, batchId: 'b7' });

      expect(await c.waitFor((m) => m.type === 'ack')).toEqual({ type: 'ack', batchId: 'b7' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('acknowledges an encrypted batch the same way', async () => {
    const h = await startHarness();
    const c = await h.connect();

    c.send({
      type: 'ops-enc',
      documentId: 'ack-doc',
      frames: [
        {
          v: 1,
          key: 'i:s@1',
          type: 'insert',
          site: 's',
          iv: 'AAAAAAAAAAAAAAAA',
          ct: 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      ],
      batchId: 'b4',
    });

    expect(await c.waitFor((m) => m.type === 'ack')).toEqual({ type: 'ack', batchId: 'b4' });
  });

  it('acknowledges each batch separately, in order', async () => {
    // The client removes one in-flight entry per ack, so a single ack standing in for two
    // frames would leave the client owing an operation the server no longer has.
    const h = await startHarness();
    const c = await h.connect();

    c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS, batchId: 'b5' });
    c.send({ type: 'ops', documentId: 'ack-doc', ops: OPS, batchId: 'b6' });

    await c.waitFor((m) => m.type === 'ack' && m.batchId === 'b6');

    const acks = c
      .received()
      .filter((m) => m.type === 'ack')
      .map((m) => (m as { batchId: string }).batchId);

    expect(acks).toEqual(['b5', 'b6']);
  });
});
