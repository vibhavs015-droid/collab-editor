import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { MAX_FRAME_BYTES } from '../shared/protocol.js';
import { createRelaySocketServer } from './socketServer.js';

/**
 * The relay used to accept 100 MiB per message, parsed before the sender was known.
 * Measured against the real server: six concurrent 60 MB frames from unauthenticated
 * sockets raised its memory by about 590 MB.
 */
describe('createRelaySocketServer', () => {
  let http: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (http === null) {
        resolve();
        return;
      }
      http.close(() => {
        resolve();
      });
      http.closeAllConnections();
    });
    http = null;
  });

  /** Boots the real helper behind an HTTP server and returns an open client. */
  async function connect(): Promise<{ client: WebSocket; received: number[] }> {
    const wss = createRelaySocketServer();
    const received: number[] = [];

    wss.on('connection', (socket) => {
      // ws emits 'error' on the server-side socket when a frame exceeds maxPayload, and an
      // unhandled 'error' event throws. The relay registers a listener for the same
      // reason (relay.ts), so this test has to as well.
      socket.on('error', () => undefined);
      socket.on('message', (data: Buffer) => {
        received.push(data.byteLength);
      });
    });

    http = createServer();
    http.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    });
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));

    const { port } = http.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => {
        resolve();
      });
      client.once('error', reject);
    });

    return { client, received };
  }

  it('accepts a frame as large as a full encrypted chunk', async () => {
    const { client, received } = await connect();

    // 1,000 encrypted operations measured about 386 KiB. One MiB is well above that.
    client.send('x'.repeat(1024 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(received).toEqual([1024 * 1024]);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('accepts a frame at the limit', async () => {
    const { client, received } = await connect();

    client.send('x'.repeat(MAX_FRAME_BYTES));
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(received).toEqual([MAX_FRAME_BYTES]);
    client.close();
  });

  it('closes the connection with 1009 for a frame over the limit, without delivering it', async () => {
    const { client, received } = await connect();

    const closed = new Promise<number>((resolve) => {
      client.once('close', (code) => {
        resolve(code);
      });
    });
    client.send('x'.repeat(MAX_FRAME_BYTES + 1));

    expect(await closed).toBe(1009);
    expect(received).toEqual([]);
  });

  it('is the server index.ts actually builds', () => {
    // Every other server test constructs its own WebSocketServer, so without this a change
    // to index.ts could silently go back to the 100 MiB default.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toContain('createRelaySocketServer()');
    expect(source).not.toMatch(/new WebSocketServer\(/);
  });
});
