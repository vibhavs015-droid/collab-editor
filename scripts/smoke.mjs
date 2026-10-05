/**
 * Production smoke test: does the BUILT artefact actually work?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS A SCRIPT AND NOT A VITEST FILE
 * ---------------------------------------------------------------------------
 * Every other test in this repository exercises the source through `tsx`. This one starts
 * `node dist/server/index.js` with `NODE_ENV=production`, exactly as a container entrypoint
 * does, and drives the thing a user actually gets.
 *
 * That gap had a real cost. `ae27a82` added static file serving because the production build
 * served NOTHING: `/` returned 401. Every source-level test passed, because they all reached
 * the API directly and never asked the server for a page. A routing table with no static
 * branch looks perfectly correct right up until a browser asks for a document.
 *
 * So this covers the seams that only exist in the built artefact:
 *
 *   - does `tsc` emit `dist/server/index.js` at the path `serve` names?
 *   - does the server find `dist/client` from its working directory?
 *   - does it REFUSE to start in production without `JWT_SECRET`? (open auth in production
 *     is the failure where the app looks healthy and is readable by anyone)
 *   - does `/` return HTML rather than a 401?
 *   - does a hashed asset resolve, so the page loads and then actually works?
 *   - does the WebSocket upgrade work against a real socket on a real port?
 *   - is a second peer served from the durable log, not just from the broadcast?
 *   - does encryption work end to end in the built server, with the frame intact?
 *
 * It is a script rather than a test file because it needs a build first. Folding that into
 * `npm test` would mean every unit-test run paying for `tsc`, and the tests would stop being
 * fast enough to run while working. It runs as its own CI step, immediately after `Build`.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

import { WebSocket } from 'ws';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'dist', 'server', 'index.js');
const CLIENT_DIST = join(ROOT, 'dist', 'client');

/** A 48-byte base64 secret. Production refuses to start without one. */
const JWT_SECRET = 'c21va2UtdGVzdC1vbmx5LXNlY3JldC1ub3QtZm9yLWRvY3M=';

let dataDir = '';
let child = null;
let port = 0;
let failures = 0;

/** Record a check, printing on success as well as failure so a CI log is complete. */
function check(name, ok, detail = '') {
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}${detail === '' ? '' : ` - ${detail}`}\n`);
  }

  return ok;
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Start the built server and wait for it to report the port it bound. */
async function start(env) {
  child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '0',
      PGLITE_DATA_DIR: dataDir,
      CLIENT_DIST,
      JWT_SECRET,
      LOG_LEVEL: 'info',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    output += `\n[exited ${code}]\n`;
  });

  // The port is 0, so the OS chooses it and the server has to tell us which.
  //
  // Read from the STRUCTURED log rather than matching text. The first version used
  // /listening[^0-9]*(\d+)/, captured `127` out of `127.0.0.1`, and dialled 127. Every log
  // line here is JSON by design (see LOG_LEVEL in .env.example), so parsing it is both more
  // robust and the format the server actually intends.
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`server exited before listening.\n${output}`);
    }

    for (const line of output.split('\n')) {
      if (!line.includes('"listening"')) {
        continue;
      }

      let parsed;

      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      // `url` is the server's own report of where it bound, so it is authoritative about
      // the interface it chose - which matters when HOST is 0.0.0.0, where assuming
      // 127.0.0.1 would be a guess rather than a fact.
      if (typeof parsed.url !== 'string') {
        continue;
      }

      const bound = new URL(parsed.url);
      const found = bound.port === '' ? 80 : Number(bound.port);

      if (Number.isInteger(found) && found > 0) {
        port = found;

        return;
      }
    }

    await delay(100);
  }

  throw new Error(`server did not report a port within 60s.\n${output}`);
}

async function stop() {
  if (child === null || child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  const deadline = Date.now() + 10_000;

  while (child.exitCode === null && Date.now() < deadline) {
    await delay(50);
  }

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

const base = () => `http://127.0.0.1:${port}`;

/**
 * Open a socket, say hello, and record every frame.
 *
 * @returns the socket plus a live array of what it has received, so a check can WAIT for a
 *   frame rather than sleep a guessed interval and hope.
 */
