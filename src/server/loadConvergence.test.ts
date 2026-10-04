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

  return { site, replica, socket, clock: 0, mine: [], received };
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
            editor.socket.send(
              JSON.stringify({
                type: 'ops',
                documentId,
                ops: [{ type: 'delete', target: { site: victim.site, clock: victim.clock } }],
              }),
            );
            continue;
          }
        }

        const op = {
          type: 'insert',
          id: { site: editor.site, clock: editor.clock },
          origin: null,
          value: 'x',
        };

        editor.mine.push({ site: editor.site, clock: editor.clock });
        editor.socket.send(JSON.stringify({ type: 'ops', documentId, ops: [op] }));
      }
    }

    // Long enough for every broadcast to land. Not a guess about correctness, just
    // enough time for the last frame to arrive.
    await settle(30);

    const texts = editors.map((editor) => editor.replica.text);
    const reference = texts[0];

    expect(reference).toBeDefined();

    for (let index = 0; index < editors.length; index += 1) {
      // The whole claim. If any two of these disagree, the CRDT is not converging
      // under real load and every latency number above is meaningless.
      expect(texts[index], `editor ${index} diverged`).toBe(reference);
    }

    for (const editor of editors) {
      expect(editor.replica.checkInvariants()).toEqual([]);
    }

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
