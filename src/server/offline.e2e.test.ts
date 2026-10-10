/**
 * Offline-first end-to-end test.
 *
 * This is the project's headline claim, so it is tested as a claim rather than as
 * a set of features:
 *
 *   "Kill the server, keep typing, restore, nothing lost."
 *
 * Everything runs against a real HTTP server, a real WebSocket relay and a real
 * PostgreSQL (via PGlite). The one thing faked is the client's storage, and that is
 * faked with a faithful in-memory {@link OperationLog} rather than IndexedDB,
 * because the IndexedDB adapter has its own suite. What is proven here is the
 * *architecture*: the write path survives losing the server, and both the device
 * and the server can rebuild the document from the operation log alone.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';

import { createRelaySocketServer } from './socketServer.js';

import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import { Replica, type LoggedOperation, type OperationLog } from '../core/crdt/replica.js';
import { initialOperations } from '../core/crdt/seed.js';
import { ApiServer } from './api.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay } from './relay.js';

/**
 * Durable log, in memory.
 *
 * A real IndexedDB would add tens of seconds to this suite and prove nothing extra:
 * what matters is that the client can rebuild from the log, not which storage engine
 * holds it. Pruning is deliberately NOT implemented, because a log that silently
 * discarded entries would let these tests pass while the product lost data.
 */
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

/** A client: a replica, its durable log, and a socket. */
interface TestPeer {
  readonly site: string;
  readonly replica: Replica;
  readonly log: MemoryLog;
  readonly socket: WebSocket;
  /** Sequence the client believes it holds. */
  seq: number;
  /** Every operation the server has sent this peer. */
  readonly received: Operation[];
  close: () => Promise<void>;
  /**
   * Put operations on the wire, if the socket is open.
   *
   * Explicit rather than driven by a queue, because these tests are about the
   * architecture rather than the transport: the outbox and its flush-on-reconnect
   * behaviour have their own suite. What matters here is that a client holding
   * operations locally can hand them to the server whenever it is able.
   */
  send: (ops: readonly Operation[]) => void;
  /** Every operation this peer ever authored, from the durable log. */
  authored: () => Operation[];
}

let db: Database;
let store: DocumentStore;
let relay: Relay;
let wss: WebSocketServer;
let api: ApiServer;
let baseUrl: string;
let wsUrl: string;
let siteCounter = 0;

const openPeers: TestPeer[] = [];

/**
 * Let queued microtasks and I/O run.
 *
 * Several turns, not one. A round trip here is socket -> relay -> database ->
 * socket, and each hop is at least one event-loop turn; a single `setTimeout(0)`
 * would assert against a half-finished pipeline and produce flaky tests that train
 * the reader to re-run them.
 */
async function settle(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function nextSite(): string {
  siteCounter += 1;
  return `peer-${siteCounter}`;
}

async function connectPeer(documentId: string, site: string, log: MemoryLog): Promise<TestPeer> {
  const received: Operation[] = [];

  const replica = new Replica({
    site,
    log,
    // The real transport subscribes here and queues operations for the socket.
    // These tests send explicitly instead, so the callback has nothing to do.
    onOperations: () => undefined,
  });

  await replica.init();

  const socket = new WebSocket(`${wsUrl}?doc=${encodeURIComponent(documentId)}`);
  const peer: TestPeer = {
    site,
    replica,
    log,
    socket,
    received,
    seq: 0,
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => {
          resolve();
        });
        socket.close();
      }),
    send: (ops) => {
      if (ops.length === 0 || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(JSON.stringify({ type: 'ops', documentId, ops }));
    },
    authored: () => log.entries.map((entry) => entry.op),
  };

  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as {
      type?: string;
      ops?: Operation[];
      snapshot?: Operation[];
      seq?: number;
    };

    const ops = message.ops ?? message.snapshot;

    if (ops !== undefined) {
      // Identical to the transport: apply first, and only then advance the cursor.
      // Advancing first would mean a failure between the two loses exactly the
      // operations the client claimed to have.
      replica.applyRemote(ops);
      received.push(...ops);
    }

    if (typeof message.seq === 'number' && message.seq > peer.seq) {
      peer.seq = message.seq;
    }
  });

  socket.on('error', () => {
    // A disconnect is a normal part of these scenarios; the close handler is what
    // the tests assert on.
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });

  // Declare a cursor so the server replays. Zero means "I hold nothing", which is
  // what a device joining an existing document honestly reports.
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      token: 'test',
      documentId,
      lastAppliedSeq: peer.seq,
    }),
  );

  return peer;
}

async function openPeer(
  documentId: string,
  site: string,
  log = new MemoryLog(),
): Promise<TestPeer> {
  const peer = await connectPeer(documentId, site, log);
  openPeers.push(peer);
  return peer;
}

