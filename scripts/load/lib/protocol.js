/**
 * Wire protocol helpers shared by the load scripts.
 *
 * These deliberately do NOT implement the CRDT. k6 cannot import this package's
 * TypeScript, and reimplementing RGA in JavaScript to drive a load test would mean
 * shipping a second, separately wrong implementation of the thing under test. A load
 * generator only needs to be a valid writer, which is much less than that.
 *
 * Convergence under load is verified separately, by
 * `src/server/loadConvergence.test.ts`, which uses the real `Replica` class. Splitting
 * the two jobs this way is what keeps the benchmark honest.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 */

import { connect } from 'k6/ws';
import { check } from 'k6';

import { mintToken } from './auth.js';

export const PROTOCOL_VERSION = 1;

/** Server frame types this suite reacts to. */
export const FRAME = {
  welcome: 'welcome',
  ops: 'ops',
  snapshot: 'snapshot',
  syncState: 'syncState',
  error: 'error',
};

/**
 * Build a unique insert operation.
 *
 * `origin: null` means "insert at the start of the document", which needs no knowledge
 * of what is already there. That is what makes a valid writer possible without the
 * CRDT: a generator that only ever appends at the head, with globally unique ids, is
 * indistinguishable to the server from a client that understands the data structure.
 *
 * @param site this client's replica identity, unique per VU
 * @param clock monotonic per site, which is what makes ids unique
 */
export function insertOp(site, clock, value) {
  return {
    type: 'insert',
    id: { site: site, clock: clock },
    origin: null,
    value: value,
  };
}

export function deleteOp(site, targetSite, targetClock) {
  return { type: 'delete', target: { site: targetSite, clock: targetClock } };
}

/** WebSocket URL for a document, derived from the configured base URL. */
export function socketUrl(baseUrl, documentId) {
  return `${baseUrl.replace(/^http/, 'ws')}/ws?doc=${encodeURIComponent(documentId)}`;
}

export function httpUrl(baseUrl, path) {
  return `${baseUrl}${path}`;
}

/**
 * Authorization header for an HTTP request.
 *
 * Returns an empty object when no secret is configured, which puts the load server in
 * open mode. That is a legitimate way to run the suite, and the summary records which
 * mode was used so a result is never ambiguous about it.
 */
export function authHeaders(secret, subject) {
  if (!secret) {
    return {};
  }

  return { Authorization: `Bearer ${mintToken(secret, subject)}` };
}

/**
 * Open a socket, complete the handshake, and measure the handshake itself.
 *
 * The handshake is not optional decoration. Since authentication was added, the server
 * refuses every frame except `hello` from an unauthorised socket, so a load generator
 * that skipped it would measure a server refusing connections rather than relaying
 * operations.
 *
 * k6 v2 renamed `WebSocket.open` to a bare `connect`. The old name still appears in
 * most examples online, and using it fails with a confusing `Cannot read property
 * 'open' of undefined` on the first iteration.
 *
 * `connect` BLOCKS for the lifetime of the socket, so nothing may be timed around it.
 * An earlier version measured from before `connect` to after it returned and reported a
 * "handshake" of 74 seconds -- which was the length of the whole ramped session, not
 * the handshake. `handshakeMs` is therefore captured inside the `welcome` handler, at
 * the only moment the handshake is genuinely complete.
 *
 * @returns `welcomed`, `errorCode`, `status`, and `handshakeMs` (null when refused).
 */
export function openSession(baseUrl, documentId, secret, subject, handlers = {}) {
  const token = secret ? mintToken(secret, subject) : subject;

  let welcomed = false;
  let errorCode = null;
  let handshakeMs = null;

  const startedAt = Date.now();

  const response = connect(socketUrl(baseUrl, documentId), {}, (socket) => {
    // No readyState guard.
    //
    // k6's WebSocket wrapper does not expose readyState, so the check silently
    // evaluated false and every operation was dropped before it left the process. The
    // run then reported one burst per VU and no server-side broadcast, which looks
    // exactly like a server that accepted a batch and then went quiet.
    const send = (frame) => {
      socket.send(JSON.stringify(frame));
    };

    // k6's connect blocks until the socket closes, so a scenario that types for a
    // while and returns never returns: the VU hangs until gracefulStop kills it, and
    // anything recorded after the call records nothing. Exposing close is what lets a
    // scenario end its own session.
    const close = () => {
      try {
        socket.close();
      } catch {
        // Already closing or closed. Nothing useful to do.
      }
    };

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          token: token,
          documentId: documentId,
          lastAppliedSeq: 0,
        }),
      );
    });

    socket.on('message', (raw) => {
      let frame;

      try {
        frame = JSON.parse(raw);
      } catch {
        // A frame that will not parse is worth counting, not worth throwing on. A load
        // generator that dies on the first bad byte reports a throughput number that
        // means only "it stopped early".
        if (handlers.onFrame) {
          handlers.onFrame(null);
        }
        return;
      }

      if (frame.type === FRAME.welcome && !welcomed) {
        welcomed = true;
        // Measured here, not around the blocking connect call.
        handshakeMs = Date.now() - startedAt;

        if (handlers.onWelcome) {
          handlers.onWelcome(send, close, frame);
        }
      }

      if (frame.type === FRAME.error) {
        errorCode = frame.code;
      }

      if (handlers.onFrame) {
        handlers.onFrame(frame);
      }
    });

    // Close once the handshake resolves, so a ramped scenario measures handshakes
    // rather than holding every socket open until the ramp ends.
    socket.on('close', () => {
      // Nothing to do. An earlier version called socket.close() here, which re-entered
      // the handler and hung the run past its own ramp. k6 tears the socket down when
      // the callback returns.
    });
  });

  return {
    welcomed: welcomed,
    errorCode: errorCode,
    status: response ? response.status : null,
    handshakeMs: handshakeMs,
  };
}

/** Assert the handshake worked, with a message that names the cause. */
export function checkWelcome(response) {
  check(response, {
    'handshake status is 101': (r) => r && r.status === 101,
  });
}
