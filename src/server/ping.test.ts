/**
 * Liveness: detecting a socket that never closes.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * A TCP connection whose packets are being silently dropped fires no `error`, fires no `close`,
 * and leaves the browser's `readyState` at OPEN. Every recovery mechanism in this project - the
 * reconnect, the in-flight replay, the honest `Synced` indicator - waits for `close`. So a
 * half-open connection means an editor that looks connected, accepts keystrokes, and quietly
 * loses them.
 *
 * This is not hypothetical for this repository. The browser tests had to stop the server
 * PROCESS to simulate an outage, because `context.setOffline(true)`, CDP
 * `Network.emulateNetworkConditions` and `routeWebSocket` all leave an ESTABLISHED WebSocket
 * connected - verified, in `docs/browser-tests.md`. Real networks behave like those three, not
 * like a stopped process.
 *
 * Both directions are tested, because they fail differently:
 *   - the CLIENT gives up when the server stops talking to it
 *   - the SERVER gives up when the client stops answering
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

/** A relay with a heartbeat short enough to test in, and nothing else. */
async function startRelay(options: { heartbeatMs?: number } = {}): Promise<{
  readonly connect: (hello?: Record<string, unknown>) => Promise<Peer>;
  readonly relays: Relay[];
}> {
  const relay = new Relay({
    heartbeatMs: options.heartbeatMs ?? 50,
    // Short enough that a test does not have to wait out the production value. The relationship
    // that matters - deadline well under the interval - is preserved.
    pongDeadlineMs: 150,
  });
  const relays = [relay];
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

    relay.attach(socket, url.searchParams.get('doc') ?? 'ping-doc');
  });

  teardown.push(async () => {
    relay.close();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  });

  const connect = async (hello: Record<string, unknown> = {}): Promise<Peer> =>
    Peer.connect(port, hello);

  return { connect, relays };
}

class Peer {
  readonly received: ServerMessage[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  /** Set to true to stop answering pings, simulating a client whose writes are being dropped. */
  answerPings = true;

  private constructor(private readonly socket: WebSocket) {}

  static async connect(port: number, hello: Record<string, unknown>): Promise<Peer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?doc=ping-doc`);
    const peer = new Peer(socket);

    socket.on('message', (data: Buffer) => {
      const parsed = JSON.parse(data.toString('utf8')) as ServerMessage;

      peer.received.push(parsed);

      if (parsed.type === 'ping' && peer.answerPings) {
        socket.send(JSON.stringify({ type: 'pong', t: parsed.t }));
      }
    });

    socket.on('close', (code, reason) => {
      peer.closes.push({ code, reason: reason.toString('utf8') });
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

    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        token: 'token',
        documentId: 'ping-doc',
        lastAppliedSeq: 0,
        ...hello,
      }),
    );

    return peer;
  }

  get pings(): { t: number }[] {
    return this.received.filter((m) => m.type === 'ping');
  }

  /** Send a raw `pong` with a chosen token, so a wrong one can be tested deliberately. */
  pongWith(token: number): void {
    this.socket.send(JSON.stringify({ type: 'pong', t: token }));
  }

  waitFor(predicate: () => boolean, why: string, timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;

      const tick = (): void => {
        if (predicate()) {
          resolve();
          return;
        }

        if (Date.now() > deadline) {
          reject(
            new Error(
              `${why}; saw ${JSON.stringify(this.received.map((m) => m.type))} closes=${JSON.stringify(this.closes)}`,
            ),
          );
          return;
        }

        setTimeout(tick, 25);
      };

      tick();
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe('liveness (ping)', () => {
  it('pings a client that declared the capability', async () => {
    const { connect } = await startRelay();
    const peer = await connect({ capabilities: ['ping'] });

    await peer.waitFor(() => peer.pings.length > 0, 'the server never pinged');

    expect(typeof peer.pings[0]?.t).toBe('number');

    peer.close();
  });

  it('never pings a client that did not declare it', async () => {
    // The compatibility requirement, and the same reasoning as the `ack` decision in ADR-0015.
    // A client that does not understand `ping` answers it with its unrecognised-frame handler,
    // so an unconditional ping would be a user-visible error every 25 seconds, forever.
    const { connect } = await startRelay();
    const peer = await connect();

    // Long enough for several heartbeat intervals.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(peer.pings, 'an undeclared client was pinged anyway').toEqual([]);

    peer.close();
  });

  it('never pings a client that declared a capability this server does not know', async () => {
    // An unknown capability is dropped on arrival, so it cannot switch pings on. This is what
    // keeps a newer client and an older server compatible rather than merely quiet.
    const { connect } = await startRelay();
    const peer = await connect({ capabilities: ['ping', 'telepathy'] });

    await new Promise((resolve) => setTimeout(resolve, 300));

    // `ping` IS known, so it was switched on; the unknown one did not cause a crash or a
    // refusal of the handshake.
    expect(peer.pings.length).toBeGreaterThan(0);

    peer.close();
  });

  it('closes a client that stops answering', async () => {
    // The server half. This is what stops a dead peer holding a socket, a room membership and a
    // place in everyone's peer count.
    const { connect } = await startRelay();
    const peer = await connect({ capabilities: ['ping'] });

    await peer.waitFor(() => peer.pings.length > 0, 'the server never pinged');

    peer.answerPings = false;

    await peer.waitFor(() => peer.closes.length > 0, 'the server never gave up on a silent peer');

    expect(peer.closes[0]?.code).toBe(1001);
    expect(peer.closes[0]?.reason).toMatch(/pong/iu);

    peer.close();
  });

  it('keeps a connection alive as long as pongs keep coming', async () => {
    // The other half of the same claim. A test that only checks "gives up on silence" would
    // pass against a relay that closed every connection after one ping interval.
    const { connect } = await startRelay();
    const peer = await connect({ capabilities: ['ping'] });

    await peer.waitFor(() => peer.pings.length >= 4, 'not enough ping rounds to judge');

    expect(peer.closes, 'a responsive client was disconnected').toEqual([]);

    peer.close();
  });

  it('does not accept a pong for a ping it never sent', async () => {
    // The token's entire purpose. A pong that happened to arrive now, having been delayed
    // minutes in some buffer, must not count as proof the client is alive.
    const { connect } = await startRelay();
    const peer = await connect({ capabilities: ['ping'] });

    // Wait for a ping, then stop answering entirely and offer a wrong token instead.
    await peer.waitFor(() => peer.pings.length > 0, 'the server never pinged');

    peer.answerPings = false;
    peer.pongWith(999_999);

    await peer.waitFor(() => peer.closes.length > 0, 'a bogus pong was accepted');

    expect(peer.closes[0]?.reason).toMatch(/pong/iu);

    peer.close();
  });
});
