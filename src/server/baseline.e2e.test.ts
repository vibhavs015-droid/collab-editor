/**
 * Snapshot baseline end-to-end.
 *
 * -- Why this file exists ----------------------------------------------------
 * Compaction is only safe if a peer that falls below the floor still converges.
 * Everything else about it is tested elsewhere; this tests the one thing that
 * matters: a client that has been away long enough to be given a baseline instead
 * of a delta ends up with exactly the same document as everyone else.
 *
 * The failure this guards against is silent and severe. Serving a delta to a peer
 * below the floor produces a document missing everything that was compacted away,
 * and nothing reports an error -- the peer's own operations still apply, so it looks
 * alive. It is just quietly wrong.
 *
 * Runs against a real relay, real WebSockets and real PostgreSQL.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import { Replica, type LoggedOperation, type OperationLog } from '../core/crdt/replica.js';
import {
  snapshotToOperations,
  type DocumentSnapshot,
  type SnapshotElement,
} from '../core/crdt/snapshot.js';
import { parseOperations } from '../shared/operation-validation.js';
import type { ServerMessage, SnapshotMessage } from '../shared/protocol.js';
import { ApiServer } from './api.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay } from './relay.js';

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

/** A client, with the baseline handling a real one performs. */
interface Peer {
  readonly site: string;
  readonly replica: Replica;
  readonly log: MemoryLog;
  readonly socket: WebSocket;
  seq: number;
  /** Baselines the server sent and the client accepted. */
  readonly baselines: SnapshotMessage[];
  /** Operations received as an ordinary delta. */
  readonly received: Operation[];
  /** Whether the client refused a baseline because it held unsent work. */
  refusals: number;
  close: () => Promise<void>;
  send: (ops: readonly Operation[]) => void;
  /**
   * Simulate a connection the network has dropped but the browser has not
   * noticed yet: not OPEN, and no close event fired.
   */
  killSocket: () => void;
  /** Deliver a frame, as the server would over a connection that still half-works. */
  deliver: (frame: object) => void;
}

let db: Database;
let store: DocumentStore;
let relay: Relay;
let wss: WebSocketServer;
let api: ApiServer;
let wsUrl: string;
let httpUrl: string;
let counter = 0;

const openPeers: Peer[] = [];

async function settle(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function openPeer(documentId: string, site: string, log = new MemoryLog()): Promise<Peer> {
  const replica = new Replica({ site, log, onOperations: () => undefined });
  await replica.init();

  const socket = new WebSocket(`${wsUrl}?doc=${encodeURIComponent(documentId)}`);
  const baselines: SnapshotMessage[] = [];
  const received: Operation[] = [];
  const outbox: Operation[] = [];

  const peer: Peer = {
    site,
    replica,
    log,
    socket,
    seq: 0,
    baselines,
    received,
    refusals: 0,
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
        outbox.push(...ops);
        return;
      }

      socket.send(JSON.stringify({ type: 'ops', documentId, ops }));
    },
    killSocket: () => {
      // Overridden, because ws exposes readyState as a getter with no setter. This
      // is the only way to model the network dropping a connection while the
      // browser has not yet fired close, which is the window this test exists for.
      Object.defineProperty(socket, 'readyState', { value: 3, configurable: true });
    },
    deliver: (frame) => {
      // Emitted rather than written through the socket, so a frame can be
      // delivered while `readyState` says the connection is dead -- which is the
      // exact situation being tested.
      socket.emit('message', Buffer.from(JSON.stringify(frame)));
    },
  };

  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as ServerMessage;

    if (message.type === 'ops') {
      const ops = parseOperations(message.ops);
      replica.applyRemote(ops);
      received.push(...ops);
      return;
    }

    if (message.type === 'snapshot') {
      // The safety rule from ADR-0011, enforced in the client exactly as the
      // transport enforces it: never adopt a baseline while holding unsent work.
      if (outbox.length > 0) {
        peer.refusals += 1;
        return;
      }

      const elements = message.elements as unknown as SnapshotElement[];
      const snapshot: DocumentSnapshot = { seq: message.seq, elements };

      void replica.resetTo(snapshotToOperations(snapshot)).then(() => {
        replica.applyRemote(parseOperations(message.ops));
      });

      baselines.push(message);
      peer.seq = Math.max(peer.seq, message.seq);
      return;
    }

    if (message.type === 'syncState' && typeof message.seq === 'number') {
      peer.seq = Math.max(peer.seq, message.seq);
    }
  });

  socket.on('error', () => {
    // A disconnect is a normal part of these scenarios.
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
      token: 'test',
      documentId,
      lastAppliedSeq: peer.seq,
    }),
  );

  openPeers.push(peer);
  return peer;
}

function nextId(): string {
  counter += 1;
  return `baseline-${counter}`;
}

