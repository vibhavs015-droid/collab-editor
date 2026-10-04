/**
 * HTTP authorisation tests.
 *
 * Uses a real {@link TokenAuthenticator}, not open mode. Open mode would let every
 * one of these tests pass for the wrong reason, because in open mode any string is
 * a valid subject and "verified" means nothing.
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApiServer } from './api.js';
import { TokenAuthenticator } from './auth.js';
import { Database } from './db.js';

const SECRET = 'http-auth-test-secret-long-enough-for-hs256';
const OTHER_SECRET = 'http-auth-other-secret-long-enough-hs256';

let db: Database;
let server: ApiServer;
let baseUrl: string;
let auth: TokenAuthenticator;

/** Mint a real token for a subject. */
async function tokenFor(subject: string): Promise<string> {
  const issued = await auth.issue(subject);
  return issued.token;
}

/**
 * Request as a specific subject.
 *
 * @param subject pass null to send no credentials at all.
 */
async function as(subject: string | null, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(
    init.headers instanceof Headers ? init.headers : (init.headers ?? {}),
  );

  if (subject !== null) {
    headers.set('Authorization', `Bearer ${await tokenFor(subject)}`);
  } else if (init.headers === undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const url = baseUrl + path;

  return fetch(url, { ...init, headers });
}

async function createAs(subject: string, id: string): Promise<Response> {
  return as(subject, '/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
}

/**
 * Boot PGlite once for the whole file and empty it between tests.
 *
 * Booting an in-memory Postgres costs about two seconds, and this file has 39
 * tests. Paying that per test made the file take longer than the entire CRDT suite.
 *
 * Isolation is preserved by truncating rather than sharing: `documents` cascades to
 * `document_ops`, `document_collaborators` and `document_snapshots`, so one TRUNCATE
 * returns the schema to its just-migrated state. Tests that share a database and do
 * not reset it become order-dependent, and this file asserts on exact list contents,
 * so it would fail confusingly rather than loudly.
 */
beforeAll(async () => {
  db = await Database.open();
  auth = new TokenAuthenticator({ secret: SECRET });

  server = new ApiServer({
    db,
    auth,
    host: '127.0.0.1',
    port: 0,
    onListen: ({ port }) => {
      baseUrl = `http://127.0.0.1:${port}`;
    },
  });

  await server.listen();
});

afterEach(async () => {
  await db.truncateAll();
});

afterAll(async () => {
  await server.close();
  await db.close();
});

describe('POST /api/auth/session', () => {
  it('issues a token and says who it is for', async () => {
    const res = await as(null, '/api/auth/session', { method: 'POST' });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { token: string; subject: string; expiresAt: number };
    expect(body.subject).toMatch(/^[A-Za-z0-9_-]{20,30}$/u);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('needs no credentials, because it is how credentials are obtained', async () => {
    const res = await fetch(`${baseUrl}/api/auth/session`, { method: 'POST' });

    expect(res.status).toBe(200);
  });

  it('issues a usable token', async () => {
    // End to end: the token it hands out must actually work on a protected route.
    // A session endpoint whose output the API rejects would be worse than none.
    const issued = (await (await as(null, '/api/auth/session', { method: 'POST' })).json()) as {
      token: string;
      subject: string;
    };

    const created = await as(issued.subject, '/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ id: 'from-session' }),
    });

    expect(created.status).toBe(201);
  });

  it('issues a different subject each time', async () => {
    const first = (await (await as(null, '/api/auth/session', { method: 'POST' })).json()) as {
      subject: string;
    };
    const second = (await (await as(null, '/api/auth/session', { method: 'POST' })).json()) as {
      subject: string;
    };

    // Otherwise "log out and log in again" is a no-op and two people share identity.
    expect(first.subject).not.toBe(second.subject);
  });
});

describe('unauthenticated requests', () => {
  it('refuses the document list', async () => {
    const res = await as(null, '/api/documents');

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses creating a document', async () => {
    const res = await as(null, '/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'anon' }),
    });

    expect(res.status).toBe(401);
  });

  it('refuses reading a document', async () => {
    const res = await as(null, '/api/documents/anything');

    expect(res.status).toBe(401);
  });

  it('refuses deleting a document', async () => {
    const res = await as(null, '/api/documents/anything', { method: 'DELETE' });

    expect(res.status).toBe(401);
  });

  it('says how to authenticate', async () => {
    // Without the challenge a client has to guess the header name and scheme.
    const res = await as(null, '/api/documents');

    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('does not disclose whether a document exists', async () => {
    await createAs('alice', 'real-doc');

    const missing = await as(null, '/api/documents/not-a-real-doc');
    const real = await as(null, '/api/documents/real-doc');

    // Identical, because an unauthenticated caller is refused before any lookup.
    expect(missing.status).toBe(real.status);
  });

  it('leaves health reachable, because a probe has no credentials', async () => {
    const res = await as(null, '/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', auth: 'required' });
  });
});

describe('malformed credentials', () => {
  it('rejects a token signed with the wrong secret', async () => {
    const foreign = await new TokenAuthenticator({ secret: OTHER_SECRET }).issue('alice');

    const res = await as(null, '/api/documents', {
      headers: { Authorization: `Bearer ${foreign.token}` },
    });

    expect(res.status).toBe(401);
  });

  it('rejects a header that is not Bearer', async () => {
    for (const header of ['Basic abc123', 'alice', 'Bearer', 'Bearer  ']) {
      const res = await as(null, '/api/documents', { headers: { Authorization: header } });
      expect(res.status, `for header ${JSON.stringify(header)}`).toBe(401);
    }
  });

  it('accepts a lowercase scheme, because RFC 7235 says the scheme is case-insensitive', async () => {
    const token = await tokenFor('alice');

    const res = await as(null, '/api/documents', { headers: { Authorization: `bearer ${token}` } });

    // Being stricter than the specification here buys nothing and becomes a support
    // question the first time a well-behaved client lowercases it.
    expect(res.status).toBe(200);
  });

  it('rejects a garbage token without echoing it', async () => {
    const res = await as(null, '/api/documents', {
      headers: { Authorization: 'Bearer not.a.jwt' },
    });

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('not.a.jwt');
  });

  it('rejects an unsigned token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url');

    const res = await as(null, '/api/documents', {
      headers: { Authorization: `Bearer ${header}.${payload}.` },
    });

    expect(res.status).toBe(401);
  });
});

describe('one subject against another', () => {
  it('cannot read a document it does not own', async () => {
    await createAs('alice', 'alice-doc');

    const res = await as('mallory', '/api/documents/alice-doc');

    // 404, not 403. See NOT_FOUND_MESSAGE in api.ts: a 403 confirms the document
    // exists, and a real id is most of what an attacker needs.
    expect(res.status).toBe(404);
  });

  it('cannot see the content of a document it does not own', async () => {
    await createAs('alice', 'alice-doc');
    await as('alice', '/api/documents/alice-doc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'private notes' }),
    });

    const res = await as('mallory', '/api/documents/alice-doc');
    const text = await res.text();

    expect(text).not.toContain('private notes');
  });

  it('cannot write to a document it does not own', async () => {
    await createAs('alice', 'alice-doc');

    const res = await as('mallory', '/api/documents/alice-doc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'overwritten' }),
    });

    expect(res.status).toBe(404);

    // And the content really is untouched.
    const owner = await as('alice', '/api/documents/alice-doc');
    expect(await owner.json()).toMatchObject({ document: { content: '' } });
  });

  it('cannot delete a document it does not own', async () => {
    await createAs('alice', 'alice-doc');

    const res = await as('mallory', '/api/documents/alice-doc', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect((await db.getDocument('alice-doc')) !== null).toBe(true);
  });

  it('cannot take over a document it does not own', async () => {
    await createAs('alice', 'alice-doc');

    const res = await as('mallory', '/api/documents/alice-doc/claim', { method: 'POST' });

    // 409 rather than 404, because the caller demonstrably knows this document
    // exists: they just failed to read it. Confirming existence here discloses
    // nothing new.
    expect(res.status).toBe(409);
    expect((await db.getDocument('alice-doc'))?.owner).toBe('alice');
  });

  it('cannot grant itself access', async () => {
    await createAs('alice', 'alice-doc');

    const res = await as('mallory', '/api/documents/alice-doc/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'mallory' }),
    });

    expect(res.status).toBe(403);
    await expect(db.canAccess('alice-doc', 'mallory')).resolves.toBe(false);
  });

  it('does not list the documents of another subject', async () => {
    await createAs('alice', 'alice-doc');

    const res = await as('mallory', '/api/documents');
    const body = (await res.json()) as { documents: { id: string }[] };

    expect(body.documents.map((document) => document.id)).not.toContain('alice-doc');
  });

  it('cannot list an unknown route without credentials', async () => {
    // Refusing before routing means the error does not enumerate what exists.
    const res = await as(null, '/api/admin/secrets');

    expect(res.status).toBe(401);
  });
});

