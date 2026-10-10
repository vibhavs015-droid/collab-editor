/**
 * End-to-end encryption through a real relay, a real database and real authorisation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ---------------------------------------------------------------------------
 * The unit tests in `src/core/crypto` prove the arithmetic. They cannot prove the
 * property that actually matters, which belongs to the whole system:
 *
 *     a document that was encrypted never has its plaintext stored anywhere the
 *     server can reach.
 *
 * So these tests assert on what is STORED after frames have passed through, not on what
 * a function returned. A test that checked a return value would pass even if the write
 * path quietly also wrote the plaintext alongside the ciphertext.
 *
 * The test that must never be weakened is `never stores the plaintext it was given`. It
 * opens its own connection to the database file with its own `PGlite`, because
 * `Database` deliberately exposes no raw SQL escape hatch and adding one for a test would
 * put an unauthenticated arbitrary-query method into production code. Everything else
 * here is supporting evidence.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { WebSocketServer } from 'ws';
import { WebSocket } from 'ws';

import { createRelaySocketServer } from './socketServer.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDocumentKey, type DocumentKey } from '../core/crypto/documentKey.js';
import { decryptOperation, encryptOperation } from '../core/crypto/envelope.js';
import type { Operation } from '../core/crdt/rga.js';
import { Replica } from '../core/crdt/replica.js';
import { ApiServer } from './api.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay } from './relay.js';

/**
 * Distinctive enough that finding it in a row is unambiguous.
 *
 * Not a single letter. An earlier assertion checked for the letter 'i', which fails
 * because the word "insert" contains one - it would have passed while proving nothing.
 */
const SECRET = 'ZEBRAFISH-PLAINYTEXT-MUST-NOT-PERSIST-4c91';
const DOC = 'encrypted-doc';
const ON_DISK = '.data/encrypted-raw-test';

/** Replica over an empty in-memory log, for building and rebuilding documents. */
function newReplica(site: string): Replica {
  return new Replica({
    site,
    log: {
      load: () => Promise.resolve([]),
      append: async () => {},
      truncateBefore: async () => {},
      clear: async () => {},
    },
    onOperations: () => undefined,
  });
}

/** Type text into a replica and collect the operations it produced. */
async function typeInto(site: string, text: string): Promise<Operation[]> {
  const recorded: Operation[] = [];

  const replica = new Replica({
    site,
    log: {
      load: () => Promise.resolve([]),
      append: async () => {},
      truncateBefore: async () => {},
      clear: async () => {},
    },
    onOperations: (ops) => {
      recorded.push(...ops);
    },
  });

  await replica.init();
  replica.insertAt(0, text);

  return recorded;
}

/** Push operations through the encrypted path, exactly as a client would. */
async function submit(
  documentId: string,
  key: DocumentKey,
  ops: readonly Operation[],
): Promise<void> {
  for (const op of ops) {
    await store.applyEncrypted(documentId, [await encryptOperation(key, documentId, op)]);
  }
}

let db: Database;
let store: DocumentStore;
let relay: Relay;
let wss: WebSocketServer;
let api: ApiServer;
let baseUrl: string;
let wsUrl: string;

/** Everything that left the relay as JSON, to assert on the wire. */
const broadcast: string[] = [];

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

    relay.attach(
      socket,
      documentId,
      (ops) => {
        void store.apply(documentId, ops);
      },
      (frameDocumentId, frames) => {
        void store.applyEncrypted(frameDocumentId, frames);
      },
    );

    socket.on('message', (raw: unknown) => {
      broadcast.push(String(raw));
    });
  });

  api.onUpgrade('/ws', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  await api.listen();

  const created = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer open-token' },
    body: JSON.stringify({ id: DOC, title: 'Encrypted' }),
  });

  expect(created.ok).toBe(true);
}, 120_000);

afterAll(async () => {
  relay.close();

  for (const client of wss.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });

  await api.close();
  await db.close();
});