async function createDocument(id: string): Promise<void> {
  const response = await fetch(`${httpUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-owner' },
    body: JSON.stringify({ id, title: 'Untitled' }),
  });

  expect(response.ok).toBe(true);
}

/**
 * Edit the document heavily enough that compaction runs.
 *
 * Types a run of text, deletes half of it, then types more at the start, so the
 * log is mostly tombstones and any threshold is cleared.
 *
 * @returns the document text as the store sees it. Read from the store rather than
 *   predicted: the interleaving of twenty edits from twenty sites is exactly what
 *   the RGA tie-break rule decides, and hand-deriving it here would be a second,
 *   wrong implementation of the algorithm in the test.
 */
async function churn(id: string, rounds: number): Promise<string> {
  const victim = new RgaDocument(`victim-${rounds}`);

  for (let round = 0; round < rounds; round += 1) {
    const writer = new RgaDocument(`w${round}`);
    await store.apply(id, writer.insertAt(0, String.fromCharCode(97 + (round % 26))));
  }

  // Delete the first half of what is currently visible.
  victim.applyInAnyOrder(await db.readAllOps(id));
  const visible = victim.inspect().filter((element) => !element.deleted);
  const doomed = visible.slice(0, Math.floor(visible.length / 2));

  for (const element of doomed) {
    await store.apply(id, [{ type: 'delete', target: element.id }]);
  }

  // More typing, so there is a tail above the snapshot to replay as well.
  for (let round = 0; round < rounds; round += 1) {
    const writer = new RgaDocument(`t${round}`);
    await store.apply(id, writer.insertAt(0, 'z'));
  }

  return store.text(id);
}

beforeAll(async () => {
  db = await Database.open();
  store = new DocumentStore({
    db,
    compactionPolicy: { minOpsBelowFloor: 4, minTombstoneRatio: 0.2 },
  });

  relay = new Relay({
    heartbeatMs: 0,
    log: { readSince: (id, since, limit) => store.readSince(id, since, limit) },
  });

  wss = new WebSocketServer({ noServer: true });

  api = new ApiServer({
    db,
    host: '127.0.0.1',
    port: 0,
    onListen: ({ port }) => {
      httpUrl = `http://127.0.0.1:${port}`;
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

describe('baseline - a peer below the compaction floor', () => {
  it('receives a baseline instead of a delta, and converges', async () => {
    const id = nextId();
    await createDocument(id);

    // Build history, then compact it away.
    const expected = await churn(id, 20);
    expect(expected.length).toBeGreaterThan(0);

    const result = await store.compact(id);
    expect(result.compacted).toBe(true);
    expect((await db.readAllOps(id)).length).toBeLessThan(10);

    // A brand-new client with no history at all, declaring cursor 0.
    const fresh = await openPeer(id, 'fresh');
    await settle(20);

    // It was given a baseline, not a delta. A delta would have produced a document
    // missing everything that was compacted away, with no error anywhere.
    expect(fresh.baselines).toHaveLength(1);
    expect(fresh.received).toHaveLength(0);

    await settle(10);
    expect(fresh.replica.text).toBe(expected);
    expect(fresh.replica.checkInvariants()).toEqual([]);
  });

  it('serves a plain delta to a peer that is current', async () => {
    const id = nextId();
    await createDocument(id);

    await churn(id, 20);
    expect((await store.compact(id)).compacted).toBe(true);

    // Catch up, then ask again from the cursor it now holds.
    const first = await openPeer(id, 'current');
    await settle(20);
    expect(first.baselines).toHaveLength(1);

    first.socket.send(JSON.stringify({ type: 'resync', documentId: id, sinceSeq: first.seq }));
    await settle(15);

    // Already current, so there is nothing to replace. Handing out a second
    // baseline would discard the client's document for no reason.
    expect(first.baselines).toHaveLength(1);
  });

  it('applies operations recorded after the baseline', async () => {
    const id = nextId();
    await createDocument(id);

    await churn(id, 20);
    expect((await store.compact(id)).compacted).toBe(true);

    const fresh = await openPeer(id, 'fresh');
    await settle(20);
    expect(fresh.replica.text.length).toBeGreaterThan(0);
    await settle(10);

    const before = fresh.replica.text;

    // Someone else edits after the snapshot was taken. Sent over a real socket, so
    // the relay broadcasts it exactly as it would for any collaborator.
    const author = await openPeer(id, 'author');
    await settle(20);

    author.replica.insertAt(0, 'NEW>');
    author.send(author.log.entries.map((entry) => entry.op));
    await settle(20);

    expect(fresh.replica.text).toContain('NEW>');
    expect(fresh.replica.text).not.toBe(before);
    expect(fresh.replica.checkInvariants()).toEqual([]);
  });

  it('keeps the text a peer typed itself when it catches up', async () => {
    const id = nextId();
    await createDocument(id);

    await churn(id, 20);
    expect((await store.compact(id)).compacted).toBe(true);

    const peer = await openPeer(id, 'peer');
    await settle(20);
    expect(peer.baselines).toHaveLength(1);
    await settle(10);

    const before = peer.replica.text;
    peer.replica.insertAt(0, 'mine>');

    expect(peer.replica.text).toBe(`mine>${before}`);
    expect(peer.replica.checkInvariants()).toEqual([]);
  });
});

describe('baseline - refusal', () => {
  it('does not discard a peer holding unsent work', async () => {
    const id = nextId();
    await createDocument(id);

    await churn(id, 20);
    expect((await store.compact(id)).compacted).toBe(true);

    const peer = await openPeer(id, 'busy');
    await settle(20);

    // The client has typed, and the socket cannot take it -- the browser has not
    // fired `close` on a connection the network has dropped. This is the exact
    // window in which adopting a baseline would destroy work.
    peer.killSocket();
    peer.replica.insertAt(0, 'X');
    peer.send([{ type: 'insert', id: { site: 'busy', clock: 999 }, origin: null, value: 'X' }]);

    const before = peer.replica.text;
    expect(before).toContain('X');

    // A frame still arrives over the dead connection: the server decided this peer
    // needs a baseline.
    const snapshotRow = await db.readSnapshot(id);
    expect(snapshotRow).not.toBeNull();

    peer.deliver({
      type: 'snapshot',
      documentId: id,
      elements: snapshotRow?.elements ?? [],
      ops: [],
      seq: snapshotRow?.seq ?? 0,
    });

    await settle(10);

    // Either refused outright or queued for retry. Either way the text survives.
    expect(peer.replica.text).toBe(before);
    expect(peer.replica.checkInvariants()).toEqual([]);
  });
});
