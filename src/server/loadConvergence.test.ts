/**
 * Convergence under contention, using the real CRDT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE THE k6 SUITE
 * ---------------------------------------------------------------------------
 * `scripts/load/divergence.js` drives as much concurrent load as it can, but k6 cannot
 * import this package's TypeScript. Checking convergence there would mean writing a
 * second RGA in JavaScript: a second, separately wrong implementation of the algorithm
 * under test, disagreeing for reasons that have nothing to do with the real CRDT.
 *
 * So the two jobs are split. That file generates contention and reads the server's
 * verdict. This one verifies convergence with the real `Replica`, over a real relay,
 * at a scale the seeded fuzzer does not reach.
 *
 * The seeded fuzzer (src/core/crdt/rga.test.ts) proves convergence for random
 * operation sets. This proves it for operations that actually travelled through
 * authorisation, the relay, the broadcast path, the durable log and the store's
 * validation - every stage that could drop or reorder something on the way.
 *
 * ASCII only, per the convention in src/core/crdt/rga.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { Replica, type LoggedOperation, type OperationLog } from '../core/crdt/replica.js';
import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import { parseOperations } from '../shared/operation-validation.js';
import { ApiServer } from './api.js';
import { TokenAuthenticator } from './auth.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay } from './relay.js';

const SECRET = 'load-convergence-test-secret-long-enough-hs256';
const OWNER = 'convergence-owner';
const EDITORS = 'convergence-editors';

/**
 * How many replicas contend for one document.
 *
 * Deliberately far above anything a person would produce. The point is not a realistic
 * editing session; it is that the ordering rules hold when every client is inserting
 * and deleting at the same instant, which is the condition under which an RGA either
 * converges or quietly does not.
 */
const EDITORS_COUNT = 24;

/** Operations each editor sends before waiting for the dust to settle. */
const OPS_PER_EDITOR = 60;

let db: Database;
let store: DocumentStore;
let relay: Relay;
let wss: WebSocketServer;
let server: ApiServer;
let baseUrl: string;
let counter = 0;

class MemoryLog implements OperationLog {
  entries: LoggedOperation[] = [];

  load(): Promise<LoggedOperation[]> {
    return Promise.resolve(this.entries.map((entry) => ({ ...entry })));
  }

  append(added: readonly LoggedOperation[]): Promise<void> {
    this.entries.push(...added.map((entry) => ({ ...entry })));
    return Promise.resolve();
  }

  truncateBefore(seq: number): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.seq >= seq);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }
}

function settle(turns = 10): Promise<void> {
  return new Promise((resolve) => {
    let remaining = turns;
    const tick = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, 20);
    };
    setTimeout(tick, 20);
  });
}

