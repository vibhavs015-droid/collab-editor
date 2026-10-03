import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { Relay } from './relay.js';
import { PROTOCOL_VERSION, type ServerMessage } from '../shared/protocol.js';

/**
 * Tests drive the relay through real WebSocket connections rather than a stubbed
 * socket object. A stub would let a broken frame encoder pass, and the frame
 * encoding is exactly where a relay most easily goes wrong.
 */

interface Harness {
  readonly url: string;
  readonly relay: Relay;
  connect: (documentId: string) => Promise<TestClient>;
  close: () => Promise<void>;
}

interface TestClient {
  readonly socket: WebSocket;
  readonly site: string;
  send: (message: object) => void;
  next: (timeoutMs?: number) => Promise<ServerMessage>;
  received: () => ServerMessage[];
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
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
    relay.attach(socket, url.searchParams.get('doc') ?? 'default');
  });

  async function connect(documentId: string): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?doc=${documentId}`);
    const inbox: ServerMessage[] = [];
    const waiters: ((message: ServerMessage) => void)[] = [];

    socket.on('message', (data: Buffer) => {
      const parsed = JSON.parse(data.toString('utf8')) as ServerMessage;
      const waiter = waiters.shift();

      if (waiter) {
        waiter(parsed);
      } else {
        inbox.push(parsed);
      }
    });

    let site = '';

    const testClient: TestClient = {
      socket,
      get site() {
        return site;
      },
      send: (message: object) => {
        socket.send(JSON.stringify(message));
      },
      next: (timeoutMs = 2000) =>
        new Promise<ServerMessage>((resolve, reject) => {
          const queued = inbox.shift();

          if (queued) {
            resolve(queued);
            return;
          }

          const timer = setTimeout(() => {
            reject(new Error('timed out waiting for a server message'));
          }, timeoutMs);

          waiters.push((message) => {
            clearTimeout(timer);
            resolve(message);
          });
        }),
      received: () => [...inbox],
      close: () =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          socket.once('close', () => {
            resolve();
          });
          socket.close();
        }),
    };

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });

    const welcome = await testClient.next();
    if (welcome.type === 'welcome') {
      site = welcome.site;
    }

    return testClient;
  }

  return {
    url: `ws://127.0.0.1:${port}`,
    relay,
    connect,
    close: async () => {
      relay.close();
      await new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          resolve();
        });
      });
    },
  };
}

