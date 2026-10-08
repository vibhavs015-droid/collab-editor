/**
 * T4: do writes survive a socket that dies after the frame was written?
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT TEST
 * ---------------------------------------------------------------------------
 * transport.test.ts proves the client side: the outbox is emptied on the strength of `send()`
 * returning, so a frame written to a socket that then dies is never written again. That is half
 * the claim. The other half is that the server really does end up without the operations - which
 * needs a real relay, a real database, and a real client, because every layer in between is a
 * place the answer could turn out to be different.
 *
 * The client here is the REAL `SyncTransport`, not a hand-rolled stub. A stub would assert that
 * the resend logic works; this asserts that the shipped client resends.
 *
 * ---------------------------------------------------------------------------
 * HOW THE FAILURE IS PRODUCED
 * ---------------------------------------------------------------------------
 * The relay's `onOps` callback is where a frame has been received but not yet persisted. This
 * harness terminates the socket at that exact point and skips the write, which is the server
 * crashing mid-frame with no way to have stored it.
 *
 * A TCP proxy that dropped the connection after N bytes would also work, and would be closer to
 * a real network failure. It would also add a second moving part to every assertion, and the
 * thing being tested is what the client does when a frame is not acknowledged - which is the
 * same either way. The terminate-before-persist version is used because its timing is exact.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { SyncTransport, type TransportHandlers } from '../client/sync/transport.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay } from './relay.js';
import { DEFAULT_LIMITS } from './limits.js';

/** The DOM WebSocket, which is what SyncTransport's factory has to return. */
type WebSocketLike = globalThis.WebSocket;

const teardown: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const done of teardown.splice(0, teardown.length).reverse()) {
    await done();
  }
});

interface Operation {
  readonly type: 'insert';
  readonly id: { site: string; clock: number };
  readonly origin: { site: string; clock: number } | null;
  readonly value: string;
}

function insert(site: string, clock: number): Operation {
  return {
    type: 'insert',
    id: { site, clock },
    origin: clock === 1 ? null : { site, clock: clock - 1 },
    value: 'x',
  };
}

/**
 * A relay whose persistence step can be made to fail exactly once.
 *
 * `setKillOnNextFrame` is the whole mechanism: it terminates the socket the moment the frame is
 * in hand, which is the instant a real server would be between "read" and "committed".
 */
async function startFlakyRelay(): Promise<{
  readonly port: number;
  readonly documentId: string;
  readonly db: Database;
  setKillOnNextFrame: (value: boolean) => void;
  setLoseAckOnNextFrame: (value: boolean) => void;
}> {
  const db = await Database.open();
  const store = new DocumentStore({ db });
  const documentId = 'durability-doc';

  await db.createDocument({ id: documentId, title: 'durability', owner: 'owner' });

  let killOnNextFrame = false;
  let loseAckOnNextFrame = false;

  const relay = new Relay({
    heartbeatMs: 0,
    log: { readSince: (id, since, limit) => store.readSince(id, since, limit) },
    limits: DEFAULT_LIMITS,
  });

  const wss = new WebSocketServer({ port: 0 });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const id = url.searchParams.get('doc') ?? 'default';

    relay.attach(socket, id, (ops) => {
      if (killOnNextFrame) {
        // Received, not persisted, socket gone. This is the failure the whole test is about.
        killOnNextFrame = false;
        socket.terminate();
        return;
      }

      const written = store.apply(id, ops).then(() => undefined);

      if (!loseAckOnNextFrame) {
        return written;
      }

      // The harder half of the uncertainty: the write DID land, and then the socket died
      // before the acknowledgement could travel. Registered before the relay's own `then`, so
      // it runs first and the ack is written into a dead socket.
      //
      // The client therefore cannot tell this apart from the case above, which is exactly why
      // it has to replay - and why replay has to be safe.
      loseAckOnNextFrame = false;
      return written.then(() => {
        socket.terminate();
      });
    });
  });

  await new Promise<void>((resolve) => {
    wss.on('listening', () => {
      resolve();
    });
  });

  const address = wss.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  teardown.push(async () => {
    relay.close();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
    await db.close();
  });

  return {
    port,
    documentId,
    db,
    setKillOnNextFrame: (v) => (killOnNextFrame = v),
    setLoseAckOnNextFrame: (v) => (loseAckOnNextFrame = v),
  };
}

interface TestClient {
  readonly transport: SyncTransport;
  readonly pending: { state: string; count: number }[];
  /** How many sockets the transport has opened. A reconnect increments it. */
  readonly socketsOpened: () => number;
  close: () => void;
}

/** The real client, wired to a real socket, reporting only what these tests need. */
function client(port: number, documentId: string): TestClient {
  const pending: { state: string; count: number }[] = [];
  let opened = 0;

  const handlers: TransportHandlers = {
    onOps: () => undefined,
    onBaseline: () => undefined,
    onPresence: () => undefined,
    onSyncState: (state, count) => {
      pending.push({ state, count });
    },
    onWelcome: () => undefined,
    onError: () => undefined,
    onStateChange: () => undefined,
  };

  const transport = new SyncTransport({
    documentId,
    url: `ws://127.0.0.1:${port}/ws?doc=${documentId}`,
    handlers,
    // `ws` and the DOM declare two different WebSocket types with the same name. The cast is
    // needed and is confined to this one line, which is the point of injecting the factory.
    socketFactory: (url) => {
      opened += 1;
      return new WebSocket(url) as unknown as WebSocketLike;
    },
    baseRetryMs: 50,
    maxRetryMs: 500,
    resolveToken: () => Promise.resolve('token'),
  });

  return {
    transport,
    pending,
    socketsOpened: () => opened,
    close: () => transport.dispose(),
  };
}