beforeAll(async () => {
  db = await Database.open();
  store = new DocumentStore({ db });

  relay = new Relay({
    heartbeatMs: 0,
    log: { readSince: (id, since, limit) => store.readSince(id, since, limit) },
    authorize: async (documentId, token) => {
      const subject = await new TokenAuthenticator({ secret: SECRET }).verify(token).then(
        (identity) => identity.subject,
        () => null,
      );

      if (subject === null) {
        return { ok: false as const, code: 'UNAUTHORIZED' as const, message: 'bad token' };
      }

      return (await db.canAccess(documentId, subject))
        ? { ok: true as const, subject }
        : {
            ok: false as const,
            code: 'DOCUMENT_NOT_FOUND' as const,
            message: 'no access',
          };
    },
  });

  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('doc') ?? 'default';

    relay.attach(socket, id, (ops) => {
      void store.apply(id, ops);
    });
  });

  server = new ApiServer({
    db,
    auth: new TokenAuthenticator({ secret: SECRET }),
    host: '127.0.0.1',
    port: 0,
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${port}`;
    },
  });

  server.onUpgrade('/ws', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  await server.listen();
}, 120_000);

afterAll(async () => {
  relay.close();

  for (const client of wss.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve) => {
    wss.close(() => {
      resolve();
    });
  });

  await server.close();
  await db.close();
});

interface Editor {
  readonly site: string;
  readonly replica: Replica;
  readonly socket: WebSocket;
  clock: number;
  /** Element ids this editor has created, for deletes it knows are safe. */
  mine: { site: string; clock: number }[];
  /** Everything received off the wire, for a post-hoc check. */
  received: Operation[];
  /**
   * Everything this editor SENT, including the operations it applied locally.
   *
   * Recorded so the assertion can build an independent reference document from the
   * operations that were actually issued, rather than only comparing replicas to each
   * other. See the note on the convergence assertion for why that distinction is the whole
   * point.
   */
  sent: Operation[];
}

/**
 * Wait until every editor has received every operation it did not send itself.
 *
 * ---------------------------------------------------------------------------
 * WHY "THEY AGREE" IS NOT A SUFFICIENT CONDITION
 * ---------------------------------------------------------------------------
 * The obvious wait is "until all replicas hold the same text". That is wrong, and it fails
 * in the most dangerous direction: once editors apply their own operations locally, they all
 * hold their own 22 characters and NOTHING from anyone else, so they agree immediately. A
 * helper that waited for agreement returned at once with 22 characters, and the assertion
 * then reported a CRDT bug that was really the helper returning before any broadcast had
 * been delivered.
 *
 * Agreement is not completeness. Two peers can agree perfectly about a document neither of
 * them has fully received.
 *
 * So the condition is delivery, which is computable and independent of the CRDT: each editor
 * sent a known number of operations, the relay does not echo to the sender, and therefore
 * each must receive exactly `totalSent - itsOwnSent`. Verified against instrumentation on the
 * failing build: 24 editors x 60 operations is 1,440 sent, and every editor had received
 * exactly 1,380.
 *
 * Once delivery is established, convergence becomes a meaningful claim: the replicas agree,
 * and they agree on the right thing.
 */
async function awaitFullDelivery(
  editors: readonly Editor[],
  totalSent: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const complete = editors.every(
      (editor) => editor.received.length >= totalSent - editor.sent.length,
    );

    if (complete) {
      return;
    }

    if (Date.now() > deadline) {
      const short = editors
        .map((editor, index) => {
          const want = totalSent - editor.sent.length;

          return `${index}:${editor.received.length}/${want}`;
        })
        .join(' ');

      throw new Error(
        `Editors had not received every operation within ${timeoutMs}ms. ` +
          `received/expected per editor: ${short}`,
      );
    }

    await settle(4);
  }
}

async function tokenFor(subject: string): Promise<string> {
  return (await new TokenAuthenticator({ secret: SECRET }).issue(subject)).token;
}

/** Open an editor, complete the handshake, and start applying inbound operations. */
async function openEditor(documentId: string, index: number, token: string): Promise<Editor> {
  const site = `editor-${index}`;
  const replica = new Replica({ site, log: new MemoryLog(), onOperations: () => undefined });
  await replica.init();

  const port = new URL(baseUrl).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?doc=${encodeURIComponent(documentId)}`);
  const received: Operation[] = [];

  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as { type: string; ops?: unknown };

    if (message.type === 'ops') {
      const ops = parseOperations((message.ops ?? []) as never);
      received.push(...ops);
      replica.applyRemote(ops);
    }
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
      token,
      documentId,
      lastAppliedSeq: 0,
    }),
  );

  await settle(4);

  return { site, replica, socket, clock: 0, mine: [], received, sent: [] };
}

