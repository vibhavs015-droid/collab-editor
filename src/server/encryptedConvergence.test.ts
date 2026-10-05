/**
 * Convergence with every operation encrypted, using the real CRDT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT COVERED BY THE PLAINTEXT CONVERGENCE TEST
 * ---------------------------------------------------------------------------
 * `loadConvergence.test.ts` proves 24 replicas converge when operations travel as
 * plaintext. That says nothing about the encrypted path, and the difference is not
 * cosmetic:
 *
 *   - the operation crosses a serialise/parse round trip as an opaque string, so a
 *     field that `JSON.stringify` drops or renames would be invisible until here
 *   - the frames are DEDUPLICATED ON A CLEARTEXT KEY the client supplied, so a bug that
 *     desynchronises that key from the operation would silently drop or duplicate work
 *   - the AAD binds document, element key, type and site, so a frame that survives
 *     transport but fails authentication would be reported as a corrupt frame rather than
 *     as divergence
 *
 * The server cannot check any of this. `applyEncrypted` has no replica, so it cannot
 * report `unplaced` - the metric a plaintext load test relies on. **For an encrypted
 * document, convergence is a claim only the clients can make.** This file is that claim,
 * tested.
 *
 * Every assertion here uses the real `Replica`, the real relay, the real relay's
 * authorisation, the real durable log and the real store. A hand-written RGA would be a
 * second, separately wrong implementation of the thing under test.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { testDocumentKey, type DocumentKey } from '../core/crypto/documentKey.js';
import { decryptOperations, encryptOperations } from '../core/crypto/envelope.js';
import { Replica, type LoggedOperation, type OperationLog } from '../core/crdt/replica.js';
import type { Operation } from '../core/crdt/rga.js';
import { parseOperations } from '../shared/operation-validation.js';
import { ApiServer } from './api.js';
import { TokenAuthenticator } from './auth.js';
import { Database } from './db.js';
import { DocumentStore } from './documentStore.js';
import { Relay } from './relay.js';

const SECRET = 'encrypted-convergence-secret-long-enough';
const OWNER = 'enc-owner';

/** Replicas contending for one encrypted document. Matches the plaintext test. */
const EDITORS_COUNT = 24;

/** Operations each editor sends. */
const OPS_PER_EDITOR = 40;

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

  truncateBefore(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries = [];
    return Promise.resolve();
  }
}

/** Let queued microtasks and socket I/O drain. */
function settle(turns = 12): Promise<void> {
  let chain = Promise.resolve();

  for (let turn = 0; turn < turns; turn += 1) {
    chain = chain.then(() => new Promise<void>((resolve) => setTimeout(resolve, 4)));
  }

  return chain;
}

/**
 * Wait until every editor holds the same text, or give up.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS POLLS INSTEAD OF SLEEPING A FIXED TIME
 * ---------------------------------------------------------------------------
 * A fixed `settle(40)` produced four failures that looked exactly like convergence bugs:
 * 960 encrypted operations, each one a WebCrypto round trip on both ends, and the last
 * message simply had not arrived yet when the assertion ran.
 *
 * That is the worst kind of test failure - it reports a CRDT bug when the bug is in the
 * test's timing, and a reader has no way to tell the difference without checking the
 * numbers. So the assertion waits for the condition it is asserting, and reports how long
 * it took.
 *
 * Convergence is not "they agree eventually within 160ms", it is "they agree". Polling for
 * it states the real property and removes the false alarm.
 *
 * @returns the agreed text, or throws with the disagreement if it never converges - which
 *   would be a genuine convergence failure.
 */
async function awaitConvergence(editors: readonly Editor[], timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const first = editors[0]?.replica.text ?? '';
    const agreed = editors.every((editor) => editor.replica.text === first);

    if (agreed && first !== '') {
      return first;
    }

    if (Date.now() > deadline) {
      // Report the disagreement rather than a bare timeout, because "they differ" is the
      // finding and the differing text is the evidence.
      const summary = editors
        .map((editor, index) => `${index}:${editor.replica.text.length}`)
        .join(' ');

      throw new Error(
        `Replicas did not converge within ${timeoutMs}ms. Lengths: ${summary}. ` +
          `Editor 0 has ${first.length} characters.`,
      );
    }

    await settle(4);
  }
}

