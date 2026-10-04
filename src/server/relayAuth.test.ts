/**
 * WebSocket authorisation tests.
 *
 * Every case here is about what a socket that has NOT proved who it is can do, and
 * the answer must be nothing. The positive cases are almost incidental.
 *
 * Runs against a real `ws` server on a real socket, because the behaviour under
 * test is about frames on the wire and close codes, neither of which a mock would
 * reproduce honestly.
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import type { ServerMessage } from '../shared/protocol.js';
import { Relay, type AuthorizeResult } from './relay.js';

const PROTOCOL = 1;

interface Harness {
  readonly relay: Relay;
  readonly url: string;
  readonly clients: WebSocket[];
  close: () => Promise<void>;
}

/**
 * Server that authorises against an in-memory policy.
 *
 * A function rather than a Database, because what is under test is the relay's
 * response to a decision, not the decision. The decision itself is tested in
 * ownership.test.ts, against a real database.
 */
function harness(
  policy: (documentId: string, token: string) => AuthorizeResult | Promise<AuthorizeResult>,
  options: { helloTimeoutMs?: number } = {},
): Harness {
  const relay = new Relay({
    // A short heartbeat rather than reaching into the relay's private reaper.
    // The sweep is part of the behaviour under test, so driving it through the
    // timer it actually runs on means the test exercises the real path.
    heartbeatMs: 20,
    authorize: (documentId, token) => Promise.resolve(policy(documentId, token)),
    ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
  });

  const wss = new WebSocketServer({ port: 0 });
  const clients: WebSocket[] = [];

  wss.on('connection', (socket, request) => {
    // From the request, not the socket. `socket.url` is not populated the way the
    // upgrade request's URL is, and reading it yields 'default' for every
    // connection -- which silently turns a per-document authorisation test into a
    // test that only ever checks one document.
    const url = new URL(request.url ?? '/', 'http://localhost');
    relay.attach(socket, url.searchParams.get('doc') ?? 'default');
  });

  return {
    relay,
    get url(): string {
      const address = wss.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      return `ws://127.0.0.1:${port}`;
    },
    clients,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) {
          client.terminate();
        }

        relay.close();
        wss.close(() => {
          resolve();
        });
      }),
  };
}

function allow(subject: string): AuthorizeResult {
  return { ok: true, subject };
}

function deny(): AuthorizeResult {
  return { ok: false, code: 'UNAUTHORIZED', message: 'Session is not valid for this document.' };
}