describe('convergence under contention', () => {
  it('reaches the same document in every replica after concurrent editing', async () => {
    counter += 1;
    const documentId = `convergence-${counter}`;

    const created = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await tokenFor(OWNER)}`,
      },
      body: JSON.stringify({ id: documentId, title: 'convergence' }),
    });

    expect(created.status).toBe(201);

    const granted = await fetch(`${baseUrl}/api/documents/${documentId}/collaborators`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await tokenFor(OWNER)}`,
      },
      body: JSON.stringify({ subject: EDITORS }),
    });

    expect(granted.status).toBe(200);

    const token = await tokenFor(EDITORS);
    const editors = await Promise.all(
      Array.from({ length: EDITORS_COUNT }, (_unused, index) =>
        openEditor(documentId, index, token),
      ),
    );

    // Every editor writes at once, with no coordination. Interleaving is whatever the
    // network and the event loop produce, which is the point.
    for (let round = 0; round < OPS_PER_EDITOR; round += 1) {
      for (const editor of editors) {
        editor.clock += 1;

        // A third of the operations are deletes against elements the editor itself
        // created, which is the only delete it can be certain is safe to send without
        // racing an element it has not seen yet.
        const shouldDelete = editor.mine.length > 0 && round % 3 === 0;

        if (shouldDelete) {
          const victim = editor.mine.shift();

          if (victim) {
            const op: Operation = {
              type: 'delete',
              target: { site: victim.site, clock: victim.clock },
            };

            // Applied locally FIRST, then sent. This is what the real client does: the edit
            // lands in the document the user is looking at, and only then goes to the wire.
            //
            // The relay deliberately does not echo a message back to its sender, so an
            // editor that only SENDS never receives its own work and its replica is short
            // by exactly the operations it produced. Every editor was short by the same
            // amount here, so they still agreed with each other and the test passed - while
            // proving nothing about completeness. See the assertion below.
            editor.replica.applyRemote([op]);
            editor.sent.push(op);

            editor.socket.send(JSON.stringify({ type: 'ops', documentId, ops: [op] }));
            continue;
          }
        }

        const op: Operation = {
          type: 'insert',
          id: { site: editor.site, clock: editor.clock },
          origin: null,
          value: 'x',
        };

        editor.mine.push({ site: editor.site, clock: editor.clock });
        editor.replica.applyRemote([op]);
        editor.sent.push(op);

        editor.socket.send(JSON.stringify({ type: 'ops', documentId, ops: [op] }));
      }
    }

    // ---------------------------------------------------------------------------
    // WAIT FOR CONVERGENCE, DO NOT SLEEP A GUESSED INTERVAL
    // ---------------------------------------------------------------------------
    // `settle(30)` is about 120ms. With 24 editors sending 1,440 operations that has to be
    // broadcast, stored, and fanned back out to 23 peers each, it is usually enough and on a
    // loaded CI runner it is not. The failure it produces is `editor 17 diverged: expected
    // 438 characters to be 391` - which reads as a CRDT losing edits and is in fact one
    // replica lagging behind.
    //
    // That is the worst kind of failure: it accuses the algorithm when the test's timing is
    // at fault, and nothing in the output distinguishes the two. Convergence is not "they
    // agree within 120ms", it is "they agree", so the assertion waits for that and reports
    // the disagreement if it never arrives.
    // Every operation issued, and therefore how many each editor must receive.
    const totalSent = editors.reduce((sum, editor) => sum + editor.sent.length, 0);

    await awaitFullDelivery(editors, totalSent);

    // With delivery established, agreement is now a real claim.
    const texts = editors.map((editor) => editor.replica.text);
    const reference = texts[0] ?? '';

    // ---------------------------------------------------------------------------
    // AND COMPARE AGAINST AN INDEPENDENT REFERENCE, NOT JUST EACH OTHER
    // ---------------------------------------------------------------------------
    // Comparing 24 replicas to `texts[0]` proves they agree. It does NOT prove any of them
    // is right: a relay that dropped every third operation on every socket would produce 24
    // replicas that agree perfectly and are all wrong.
    //
    // That is not hypothetical here. Every editor was missing its own 60 operations - the
    // relay does not echo to the sender - so all 24 were short by the same amount and
    // agreed with each other. The test passed on a document that no replica actually held in
    // full.
    //
    // So this builds the document a THIRD time, from the operations the editors issued,
    // with no relay, no socket and no network involved. Every replica must match that. Now a
    // dropped operation fails, because the reference contains it and the replica does not.
    const rebuilt = new RgaDocument('reference');

    for (const editor of editors) {
      for (const op of editor.sent) {
        rebuilt.apply(op);
      }
    }

    const expected = rebuilt.toText();

    expect(expected.length).toBeGreaterThan(100);

    for (const [index, editor] of editors.entries()) {
      // The whole claim, in two halves. Agreement with each other, and agreement with an
      // independently built document.
      expect(editor.replica.text, `editor ${index} diverged from its peers`).toBe(reference);
      expect(editor.replica.text, `editor ${index} diverged from the reference`).toBe(expected);
      expect(editor.replica.checkInvariants(), `editor ${index} broke an invariant`).toEqual([]);
    }

    // Nothing was invented or dropped.
    expect(totalSent).toBe(EDITORS_COUNT * OPS_PER_EDITOR);
    expect(expected).toHaveLength(reference.length);

    // The document is genuinely non-trivial. A test that converged on an empty string
    // would pass every assertion above and prove nothing.
    expect(reference?.length ?? 0).toBeGreaterThan(100);

    // And the server stored what it should have. A relay that broadcast to peers but
    // failed to persist would leave every client right and the next reconnect broken.
    const result = await store.apply(documentId, []);
    expect(result.unplaced).toEqual([]);

    for (const editor of editors) {
      editor.socket.terminate();
    }
  }, 180_000);

  it('produces the same document when operations arrive in a different order', async () => {
    // The relay's ordering is one possible order, not the only one. Convergence must not
    // depend on it, so this drives the same operation set through several orderings and
    // compares the results.
    counter += 1;
    const documentId = `order-${counter}`;

    await db.createDocument({ id: documentId, owner: OWNER });

    const ops: Operation[] = [];
    const author = new RgaDocument('author');

    for (let index = 0; index < 200; index += 1) {
      ops.push(...author.insertAt(index % 40, 'o'));
    }

    const results = new Set<string>();

    // A handful of deterministic shuffles. Fixed seeds rather than random, so a failure
    // here reproduces exactly rather than intermittently.
    for (let seed = 1; seed <= 4; seed += 1) {
      const shuffled = [...ops];
      const random = (n: number): number => (seed * 9301 + n * 49297) % 233280;

      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = random(index) % (index + 1);
        const held = shuffled[index];
        shuffled[index] = shuffled[swap] as Operation;
        shuffled[swap] = held as Operation;
      }

      const replica = new RgaDocument('replica');
      replica.applyInAnyOrder(shuffled);
      results.add(replica.toText());
    }

    expect(results.size).toBe(1);
    expect([...results][0]?.length ?? 0).toBe(200);
  }, 120_000);
});
