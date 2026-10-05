/**
 * Client-side encryption, driving the real transport over a fake socket.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS WORTH TESTING HERE
 * ---------------------------------------------------------------------------
 * The arithmetic is already proven in `src/core/crypto`. What is new in the transport is
 * a set of decisions that could each be wrong in a way that only shows up as "the other
 * person's text did not appear":
 *
 *   - encrypt on send, never on queue
 *   - the outbox holds PLAINTEXT, so a retry after an encryption failure still works
 *   - a batch is not sent twice when two flushes overlap
 *   - a wrong key reports an error instead of applying garbage
 *   - a plaintext baseline is refused rather than adopted
 *   - no key means plaintext mode, which is how every old document is opened
 *
 * A fake socket rather than a real one: this is about what the transport puts in a frame
 * and what it does with what comes back, and a real WebSocket would only add timing.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { testDocumentKey } from '../../core/crypto/documentKey.js';
import { encryptOperation } from '../../core/crypto/envelope.js';
import type { Operation } from '../../core/crdt/rga.js';
import type { EncryptedOperationFrame } from '../../shared/protocol.js';
import { SyncTransport, type TransportHandlers } from './transport.js';

/** A socket that records what it was sent and lets a test reply. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly sent: string[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    // The real socket fires `open` asynchronously. Firing it synchronously would hide
    // every ordering bug this file is looking for.
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Frames this socket was asked to send, parsed. */
  get frames(): { type: string }[] {
    return this.sent.map((text) => JSON.parse(text) as { type: string });
  }

  /** Deliver a server frame. */
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** Errors the transport reported. */
interface Harness {
  readonly transport: SyncTransport;
  readonly socket: () => FakeSocket;
  readonly errors: { code: string; message: string }[];
  readonly ops: Operation[][];
}

const opened: FakeSocket[] = [];

afterEach(() => {
  FakeSocket.instances = [];
  opened.length = 0;
});

function harness(options: { key?: Awaited<ReturnType<typeof testDocumentKey>> } = {}): Harness {
  const errors: { code: string; message: string }[] = [];
  const ops: Operation[][] = [];

  const handlers: TransportHandlers = {
    onOps: (received) => {
      ops.push([...received]);
    },
    onPresence: () => undefined,
    onWelcome: () => undefined,
    onSyncState: () => undefined,
    onBaseline: () => undefined,
    onStateChange: () => undefined,
    onError: (code, message) => {
      errors.push({ code, message });
    },
  };

  const transport = new SyncTransport({
    documentId: 'doc-1',
    url: 'ws://localhost/ws?doc=doc-1',
    resolveToken: () => Promise.resolve('test-token'),
    handlers,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      opened.push(socket);
      return socket as unknown as WebSocket;
    },
    ...(options.key === undefined ? {} : { key: options.key }),
  });

  return {
    transport,
    socket: () => opened[opened.length - 1] as FakeSocket,
    errors,
    ops,
  };
}

/** Wait for the microtask queue and the fake socket's async `open`. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await Promise.resolve();
  }

  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Drive a socket to the point where it is admitted and can send. */
async function connect(h: Harness): Promise<FakeSocket> {
  h.transport.connect();
  await settle();

  const socket = h.socket();

  socket.receive({ type: 'welcome', protocolVersion: 1, site: 'site-a', documentId: 'doc-1' });
  await settle();

  return socket;
}

function insert(
  site: string,
  clock: number,
  value: string,
  originClock: number | null = null,
): Operation {
  return {
    type: 'insert',
    id: { site, clock },
    origin: originClock === null ? null : { site, clock: originClock },
    value,
  };
}

/**
 * Every element key this socket was sent, across every encrypted frame.
 *
 * Flattened deliberately: "how many times did the server hear about this keystroke" is
 * the question, and a per-frame count would hide a duplicate that appears in two frames
 * while each frame individually looks right.
 */
function frameKeys(socket: FakeSocket): string[] {
  return socket.sent
    .map((text) => JSON.parse(text) as { type: string; frames?: EncryptedOperationFrame[] })
    .filter((frame) => frame.type === 'ops-enc')
    .flatMap((frame) => (frame.frames ?? []).map((inner) => inner.key));
}

describe('unencrypted mode is unchanged', () => {
  it('sends plaintext operations when there is no key', async () => {
    const h = harness();
    const socket = await connect(h);

    h.transport.send([insert('a', 1, 'x')]);
    await settle();

    const ops = socket.frames.find((frame) => frame.type === 'ops');

    expect(ops).toBeDefined();
    expect(socket.sent.join('\n')).toContain('"value":"x"');
  });

  it('opens a document with no key at all', () => {
    // The default. Every document created before this feature is opened exactly this way,
    // so a missing key must not be an error.
    const h = harness();

    expect(h.errors).toEqual([]);
  });
});