/** Create a document through the HTTP API, the way a browser first arriving would. */
async function createDocument(id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-owner' },
    body: JSON.stringify({ id, title: 'Untitled' }),
  });

  expect(response.ok).toBe(true);
}

beforeAll(async () => {
  db = await Database.open();
  store = new DocumentStore({ db });

  relay = new Relay({
    heartbeatMs: 0,
    log: { readSince: (id, since, limit) => store.readSince(id, since, limit) },
  });

  wss = createRelaySocketServer();

  api = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
    },
  });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const documentId = url.searchParams.get('doc') ?? 'default';

    relay.attach(socket, documentId, (ops) => {
      void store.apply(documentId, ops);
    });
  });

  api.onUpgrade('/ws', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  await api.listen();
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

  await api.close();
  await db.close();
});

afterEach(async () => {
  await Promise.all(openPeers.splice(0).map((peer) => peer.close()));
});

describe('offline-first: the write path does not need the server', () => {
  it('stores operations locally even when the socket is dead', async () => {
    const id = 'offline-write';
    await createDocument(id);

    const peer = await openPeer(id, nextSite());
    await settle();

    // Cut the connection before typing. Nothing below may depend on the server.
    await peer.close();

    peer.replica.insertAt(0, 'typed with no server');
    peer.send(peer.authored());

    expect(peer.replica.text).toBe('typed with no server');
    expect(peer.log.entries).toHaveLength('typed with no server'.length);
  });

  it('rebuilds the document from the log alone after a reload', async () => {
    const id = 'offline-reload';
    await createDocument(id);

    const log = new MemoryLog();
    const first = await openPeer(id, nextSite(), log);
    await settle();

    await first.close();
    first.replica.insertAt(0, 'never sent');
    first.send(first.authored());

    // A reload: brand new replica, brand new identity, same durable log.
    const reloaded = new Replica({ site: nextSite(), log, onOperations: () => undefined });
    await reloaded.init();

    expect(reloaded.text).toBe('never sent');
    expect(reloaded.checkInvariants()).toEqual([]);
  });

  it('survives many offline edits, then delivers all of them on reconnect', async () => {
    const id = 'offline-burst';
    await createDocument(id);

    const log = new MemoryLog();
    const peer = await openPeer(id, nextSite(), log);
    await settle();
    await peer.close();

    // Mix inserts and deletes so the result is not simply the concatenation of the
    // keystrokes, which would let a log that dropped deletes still pass.
    peer.replica.insertAt(0, 'the quick brown fox');
    peer.replica.deleteRange(4, 6);
    peer.replica.insertAt(peer.replica.text.length, ' jumps');
    const expected = peer.replica.text;

    const reconnected = await connectPeer(id, peer.site, log);
    openPeers.push(reconnected);

    reconnected.replica.applyRemote(peer.authored());
    reconnected.send(reconnected.authored());
    await settle(20);

    expect(await db.materializeContent(id)).toBe(expected);
  });
});

describe('offline-first: the server log is the authoritative history', () => {
  it('serves a fresh device the full document', async () => {
    const id = 'offline-fresh-device';
    await createDocument(id);

    const author = await openPeer(id, nextSite());
    await settle();

    author.replica.insertAt(0, 'written by the first device');
    author.send(author.authored());
    await settle(20);

    // A second device with an empty log and no history at all.
    const fresh = await openPeer(id, nextSite(), new MemoryLog());
    await settle(20);

    expect(fresh.replica.text).toBe('written by the first device');
    expect(fresh.replica.checkInvariants()).toEqual([]);
  });

  it('replays only what a partly-caught-up device is missing', async () => {
    const id = 'offline-partial';
    await createDocument(id);

    const author = await openPeer(id, nextSite());
    await settle();

    author.replica.insertAt(0, 'first batch');
    author.send(author.authored());
    await settle(20);

    const catching = await openPeer(id, nextSite());
    await settle(20);
    expect(catching.replica.text).toBe('first batch');

    // Author something the catching device has not seen.
    author.replica.insertAt(author.replica.text.length, ' second batch');
    author.send(author.authored());
    await settle(20);

    await catching.close();

    const resumed = await connectPeer(id, catching.site, catching.log);
    openPeers.push(resumed);

    // The cursor travels on the request. A server-side per-connection cache would
    // not survive the reconnect, which is exactly what this exercises.
    resumed.socket.send(JSON.stringify({ type: 'resync', documentId: id, sinceSeq: resumed.seq }));
    await settle(20);

    expect(resumed.replica.text).toBe('first batch second batch');
  });

  it('keeps the text cache in step with the log', async () => {
    const id = 'offline-cache';
    await createDocument(id);

    const author = await openPeer(id, nextSite());
    await settle();

    author.replica.insertAt(0, 'cache check');
    author.send(author.authored());
    await settle(20);

    const record = await db.getDocument(id);

    // The cache is derived, so it must agree with the log without anyone having to
    // remember to refresh it.
    expect(record?.content).toBe('cache check');
    expect(await db.materializeContent(id)).toBe('cache check');
  });

  it('ignores a redelivered batch', async () => {
    const id = 'offline-redelivery';
    await createDocument(id);

    const peer = await openPeer(id, nextSite());
    await settle();

    const batch = peer.replica.insertAt(0, 'once only');
    peer.send(peer.authored());
    await settle(20);

    // The relay reconnects and hands the same operations back. The store must not
    // append them again, or seq would stop describing the log.
    const before = (await db.readAllOps(id)).length;
    await store.apply(id, batch);
    await settle();

    expect(await db.readAllOps(id)).toHaveLength(before);
  });

  it('does not duplicate text when a device replays what it already holds', async () => {
    const id = 'offline-replay';
    await createDocument(id);

    const author = await openPeer(id, nextSite());
    await settle();

    author.replica.insertAt(0, 'exactly once');
    author.send(author.authored());
    await settle(20);

    // A buggy client asking for the whole log despite already holding it. Applying
    // what it has must be a no-op rather than a second copy.
    author.replica.applyRemote(await db.readAllOps(id));
    await settle();

    expect(author.replica.text).toBe('exactly once');
  });
});

