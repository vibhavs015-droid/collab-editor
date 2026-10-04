import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { ApiServer } from './api.js';
import { Database } from './db.js';
import { Relay } from './relay.js';

/**
 * Integration test for the HTTP/WebSocket upgrade path.
 *
 * Runs a real server and real WebSocket clients, because the handshake is exactly
 * where a mock would hide the bug: a misconfigured upgrade handler passes unit
 * tests and fails only in a browser.
 */

let db: Database;
let api: ApiServer;
let relay: Relay;
let wss: WebSocketServer;
let baseUrl: string;
let wsUrl: string;

/**
 * Open a socket with the message listener already attached.
 *
 * The listener must be registered BEFORE awaiting 'open'. The server sends
 * `welcome` the instant the handshake completes, so a listener attached
 * afterwards misses it and the test hangs waiting for a frame that already
 * arrived. That race is invisible when reading the test, which is why it is
 * handled inside the helper rather than at each call site.
 */
function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox: string[] = [];

    socket.on('message', (data: Buffer) => {
      inbox.push(data.toString('utf8'));
    });

    socket.once('error', reject);

    socket.once('open', () => {
      // Attach the drain helper now that earlier frames are buffered.
      Object.assign(socket, {
        __inbox: inbox,
        nextMessage: async (): Promise<Record<string, unknown>> => {
          for (let waited = 0; waited < 500; waited += 1) {
            const next = inbox.shift();
            if (next !== undefined) {
              return JSON.parse(next) as Record<string, unknown>;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error('timed out waiting for a frame');
        },
      });
      resolve(socket);
    });
  });
}

/** Read the next buffered frame from a socket opened by `open()`. */
async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const helper = socket as unknown as {
    nextMessage: () => Promise<Record<string, unknown>>;
  };
  return helper.nextMessage();
}

beforeEach(async () => {
  db = await Database.open();
  relay = new Relay({ heartbeatMs: 0 });
  wss = new WebSocketServer({ noServer: true });

  api = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
    },
  });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    relay.attach(socket, url.searchParams.get('doc') ?? 'default');
  });

  api.onUpgrade('/ws', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  await api.listen();
});

afterEach(async () => {
  relay.close();

  for (const client of wss.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve) => {
    wss.close(() => {
      resolve();
    });
  });

  await api.close();
  await db.close();
});

describe('HTTP and WebSocket on one port', () => {
  it('still answers HTTP requests after the upgrade listener is attached', async () => {
    // Registering 'upgrade' must not break normal HTTP. It is a separate
    // listener, not a replacement.
    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);
    // `auth` rides along so a probe can tell a secured server from an open one. This
    // test server has no secret configured, so it is open.
    expect(await res.json()).toEqual({ status: 'ok', auth: 'open' });
  });

  it('accepts a WebSocket upgrade on /ws', async () => {
    const socket = await open(`${wsUrl}?doc=doc-1`);

    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('greets the client with a welcome frame', async () => {
    const socket = await open(`${wsUrl}?doc=doc-1`);

    const message = await nextMessage(socket);

    expect(message['type']).toBe('welcome');
    expect(message['site']).not.toBe('');
    socket.close();
  });

  it('relays operations between two clients on one port', async () => {
    const alice = await open(`${wsUrl}?doc=shared`);
    const bob = await open(`${wsUrl}?doc=shared`);

    // Drain both welcomes so they do not shift the ops assertion.
    await nextMessage(alice);
    await nextMessage(bob);

    alice.send(
      JSON.stringify({
        type: 'ops',
        documentId: 'shared',
        ops: [{ type: 'insert', id: { site: 'a', clock: 1 }, origin: null, value: 'x' }],
      }),
    );

    const received = await nextMessage(bob);

    expect(received['type']).toBe('ops');
    expect((received['ops'] as unknown[]).length).toBe(1);

    alice.close();
    bob.close();
  });

  it('refuses an upgrade for an unknown path', async () => {
    await expect(open(`ws://127.0.0.1:${new URL(baseUrl).port}/nope?doc=doc-1`)).rejects.toThrow();
  });

  it('refuses an upgrade with a malformed document id', async () => {
    // Path traversal in a document id must be rejected before the socket is
    // handed over, not silently coerced into some default.
    await expect(open(`${wsUrl}?doc=../secrets`)).rejects.toThrow();
  });

  it('assigns distinct sites to concurrent clients', async () => {
    const sites = await Promise.all(
      [1, 2, 3].map(async () => {
        const socket = await open(`${wsUrl}?doc=doc-1`);
        const welcome = await nextMessage(socket);
        socket.close();
        return welcome['site'] as string;
      }),
    );

    // Two clients sharing a site would collide on element IDs and corrupt the
    // document, so uniqueness is a correctness property, not a nicety.
    expect(new Set(sites).size).toBe(3);
  });
});