/** Open a socket and collect every frame it receives. */
function connect(
  h: Harness,
  documentId: string,
): {
  socket: WebSocket;
  frames: ServerMessage[];
  waitFor: (predicate: () => boolean, label?: string) => Promise<void>;
  send: (frame: unknown) => void;
} {
  const socket = new WebSocket(`${h.url}?doc=${encodeURIComponent(documentId)}`);
  const frames: ServerMessage[] = [];
  const waiters: { predicate: () => boolean; resolve: () => void }[] = [];

  socket.on('message', (data: Buffer) => {
    frames.push(JSON.parse(data.toString('utf8')) as ServerMessage);

    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter && waiter.predicate()) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  });

  socket.on('error', () => {
    // Expected in most of these tests.
  });

  h.clients.push(socket);

  const send = (frame: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };

  const waitFor = (predicate: () => boolean, label = 'condition'): Promise<void> => {
    if (predicate()) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for ${label}; saw ${frames.map((f) => f.type).join(', ') || 'nothing'}`,
          ),
        );
      }, 3000);

      waiters.push({
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  };

  return { socket, frames, waitFor, send };
}

function hello(token: string, lastAppliedSeq = 0): unknown {
  return { type: 'hello', protocolVersion: PROTOCOL, token, documentId: 'doc', lastAppliedSeq };
}

describe('relay - authorised clients', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(() => allow('alice'));
  });

  afterEach(async () => {
    await h.close();
  });

  it('admits a client with a valid token', async () => {
    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('good'));

    await client.waitFor(() => client.frames.some((frame) => frame.type === 'welcome'), 'welcome');

    expect(h.relay.clientCount).toBe(1);
    // And no longer pending.
    expect(h.relay.pendingCount).toBe(0);
  });

  it('accepts operations once admitted', async () => {
    const alice = connect(h, 'doc');
    const bob = connect(h, 'doc');

    await Promise.all(
      [alice, bob].map(
        (client) =>
          new Promise<void>((resolve) => {
            client.socket.once('open', () => {
              resolve();
            });
          }),
      ),
    );

    alice.send(hello('good'));
    bob.send(hello('good'));

    await alice.waitFor(
      () => alice.frames.some((frame) => frame.type === 'welcome'),
      'alice welcome',
    );
    await bob.waitFor(() => bob.frames.some((frame) => frame.type === 'welcome'), 'bob welcome');

    alice.send({
      type: 'ops',
      documentId: 'doc',
      ops: [{ type: 'insert', id: { site: 'a', clock: 1 }, origin: null, value: 'x' }],
    });

    await bob.waitFor(
      () => bob.frames.some((frame) => frame.type === 'ops'),
      "bob to receive alice's operations",
    );
  });
});

describe('relay - unauthorised clients', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(() => deny());
  });

  afterEach(async () => {
    await h.close();
  });

  it('sends nothing but an error to a refused client', async () => {
    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('bad'));

    await client.waitFor(() => client.frames.some((frame) => frame.type === 'error'), 'error');

    // No welcome, so no site id, so no element ids minted against this server.
    expect(client.frames.some((frame) => frame.type === 'welcome')).toBe(false);
  });

  it('closes the socket after refusing', async () => {
    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('bad'));

    const closed = await new Promise<number>((resolve) => {
      client.socket.once('close', (code: number) => {
        resolve(code);
      });
    });

    // 1008 is "policy violation". A client branching on 1000 would retry forever
    // against an authorisation that will never succeed.
    expect(closed).toBe(1008);
  });

  it('never joins the room', async () => {
    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('bad'));

    await client.waitFor(() => client.frames.some((frame) => frame.type === 'error'), 'error');
    await new Promise<void>((resolve) => {
      client.socket.once('close', () => {
        resolve();
      });
    });

    expect(h.relay.clientCount).toBe(0);
  });

  it('refuses operations sent before hello', async () => {
    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    // The critical gate: a socket that never says hello must not be able to write.
    client.send({
      type: 'ops',
      documentId: 'doc',
      ops: [{ type: 'insert', id: { site: 'a', clock: 1 }, origin: null, value: 'x' }],
    });

    await client.waitFor(() => client.frames.some((frame) => frame.type === 'error'), 'error');

    const error = client.frames.find((frame) => frame.type === 'error');
    expect(error).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(client.frames.some((frame) => frame.type === 'welcome')).toBe(false);
  });

  it('refuses presence, resync and ops alike before hello', async () => {
    // One check above the switch, so a new frame type cannot slip past it. Each of
    // these is a distinct way to affect or observe the document.
    const frames: unknown[] = [
      { type: 'ops', documentId: 'doc', ops: [] },
      { type: 'presence', documentId: 'doc', cursor: 1, selectedLength: 0 },
      { type: 'resync', documentId: 'doc', sinceSeq: 0 },
    ];

    for (const frame of frames) {
      const client = connect(h, 'doc');

      await new Promise<void>((resolve) => {
        client.socket.once('open', () => {
          resolve();
        });
      });

      client.send(frame);

      await client.waitFor(() => client.frames.some((f) => f.type === 'error'), 'error');

      const error = client.frames.find((f) => f.type === 'error');
      expect(error).toMatchObject({ code: 'UNAUTHORIZED' });

      client.socket.terminate();
    }
  });
});

describe('relay - a socket that never says hello', () => {
  let h: Harness;

  beforeEach(() => {
    // Authorisation is available and would succeed. The lurker simply never uses it,
    // which is what makes this the interesting case.
    h = harness(() => allow('alice'));
  });

  afterEach(async () => {
    await h.close();
  });

  it('does not receive operations broadcast by an admitted client', async () => {
    // The other direction of the same leak: a socket parked in a room receives
    // broadcasts. Joining before authorising would hand every keystroke to an
    // anonymous connection.
    const alice = connect(h, 'doc');
    const lurker = connect(h, 'doc');

    await Promise.all(
      [alice, lurker].map(
        (client) =>
          new Promise<void>((resolve) => {
            client.socket.once('open', () => {
              resolve();
            });
          }),
      ),
    );

    alice.send(hello('good'));
    await alice.waitFor(() => alice.frames.some((f) => f.type === 'welcome'), 'welcome');

    // The lurker says nothing at all.
    alice.send({
      type: 'ops',
      documentId: 'doc',
      ops: [{ type: 'insert', id: { site: 'a', clock: 1 }, origin: null, value: 'secret' }],
    });

    // Long enough for a broadcast to have been delivered, if the lurker were in the
    // room. Short enough not to matter.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(lurker.frames).toHaveLength(0);
    expect(h.relay.clientCount).toBe(1);
  });

  it('does not appear in the presence list', async () => {
    // A third admitted client is needed to observe the broadcast: presence goes to
    // everyone in the room EXCEPT the sender, so a lone alice would see nothing.
    const alice = connect(h, 'doc');
    const bob = connect(h, 'doc');
    const lurker = connect(h, 'doc');

    await Promise.all(
      [alice, bob, lurker].map(
        (client) =>
          new Promise<void>((resolve) => {
            client.socket.once('open', () => {
              resolve();
            });
          }),
      ),
    );

    alice.send(hello('good'));
    bob.send(hello('good'));
    await alice.waitFor(() => alice.frames.some((f) => f.type === 'welcome'), 'alice welcome');
    await bob.waitFor(() => bob.frames.some((f) => f.type === 'welcome'), 'bob welcome');

    alice.send({ type: 'presence', documentId: 'doc', cursor: 3, selectedLength: 0 });

    await bob.waitFor(() => bob.frames.some((f) => f.type === 'presence'), 'a presence broadcast');

    // Exactly one collaborator. A lurker in the presence map would show a
    // collaborator nobody can see leave, because it never identified itself.
    const presence = bob.frames.filter((f) => f.type === 'presence').at(-1);
    const cursors = (presence as { cursors: Record<string, number> }).cursors;
    expect(Object.keys(cursors)).toHaveLength(1);
    expect(lurker.frames).toHaveLength(0);
  });
});

describe('relay - authorisation is per document', () => {
  let h: Harness;

  beforeEach(() => {
    // Only `mine` is readable. The point of the case is that the document in the
    // URL is the one checked, not something the client claims later.
    h = harness((documentId) => (documentId === 'mine' ? allow('alice') : deny()));
  });

  afterEach(async () => {
    await h.close();
  });

  it('admits for one document and refuses for another', async () => {
    const mine = connect(h, 'mine');
    const yours = connect(h, 'yours');

    await Promise.all(
      [mine, yours].map(
        (client) =>
          new Promise<void>((resolve) => {
            client.socket.once('open', () => {
              resolve();
            });
          }),
      ),
    );

    mine.send(hello('good'));
    yours.send(hello('good'));

    await mine.waitFor(() => mine.frames.some((f) => f.type === 'welcome'), 'welcome');
    await yours.waitFor(() => yours.frames.some((f) => f.type === 'error'), 'error');

    expect(yours.frames.some((f) => f.type === 'welcome')).toBe(false);
  });

  it('passes the token from the URL document to the authoriser', async () => {
    const seen: { documentId: string; token: string }[] = [];

    const policy = harness((documentId, token) => {
      seen.push({ documentId, token });
      return allow('alice');
    });

    const client = connect(policy, 'specific-doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('a-token'));

    await client.waitFor(() => client.frames.some((f) => f.type === 'welcome'), 'welcome');

    expect(seen).toEqual([{ documentId: 'specific-doc', token: 'a-token' }]);

    await policy.close();
  });
});

describe('relay - authorisation failures', () => {
  let h: Harness;

  afterEach(async () => {
    await h.close();
  });

  it('fails closed when the authoriser throws', async () => {
    // The important half of "handle errors" is which side of the door they land on.
    h = harness(() => {
      throw new Error('database unavailable');
    });

    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('good'));

    await client.waitFor(() => client.frames.some((f) => f.type === 'error'), 'error');

    expect(client.frames.some((f) => f.type === 'welcome')).toBe(false);
    expect(h.relay.clientCount).toBe(0);
  });

  it('fails closed when the authoriser rejects', async () => {
    h = harness(() => Promise.reject(new Error('nope')));

    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('good'));

    await client.waitFor(() => client.frames.some((f) => f.type === 'error'), 'error');

    expect(client.frames.some((f) => f.type === 'welcome')).toBe(false);
  });

  it('does not leak the internal failure reason to the client', async () => {
    h = harness(() => {
      throw new Error('connection to 10.0.0.5 refused: password=hunter2');
    });

    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('good'));

    await client.waitFor(() => client.frames.some((f) => f.type === 'error'), 'error');

    const text = JSON.stringify(client.frames);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('10.0.0.5');
  });
});

describe('relay - hello timeout', () => {
  let h: Harness;

  afterEach(async () => {
    await h.close();
  });

  it('drops a socket that never says hello', async () => {
    h = harness(() => allow('alice'), { helloTimeoutMs: 60 });

    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    // The heartbeat drives the sweep; nothing reaches into the relay here.
    const closed = await new Promise<number>((resolve) => {
      client.socket.once('close', (code: number) => {
        resolve(code);
      });
    });

    // 1008, not 1000: the client should not retry a connection it never authorised.
    expect(closed).toBe(1008);
  });

  it('stops counting a timed-out socket as pending', async () => {
    h = harness(() => allow('alice'), { helloTimeoutMs: 30 });

    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    expect(h.relay.pendingCount).toBe(1);

    await new Promise<void>((resolve) => {
      client.socket.once('close', () => {
        resolve();
      });
    });

    // Otherwise these accumulate forever, which is a denial of service that costs
    // the attacker nothing.
    expect(h.relay.pendingCount).toBe(0);
  });

  it('does not reap a socket that did say hello', async () => {
    h = harness(() => allow('alice'), { helloTimeoutMs: 30 });

    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('good'));
    await client.waitFor(() => client.frames.some((f) => f.type === 'welcome'), 'welcome');

    // Comfortably past the hello deadline, so a reaper that did not clear the
    // deadline on admission would have closed this by now.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(h.relay.clientCount).toBe(1);
    expect(h.relay.pendingCount).toBe(0);
  });
});

describe('relay - no authoriser configured', () => {
  it('keeps the pre-authentication behaviour', async () => {
    // A relay with no tokens at all must still work, because that is how the
    // single-process tests and the Phase 3 deployment are wired. If this broke,
    // adding auth would have silently broken every existing deployment.
    const relay = new Relay({ heartbeatMs: 0 });
    const wss = new WebSocketServer({ port: 0 });

    wss.on('connection', (socket) => {
      relay.attach(socket, 'doc');
    });

    const address = wss.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);

    const welcome = await new Promise<string>((resolve, reject) => {
      socket.on('message', (data: Buffer) => {
        resolve(data.toString('utf8'));
      });
      socket.on('error', reject);
    });

    expect(JSON.parse(welcome)).toMatchObject({ type: 'welcome' });
    expect(relay.clientCount).toBe(1);
    expect(relay.pendingCount).toBe(0);

    socket.terminate();
    relay.close();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
  });
});

describe('relay - repeated hello', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(() => allow('alice'));
  });

  afterEach(async () => {
    await h.close();
  });

  it('replays again without re-admitting', async () => {
    const client = connect(h, 'doc');

    await new Promise<void>((resolve) => {
      client.socket.once('open', () => {
        resolve();
      });
    });

    client.send(hello('good'));
    await client.waitFor(() => client.frames.some((f) => f.type === 'welcome'), 'welcome');

    client.send(hello('good'));
    await client.waitFor(() => client.frames.some((f) => f.type === 'syncState'), 'syncState');

    // One welcome, not two. A second admission would send a second identity and a
    // second replay for a client that had already been caught up.
    expect(client.frames.filter((f) => f.type === 'welcome')).toHaveLength(1);
    expect(h.relay.clientCount).toBe(1);
  });
});
