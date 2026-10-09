/**
 * The WebSocket server the relay listens on.
 *
 * Its own module so that production and its test construct the server from the same
 * options. Every other server test builds its own `WebSocketServer`, which is fine for
 * testing the relay but means nothing exercised the options `index.ts` actually used.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { WebSocketServer } from 'ws';

import { MAX_FRAME_BYTES } from '../shared/protocol.js';

/**
 * Create the server in `noServer` mode: the HTTP layer completes the handshake itself so
 * HTTP and WebSocket share one port.
 *
 * `maxPayload` is the point of this function. `ws` defaults to 100 MiB per message, and
 * the relay parses a message before it knows who sent it, so without a limit one
 * unauthenticated socket could make the process buffer and parse a frame two orders of
 * magnitude larger than any client sends. A message over the limit closes the connection
 * with code 1009 before it is buffered in full.
 */
export function createRelaySocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
}

/** Close code for "we are going away", per RFC 6455 section 7.4.1. */
const GOING_AWAY = 1001;

/** How long a peer is given to complete the close handshake before its socket is destroyed. */
const DEFAULT_DRAIN_MS = 5_000;

/** How long to wait for `terminate()` to finish the job, so this can never hang either. */
const AFTER_TERMINATE_MS = 1_000;

/**
 * Close the relay's WebSocket server without ever waiting forever for a peer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `wss.close(callback)` does not fire until every client socket has finished closing, and
 * `client.close()` only *asks* a peer to close: the peer has to answer with its own close frame
 * before the socket is done. A peer that never answers - a backgrounded tab the OS froze, a
 * laptop that lid-closed, a phone that dropped off the network - holds the whole sequence open
 * forever.
 *
 * That is not theoretical. It is what the first CI run of this repository showed: the server logged
 * `shutting down` and was still alive 45 seconds later, and the only reason the sequence was still
 * running was a WebSocket close handshake that a browser had not completed. Everything after this
 * step was blocked behind it, including `db.close()`.
 *
 * That matters outside tests. `docker stop` allows 10 seconds before SIGKILL, so a server that
 * waits for a handshake is a server whose database is never closed cleanly.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ANSWER IS TO DESTROY SOCKETS, NOT TO BE POLITE LONGER
 * ---------------------------------------------------------------------------
 * A peer that has not answered within the grace period is not slow, it is gone. The work that
 * matters is already durable - the relay persists before it acknowledges - so a socket that cannot
 * complete a handshake has nothing left to lose. `terminate()` destroys it, `wss.close()` then
 * completes, and the database gets closed.
 *
 * Being polite first and forceful second is deliberate: a well-behaved peer gets a clean close
 * frame and the normal code path, and only a peer that ignores it gets its socket destroyed.
 */
export async function drainRelaySocketServer(
  wss: WebSocketServer,
  timeoutMs: number = DEFAULT_DRAIN_MS,
  onStraggler?: (count: number) => void,
): Promise<void> {
  for (const client of wss.clients) {
    client.close(GOING_AWAY, 'Server shutting down');
  }

  // Called once. A second call throws ERR_SERVER_NOT_RUNNING, so this must not be raced against
  // anything that might also try to close.
  const closed = new Promise<void>((resolve) => {
    wss.close(() => {
      resolve();
    });
  });

  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(() => {
      const stragglers = [...wss.clients];

      if (stragglers.length > 0) {
        onStraggler?.(stragglers.length);

        for (const client of stragglers) {
          client.terminate();
        }
      }

      resolve();
    }, timeoutMs);

    // A pending timer must not be the reason a process stays alive.
    graceTimer.unref?.();
  });

  await Promise.race([closed, grace]);

  if (graceTimer !== undefined) {
    clearTimeout(graceTimer);
  }

  if (wss.clients.size > 0) {
    // terminate() was sent; give it a moment, then stop caring. This path must not be able to
    // hang, which is the entire point of the function.
    await Promise.race([closed, delay(AFTER_TERMINATE_MS)]);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