async function openPeer(documentId, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?doc=${documentId}`);
  const frames = [];

  socket.on('message', (raw) => {
    frames.push(JSON.parse(raw.toString('utf8')));
  });

  await new Promise((resolvePromise, reject) => {
    socket.once('open', resolvePromise);
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

  await delay(400);

  return { socket, frames };
}

/** Wait for a frame matching `predicate`. Returns it, or null on timeout. */
async function awaitFrame(peer, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = peer.frames.find(predicate);

    if (found !== undefined) {
      return found;
    }

    if (Date.now() > deadline) {
      return null;
    }

    await delay(50);
  }
}

/** Issue a session token through the built auth module, so the check is genuinely e2e. */
async function tokenFor(subject) {
  const { TokenAuthenticator } = await import(
    new URL('../dist/server/auth.js', import.meta.url).href
  );

  return (await new TokenAuthenticator({ secret: JWT_SECRET }).issue(subject)).token;
}

/** The page and the HTTP API. */
async function httpChecks() {
  const page = await fetch(`${base()}/`);

  check('GET / is 200', page.status === 200, `got ${page.status}`);
  check('GET / is HTML', (page.headers.get('content-type') ?? '').includes('text/html'));

  const html = await page.text();

  check('GET / is the editor, not an error page', html.includes('<html'));

  // A hashed asset must resolve, or the page loads and then does nothing at all - which is
  // exactly the class of failure static serving had.
  const asset = /src="(\/assets\/[^"]+)"/u.exec(html)?.[1];

  if (asset === undefined) {
    check('the page references a built asset', false, 'no /assets/ src found in the HTML');
  } else {
    const assetResponse = await fetch(`${base()}${asset}`);

    check(`GET ${asset} is 200`, assetResponse.status === 200, `got ${assetResponse.status}`);
  }

  const owner = await tokenFor('smoke-owner');

  const created = await fetch(`${base()}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ id: 'smoke-doc', title: 'Smoke' }),
  });

  check('POST /api/documents is 201', created.status === 201, `got ${created.status}`);

  // The response nests the document. Reading `body.id` returns undefined and looks like a
  // server bug rather than a probe bug - two of my own checks made that mistake earlier.
  const createdBody = await created.json();
  const documentId = createdBody?.document?.id;

  check(
    'the response carries document.id',
    typeof documentId === 'string',
    JSON.stringify(createdBody),
  );

  const read = await fetch(`${base()}/api/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${owner}` },
  });

  check('the document reads back as 200', read.status === 200, `got ${read.status}`);

  // Unauthenticated reads must NOT be 200. This is the same check that failed in the other
  // direction in `ae27a82`, and it is the one that would catch a regression there.
  const anonymous = await fetch(`${base()}/api/documents/${documentId}`);

  check(
    'an unauthenticated document read is refused',
    anonymous.status === 401 || anonymous.status === 404,
    `got ${anonymous.status}`,
  );

  const metrics = await fetch(`${base()}/api/metrics`);

  check('GET /api/metrics is 200', metrics.status === 200, `got ${metrics.status}`);
  check(
    'metrics are Prometheus text',
    (metrics.headers.get('content-type') ?? '').includes('text/plain'),
  );

  return owner;
}

/** The WebSocket and encryption paths, on the built server. */
async function realtimeChecks(owner) {
  const documentId = 'smoke-doc';

  // ---------------------------------------------------------------------------
  // TWO SOCKETS, NOT ONE, AND THE REASON IS WORTH WRITING DOWN
  // ---------------------------------------------------------------------------
  // The relay deliberately does NOT broadcast a message back to the socket that sent it: the
  // sender already has those operations. So a single socket sends an operation and receives
  // nothing, ever - and a smoke test asserting an echo fails against a CORRECT server.
  //
  // I got this wrong twice in one session: once in the convergence harness, where every
  // replica ended up one editor's worth short, and then here. It is easy to forget precisely
  // because it is an optimisation nobody notices while it works.
  const alice = await openPeer(documentId, owner);
  const bob = await openPeer(documentId, owner);

  check('welcome arrives', (await awaitFrame(alice, (m) => m.type === 'welcome')) !== null);

  alice.socket.send(
    JSON.stringify({
      type: 'ops',
      documentId,
      ops: [{ type: 'insert', id: { site: 'alice', clock: 1 }, origin: null, value: 'S' }],
    }),
  );

  const relayed = await awaitFrame(bob, (m) => m.type === 'ops' && m.ops?.length > 0);

  check(
    'a second peer receives the insert',
    relayed !== null,
    `bob saw ${JSON.stringify(bob.frames.map((m) => m.type))}`,
  );

  // A delete too, so both operation shapes are covered end to end.
  alice.socket.send(
    JSON.stringify({
      type: 'ops',
      documentId,
      ops: [{ type: 'delete', target: { site: 'alice', clock: 1 } }],
    }),
  );

  const deleted = await awaitFrame(bob, (m) => m.type === 'ops' && m.ops?.[0]?.type === 'delete');

  check('a second peer receives the delete', deleted !== null);

  alice.socket.close();
  bob.socket.close();
  await delay(300);

  // ---------------------------------------------------------------------------
  // REPLAY FROM A COLD CURSOR, which is the durability claim
  // ---------------------------------------------------------------------------
  // Everything above travelled over a socket. This asks for it again from sequence 0, as a
  // BRAND NEW client would, so it can only be served from the durable log. If persistence
  // were broken the document would come back empty and nothing above would have noticed.
  const carol = await openPeer(documentId, owner);
  const replayed = await awaitFrame(carol, (m) => m.type === 'ops' && m.ops?.length >= 2);

  check(
    'a cold client is caught up from the durable log',
    replayed !== null,
    `carol saw ${JSON.stringify(carol.frames.map((m) => m.type))}`,
  );

  carol.socket.close();
}

