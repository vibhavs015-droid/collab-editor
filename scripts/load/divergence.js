/**
 * `divergence.js` - correctness under contention.
 *
 * This is the scenario the load suite exists for. A latency benchmark will happily
 * report success while documents are quietly diverging underneath it, so this drives as
 * many concurrent writers into one document as it can and then asks the one question
 * that matters: did anything fail to apply?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE DOES NOT CHECK CONVERGENCE ITSELF
 * ---------------------------------------------------------------------------
 * k6 cannot import this package's TypeScript, so verifying convergence inside k6 would
 * mean writing a second RGA in JavaScript. That is exactly the mistake this project has
 * avoided all along: a second, separately wrong implementation of the algorithm under
 * test, which would disagree for reasons that have nothing to do with the real CRDT.
 *
 * So the jobs are split:
 *
 *   - THIS FILE generates maximum contention and reads the server's own verdict.
 *   - `src/server/loadConvergence.test.ts` verifies convergence using the real
 *     `Replica` class, over the real relay, at a scale the seeded fuzzer does not reach.
 *
 * The signal this file reports is `collab_operations_unplaced_total`. An operation
 * that cannot be placed is an operation some peer is still waiting for, and if it never
 * arrives that peer stays silently behind. It is the one number where a zero is the
 * only acceptable answer.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

import { authHeaders, deleteOp, insertOp, openSession } from './lib/protocol.js';

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://127.0.0.1:3001';
const SECRET = __ENV.JWT_SECRET || '';
const SUBJECT = __ENV.LOAD_SUBJECT || 'load-divergence';
const DOCUMENT_ID = __ENV.LOAD_DOCUMENT_ID || 'load-divergence-doc';
const DURATION = __ENV.LOAD_DURATION || '20s';
const TARGET_VUS = Number(__ENV.LOAD_VUS || 25);

/** One shared identity, as in connect.js. */
const EDITOR_SUBJECT = `${SUBJECT}-editors`;

/** Concurrent writes per burst. Larger than edit.js, on purpose. */
const BURST = Number(__ENV.LOAD_BURST || 10);

/** Proportion of deletes, which is what produces the ordering conflicts that matter. */
const DELETE_RATIO = Number(__ENV.LOAD_DELETE_RATIO || 0.3);

/**
 * Bursts each VU contributes per session.
 *
 * Capped so sessions turn over and the run measures a steady stream of clients rather
 * than one long-lived set accumulating.
 */
const BURSTS_PER_SESSION = Number(__ENV.LOAD_BURSTS || 20);

const opsSent = new Counter('ops_sent');
const deletesSent = new Counter('deletes_sent');
const admitted = new Rate('admitted');
const framesDropped = new Counter('frames_unparseable');
/**
 * Highest element clock this VU has observed from any peer.
 *
 * A clock value, not a duration, despite living in a Trend - which is why it is not
 * named with a unit suffix. It answers "how far ahead of me are the other clients",
 * which is the thing that would grow without bound if the CRDT were not converging.
 */
const maxObservedClock = new Trend('max_observed_clock');

export const options = {
  scenarios: {
    divergence: {
      executor: 'constant-vus',
      vus: TARGET_VUS,
      duration: DURATION,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    admitted: ['rate>0.99'],
    frames_unparseable: ['count==0'],
    ops_sent: ['count>0'],
  },
};

export function setup() {
  const created = http.post(
    `${BASE_URL}/api/documents`,
    JSON.stringify({ id: DOCUMENT_ID, title: 'load: divergence' }),
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
  const site = `${EDITOR_SUBJECT}-vu${__VU}`;
  let clock = 0;

  /** Every element id this VU has observed, so deletes can target real elements. */
  const seen = [];

  let welcomed = false;
  let close = () => undefined;
  let send = null;
  let burstsSent = 0;

  const emit = () => {
    if (send === null) {
      return;
    }

    const batch = [];

    for (let index = 0; index < BURST; index += 1) {
      clock += 1;

      // Deletes target elements this VU has SEEN, which under contention belong to
      // other VUs. That is what creates genuine ordering conflicts rather than each
      // client tidying up after itself.
      const shouldDelete = seen.length > 0 && Math.random() < DELETE_RATIO;

      if (shouldDelete) {
        const victim = seen.shift();
        batch.push(deleteOp(site, victim.site, victim.clock));
        deletesSent.add(1);
        continue;
      }

      const op = insertOp(site, clock, 'x');
      seen.push({ site: site, clock: clock });
      batch.push(op);
    }

    send({ type: 'ops', documentId: data.documentId, ops: batch });
    opsSent.add(batch.length);
    burstsSent += 1;
  };

  const result = openSession(BASE_URL, data.documentId, SECRET, EDITOR_SUBJECT, {
    onWelcome: (sendFn, closeSocket) => {
      welcomed = true;
      send = sendFn;
      close = closeSocket;
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

      // Track the highest clock seen from each site, so the run reports how far the
      // clients' views actually diverge at any moment. A CRDT that is not converging
      // shows up here as a spread that grows without bound.
      let highest = 0;

      for (const op of frame.ops) {
        const site = op.type === 'insert' ? op.id.site : op.target.site;
        const clock = op.type === 'insert' ? op.id.clock : op.target.clock;

        seen.push({ site: site, clock: clock });
        highest = Math.max(highest, clock);
      }

      if (highest > 0) {
        maxObservedClock.add(highest);
      }

      // Sessions turn over once this VU has contributed enough operations.
      // Without an explicit close the socket stays open, k6's blocking connect never
      // returns, and the admitted rate reports "0 out of 0" instead of a number.
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

  check(welcomed, { 'admitted and contended': () => welcomed });
}

export function teardown() {
  // One final read of the server's verdict. Reported as a console line rather than a
  // metric because it is only known after every VU has finished, and a value written
  // here would not be attributed to any scenario.
  // k6's sleep takes SECONDS. sleep(1_000) here meant a thousand seconds, and the
  // teardown timed out after 60 with the run reported as a script exception - which
  // reads as a failure of the thing being measured rather than of the harness.
  sleep(1);

  try {
    const response = http.get(`${BASE_URL}/api/metrics`);

    if (!response.ok) {
      return;
    }

    const match = /^collab_operations_unplaced_total (\d+)$/mu.exec(response.body);

    if (match) {
      const unplaced = Number(match[1]);

      // This is the number the whole file exists to produce.
      console.log(`unplaced operations: ${unplaced}`);
    }
  } catch {
    // The server is stopped by run.mjs after teardown on some paths. Absence of this
    // line is reported by the harness, not silently treated as zero.
  }
}