function nextDocumentId(): string {
  counter += 1;
  return `enc-convergence-${counter}`;
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

    relay.attach(
      socket,
      id,
      (ops) => {
        void store.apply(id, ops);
      },
      (frameDocumentId, frames) => {
        void store.applyEncrypted(frameDocumentId, frames);
      },
    );
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
    wss.close(() => resolve());
  });

  await server.close();
  await db.close();
});

interface Editor {
  readonly index: number;
  readonly site: string;
  readonly replica: Replica;
  readonly socket: WebSocket;
  clock: number;
  mine: { site: string; clock: number }[];
  /** Operations that failed to decrypt, which must be zero. */
  decryptFailures: number;
}

/**
 * A value that is unique per editor and round, and a FIXED WIDTH.
 *
 * Two earlier versions were wrong here, in ways worth recording:
 *
 *   - `site.slice(-1)` is not unique across 24 editors: `enc-editor-10` and
 *     `enc-editor-0` both yield `'0'`, so any assertion about a particular character
 *     surviving was checking the wrong element.
 *   - `<index>/<round>` IS unique, but checking it with `String.includes` is still wrong.
 *     The document text is a concatenation of surviving values, so a deleted token `'0/2'`
 *     is found inside the surviving token `'10/2'`. The assertion reported a tombstone
 *     that had been applied correctly as a failure.
 *
 * Fixed width fixes it properly: every element's value is the same length, so the text
 * slices into exact elements and membership becomes a set comparison rather than a
 * substring search. Exact beats clever.
 */
const VALUE_WIDTH = 6;

function valueFor(index: number, round: number): string {
  return `${String(index).padStart(3, '0')}${String(round).padStart(3, '0')}`;
}

/**
 * The document's elements, in order, as a multiset of their values.
 *
 * Asserts the width invariant first, because a value of the wrong length would silently
 * make every subsequent slice read across an element boundary - and produce a confident,
 * wrong answer rather than a failure.
 */
function elementValues(text: string): Set<string> {
  if (text.length % VALUE_WIDTH !== 0) {
    throw new Error(
      `Document text is ${text.length} characters, which is not a whole number of ` +
        `${VALUE_WIDTH}-character elements. An element value is the wrong width, so slicing ` +
        'would read across boundaries and compare the wrong things.',
    );
  }

  const values = new Set<string>();

  for (let offset = 0; offset < text.length; offset += VALUE_WIDTH) {
    values.add(text.slice(offset, offset + VALUE_WIDTH));
  }

  return values;
}

/**
 * Open an editor that speaks only encrypted frames.
 *
 * Note what is absent: there is no plaintext path anywhere. Every operation it sends is
 * encrypted, and every operation it accepts arrives as ciphertext and is decrypted before
 * touching the replica. A test that quietly fell back to plaintext would prove nothing
 * about the encrypted path, so the fallback does not exist.
 */