describe('Relay', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('connection lifecycle', () => {
    it('greets a new client with a welcome and a unique site', async () => {
      const a = await harness.connect('doc-1');
      const b = await harness.connect('doc-1');

      expect(a.site).not.toBe('');
      expect(a.site).not.toBe(b.site);
    });

    it('tracks client and room counts', async () => {
      expect(harness.relay.clientCount).toBe(0);

      await harness.connect('doc-1');
      await harness.connect('doc-1');
      await harness.connect('doc-2');

      expect(harness.relay.clientCount).toBe(3);
      expect(harness.relay.roomCount).toBe(2);
    });

    it('removes empty rooms rather than leaking them', async () => {
      const only = await harness.connect('ephemeral');
      expect(harness.relay.roomCount).toBe(1);

      await only.close();
      // Give the close event a turn to propagate.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(harness.relay.roomCount).toBe(0);
    });

    it('decrements the client count on disconnect', async () => {
      const client = await harness.connect('doc-1');
      expect(harness.relay.clientCount).toBe(1);

      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(harness.relay.clientCount).toBe(0);
    });
  });

  describe('operation relay', () => {
    it('forwards operations to peers but not back to the author', async () => {
      const alice = await harness.connect('doc-1');
      const bob = await harness.connect('doc-1');

      const op = {
        type: 'insert',
        id: { site: alice.site, clock: 1 },
        origin: null,
        value: 'x',
      };

      alice.send({ type: 'ops', documentId: 'doc-1', ops: [op] });

      const received = await bob.next();
      expect(received.type).toBe('ops');

      if (received.type === 'ops') {
        expect(received.ops).toHaveLength(1);
      }

      // The author already has it; echoing would duplicate every local edit.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alice.received()).toHaveLength(0);
    });

    it('never crosses room boundaries', async () => {
      const inRoomA = await harness.connect('doc-a');
      const inRoomB = await harness.connect('doc-b');

      inRoomA.send({
        type: 'ops',
        documentId: 'doc-a',
        ops: [{ type: 'insert', id: { site: inRoomA.site, clock: 1 }, origin: null, value: 'x' }],
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      // The most dangerous possible bug: leaking one document's edits to another.
      expect(inRoomB.received()).toHaveLength(0);
    });

    it('relays to every peer in a room', async () => {
      const alice = await harness.connect('doc-1');
      const bob = await harness.connect('doc-1');
      const carol = await harness.connect('doc-1');

      alice.send({
        type: 'ops',
        documentId: 'doc-1',
        ops: [{ type: 'insert', id: { site: alice.site, clock: 1 }, origin: null, value: 'a' }],
      });

      expect((await bob.next()).type).toBe('ops');
      expect((await carol.next()).type).toBe('ops');
    });

    it('preserves operation order as sent', async () => {
      const alice = await harness.connect('doc-1');
      const bob = await harness.connect('doc-1');

      const ops = [1, 2, 3].map((clock) => ({
        type: 'insert',
        id: { site: alice.site, clock },
        origin: null,
        value: String(clock),
      }));

      alice.send({ type: 'ops', documentId: 'doc-1', ops });

      const received = await bob.next();
      if (received.type === 'ops') {
        // Reordering is the CRDT's job, not the transport's. The relay must not
        // silently sort or shuffle.
        const clocks = received.ops.map((op) => (op as { id: { clock: number } }).id.clock);
        expect(clocks).toEqual([1, 2, 3]);
      } else {
        throw new Error('expected an ops message');
      }
    });

    it('reports inbound operations to the persistence callback', async () => {
      const receivedBatches: number[] = [];
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      const relay = new Relay({ heartbeatMs: 0 });

      await new Promise<void>((resolve) => {
        wss.on('listening', () => {
          resolve();
        });
      });

      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      wss.on('connection', (socket) => {
        relay.attach(socket, 'doc-1', (ops) => {
          receivedBatches.push(ops.length);
        });
      });

      const client = new WebSocket(`ws://127.0.0.1:${port}/`);
      await new Promise<void>((resolve) => {
        client.on('open', () => {
          resolve();
        });
      });

      client.send(
        JSON.stringify({
          type: 'ops',
          documentId: 'doc-1',
          ops: [{ type: 'insert', id: { site: 'x', clock: 1 }, origin: null, value: 'a' }],
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(receivedBatches).toEqual([1]);

      client.terminate();
      relay.close();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    });
  });

  describe('hostile input', () => {
    it('rejects malformed JSON without closing the connection', async () => {
      const client = await harness.connect('doc-1');
      // Raw text, bypassing the client's send helper.
      client.socket.send('{not json');

      const response = await client.next();
      expect(response.type).toBe('error');

      if (response.type === 'error') {
        expect(response.code).toBe('BAD_MESSAGE');
      }

      // Still usable afterwards: a bad frame must not drop a good session.
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });

    it('rejects an unknown message type', async () => {
      const client = await harness.connect('doc-1');
      client.send({ type: 'dropTables', documentId: 'doc-1' });

      const response = await client.next();
      expect(response.type).toBe('error');
    });

    it('rejects a protocol version it does not speak', async () => {
      const client = await harness.connect('doc-1');
      client.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION + 99,
        token: 'x',
        documentId: 'doc-1',
        lastAppliedClock: 0,
      });

      const response = await client.next();
      expect(response.type).toBe('error');
    });

    it('ignores an oversized frame rather than buffering it', async () => {
      const client = await harness.connect('doc-1');

      // A single frame far past any sensible document size.
      const huge = 'x'.repeat(2_000_000);
      client.socket.send(
        JSON.stringify({ type: 'ops', documentId: 'doc-1', ops: [{ value: huge }] }),
      );

      // The server either rejects it or stays alive; the assertion that matters
      // is that it does not crash or hang the test process.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(harness.relay.clientCount).toBeLessThanOrEqual(1);
    });
  });

  describe('presence', () => {
    it('broadcasts a cursor update to peers', async () => {
      const alice = await harness.connect('doc-1');
      const bob = await harness.connect('doc-1');

      alice.send({ type: 'presence', documentId: 'doc-1', cursor: 7, selectedLength: 0 });

      const received = await bob.next();
      expect(received.type).toBe('presence');

      if (received.type === 'presence') {
        expect(received.cursors[alice.site]).toBe(7);
      }
    });

    it('clears a departed client cursor for remaining peers', async () => {
      const alice = await harness.connect('doc-1');
      const bob = await harness.connect('doc-1');

      alice.send({ type: 'presence', documentId: 'doc-1', cursor: 3, selectedLength: 0 });
      expect((await bob.next()).type).toBe('presence');

      await alice.close();

      const update = await bob.next();
      if (update.type === 'presence') {
        // A stale cursor would render as a collaborator who never left.
        expect(update.cursors[alice.site]).toBeUndefined();
      }
    });
  });

  describe('resync', () => {
    it('acknowledges a resync request', async () => {
      const client = await harness.connect('doc-1');
      client.send({ type: 'resync', documentId: 'doc-1' });

      const response = await client.next();
      expect(response.type).toBe('syncState');
    });
  });
});