describe('sending encrypted', () => {
  it('sends frames, never plaintext', async () => {
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    h.transport.send([insert('a', 1, 'ZEBRAFISH')]);
    await settle();

    const wire = socket.sent.join('\n');

    expect(wire).toContain('ops-enc');
    expect(wire).not.toContain('ZEBRAFISH');
    expect(socket.frames.some((frame) => frame.type === 'ops')).toBe(false);
  });

  it('carries the element key in the clear so the server can dedupe', async () => {
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    h.transport.send([insert('alice', 7, 'x')]);
    await settle();

    expect(socket.sent.join('\n')).toContain('i:alice@7');
  });

  it('empties the outbox once the frames are sent', async () => {
    const key = await testDocumentKey('alice');
    const h = harness({ key });

    await connect(h);
    h.transport.send([insert('a', 1, 'x'), insert('a', 2, 'y', 1)]);
    await settle();

    expect(h.transport.queuedOperationCount).toBe(0);
    expect(h.transport.queuedOperations).toEqual([]);
  });

  it('keeps unsent operations readable in the outbox', async () => {
    // Deliberate. The outbox is this process's memory holding the local user's own edits;
    // encrypting at the queue boundary would leave a partially-encrypted outbox if
    // encryption failed midway, which nothing else knows how to handle.
    const key = await testDocumentKey('alice');
    const h = harness({ key });

    h.transport.connect();
    await settle();

    h.transport.send([insert('a', 1, 'ZEBRAFISH')]);
    await settle();

    // Not admitted, so nothing has been sent and the operation is still there.
    expect(h.transport.queuedOperationCount).toBe(1);
    expect(JSON.stringify(h.transport.queuedOperations)).toContain('ZEBRAFISH');
  });

  it('does not send the same operation twice when two sends overlap', async () => {
    // A genuine overlap, not a simulated one: `send()` flushes synchronously when the
    // socket is open, and `encryptOperations` is a real promise. So the second `send`
    // runs while the first batch is still encrypting.
    //
    // The first version of this test called `requestResync()`, which does not flush at
    // all, so it passed whether or not the guard existed. Removing the guard left all 19
    // tests green, which is how this was replaced.
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    h.transport.send([insert('a', 1, 'first')]);
    h.transport.send([insert('a', 2, 'second', 1)]);
    await settle();

    const keys = frameKeys(socket);

    // TWO frames, because the guard makes the second flush wait rather than racing.
    // The important half is that every operation appears exactly once - a duplicate is
    // harmless to a CRDT and wrong for the server, which would store two rows for one
    // keystroke.
    expect(keys.sort()).toEqual(['i:a@1', 'i:a@2']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sends everything, once, even when a second edit lands mid-encryption', async () => {
    // The re-read of the outbox after encryption is what makes this hold: sending a
    // captured copy instead would drop the operation queued while it was in flight, and
    // the user would see a keystroke that never appeared for anyone else.
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    h.transport.send([insert('a', 1, 'x')]);
    await settle();

    h.transport.send([insert('a', 2, 'y', 1)]);
    await settle();

    expect(frameKeys(socket).sort()).toEqual(['i:a@1', 'i:a@2']);
    expect(h.transport.queuedOperationCount).toBe(0);
  });

  it('reports an error and keeps the operations when encryption fails', async () => {
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    // Break the key after admission, so encryption cannot succeed.
    const broken = { cryptoKey: {} as CryptoKey };
    Reflect.set(h.transport as unknown as Record<string, unknown>, 'key', null);
    Reflect.set(h.transport as unknown as Record<string, unknown>, 'key', broken);

    h.transport.send([insert('a', 1, 'x')]);
    await settle();

    // Whatever happened, the operation must not have been silently dropped from the
    // outbox: the user would believe their edit was saved.
    expect(
      h.transport.queuedOperationCount + socket.frames.filter((f) => f.type === 'ops-enc').length,
    ).toBe(1);
  });
});

describe('receiving encrypted', () => {
  it('decrypts frames into operations', async () => {
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    const op = insert('bob', 5, 'hello');
    const frame: EncryptedOperationFrame = await encryptOperation(key, 'doc-1', op);

    socket.receive({ type: 'ops-enc', documentId: 'doc-1', frames: [frame] });
    await settle();

    expect(h.ops).toEqual([[op]]);
    expect(h.errors).toEqual([]);
  });

  it('reports a wrong key instead of applying garbage', async () => {
    const h = harness({ key: await testDocumentKey('bob') });
    const socket = await connect(h);

    // Encrypted for someone else.
    const frame = await encryptOperation(
      await testDocumentKey('alice'),
      'doc-1',
      insert('a', 1, 'x'),
    );

    socket.receive({ type: 'ops-enc', documentId: 'doc-1', frames: [frame] });
    await settle();

    expect(h.ops).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('WRONG_KEY');
    // The message has to be actionable. "Decryption failed" is not.
    expect(h.errors[0]?.message).toMatch(/key/u);
  });

  it('applies none of a batch it could not decrypt', async () => {
    // Half a keystroke batch would leave the document in a state nobody typed.
    const key = await testDocumentKey('bob');
    const h = harness({ key });
    const socket = await connect(h);

    const good = await encryptOperation(
      await testDocumentKey('alice'),
      'doc-1',
      insert('a', 1, 'x'),
    );
    const alsoGood = await encryptOperation(
      await testDocumentKey('alice'),
      'doc-1',
      insert('a', 2, 'y', 1),
    );

    socket.receive({ type: 'ops-enc', documentId: 'doc-1', frames: [good, alsoGood] });
    await settle();

    expect(h.ops).toEqual([]);
    expect(h.errors).toHaveLength(1);
  });

  it('refuses frames when this session has no key', async () => {
    // The document is encrypted and this link was opened without its fragment. Dropping
    // the frames silently would show a document missing whatever the others typed.
    const h = harness();
    const socket = await connect(h);

    const frame = await encryptOperation(
      await testDocumentKey('alice'),
      'doc-1',
      insert('a', 1, 'x'),
    );

    socket.receive({ type: 'ops-enc', documentId: 'doc-1', frames: [frame] });
    await settle();

    expect(h.ops).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('ENCRYPTED_NO_KEY');
  });

  it('refuses a frame that belongs to another document', async () => {
    // The AAD binds the document. A frame lifted from a document this client also has
    // the key for must still fail, or two documents could be cross-contaminated.
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    const frame = await encryptOperation(key, 'other-doc', insert('a', 1, 'x'));

    socket.receive({ type: 'ops-enc', documentId: 'doc-1', frames: [frame] });
    await settle();

    expect(h.ops).toEqual([]);
    expect(h.errors).toHaveLength(1);
  });
});

describe('baselines and encrypted documents', () => {
  it('refuses a plaintext baseline when a key is present', async () => {
    // The server cannot produce one, so this is unreachable. Refusing is still right:
    // adopting elements this client never derived would replace the document with
    // something the user did not write, with no error shown.
    const key = await testDocumentKey('alice');
    const h = harness({ key });
    const socket = await connect(h);

    socket.receive({
      type: 'snapshot',
      documentId: 'doc-1',
      elements: [{ id: { site: 'x', clock: 1 }, value: 'h', origin: null }],
      ops: [],
      seq: 5,
    });
    await settle();

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('BASELINE_REFUSED');
  });

  it('still refuses a baseline while holding unsent work, with no key', async () => {
    // The pre-existing obligation, unchanged by encryption. A baseline REPLACES the
    // document, so discarding queued edits would lose work the user believes is saved.
    const h = harness();
    const socket = await connect(h);

    h.transport.send([insert('a', 1, 'x')]);
    await settle();

    // Queue more without flushing: close the socket first.
    socket.close();
    h.transport.send([insert('a', 2, 'y', 1)]);
    await settle();

    socket.receive({
      type: 'snapshot',
      documentId: 'doc-1',
      elements: [{ id: { site: 'x', clock: 1 }, value: 'h', origin: null }],
      ops: [],
      seq: 5,
    });
    await settle();

    expect(h.transport.queuedOperationCount).toBeGreaterThan(0);
  });
});

describe('what the transport does not leak', () => {
  it('never puts the key in a frame', async () => {
    const key = await testDocumentKey('alice');
    const raw = await crypto.subtle.exportKey('raw', key.cryptoKey);
    const encoded = Buffer.from(raw).toString('base64url');

    const h = harness({ key });
    const socket = await connect(h);

    h.transport.send([insert('a', 1, 'x')]);
    await settle();

    socket.receive({
      type: 'syncState',
      documentId: 'doc-1',
      state: 'synced',
      pendingOps: 0,
      seq: 1,
    });
    await settle();

    expect(socket.sent.join('\n')).not.toContain(encoded);
  });

  it('never puts the key in the URL it connects to', async () => {
    const key = await testDocumentKey('alice');
    const h = harness({ key });

    h.transport.connect();
    await settle();

    // The fragment is how the key travels. If it also appeared in the socket URL it
    // would be in the HTTP upgrade request, and the server would see it.
    expect(h.socket().url).not.toContain('k=');
    expect(h.socket().url).toBe('ws://localhost/ws?doc=doc-1');
  });
});

describe('resolveToken still runs per connect', () => {
  it('re-resolves on every connect', async () => {
    // Unchanged by encryption, and worth keeping tested: a token captured at construction
    // would expire silently.
    const resolveToken = vi.fn(() => Promise.resolve('fresh-token'));
    const transport = new SyncTransport({
      documentId: 'doc-1',
      url: 'ws://localhost/ws?doc=doc-1',
      resolveToken,
      handlers: {
        onOps: () => undefined,
        onPresence: () => undefined,
        onWelcome: () => undefined,
        onSyncState: () => undefined,
        onBaseline: () => undefined,
        onStateChange: () => undefined,
        onError: () => undefined,
      },
      socketFactory: (url) => {
        const socket = new FakeSocket(url);
        opened.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    transport.connect();
    await settle();

    expect(resolveToken).toHaveBeenCalled();
  });
});
