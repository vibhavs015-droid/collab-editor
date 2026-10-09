/**
 * Draining the relay socket server without waiting forever for a peer.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * `wss.close(callback)` does not fire until every client socket has finished closing, and
 * `client.close()` only *asks* a peer to close - the peer has to answer with its own close frame
 * before the socket is done. A peer that never answers holds the whole shutdown sequence open
 * forever, and everything queued behind it is stuck too, including `db.close()`.
 *
 * This is the first CI run's finding rather than a thought experiment: the server logged
 * `shutting down` and was still alive 45 seconds later. Docker allows 10 seconds before SIGKILL,
 * so an unbounded drain means the database is never closed cleanly in production either.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PEER HERE IS A RAW SOCKET
 * ---------------------------------------------------------------------------
 * A frozen browser tab is a peer that never answers the close handshake, and `ws` cannot stand in
 * for one: a `ws` client always replies automatically, so it can never produce the failure being
 * tested. The peer below completes the WebSocket handshake by hand and then goes silent forever.
 */

import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { drainRelaySocketServer } from './socketServer.js';

const teardown: (() => void | Promise<void>)[] = [];
const rawSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of rawSockets.splice(0)) {
    socket.destroy();
  }

  for (const done of teardown.splice(0)) {
    await done();
  }
});

async function startServer(): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });

  await new Promise<void>((resolve) => {
    wss.on('listening', () => {
      resolve();
    });
  });

  teardown.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }

        wss.close(() => {
          resolve();
        });
      }),
  );

  return wss;
}

/**
 * A peer that completes the WebSocket handshake and then never speaks again.
 *
 * @returns the handshake response, so a caller can assert the peer really did connect.
 */
async function silentPeer(wss: WebSocketServer): Promise<string> {
  const address = wss.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const socket = netConnect(port, '127.0.0.1');
  rawSockets.push(socket);

  // Base64 of exactly 16 bytes, per RFC 6455 section 4.1.
  const key = randomBytes(16).toString('base64');

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(
    [
      'GET /ws?doc=silent HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );

  const response = await new Promise<string>((resolve, reject) => {
    let seen = '';

    const timer = setTimeout(() => {
      reject(new Error(`the silent peer never got a handshake; received ${JSON.stringify(seen)}`));
    }, 5_000);

    timer.unref?.();

    socket.on('data', (chunk: Buffer) => {
      seen += chunk.toString('latin1');

      if (seen.includes('\r\n\r\n')) {
        clearTimeout(timer);
        // Stop reading entirely: a close frame arrives and is never answered.
        socket.pause();
        resolve(seen);
      }
    });

    socket.once('error', reject);
  });

  // `wss.clients` is populated by the upgrade, a tick after the 101 is written. Waiting for the
  // count rather than assuming it removes a race that would otherwise make this file
  // intermittently test nothing.
  const deadline = Date.now() + 5_000;

  while (wss.clients.size === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  return response;
}

describe('draining the relay socket server', () => {
  it('completes when a peer never answers the close handshake', async () => {
    // THE TEST THAT HANGS WITHOUT THE FIX. With no bound and no terminate, `wss.close()` waits for
    // this peer forever and the test times out rather than failing.
    const wss = await startServer();
    const handshake = await silentPeer(wss);

    expect(handshake).toContain('101');
    expect(
      wss.clients.size,
      'the silent peer never connected, so nothing is being tested',
    ).toBeGreaterThan(0);

    const started = Date.now();
    await drainRelaySocketServer(wss, 150);

    // Generous enough that a loaded machine passes, tight enough that "waits forever" cannot.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports how many peers had to be destroyed', async () => {
    // A drain that silently force-closed sockets would be indistinguishable in a log from a clean
    // one, which is exactly the confusion this change exists to remove.
    const wss = await startServer();
    await silentPeer(wss);
    await silentPeer(wss);

    const stragglers: number[] = [];
    await drainRelaySocketServer(wss, 150, (count) => stragglers.push(count));

    expect(stragglers, 'no straggler was reported for two silent peers').toEqual([2]);
  });

  it('destroys the sockets it gave up on', async () => {
    // Reporting a count is not the same as doing anything about it.
    const wss = await startServer();
    await silentPeer(wss);

    await drainRelaySocketServer(wss, 150);

    // Polled rather than asserted immediately: `ws` prunes `wss.clients` on the socket's close
    // event, which is a tick after `terminate()`. The bound is short enough that "never" fails.
    const deadline = Date.now() + 2_000;

    while (wss.clients.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(wss.clients.size, 'the silent peer survived the drain').toBe(0);
  });

  it('completes even with no peers at all', async () => {
    // Trivial, and the case most likely to be broken by an implementation that assumes
    // wss.clients is non-empty.
    const wss = await startServer();

    await expect(drainRelaySocketServer(wss, 150)).resolves.toBeUndefined();
  });
});
