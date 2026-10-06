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