describe('collaboration', () => {
  it('lets a granted subject read and write', async () => {
    await createAs('alice', 'shared');

    const granted = await as('alice', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'bob' }),
    });
    expect(granted.status).toBe(200);

    expect((await as('bob', '/api/documents/shared')).status).toBe(200);

    const write = await as('bob', '/api/documents/shared', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'from bob' }),
    });
    expect(write.status).toBe(200);
  });

  it('treats a repeated grant as success, not an error', async () => {
    // The bug the benchmark harness found: it re-runs `setup()` against a warm database,
    // so it grants access that already exists, and the API answered 400. A client
    // retrying a grant because it never saw the response hit exactly the same case and
    // got told its successful request was malformed.
    await createAs('alice', 'shared');

    const grant = () =>
      as('alice', '/api/documents/shared/collaborators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'bob' }),
      });

    const first = await grant();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ granted: true, subject: 'bob', alreadyGranted: false });

    const second = await grant();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ granted: true, subject: 'bob', alreadyGranted: true });

    // Still exactly one collaborator, not a row per attempt.
    const listed = await as('alice', '/api/documents/shared/collaborators');
    expect(((await listed.json()) as { collaborators: string[] }).collaborators).toEqual(['bob']);
  });

  it('keeps granting idempotent across many retries', async () => {
    // A client that retries on a timeout must converge, not accumulate.
    await createAs('alice', 'shared');

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await as('alice', '/api/documents/shared/collaborators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'bob' }),
      });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);

    const listed = await as('alice', '/api/documents/shared/collaborators');
    expect(((await listed.json()) as { collaborators: string[] }).collaborators).toEqual(['bob']);
  });

  it('lists collaborators for the owner', async () => {
    await createAs('alice', 'shared');
    await as('alice', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'bob' }),
    });

    const res = await as('alice', '/api/documents/shared/collaborators');
    const body = (await res.json()) as { collaborators: string[] };

    expect(body.collaborators).toEqual(['bob']);
  });

  it('revokes access', async () => {
    await createAs('alice', 'shared');
    await as('alice', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'bob' }),
    });

    const revoked = await as('alice', '/api/documents/shared/collaborators/bob', {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);

    expect((await as('bob', '/api/documents/shared')).status).toBe(404);
  });

  it('does not let a collaborator delete the document', async () => {
    await createAs('alice', 'shared');
    await as('alice', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'bob' }),
    });

    // Write access is not ownership. Delete is disposal, not an edit.
    const res = await as('bob', '/api/documents/shared', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect((await db.getDocument('shared')) !== null).toBe(true);
  });

  it('does not let a collaborator grant further access', async () => {
    await createAs('alice', 'shared');
    await as('alice', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'bob' }),
    });

    const res = await as('bob', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'mallory' }),
    });

    expect(res.status).toBe(403);
    await expect(db.canAccess('shared', 'mallory')).resolves.toBe(false);
  });

  it('rejects a grant with no subject', async () => {
    await createAs('alice', 'shared');

    const res = await as('alice', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('rejects a grant whose subject cannot be stored', async () => {
    await createAs('alice', 'shared');

    const res = await as('alice', '/api/documents/shared/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'not a legal subject '.repeat(20) }),
    });

    // Refused rather than stored. A subject is used in a database key and shown in
    // a UI, and neither wants arbitrary text.
    expect(res.status).toBe(400);
  });
});

