/**
 * Durable identity, and refusing what a retry cannot fix.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Both of these bugs were invisible to the whole suite, and one of them made the
 * application unusable in the most ordinary way possible.
 *
 * Observed in a real browser:
 *
 *   - Type into a document. Reload. The text is still on screen, because it comes from
 *     IndexedDB. But the page reports "Offline" forever and never syncs again, and the
 *     server logs `rejected websocket client ... DOCUMENT_NOT_FOUND` roughly twice a second,
 *     indefinitely.
 *
 * Two independent causes:
 *
 *   1. `POST /api/auth/session` always minted a NEW random subject, and the client kept the
 *      token in memory only. A reload therefore produced a new identity - and with anonymous
 *      identities there is no way back to the old one. Not a re-login; a different person.
 *   2. The transport retried on EVERY close, ignoring both the close code and the `error`
 *      frame the server had already sent. The server was correct: it closes with 1008
 *      "policy violation" precisely so a client can tell a refusal from a dropped socket.
 *
 * Every existing test minted its own token and used it consistently, so neither could show
 * up. That is the lesson: a test that controls the credential is blind to credential
 * lifecycle.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TokenAuthenticator } from './auth.js';
import { Database } from './db.js';
import { ApiServer } from './api.js';

const SECRET = 'durable-identity-secret-long-enough-0123456789ab';

let db: Database | null = null;
let server: ApiServer | null = null;
let baseUrl = '';
let dataDir = '';

/** A running server, torn down after each test so the database starts clean. */
async function startServer(): Promise<{ close: () => Promise<void> }> {
  dataDir = await mkdtemp(join(tmpdir(), 'identity-'));
  db = await Database.openAt(join(dataDir, 'pg'));

  return {
    close: async () => {
      await server?.close();
      await db?.close();
      await rm(dataDir, { recursive: true, force: true });
      server = null;
      db = null;
    },
  };
}

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

afterEach(async () => {
  await server?.close();
  await db?.close();
  if (dataDir !== '') {
    await rm(dataDir, { recursive: true, force: true });
  }
  server = null;
  db = null;
  dataDir = '';
});

describe('a subject survives a reload', () => {
  it('is resumed when the client presents the one it already had', async () => {
    const lifecycle = await startServer();

    try {
      server = new ApiServer({
        db: db as unknown as Database,
        auth: new TokenAuthenticator({ secret: SECRET }),
        host: '127.0.0.1',
        port: 0,
        onListen: ({ port }) => {
          baseUrl = `http://127.0.0.1:${port}`;
        },
      });

      await server.listen();

      // First load: no stored subject, so one is minted.
      const first = await post(undefined);

      expect(first.status).toBe(200);
      expect(first.json['resumed']).toBe(false);

      const subject = first.json['subject'];

      expect(typeof subject).toBe('string');

      // Reload: the client presents what it stored. This is the request that used to mint a
      // DIFFERENT subject and cost the user every document they had opened.
      const second = await post({ subject });

      expect(second.status).toBe(200);
      expect(second.json['resumed']).toBe(true);
      expect(second.json['subject']).toBe(subject);

      // The token is a token, not the subject echoed back.
      expect(typeof second.json['token']).toBe('string');

      // NOT asserted: that the two tokens differ. A JWT over the same subject with the same
      // `iat` and `exp` is byte-identical, so two requests inside one second legitimately
      // produce the same string. The first version of this test asserted they differed and
      // failed - an over-specified assertion about an implementation detail, which is worse
      // than no assertion because it looks like it is testing something.
    } finally {
      await lifecycle.close();
    }
  }, 60_000);

  it('refuses a malformed subject rather than silently minting a different one', async () => {
    // The failure this prevents is subtle and nasty: the client would believe it had kept
    // its identity while actually holding a new one, and would go on writing to documents it
    // can no longer read.
    const lifecycle = await startServer();

    try {
      server = new ApiServer({
        db: db as unknown as Database,
        auth: new TokenAuthenticator({ secret: SECRET }),
        host: '127.0.0.1',
        port: 0,
        onListen: ({ port }) => {
          baseUrl = `http://127.0.0.1:${port}`;
        },
      });

      await server.listen();

      for (const bad of ['', 'has space', 'x'.repeat(200), 'quote"inject', '<script>']) {
        const result = await post({ subject: bad });

        expect(result.status, `for ${JSON.stringify(bad)}`).toBe(400);
        expect(result.json['token']).toBeUndefined();
      }
    } finally {
      await lifecycle.close();
    }
  }, 60_000);

  it('keeps working with no subject at all', async () => {
    // Storage can be unavailable - private browsing, a quota error. Falling back to a minted
    // subject is the OLD behaviour, so this must degrade rather than break.
    const lifecycle = await startServer();

    try {
      server = new ApiServer({
        db: db as unknown as Database,
        auth: new TokenAuthenticator({ secret: SECRET }),
        host: '127.0.0.1',
        port: 0,
        onListen: ({ port }) => {
          baseUrl = `http://127.0.0.1:${port}`;
        },
      });

      await server.listen();

      const result = await post(undefined);

      expect(result.status).toBe(200);
      expect(result.json['resumed']).toBe(false);
      expect(typeof result.json['subject']).toBe('string');
    } finally {
      await lifecycle.close();
    }
  }, 60_000);
});

describe('documents created under one subject stay reachable', () => {
  it('after a reload presents the same subject', async () => {
    // The end-to-end version of the bug. Before, the second call was a different person and
    // this returned 404 - the existence-oracle answer, which is correct behaviour applied to
    // a situation the client had created for itself.
    const lifecycle = await startServer();

    try {
      const database = db as unknown as Database;

      server = new ApiServer({
        db: database,
        auth: new TokenAuthenticator({ secret: SECRET }),
        host: '127.0.0.1',
        port: 0,
        onListen: ({ port }) => {
          baseUrl = `http://127.0.0.1:${port}`;
        },
      });

      await server.listen();

      const session = (await post(undefined)).json;
      const subject = session['subject'] as string;
      const token = session['token'] as string;

      await database.createDocument({ id: 'mine', title: 'Mine', owner: subject });

      // Same subject, fresh token: the reload case.
      const reloaded = await post({ subject });
      const reloadedToken = reloaded.json['token'] as string;

      expect(reloaded.json['subject']).toBe(subject);

      const read = await fetch(`${baseUrl}/api/documents/mine`, {
        headers: { Authorization: `Bearer ${reloadedToken}` },
      });

      expect(read.status, 'the document should still be readable after a reload').toBe(200);

      // And a genuinely different subject still gets the existence-oracle 404, which is the
      // protection this design depends on.
      const stranger = (await post(undefined)).json;

      const refused = await fetch(`${baseUrl}/api/documents/mine`, {
        headers: { Authorization: `Bearer ${stranger['token'] as string}` },
      });

      expect(refused.status).toBe(404);
      expect(refused.status).not.toBe(403);
      expect(token).toBeTruthy();
    } finally {
      await lifecycle.close();
    }
  }, 60_000);
});
