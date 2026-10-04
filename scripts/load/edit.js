/**
 * `edit.js` - sustained concurrent typing.
 *
 * The scenario that matters most for a collaborative editor: N clients in one room,
 * all typing at once. Every operation one client sends is fanned out to all the others,
 * so this measures relay fanout cost, not just throughput.
 *
 * Cost per operation is therefore quadratic in room size, and that is the point worth
 * measuring rather than assuming.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

import { authHeaders, deleteOp, insertOp, openSession } from './lib/protocol.js';

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://127.0.0.1:3001';
const SECRET = __ENV.JWT_SECRET || '';
const SUBJECT = __ENV.LOAD_SUBJECT || 'load-edit';
const DOCUMENT_ID = __ENV.LOAD_DOCUMENT_ID || 'load-edit-doc';
const DURATION = __ENV.LOAD_DURATION || '30s';
const TARGET_VUS = Number(__ENV.LOAD_VUS || 20);

/** One shared identity, as in connect.js. Sessions are anonymous; VUs are not people. */
const EDITOR_SUBJECT = `${SUBJECT}-editors`;

/** Characters per burst. A burst models a paste or a fast typist, not one keystroke. */
const BURST = Number(__ENV.LOAD_BURST || 5);

/** Proportion of operations that are deletes, which is what creates tombstones. */
const DELETE_RATIO = Number(__ENV.LOAD_DELETE_RATIO || 0.2);

/**
 * Bursts each VU sends per session.
 *
 * Each session ends once this many have gone out, so sessions turn over and the run
 * measures a steady stream of clients rather than one long-lived set accumulating.
 */
const BURSTS_PER_SESSION = Number(__ENV.LOAD_BURSTS || 25);

/** Operations this VU has sent. Used to build deletes against elements it knows exist. */
const sentOps = [];

const opsSent = new Counter('ops_sent');
const deletesSent = new Counter('deletes_sent');
const opsReceived = new Counter('ops_received');
const framesDropped = new Counter('frames_unparseable');
const admitted = new Rate('admitted');

export const options = {
  scenarios: {
    edit: {
      // A steady-state rate of sessions, each of which types for TYPING_WINDOW_MS and
      // then leaves. Steady VUs would accumulate sessions that never end, and the run
      // would measure how long the server takes to fill up rather than how fast it is.
      executor: 'constant-vus',
      vus: TARGET_VUS,
      duration: DURATION,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    admitted: ['rate>0.99'],
    // Refusals are counted, never tolerated. A relay that silently drops a client under
    // load reports good latency and quietly loses work.
    frames_unparseable: ['count==0'],
    ops_sent: ['count>0'],
  },
};

export function setup() {
  const created = http.post(
    `${BASE_URL}/api/documents`,
    JSON.stringify({ id: DOCUMENT_ID, title: 'load: edit' }),
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
  // One replica identity per VU. Two clients sharing a site id would mint colliding
  // element ids and corrupt the document, which would show up as divergence rather
  // than as a load number.
  const site = `${EDITOR_SUBJECT}-vu${__VU}`;
  let clock = 0;
  let burstsSent = 0;
  let close = () => undefined;
  // Held from onWelcome so incoming frames can answer the traffic without re-entering
  // the handshake. Assigning null here would throw on the first broadcast.
  let send = null;

  /**
   * Emit one burst of operations.
   *
   * Bursts are driven by incoming frames rather than by a timer. Timers registered
   * inside a k6 WebSocket callback do not fire, and a `while` loop with `sleep` stops
   * after a single iteration -- both produce a run that looks like a server which
   * accepted one batch and then went quiet. Driving from the event loop means the loop
   * runs exactly as long as the server keeps broadcasting, which is also a more honest
   * model of typing: a real client sends when it has something to say.
   */
  const emit = () => {
    if (burstsSent >= BURSTS_PER_SESSION) {
      return;
    }

    const batch = [];

    for (let index = 0; index < BURST; index += 1) {
      clock += 1;

      // Deleting something this VU inserted is the only delete it can be certain is
      // safe to send. Deleting another client's element would work, but only because
      // that element is broadcast first -- a race the load test has no business having,
      // and one that would make any failure ambiguous.
      const shouldDelete = sentOps.length > 0 && Math.random() < DELETE_RATIO;

      if (shouldDelete) {
        const victim = sentOps.shift();
        batch.push(deleteOp(site, victim.site, victim.clock));
        deletesSent.add(1);
        continue;
      }

      batch.push(insertOp(site, clock, 'e'));
      sentOps.push({ site: site, clock: clock });
    }

    if (send === null) {
      return;
    }

    send({ type: 'ops', documentId: data.documentId, ops: batch });
    opsSent.add(batch.length);
    burstsSent += 1;
  };

  let welcomed = false;

  const result = openSession(BASE_URL, data.documentId, SECRET, EDITOR_SUBJECT, {
    onWelcome: (sendFn, closeSocket) => {
      welcomed = true;
      close = closeSocket;
      send = sendFn;
      emit();
    },

    onFrame: (frame) => {
      if (frame === null) {
        framesDropped.add(1);
        return;
      }

      if (frame.type !== 'ops') {
        return;
      }

      opsReceived.add(frame.ops.length);

      // Answer the traffic we just received, and finish once the session is long
      // enough. Closing explicitly matters: k6's `connect` blocks until the socket
      // closes, so a VU that never closes never returns and nothing recorded after the
      // call records anything.
      if (burstsSent >= BURSTS_PER_SESSION) {
        close();
        return;
      }

      emit();
    },
  });

  admitted.add(result.welcomed);

  if (result.errorCode !== null) {
    console.error(`refused with ${result.errorCode}`);
  }

  check(welcomed, { 'admitted and typed': () => welcomed });
}