/** Encryption, in the built server, with the frame's integrity checked. */
async function encryptionChecks(owner) {
  const { testDocumentKey } = await import(
    new URL('../dist/core/crypto/documentKey.js', import.meta.url).href
  );
  const { encryptOperation } = await import(
    new URL('../dist/core/crypto/envelope.js', import.meta.url).href
  );

  const created = await fetch(`${base()}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ id: 'smoke-enc', title: 'Encrypted' }),
  });

  check('an encrypted document is created', created.status === 201, `got ${created.status}`);

  const key = await testDocumentKey('smoke');
  const alice = await openPeer('smoke-enc', owner);
  const bob = await openPeer('smoke-enc', owner);

  const frame = await encryptOperation(key, 'smoke-enc', {
    type: 'insert',
    id: { site: 'enc', clock: 1 },
    origin: null,
    value: 'x',
  });

  alice.socket.send(JSON.stringify({ type: 'ops-enc', documentId: 'smoke-enc', frames: [frame] }));

  const relayed = await awaitFrame(bob, (m) => m.type === 'ops-enc' && m.frames?.length > 0);

  check(
    'an encrypted frame reaches a second peer',
    relayed !== null,
    `bob saw ${JSON.stringify(bob.frames.map((m) => m.type))}`,
  );

  // Byte-for-byte. Re-serialising a frame on the way through storage would invalidate the
  // tag every client authenticates, and the failure would surface as "wrong key" on a
  // document the recipient has the right key for.
  check(
    'the frame is relayed byte-for-byte',
    relayed?.frames?.[0]?.ct === frame.ct &&
      relayed?.frames?.[0]?.iv === frame.iv &&
      relayed?.frames?.[0]?.key === frame.key,
    'ciphertext, nonce or element key changed in transit',
  );

  // A plaintext operation on an encrypted document must be refused, not quietly accepted.
  alice.socket.send(
    JSON.stringify({
      type: 'ops',
      documentId: 'smoke-enc',
      ops: [{ type: 'insert', id: { site: 'leak', clock: 1 }, origin: null, value: 'L' }],
    }),
  );

  await delay(800);

  const response = await fetch(`${base()}/api/documents/smoke-enc`, {
    headers: { Authorization: `Bearer ${owner}` },
  });

  const body = await response.json();
  const document = body?.document ?? body;

  check(
    'the encrypted document holds no readable content',
    document?.content === '',
    `content was ${JSON.stringify(document?.content)}`,
  );

  alice.socket.close();
  bob.socket.close();
}

/**
 * Production must REFUSE to start without a signing secret.
 *
 * Checked first and separately, because it is the one failure that looks exactly like
 * success: the server boots, serves the page, answers the health check, and every document
 * is readable by anyone who guesses an id.
 *
 * TWO assertions, and the first exists because a single one was too weak. The original
 * checked only that the failure text mentioned JWT_SECRET/secret/AUTH - and a sabotage that
 * set `AUTH_MODE=open` produced a refusal whose message mentioned AUTH, so the check passed
 * against a server refusing for the WRONG reason.
 *
 * Requiring that it never reported a listening port is what makes this specific: the
 * scenario has exactly one acceptable outcome, and it is "never bound a socket".
 */
async function refusesOpenAuth() {
  dataDir = await mkdtemp(join(tmpdir(), 'collab-smoke-noauth-'));

  try {
    await start({ JWT_SECRET: '' });
    check('production never binds a port without JWT_SECRET', false, 'it started and bound one');

    return;
  } catch (error) {
    const text = String(error);

    // The decisive assertion. A `listening` line here means the server is serving every
    // document to anyone, which is the whole thing this check exists to prevent.
    check(
      'production never binds a port without JWT_SECRET',
      !text.includes('"listening"'),
      'the server reported a listening port',
    );

    check(
      'the refusal names the missing secret',
      /JWT_SECRET|JWT secret|signing secret/iu.test(text),
      (text.split('\n').find((line) => line.trim() !== '') ?? 'no message').slice(0, 200),
    );
  } finally {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  process.stdout.write('production smoke test\n');

  check('dist/server/index.js exists', await exists(ENTRY), ENTRY);
  check('dist/client/index.html exists', await exists(join(CLIENT_DIST, 'index.html')));

  await refusesOpenAuth();

  dataDir = await mkdtemp(join(tmpdir(), 'collab-smoke-'));

  try {
    await start({});

    const owner = await httpChecks();

    await realtimeChecks(owner);
    await encryptionChecks(owner);
  } finally {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stdout.write(`\n${failures} check(s) failed\n`);
    process.exitCode = 1;

    return;
  }

  process.stdout.write('\nall checks passed\n');
}

await main();