/** Wait for a condition, or fail saying what was still true. */
async function waitFor(check: () => boolean, why: () => string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`timed out: ${why()}`);
}

/** Poll the stored text, because the interesting change is on the far side of a reconnect. */
async function readUntil(db: Database, documentId: string, want: string): Promise<string> {
  const deadline = Date.now() + 25_000;
  let content = '';

  while (Date.now() < deadline) {
    content = (await db.getDocument(documentId))?.content ?? '';

    if (content === want) {
      return content;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return content;
}

describe('a frame that is never acknowledged (T4)', () => {
  it('the operations survive a socket that dies before the server persists them', async () => {
    // ---------------------------------------------------------------------------
    // THIS IS THE PROOF. IT FAILED WITH `expected '' to be 'xx'` BEFORE THE FIX.
    // ---------------------------------------------------------------------------
    // Nothing here asserts the old behaviour: a test written to match the bug would break the
    // moment the bug was fixed, and would then be arguing with the fix rather than guarding it.
    // This states the requirement, so a failure means data was lost.
    const h = await startFlakyRelay();
    const c = client(h.port, h.documentId);

    c.transport.connect();
    await waitFor(
      () => c.transport.state === 'open',
      () => `never connected, state ${c.transport.state}`,
    );

    const before = c.socketsOpened();

    // Arm the failure, then send. The frame is read by the relay and the socket is destroyed
    // before anything is written.
    h.setKillOnNextFrame(true);
    c.transport.send([insert('writer', 1), insert('writer', 2)]);

    // The reconnect is the mechanism, and it happens on its own. Waiting on the socket COUNT
    // rather than on a state transition: with a 50 ms base retry the connection can be down and
    // back up between two polls, so `state !== 'open'` is a race that loses.
    await waitFor(
      () => c.socketsOpened() > before,
      () => `still on the first socket after ${c.transport.state}`,
      30_000,
    );

    const content = await readUntil(h.db, h.documentId, 'xx');

    expect(content, 'the resend never reached the server, so the edits were lost').toBe('xx');
    expect(c.socketsOpened(), 'the client reconnected on its own').toBeGreaterThan(before);

    c.close();
  });

  it('reports pending, not synced, until the server has acknowledged the frame', async () => {
    // The indicator half of the claim. `Synced` on the strength of `send()` returning is the
    // application asserting something it cannot know, and it is why the bug was silent: the
    // user was told their work was safe at the exact moment it was least safe.
    const h = await startFlakyRelay();
    const c = client(h.port, h.documentId);

    c.transport.connect();
    await waitFor(
      () => c.transport.state === 'open',
      () => `never connected, state ${c.transport.state}`,
    );

    h.setKillOnNextFrame(true);
    c.transport.send([insert('writer', 1)]);

    const reportedPending = await waitFor(
      () => c.pending.some((p) => p.state === 'pending'),
      () => `never reported pending; saw ${JSON.stringify(c.pending)}`,
      5_000,
    ).then(
      () => true,
      () => false,
    );

    expect(
      reportedPending,
      `reported ${JSON.stringify(c.pending.at(-1))} with an unacknowledged operation`,
    ).toBe(true);

    c.close();
  });

  it('a frame the server DID persist, but whose acknowledgement was lost, is not stored twice', async () => {
    // ---------------------------------------------------------------------------
    // THE GUARD ON THE FIX. Resending is only safe because persistence is idempotent.
    // ---------------------------------------------------------------------------
    // This is the case the client cannot distinguish from the first test: the write landed, and
    // the connection died before the acknowledgement arrived. So it replays - and the document
    // must still hold two characters, not four.
    //
    // Without this, "resend on reconnect" would be a fix that trades lost edits for duplicated
    // ones, and idempotency would be an assumption in a comment rather than a measured fact.
    const h = await startFlakyRelay();
    const c = client(h.port, h.documentId);

    c.transport.connect();
    await waitFor(
      () => c.transport.state === 'open',
      () => `never connected, state ${c.transport.state}`,
    );

    const before = c.socketsOpened();

    // Stored, then the socket destroyed before the ack can travel.
    h.setLoseAckOnNextFrame(true);
    c.transport.send([insert('writer', 1), insert('writer', 2)]);

    await waitFor(
      () => c.socketsOpened() > before,
      () => 'the socket never died, so the acknowledgement was not actually lost',
      30_000,
    );

    // Let the replay land and be acknowledged in turn.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(
      (await h.db.getDocument(h.documentId))?.content,
      'a frame that was persisted, then replayed, was applied twice',
    ).toBe('xx');

    expect(c.socketsOpened(), 'the replay really did go out on a new socket').toBeGreaterThan(
      before,
    );

    c.close();
  });
});
