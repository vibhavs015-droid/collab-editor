/**
 * Closing the HTTP server must not wait forever for a connection.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * `server.close(callback)` does not fire until every connection has ended. Measured precisely: an
 * *idle* keep-alive socket does NOT block it, because Node has closed those itself since v19. What
 * does block it, indefinitely, is a connection that completed the TCP handshake and never sent a
 * request - which is not idle by Node's definition, because there is no request to have gone idle.
 *
 * Chromium produces exactly that on its own: speculative preconnect opens a socket before deciding
 * whether to use it.
 *
 * So a shutdown that begins with `await server.close()` can block indefinitely, and everything
 * after it is stuck too, including `db.close()`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE IS ONLY VISIBLE ON LINUX
 * ---------------------------------------------------------------------------
 * On Windows `process.kill(pid, 'SIGTERM')` calls `TerminateProcess`: the process dies immediately
 * and `shutdown()` never runs at all. So no measurement taken on a developer machine says anything
 * about this code, no matter how many times it is run. The only real evidence came from CI, where
 * the server logged `shutting down` and was still alive 45 seconds later.
 *
 * That is worth stating plainly: the graceful shutdown path was never exercised locally until CI
 * ran it, and the first thing it did on a real platform was fail.
 */

import { connect as netConnect, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { ApiServer } from './api.js';
import { Database } from './db.js';

const teardown: (() => Promise<void>)[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }

  for (const done of teardown.splice(0)) {
    await done();
  }
});

/**
 * A connection that completes a request and then holds the socket open forever.
 *
 * A keep-alive connection left idle by a browser. The response is read so the request genuinely
 * completes - otherwise this would be testing an in-flight request rather than an idle one, which
 * is the different and much rarer case.
 */
async function idleKeepAlive(port: number, path = '/api/health'): Promise<void> {
  const socket = netConnect(port, '127.0.0.1');
  sockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(
    [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${String(port)}`, 'Connection: keep-alive', '', '']
      .join('\r\n')
      .concat('\r\n'),
  );

  await new Promise<void>((resolve, reject) => {
    let seen = '';

    const timer = setTimeout(() => {
      reject(new Error(`no response; received ${JSON.stringify(seen)}`));
    }, 5_000);

    timer.unref?.();

    socket.on('data', (chunk: Buffer) => {
      seen += chunk.toString('latin1');

      if (seen.includes('\r\n\r\n')) {
        clearTimeout(timer);
        resolve();
      }
    });

    socket.once('error', reject);
  });
}

/**
 * A connection that completes the TCP handshake and never sends anything at all.
 *
 * This is the harder case and the one a browser produces on its own: Chromium opens speculative
 * preconnect sockets before deciding whether to use them.
 */
async function silentConnection(port: number): Promise<void> {
  const socket = netConnect(port, '127.0.0.1');
  sockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

/**
 * Close a server that may already be closed.
 *
 * Every test here closes its own server, because closing is the behaviour under test. Node throws
 * ERR_SERVER_NOT_RUNNING on a second close, so teardown has to tolerate it - otherwise a passing
 * test fails in cleanup and reports the wrong problem.
 */
async function closeQuietly(server: ApiServer): Promise<void> {
  try {
    await server.close();
  } catch {
    /* already closed, which is the normal case here */
  }
}

async function startServer(): Promise<{ server: ApiServer; port: number; db: Database }> {
  // A real database, as api.test.ts does, rather than a stub. It costs a couple of seconds and it
  // means nothing here passes because a fake happened to satisfy a method that is never called.
  const db = await Database.open();
  const server = new ApiServer({ db, host: '127.0.0.1', port: 0 });
  const bound = await server.listen();

  teardown.push(async () => {
    await closeQuietly(server);
    await db.close();
  });

  return { server, port: bound.port, db };
}

describe('closing the API server', () => {
  it('completes with an idle keep-alive connection attached', async () => {
    // Passes with or without the bound, and that is the point of keeping it.
    //
    // Measured, not assumed: Node has closed idle keep-alive sockets on `server.close()` since
    // v19, so a browser's idle pooled socket does NOT block shutdown. This test is here to stop
    // someone "fixing" a non-problem, and to notice if that behaviour ever changes.
    const { server, port } = await startServer();
    await idleKeepAlive(port);

    const started = Date.now();
    await closeQuietly(server);

    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('completes with a connection that never sends a request', async () => {
    // THE TEST THAT FAILS WITHOUT THE BOUND, and the only one of the two that does.
    //
    // A connection that has completed the TCP handshake but never sent a request is not idle by
    // Node's definition - there is no request to have gone idle - so `server.close()` waits for it
    // indefinitely. Chromium produces exactly this on its own: speculative preconnect opens a
    // socket before deciding whether to use it.
    //
    // This is the shape that hung the server on CI, and it is worth being precise about because
    // the obvious guess - "keep-alive connections block shutdown" - is wrong, and measuring that
    // is what found the real one.
    const { server, port } = await startServer();
    await silentConnection(port);

    const started = Date.now();
    await closeQuietly(server);

    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('still serves requests before it is closed', async () => {
    // The other half: a close that destroys everything immediately would pass the two tests above
    // and break every real shutdown.
    const { server, port } = await startServer();

    const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
    expect(res.ok).toBe(true);

    await closeQuietly(server);
  });

  it('closes with no connections at all', async () => {
    const { server } = await startServer();

    await expect(closeQuietly(server)).resolves.toBeUndefined();
  });
});