async function openEncryptedEditor(
  documentId: string,
  index: number,
  token: string,
  key: DocumentKey,
): Promise<Editor> {
  const site = `enc-editor-${index}`;
  const replica = new Replica({ site, log: new MemoryLog(), onOperations: () => undefined });
  await replica.init();

  const port = new URL(baseUrl).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?doc=${encodeURIComponent(documentId)}`);
  const editor: Editor = {
    index,
    site,
    replica,
    socket,
    clock: 0,
    mine: [],
    decryptFailures: 0,
  };

  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString('utf8')) as {
      type: string;
      ops?: unknown;
      frames?: readonly never[];
    };

    if (message.type === 'ops') {
      // A plaintext batch on an encrypted document would be a real bug, so it is counted
      // rather than ignored. Silently accepting it would let a mixed-mode regression pass.
      throw new Error('a plaintext ops batch arrived on an encrypted document');
    }

    if (message.type === 'ops-enc') {
      void decryptOperations(key, documentId, message.frames ?? []).then(
        (ops) => replica.applyRemote(ops),
        () => {
          editor.decryptFailures += 1;
        },
      );
    }
  });

  socket.on('error', () => {
    // Expected when the server closes first.
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
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

  return editor;
}

/**
 * Apply operations locally, then encrypt and send them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOCAL APPLY IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * The relay deliberately does NOT echo a message back to the socket that sent it: the
 * sender already has those operations, and re-delivering them would be waste at best.
 *
 * So an editor that only SENDS never receives its own work back, and ends up one
 * editor's worth short. That is not a convergence bug - it is a harness that forgot the
 * client applies locally and relays the same operations, which is what `SyncTransport`
 * and `EditorBinding` do in the real application.
 *
 * Diagnosed by diffing two replicas rather than reading the code: every replica had the
 * same LENGTH but different CONTENT, and the differing elements were exactly one editor's
 * set in each. Same length, different set - which is the signature of a missing delivery
 * rather than a misordered one.
 */
async function emit(
  editor: Editor,
  documentId: string,
  key: DocumentKey,
  ops: readonly Operation[],
): Promise<void> {
  // Applied first, exactly as the real client does: the edit lands in the document the
  // user is looking at, and only then goes to the wire.
  editor.replica.applyRemote(ops);

  const frames = await encryptOperations(key, documentId, ops);

  editor.socket.send(JSON.stringify({ type: 'ops-enc', documentId, frames }));
}

describe('convergence with every operation encrypted', () => {
  it('reaches the same document in every replica', async () => {
    const documentId = nextDocumentId();
    const key = await testDocumentKey('convergence');

    await db.createDocument({ id: documentId, owner: OWNER });

    // One await, not two. The first version read
    //   await (await issue()).token
    // which awaits a string, and ESLint's `await-thenable` was right to complain: the
    // outer await did nothing and only obscured what was being awaited.
    const token = (await new TokenAuthenticator({ secret: SECRET }).issue(OWNER)).token;

    const editors: Editor[] = [];

    for (let index = 0; index < EDITORS_COUNT; index += 1) {
      editors.push(await openEncryptedEditor(documentId, index, token, key));
    }

    // Everyone inserts at the head at the same instant. `origin: null` needs no knowledge
    // of what is already in the document, which is what makes 24 simultaneous writers
    // possible without any of them understanding RGA integration.
    for (let round = 0; round < OPS_PER_EDITOR; round += 1) {
      for (const editor of editors) {
        editor.clock += 1;

        const op: Operation = {
          type: 'insert',
          id: { site: editor.site, clock: editor.clock },
          origin: null,
          value: valueFor(editor.index, round),
        };

        editor.mine.push({ site: editor.site, clock: editor.clock });
        await emit(editor, documentId, key, [op]);
      }
    }

    // Every replica identical. This is the claim, and for an encrypted document it is
    // one ONLY the clients can make: the server has no replica and reports no `unplaced`.
    const first = await awaitConvergence(editors);

    expect(first.length).toBeGreaterThan(0);

    // Nothing failed to decrypt. A non-zero count means the transport altered a frame,
    // which would show up as divergence but is a different and more specific fault.
    for (const [index, editor] of editors.entries()) {
      expect(editor.decryptFailures, `editor ${index} could not decrypt`).toBe(0);
    }

    for (const editor of editors) {
      editor.socket.close();
    }
  }, 180_000);

  it('applies deletes that arrive BEFORE the inserts they name', async () => {
    // -----------------------------------------------------------------------
    // WHAT THE FIRST VERSION OF THIS TEST ACTUALLY DID
    // -----------------------------------------------------------------------
    // It inserted everything, called `settle(24)`, and only then deleted. So no delete
    // ever raced anything: by the time each one was sent, its target had long since landed
    // everywhere. The test was named "deletes contending against inserts" and contained no
    // contention.
    //
    // It also asserted `length < EDITORS_COUNT * 10`, which failed with 460 against a
    // threshold of 240. The 460 was CORRECT: the old target expression
    // `(round + 1) % editors.length` maps rounds 0-9 onto editors 1-10 and skips rounds
    // 10-19 because `mine[round]` does not exist, so exactly 10 of 240 elements were ever
    // deleted. The assertion was guessing at a number the test had not computed.
    //
    // Both problems have the same root cause: the assertion was written to describe the
    // intent rather than the arithmetic. This version derives its expectation from what it
    // actually sends.
    const documentId = nextDocumentId();
    const key = await testDocumentKey('divergence');

    await db.createDocument({ id: documentId, owner: OWNER });

    // One await, not two. The first version read
    //   await (await issue()).token
    // which awaits a string, and ESLint's `await-thenable` was right to complain: the
    // outer await did nothing and only obscured what was being awaited.
    const token = (await new TokenAuthenticator({ secret: SECRET }).issue(OWNER)).token;

    const editors: Editor[] = [];

    for (let index = 0; index < EDITORS_COUNT; index += 1) {
      editors.push(await openEncryptedEditor(documentId, index, token, key));
    }

    const rounds = OPS_PER_EDITOR;

    /** Element every editor creates at a given round. Keyed before it exists. */
    const elementAt = (index: number, round: number): { site: string; clock: number } => ({
      site: `enc-editor-${index}`,
      clock: round + 1,
    });

    /** Rounds whose elements get deleted. Half of them, so survivors are provable. */
    const doomed = new Set<number>();

    for (let round = 0; round < rounds; round += 1) {
      for (const editor of editors) {
        // The delete goes FIRST, naming an element that has not been created yet by
        // anyone - not even locally. This is the case that needs care in an RGA: the
        // tombstone has to be remembered until the insert arrives.
        //
        // Two editors target the same element, so duplicate deletes contend as well.
        const victims =
          round % 2 === 0
            ? [(editor.index + 1) % EDITORS_COUNT, (editor.index + 2) % EDITORS_COUNT]
            : [];

        for (const victim of victims) {
          doomed.add(victim * 1000 + round);

          await emit(editor, documentId, key, [
            { type: 'delete', target: elementAt(victim, round) },
          ]);
        }

        editor.clock += 1;
        editor.mine.push({ site: editor.site, clock: editor.clock });

        await emit(editor, documentId, key, [
          {
            type: 'insert',
            id: { site: editor.site, clock: editor.clock },
            origin: null,
            value: valueFor(editor.index, round),
          },
        ]);
      }
    }

    const first = await awaitConvergence(editors);

    // -----------------------------------------------------------------------
    // THE ASSERTION, COMPUTED RATHER THAN GUESSED
    // -----------------------------------------------------------------------
    // Every value identifies exactly one (editor, round) pair, so the surviving set is
    // computable and can be compared exactly.
    const expected = new Set<string>();

    for (let index = 0; index < EDITORS_COUNT; index += 1) {
      for (let round = 0; round < rounds; round += 1) {
        if (!doomed.has(index * 1000 + round)) {
          expected.add(valueFor(index, round));
        }
      }
    }

    const actual = elementValues(first);

    // Exact set equality: every survivor present, and nothing else. Written as two
    // directions rather than `expect(actual).toEqual(expected)` because Set comparison in
    // vitest prints as `[Set]` and says nothing about WHICH element differs - which is the
    // only thing a reader needs when this fails.
    for (const value of expected) {
      expect(actual.has(value), `${value} should have survived`).toBe(true);
    }

    for (const value of actual) {
      expect(expected.has(value), `${value} should have been deleted`).toBe(true);
    }

    // Both halves of the behaviour are observable. An empty document is what a decryption
    // failure produces, and would satisfy "nothing doomed survived" on its own.
    expect(expected.size).toBeGreaterThan(0);
    expect(doomed.size).toBeGreaterThan(0);
    expect(first.length).toBe(expected.size * VALUE_WIDTH);

    for (const [index, editor] of editors.entries()) {
      expect(editor.decryptFailures, `editor ${index} could not decrypt`).toBe(0);
    }

    for (const editor of editors) {
      editor.socket.close();
    }
  }, 180_000);

  it('gives every replica the same answer from the stored log alone', async () => {
    // Rebuild from what the SERVER holds, rather than from what the sockets delivered.
    //
    // This is the check that matters most for the encrypted path, and it is strictly
    // stronger than the ones above: it says the relay, the store, the durable log and the
    // dedupe key all agree, because every replica is built from one source.
    const documentId = nextDocumentId();
    const key = await testDocumentKey('rebuild');

    await db.createDocument({ id: documentId, owner: OWNER });

    // One await, not two. The first version read
    //   await (await issue()).token
    // which awaits a string, and ESLint's `await-thenable` was right to complain: the
    // outer await did nothing and only obscured what was being awaited.
    const token = (await new TokenAuthenticator({ secret: SECRET }).issue(OWNER)).token;

    const editors: Editor[] = [];

    for (let index = 0; index < 6; index += 1) {
      editors.push(await openEncryptedEditor(documentId, index, token, key));
    }

    for (let round = 0; round < 15; round += 1) {
      for (const editor of editors) {
        editor.clock += 1;
        editor.mine.push({ site: editor.site, clock: editor.clock });

        await emit(editor, documentId, key, [
          {
            type: 'insert',
            id: { site: editor.site, clock: editor.clock },
            origin: null,
            value: valueFor(editor.index, round),
          },
        ]);
      }
    }

    // Everything the server kept, in order. This waits rather than sleeping, because the
    // count below is the assertion and a short count is the failure mode.
    await awaitConvergence(editors);

    const stored = await db.readEncryptedOpsSince(documentId, 0);
    const operations = await decryptOperations(key, documentId, stored.frames);

    expect(operations.length).toBe(editors.length * 15);

    const rebuilt = new Replica({
      site: 'rebuild',
      log: new MemoryLog(),
      onOperations: () => undefined,
    });

    await rebuilt.init();
    rebuilt.applyRemote(operations);

    for (const [index, editor] of editors.entries()) {
      expect(rebuilt.text, `rebuild disagrees with replica ${index}`).toBe(editor.replica.text);
    }

    for (const editor of editors) {
      editor.socket.close();
    }
  }, 120_000);

  it('keeps element keys unique, so dedupe never drops a live operation', async () => {
    // The dedupe key is supplied by the CLIENT here rather than derived by the server.
    // If `elementKeyOf` and the server's key format ever disagreed, an insert would be
    // stored as a duplicate of a delete and the character would survive its own deletion -
    // a silent data-loss bug with no error anywhere.
    const documentId = nextDocumentId();
    const key = await testDocumentKey('dedupe');

    await db.createDocument({ id: documentId, owner: OWNER });

    // One await, not two. The first version read
    //   await (await issue()).token
    // which awaits a string, and ESLint's `await-thenable` was right to complain: the
    // outer await did nothing and only obscured what was being awaited.
    const token = (await new TokenAuthenticator({ secret: SECRET }).issue(OWNER)).token;

    const editor = await openEncryptedEditor(documentId, 0, token, key);

    const inserts: Operation[] = [];

    for (let clock = 1; clock <= 20; clock += 1) {
      inserts.push({
        type: 'insert',
        id: { site: editor.site, clock },
        origin: clock === 1 ? null : { site: editor.site, clock: clock - 1 },
        value: String(clock),
      });
    }

    await emit(editor, documentId, key, inserts);
    await settle(12);

    // All twenty survived. A dedupe collision would show up as fewer.
    expect((await db.readEncryptedOpsSince(documentId, 0)).frames).toHaveLength(20);

    // And the deletes are distinct from the inserts of the same element, which is the
    // other half of the reason the type is part of the key.
    const deletes: Operation[] = inserts.slice(0, 5).map((op) => ({
      type: 'delete',
      target: op.type === 'insert' ? op.id : { site: '', clock: 0 },
    }));

    await emit(editor, documentId, key, deletes);
    await settle(12);

    expect((await db.readEncryptedOpsSince(documentId, 0)).frames).toHaveLength(25);

    editor.socket.close();
  }, 120_000);

  it('refuses a plaintext operation on a document that is encrypted', async () => {
    // The mode guard. Without it, a client without the key would fall back to plaintext
    // and put readable text into a document its participants chose to encrypt.
    const documentId = nextDocumentId();
    const key = await testDocumentKey('guard');

    await db.createDocument({ id: documentId, owner: OWNER });

    // One await, not two. The first version read
    //   await (await issue()).token
    // which awaits a string, and ESLint's `await-thenable` was right to complain: the
    // outer await did nothing and only obscured what was being awaited.
    const token = (await new TokenAuthenticator({ secret: SECRET }).issue(OWNER)).token;

    const editor = await openEncryptedEditor(documentId, 0, token, key);

    editor.clock += 1;
    await emit(editor, documentId, key, [
      {
        type: 'insert',
        id: { site: editor.site, clock: editor.clock },
        origin: null,
        value: 'x',
      },
    ]);
    await settle(10);

    expect((await db.getDocument(documentId))?.encrypted).toBe(true);

    // parseOperations is the real narrowing the plaintext path would use, so the value
    // offered here is exactly what a well-behaved non-encrypting client would send.
    const plaintext = parseOperations([
      { type: 'insert', id: { site: 'mallory', clock: 1 }, origin: null, value: 'leak' },
    ] as never);

    await expect(store.apply(documentId, plaintext)).rejects.toThrow(/encrypted/u);

    editor.socket.close();
  }, 120_000);
});
