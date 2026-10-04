/**
 * `reconnect.js` - churn: clients leaving and returning.
 *
 * The scenario that distinguishes a real-time system from a message bus. A client that
 * has been away must become current before it sends anything, and the cost of that
 * catch-up is what this measures.
 *
 * Each VU connects, is admitted, leaves abruptly, then reconnects declaring a cursor
 * of zero. A zero cursor asks the server for everything it has, which is the worst case
 * a real client can present and therefore the one worth bounding.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

import { authHeaders, insertOp, openSession } from './lib/protocol.js';

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://127.0.0.1:3001';
const SECRET = __ENV.JWT_SECRET || '';
const SUBJECT = __ENV.LOAD_SUBJECT || 'load-reconnect';
const DOCUMENT_ID = __ENV.LOAD_DOCUMENT_ID || 'load-reconnect-doc';
const DURATION = __ENV.LOAD_DURATION || '30s';
const TARGET_VUS = Number(__ENV.LOAD_VUS || 10);

/** One shared identity, as in connect.js. Sessions are anonymous; VUs are not people. */
const EDITOR_SUBJECT = `${SUBJECT}-editors`;

/** Operations written before each client vanishes, so the log has something to replay. */
const OPS_BEFORE_LEAVING = Number(__ENV.LOAD_OPS_BEFORE_LEAVING || 10);

/** How long a VU stays away before returning. */
const AWAY_MS = Number(__ENV.LOAD_AWAY_MS || 1_000);

const reconnects = new Counter('reconnects');
const readmitted = new Rate('readmitted');
const refused = new Counter('refusals');
/** Time from socket open to welcome on the SECOND connection. */
const catchUp = new Trend('catchup_duration', true);

export const options = {
  scenarios: {
    reconnect: {
      executor: 'constant-vus',
      vus: TARGET_VUS,
      duration: DURATION,
      gracefulStop: '15s',
    },
  },
  thresholds: {
    // A client that cannot get back in after a blip is a data-loss bug wearing a
    // latency costume.
    readmitted: ['rate>0.99'],
    refusals: ['count==0'],
    reconnects: ['count>0'],
  },
};

export function setup() {
  const created = http.post(
    `${BASE_URL}/api/documents`,
    JSON.stringify({ id: DOCUMENT_ID, title: 'load: reconnect' }),
    { headers: { 'Content-Type': 'application/json', ...authHeaders(SECRET, SUBJECT) } },
  );

  check(created, {
    'document created': (r) => r.status === 201 || r.status === 409,
  });

  const grant = http.post(
    `${BASE_URL}/api/documents/${DOCUMENT_ID}/collaborators`,
    JSON.stringify({ subject: EDITOR_SUBJECT }),
    { headers: { 'Content-Type': 'application/json', ...authHeaders(SECRET, SUBJECT) } },
  );

  check(grant, { 'editor access granted': (r) => r.status === 200 });

  return { documentId: DOCUMENT_ID };
}

export default function (data) {
  const site = `${EDITOR_SUBJECT}-vu${__VU}-${__ITER}`;
  let clock = 0;

  // ---- Visit one: connect, write, vanish --------------------------------------
  let closeFirst = () => undefined;

  const first = openSession(BASE_URL, data.documentId, SECRET, EDITOR_SUBJECT, {
    onWelcome: (send, closeSocket) => {
      closeFirst = closeSocket;

      const batch = [];

      for (let index = 0; index < OPS_BEFORE_LEAVING; index += 1) {
        clock += 1;
        batch.push(insertOp(site, clock, 'r'));
      }

      send({ type: 'ops', documentId: data.documentId, ops: batch });
    },

    onFrame: (frame) => {
      // Leave as soon as the server has answered. Waiting for an `ops` frame would be
      // more precise, but with one client in the room there is nobody to broadcast to,
      // so the client would wait forever and k6 would kill it at gracefulStop.
      //
      // Closing the socket from inside `onWelcome` instead does not work either: it
      // aborts the handshake mid-flight, and k6's blocking `connect` never returns, so
      // the second visit below never happens and the run reports zero reconnects.
      if (frame !== null && frame.type !== 'welcome') {
        closeFirst();
      }
    },
  });
  if (!first.welcomed) {
    refused.add(1);
    check(false, { 'first visit admitted': () => false });
    return;
  }

  // Being away is the point. `sleep` is used here rather than inside the socket
  // callback because this is ordinary VU code, not the WebSocket event loop.
  sleep(AWAY_MS / 1000);

  // ---- Visit two: come back with a zero cursor -------------------------------
  // The return visit closes as soon as it is admitted.
  //
  // k6's `connect` blocks until the socket closes, so a session left open hangs the VU
  // until gracefulStop kills it, and everything recorded afterwards - including the
  // reconnect count - records nothing. That is exactly what happened: 20 sessions were
  // opened and zero reconnects recorded.
  const second = openSession(BASE_URL, data.documentId, SECRET, EDITOR_SUBJECT, {
    onWelcome: (_send, close) => {
      close();
    },
  });

  reconnects.add(1);
  readmitted.add(second.welcomed);

  if (second.welcomed) {
    catchUp.add(second.handshakeMs);
  } else {
    refused.add(1);
  }

  check(second.welcomed, { 'readmitted after a gap': () => second.welcomed });
}