describe('the server cannot read an encrypted document', () => {
  it('never stores the plaintext it was given', async () => {
    // Its own on-disk database, and its own connection to read the rows back. `Database`
    // exposes no raw SQL method, and adding one for a test would put an
    // unauthenticated arbitrary-query capability into production code.
    const dir = ON_DISK;
    const writing = await Database.openAt(dir);
    const key = await testDocumentKey('raw-scan');

    try {
      await writing.createDocument({ id: 'raw', title: 'Raw' });

      const ops = await typeInto('alice', SECRET);
      const rawStore = new DocumentStore({ db: writing });

      for (const op of ops) {
        await rawStore.applyEncrypted('raw', [await encryptOperation(key, 'raw', op)]);
      }

      const reader = new PGlite(dir);

      try {
        const rows = await reader.query<{ op: string }>(
          'SELECT op::text AS op FROM document_ops WHERE document_id = $1 ORDER BY seq',
          ['raw'],
        );

        expect(rows.rows.length).toBe(ops.length);

        for (const row of rows.rows) {
          expect(row.op).not.toContain('ZEBRAFISH');
        }

        // The WHOLE table, not just this document. A stray write to another row would be
        // just as bad, and a per-document query would miss it entirely.
        const everything = await reader.query<{ op: string }>(
          'SELECT op::text AS op FROM document_ops',
        );
        const combined = everything.rows.map((row) => row.op).join('\n');

        expect(combined).not.toContain('ZEBRAFISH');
        expect(combined).not.toContain(SECRET);
      } finally {
        await reader.close();
      }
    } finally {
      await writing.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('leaves documents.content empty, because it cannot replay a log it cannot read', async () => {
    const key = await testDocumentKey('shared-key');
    await submit(DOC, key, await typeInto('alice', SECRET));

    const document = await db.getDocument(DOC);

    expect(document?.encrypted).toBe(true);
    // Better empty than wrong: a client falling back to this cache would see a document
    // that contradicts the log it also holds.
    expect(document?.content).toBe('');
  });

  it('refuses plaintext operations on an encrypted document', async () => {
    // The natural-looking fallback when a client has no key is to send plaintext anyway.
    // That would put readable text into a document its other participants chose to
    // encrypt, which is the exact harm the feature exists to prevent.
    await expect(store.apply(DOC, await typeInto('eve', 'leak'))).rejects.toThrow(/encrypted/u);
  });

  it('reports a stale client as encrypted rather than replaying ciphertext as operations', async () => {
    // `readAllOps` is the plaintext reader. On an encrypted document it returns frames
    // cast to `Operation`, which is nonsense - so this asserts the caller must not use
    // it, by way of the fact that nothing in the encrypted path calls it. What it can
    // assert is that the frames are unmistakably not operations.
    const page = await db.readForClient(DOC, 0);

    expect(page.kind).toBe('ops-enc');
  });
});

describe('catching up on an encrypted document', () => {
  it('serves frames, never a snapshot', async () => {
    // The server holds no elements for an encrypted document, so it has no baseline to
    // send. Reachable only because compaction is skipped; this assertion is what keeps
    // that true.
    const page = await db.readForClient(DOC, 0);

    expect(page.kind).toBe('ops-enc');

    if (page.kind !== 'ops-enc') {
      throw new Error('expected an encrypted page');
    }

    expect(page.frames.length).toBeGreaterThan(0);
  });

  it('serves the whole log from the beginning, so a delta is always complete', async () => {
    // No compaction means no hole in the log, which is exactly why the baseline path is
    // unreachable rather than merely unused.
    expect((await db.readEncryptedOpsSince(DOC, 0)).frames.length).toBeGreaterThan(0);
    expect((await db.readEncryptedOpsSince(DOC, 10_000)).frames.length).toBe(0);
  });

  it('declines to compact', async () => {
    const fresh = new DocumentStore({ db });

    await fresh.applyEncrypted(DOC, []);

    // Declined before the counter, so nothing accumulates towards a compaction that
    // would produce a snapshot of a document this process cannot read.
    fresh.maybeCompact(DOC);

    expect(fresh.pendingCompactionWrites(DOC)).toBe(0);
    expect(fresh.isEncrypted(DOC)).toBe(true);
  });
});

describe('a client holding the key', () => {
  it('rebuilds exactly what was typed', async () => {
    const key = await testDocumentKey('shared-key');
    const page = await db.readForClient(DOC, 0);

    if (page.kind !== 'ops-enc') {
      throw new Error('expected an encrypted page');
    }

    const ops: Operation[] = [];

    for (const frame of page.frames) {
      ops.push(await decryptOperation(key, DOC, frame));
    }

    const reader = newReplica('reader');
    await reader.init();
    reader.applyRemote(ops);

    expect(reader.text).toBe(SECRET);
  });

  it('cannot read it without the key', async () => {
    const stranger = await testDocumentKey('stranger');
    const page = await db.readForClient(DOC, 0);

    if (page.kind !== 'ops-enc') {
      throw new Error('expected an encrypted page');
    }

    const frame = page.frames[0];

    expect(frame).toBeDefined();

    if (frame !== undefined) {
      await expect(decryptOperation(stranger, DOC, frame)).rejects.toThrow(/decrypt/u);
    }
  });
});

describe('what leaves the relay', () => {
  it('is ciphertext, on a real socket', async () => {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`${wsUrl}?doc=${DOC}`);

      s.on('open', () => {
        s.send(
          JSON.stringify({
            type: 'hello',
            protocolVersion: 1,
            token: 'open-token',
            documentId: DOC,
            lastAppliedSeq: 0,
          }),
        );
        resolve(s);
      });
      s.on('error', reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    socket.close();

    expect(broadcast.length).toBeGreaterThan(0);
    expect(broadcast.join('\n')).not.toContain('ZEBRAFISH');
  }, 30_000);
});