describe('ownership at creation', () => {
  it('records the caller as owner', async () => {
    const res = await createAs('alice', 'owned');

    expect(res.status).toBe(201);
    const body = (await res.json()) as { document: { owner: string | null } };
    expect(body.document.owner).toBe('alice');
  });

  it('makes the document private from the moment it exists', async () => {
    await createAs('alice', 'owned');

    // Previously every document was world-writable. This is the behaviour that
    // stops that.
    expect((await as('mallory', '/api/documents/owned')).status).toBe(404);
  });

  it('lets the owner delete it', async () => {
    await createAs('alice', 'owned');

    expect((await as('alice', '/api/documents/owned', { method: 'DELETE' })).status).toBe(200);
    expect(await db.getDocument('owned')).toBeNull();
  });

  it('lets the owner claim an unowned document', async () => {
    // The path by which documents created outside the API, or before this migration,
    // stop being world-writable.
    await db.createDocument({ id: 'legacy' });

    const res = await as('alice', '/api/documents/legacy/claim', { method: 'POST' });

    expect(res.status).toBe(200);
    await expect(db.canAccess('legacy', 'mallory')).resolves.toBe(false);
  });

  it('refuses a claim on an already-owned document', async () => {
    await createAs('alice', 'owned');

    const res = await as('bob', '/api/documents/owned/claim', { method: 'POST' });

    expect(res.status).toBe(409);
    expect((await db.getDocument('owned'))?.owner).toBe('alice');
  });

  it('leaves an unowned document reachable, so pre-authentication data still works', async () => {
    await db.createDocument({ id: 'legacy' });

    expect((await as('anyone', '/api/documents/legacy')).status).toBe(200);
  });
});

describe('scoped listing', () => {
  it('returns owned, granted and unowned documents', async () => {
    await createAs('alice', 'mine');
    await db.createDocument({ id: 'unowned' });
    await createAs('carol', 'theirs');
    await as('carol', '/api/documents/theirs/collaborators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'alice' }),
    });

    const res = await as('alice', '/api/documents');
    const ids = ((await res.json()) as { documents: { id: string }[] }).documents.map((d) => d.id);

    expect(ids).toContain('mine');
    expect(ids).toContain('unowned');
    expect(ids).toContain('theirs');
    expect(ids).not.toContain('nothing-else');
  });

  it('agrees with per-document access for every id it returns', async () => {
    await createAs('alice', 'mine');
    await createAs('carol', 'theirs');

    const ids = (
      (await (await as('alice', '/api/documents')).json()) as { documents: { id: string }[] }
    ).documents.map((document) => document.id);

    for (const id of ids) {
      expect((await as('alice', `/api/documents/${id}`)).status).toBe(200);
    }
  });
});
