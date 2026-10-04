/**
 * `connect.js` - connection ramp and handshake latency.
 *
 * The cheapest thing to measure and the first thing to break. Every other script
 * depends on a client getting through this, so a regression here silently caps the
 * numbers everywhere else.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

import { authHeaders, openSession } from './lib/protocol.js';

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://127.0.0.1:3001';
const SECRET = __ENV.JWT_SECRET || '';
const SUBJECT = __ENV.LOAD_SUBJECT || 'load-connect';
const DOCUMENT_ID = __ENV.LOAD_DOCUMENT_ID || 'load-connect-doc';
const RAMP_TIME = __ENV.LOAD_RAMP_TIME || '20s';
const TARGET_VUS = Number(__ENV.LOAD_VUS || 25);

/**
 * The identity every VU edits as.
 *
 * One shared subject rather than one per VU, and that is not a shortcut. Sessions are
 * anonymous, so a different subject really is a different person -- and a document
 * created by one subject is not readable by any other. Giving each VU its own identity
 * made every handshake fail with DOCUMENT_NOT_FOUND, which is the authorisation layer
 * working exactly as designed.
 *
 * So setup creates the document as the owner and grants this subject access, which is
 * the collaborator case the ownership model exists for. Every VU then shares one
 * identity, exactly as every browser tab of one person's document would.
 */
const EDITOR_SUBJECT = `${SUBJECT}-editors`;

/**
 * Time from socket open to the server's `welcome`.
 *
 * The number a user actually waits for, and it includes the server's authorisation
 * check because that check IS the handshake. Measuring from open to first byte instead
 * would report the TCP handshake and call it a result.
 */
const handshakeDuration = new Trend('handshake_duration', true);

/** Refusals, kept out of the trend so a failure cannot flatter the percentiles. */
const refusals = new Counter('handshake_refusals');

export const options = {
  scenarios: {
    connect: {
      // Every VU opens one connection, completes the handshake, and finishes. VUs then
      // idle until the ramp ends, so the run holds TARGET_VUS connections open at once
      // without needing a long-lived session.
      //
      // No `maxDuration` here: it is only valid for the iteration-based executors, and
      // passing it to `ramping-vus` makes k6 refuse to start with "unknown field". The
      // ceiling on the whole run lives in run.mjs, which can actually enforce one.
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [{ target: TARGET_VUS, duration: RAMP_TIME }],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // Asserted against the recorded run in docs/benchmarks.md. A threshold nobody
    // looked at is decoration.
    handshake_duration: ['p(95)<500'],
    handshake_refusals: ['count==0'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  // The document has to exist before anyone connects, or every handshake fails for a
  // reason that has nothing to do with the handshake.
  const created = http.post(
    `${BASE_URL}/api/documents`,
    JSON.stringify({ id: DOCUMENT_ID, title: 'load: connect' }),
    { headers: { 'Content-Type': 'application/json', ...authHeaders(SECRET, SUBJECT) } },
  );

  check(created, {
    'document created': (r) => r.status === 201 || r.status === 409,
  });

  // Grant the editing subject. Doing this in setup rather than creating the document
  // unowned is what keeps the load run on the same authorisation path production uses.
  const grant = http.post(
    `${BASE_URL}/api/documents/${DOCUMENT_ID}/collaborators`,
    JSON.stringify({ subject: EDITOR_SUBJECT }),
    { headers: { 'Content-Type': 'application/json', ...authHeaders(SECRET, SUBJECT) } },
  );

  check(grant, { 'editor access granted': (r) => r.status === 200 });

  return { documentId: DOCUMENT_ID };
}

export default function (data) {
  // Close as soon as we are admitted.
  //
  // k6's `connect` blocks until the socket closes, so a session left open holds the VU
  // until the ramp ends and nothing recorded after the call records anything.
  const result = openSession(BASE_URL, data.documentId, SECRET, EDITOR_SUBJECT, {
    onWelcome: (_send, close) => {
      close();
    },
  });

  if (result.welcomed) {
    // Measured by the handshake itself, inside the welcome handler. Timing around
    // k6's blocking connect would report the length of the whole session instead.
    handshakeDuration.add(result.handshakeMs);
  } else {
    // Counted, not timed. Recording a placeholder here would drag p95 down by making
    // failures look like the fastest handshakes in the run.
    refusals.add(1);
  }

  check(result.welcomed, { 'admitted to the room': () => result.welcomed });

  if (result.errorCode !== null && refusalsLogged < 5) {
    // A handful of lines, not one per VU. A refusal storm is the signal; its full
    // volume is not, and flooding the output is how a real failure gets missed.
    refusalsLogged += 1;
    console.error(`refused with ${result.errorCode}`);
  }
}

/** Refusals logged so far. Bounded so a broken run does not produce a gigabyte of it. */
let refusalsLogged = 0;