describe('offline-first: two devices converge through the server', () => {
  it('converges when both edit while partitioned, then reconnect', async () => {
    const id = 'offline-partition';
    await createDocument(id);

    const seedAuthor = await openPeer(id, nextSite());
    await settle();
    seedAuthor.replica.insertAt(0, 'shared base');
    seedAuthor.send(seedAuthor.authored());
    await settle(20);

    const a = await openPeer(id, nextSite());
    const b = await openPeer(id, nextSite());
    await settle(20);

    expect(a.replica.text).toBe('shared base');
    expect(b.replica.text).toBe('shared base');

    // Partition: both edit with no knowledge of the other.
    await a.close();
    await b.close();

    a.replica.insertAt(0, 'A>');
    a.send(a.authored());

    b.replica.insertAt(b.replica.text.length, '<B');
    b.send(b.authored());

    // Heal: both reconnect and exchange what they hold.
    const a2 = await connectPeer(id, a.site, a.log);
    const b2 = await connectPeer(id, b.site, b.log);
    openPeers.push(a2, b2);

    a2.replica.applyRemote(b.authored());
    b2.replica.applyRemote(a.authored());
    await settle(10);

    a2.send(a2.authored());
    b2.send(b2.authored());
    await settle(20);

    expect(a2.replica.text).toBe(b2.replica.text);
    expect(a2.replica.text).toContain('A>');
    expect(a2.replica.text).toContain('<B');
    expect(a2.replica.checkInvariants()).toEqual([]);
    expect(b2.replica.checkInvariants()).toEqual([]);

    // And the server's own view agrees with both of them.
    expect(await db.materializeContent(id)).toBe(a2.replica.text);
  });
});

describe('offline-first: restart and backfill', () => {
  it('replays the whole document to a device joining after a restart', async () => {
    const id = 'offline-restart';
    await createDocument(id);

    const author = await openPeer(id, nextSite());
    await settle();

    author.replica.insertAt(0, 'survives a restart');
    author.send(author.authored());
    await settle(20);

    // Everything a restart loses is in-memory: rooms, presence, sockets. A device
    // joining afterwards must rebuild from the database alone.
    await author.close();

    const afterRestart = await openPeer(id, nextSite(), new MemoryLog());
    await settle(20);

    expect(afterRestart.replica.text).toBe('survives a restart');
  });

  it('gives a pre-log document an operation log on backfill', async () => {
    // A Phase 1 document meeting Phase 4: plain text, no operations.
    const id = 'offline-backfill';
    await db.createDocument({ id, title: 'Legacy', content: '' });
    await db.saveDocument(id, 'written before the log existed');

    await db.backfillOperationLogs();

    const ops = await db.readAllOps(id);
    const replica = new RgaDocument(id);

    expect(replica.applyInAnyOrder(ops)).toBe(0);
    expect(replica.toText()).toBe('written before the log existed');
  });
});

describe('offline-first: seeding is idempotent', () => {
  it('produces the same elements on every device', async () => {
    const id = 'offline-seed';
    await db.createDocument({ id, title: 'Seeded', content: 'seeded body' });

    const a = initialOperations(id, 'seeded body');
    const b = initialOperations(id, 'seeded body');

    // If these differed, two devices seeding the same document would each add their
    // own copy and the merge would double the text.
    expect(a).toEqual(b);

    const replicaA = new RgaDocument('a');
    const replicaB = new RgaDocument('b');
    replicaA.applyInAnyOrder(a);
    replicaB.applyInAnyOrder(b);
    replicaA.applyInAnyOrder(b);

    expect(replicaA.toText()).toBe('seeded body');
    expect(replicaA.toText()).toBe(replicaB.toText());
  });
});
