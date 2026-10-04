/**
 * Document ownership and access tests.
 *
 * The properties that matter are the NEGATIVE ones: who must be refused. A test
 * suite that only proves the owner can do things proves very little, because the
 * interesting bugs are all in the other direction.
 *
 * NOTE ON ENCODING: ASCII only. See src/core/crdt/rga.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Database } from './db.js';

let db: Database;
let counter = 0;

beforeAll(async () => {
  db = await Database.open();
});

afterAll(async () => {
  await db.close();
});

/**
 * Unique per call, not per test.
 *
 * Several tests need two or three documents in one test, and a counter bumped in
 * `beforeEach` hands them the same id twice. That produces a primary-key violation,
 * which reads as a database bug rather than a test-harness mistake.
 */
function nextId(): string {
  counter += 1;
  return `own-${counter}`;
}

describe('ownership on create', () => {
  it('records the creating subject', async () => {
    const id = nextId();
    const created = await db.createDocument({ id, owner: 'alice' });

    expect(created.owner).toBe('alice');
    expect((await db.getDocument(id))?.owner).toBe('alice');
  });

  it('leaves a document unowned when no subject is supplied', async () => {
    // The pre-authentication behaviour, preserved on purpose. See ADR-0012.
    const id = nextId();
    const created = await db.createDocument({ id });

    expect(created.owner).toBeNull();
  });

  it('does not treat an explicit null as different from omitted', async () => {
    const id = nextId();
    const created = await db.createDocument({ id, owner: null });

    expect(created.owner).toBeNull();
  });

  it('keeps owner when the document has initial content', async () => {
    // createDocument writes an operation log when content is present. That second
    // write must not drop the owner on the way.
    const id = nextId();
    const created = await db.createDocument({ id, content: 'seeded text', owner: 'alice' });

    expect(created.content).toBe('seeded text');
    expect((await db.getDocument(id))?.owner).toBe('alice');
  });
});

describe('canAccess', () => {
  it('lets the owner in', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    await expect(db.canAccess(id, 'alice')).resolves.toBe(true);
  });

  it('refuses a stranger', async () => {
    // The defect this whole migration exists to close.
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    await expect(db.canAccess(id, 'mallory')).resolves.toBe(false);
  });

  it('refuses a stranger even when they know the id', async () => {
    // Knowing the id is the whole attack. It must not help.
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    expect(id.length).toBeGreaterThan(4);
    await expect(db.canAccess(id, 'mallory')).resolves.toBe(false);
  });

  it('lets anyone reach an unowned document', async () => {
    const id = nextId();
    await db.createDocument({ id });

    await expect(db.canAccess(id, 'alice')).resolves.toBe(true);
    await expect(db.canAccess(id, 'mallory')).resolves.toBe(true);
  });

  it('refuses access to a document that does not exist', async () => {
    // So this cannot be used to enumerate which ids are real.
    await expect(db.canAccess('does-not-exist', 'alice')).resolves.toBe(false);
  });

  it('lets a granted subject in', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });
    await db.grantAccess(id, 'bob', 'alice');

    await expect(db.canAccess(id, 'bob')).resolves.toBe(true);
  });

  it('keeps refusing subjects who were never granted', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });
    await db.grantAccess(id, 'bob', 'alice');

    await expect(db.canAccess(id, 'carol')).resolves.toBe(false);
  });

  it('does not leak access across documents', async () => {
    const mine = nextId();
    const yours = nextId();
    await db.createDocument({ id: mine, owner: 'alice' });
    await db.createDocument({ id: yours, owner: 'carol' });
    await db.grantAccess(mine, 'bob', 'alice');

    // A grant on one document must never grant another. Documents ids share a
    // namespace, so a missing document qualifier here would be silent and total.
    await expect(db.canAccess(yours, 'bob')).resolves.toBe(false);
    await expect(db.canAccess(mine, 'bob')).resolves.toBe(true);
  });

  it('is not confused by a subject that looks like another', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    // Equality, not prefix or LIKE.
    await expect(db.canAccess(id, 'alice2')).resolves.toBe(false);
    await expect(db.canAccess(id, 'alic')).resolves.toBe(false);
    await expect(db.canAccess(id, 'ALICE')).resolves.toBe(false);
  });

  it('treats a subject with a wildcard as a literal', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    // A LIKE-based implementation would let this match every owner.
    await expect(db.canAccess(id, '%')).resolves.toBe(false);
    await expect(db.canAccess(id, '_lice')).resolves.toBe(false);
  });
});

describe('grantAccess', () => {
  it('distinguishes a new grant from a repeated one', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    await expect(db.grantAccess(id, 'bob', 'alice')).resolves.toEqual({ outcome: 'granted' });

    // A repeated grant is NOT a failure. Conflating "you may not" with "you already
    // have" is what made the API answer 400 for a retry of a request that had already
    // succeeded, which the benchmark harness found by re-running setup() against a warm
    // database.
    await expect(db.grantAccess(id, 'bob', 'alice')).resolves.toEqual({
      outcome: 'already-granted',
    });

    await expect(db.listCollaborators(id)).resolves.toEqual(['bob']);
  });

  it('stays stable across many repeats', async () => {
    // A client retrying on a timeout must never accumulate duplicate collaborators.
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    const outcomes: string[] = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await db.grantAccess(id, 'bob', 'alice');
      outcomes.push(result.outcome);
    }

    expect(outcomes).toEqual([
      'granted',
      'already-granted',
      'already-granted',
      'already-granted',
      'already-granted',
    ]);
    await expect(db.listCollaborators(id)).resolves.toEqual(['bob']);
  });

  it('refuses a stranger granting access', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    // A named outcome rather than false, so the caller maps it to a 403 instead of a
    // 500 or a 400. A 500 would be a lie about what went wrong.
    await expect(db.grantAccess(id, 'mallory', 'mallory')).resolves.toEqual({
      outcome: 'not-owner',
    });
    await expect(db.listCollaborators(id)).resolves.toEqual([]);
    await expect(db.canAccess(id, 'mallory')).resolves.toBe(false);
  });

  it('refuses a grant on a document that does not exist', async () => {
    await expect(db.grantAccess('does-not-exist', 'bob', 'alice')).resolves.toEqual({
      outcome: 'no-document',
    });
  });

  it('refuses a grant whose subject cannot be stored', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    // Distinct from `no-document`: the document is fine, the request is not. Folding
    // these together is what made the API answer 404 for a body problem, which the
    // HTTP test caught.
    await expect(db.grantAccess(id, 'not a legal subject', 'alice')).resolves.toEqual({
      outcome: 'invalid-subject',
    });
    await expect(db.listCollaborators(id)).resolves.toEqual([]);
  });

  it('reports an invalid subject before looking the document up', async () => {
    // Otherwise a caller could probe which document ids exist by watching for a 404
    // versus a 400, which is the existence oracle ADR-0012 exists to avoid.
    await expect(db.grantAccess('does-not-exist', 'not a legal subject', 'alice')).resolves.toEqual(
      { outcome: 'invalid-subject' },
    );
  });

  it('lets an unowned document be claimed by whoever grants', async () => {
    // An unowned document is world-writable, so anybody may also be the one to hand it
    // to someone else. Consistent, if slightly odd. The ownership check treats a null
    // owner as "not owned" rather than "owned by someone", which is why this passes:
    // `#ownershipOf` returns a record so the two cannot be confused by string equality.
    const id = nextId();
    await db.createDocument({ id });

    await expect(db.grantAccess(id, 'bob', 'mallory')).resolves.toEqual({ outcome: 'granted' });
    await expect(db.canAccess(id, 'bob')).resolves.toBe(true);
  });

  it('stays revocable', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });
    await db.grantAccess(id, 'bob', 'alice');

    await expect(db.revokeAccess(id, 'bob', 'alice')).resolves.toBe(true);
    await expect(db.canAccess(id, 'bob')).resolves.toBe(false);
    await expect(db.listCollaborators(id)).resolves.toEqual([]);
  });

  it('refuses revocation by a stranger', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });
    await db.grantAccess(id, 'bob', 'alice');

    // Otherwise a collaborator could remove other people's access.
    await expect(db.revokeAccess(id, 'bob', 'mallory')).resolves.toBe(false);
    await expect(db.canAccess(id, 'bob')).resolves.toBe(true);
  });

  it('cannot revoke the owner out of their own document', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });
    await db.grantAccess(id, 'alice', 'alice');

    // Owners are not rows in the collaborator table, so a "revoke self" is a
    // no-op rather than a lockout.
    await db.revokeAccess(id, 'alice', 'alice');
    await expect(db.canAccess(id, 'alice')).resolves.toBe(true);
  });
});

describe('claimOwnership', () => {
  it('takes an unowned document', async () => {
    const id = nextId();
    await db.createDocument({ id });

    await expect(db.claimOwnership(id, 'alice')).resolves.toBe(true);
    await expect(db.canAccess(id, 'mallory')).resolves.toBe(false);
  });

  it('refuses to take an already-owned document', async () => {
    // The takeover that the `owner IS NULL` guard exists to prevent.
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    await expect(db.claimOwnership(id, 'mallory')).resolves.toBe(false);
    await expect(db.canAccess(id, 'mallory')).resolves.toBe(false);
    await expect(db.canAccess(id, 'alice')).resolves.toBe(true);
  });

  it('refuses to take a document that does not exist', async () => {
    await expect(db.claimOwnership('does-not-exist', 'alice')).resolves.toBe(false);
  });

  it('is not repeatable', async () => {
    const id = nextId();
    await db.createDocument({ id });

    await expect(db.claimOwnership(id, 'alice')).resolves.toBe(true);
    await expect(db.claimOwnership(id, 'alice')).resolves.toBe(false);
  });

  it('keeps existing grants after a claim', async () => {
    const id = nextId();
    await db.createDocument({ id });
    await db.grantAccess(id, 'bob', 'alice');

    await db.claimOwnership(id, 'alice');

    // Claiming locks the document down, but must not evict someone who already
    // had access.
    await expect(db.canAccess(id, 'bob')).resolves.toBe(true);
  });
});

describe('listDocumentsFor', () => {
  it('returns owned documents', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    const mine = await db.listDocumentsFor('alice');

    expect(mine.map((document) => document.id)).toContain(id);
  });

  it('hides documents belonging to someone else', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });

    const mine = await db.listDocumentsFor('mallory');

    expect(mine.map((document) => document.id)).not.toContain(id);
  });

  it('includes granted documents', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });
    await db.grantAccess(id, 'bob', 'alice');

    const mine = await db.listDocumentsFor('bob');

    expect(mine.map((document) => document.id)).toContain(id);
  });

  it('includes unowned documents', async () => {
    const id = nextId();
    await db.createDocument({ id });

    const mine = await db.listDocumentsFor('anyone');

    // Consistent with canAccess: reachable by everyone, so listed for everyone.
    expect(mine.map((document) => document.id)).toContain(id);
  });

  it('does not list a document twice when a grant duplicates ownership', async () => {
    const id = nextId();
    await db.createDocument({ id, owner: 'alice' });
    // Granting the owner access as well. EXISTS and `owner = $1` both match, so a
    // naive UNION would return the row twice.
    await db.grantAccess(id, 'alice', 'alice');

    const mine = await db.listDocumentsFor('alice');
    const matches = mine.filter((document) => document.id === id);

    expect(matches).toHaveLength(1);
  });

  it('orders deterministically', async () => {
    // Two calls on the same data must produce the same order, or the endpoint
    // cannot be paginated against. This is the same tiebreaker reasoning as
    // listDocuments; see NOTES.md.
    const ids = [nextId(), nextId(), nextId()];

    for (const id of ids) {
      await db.createDocument({ id, owner: 'alice', title: 'same title' });
    }

    const first = await db.listDocumentsFor('alice');
    const second = await db.listDocumentsFor('alice');

    expect(first.map((document) => document.id)).toEqual(second.map((document) => document.id));
  });

  it('honours the limit', async () => {
    const mine = await db.listDocumentsFor('alice', 1);

    expect(mine.length).toBeLessThanOrEqual(1);
  });

  it('agrees with canAccess for every document it returns', async () => {
    // The two endpoints must not disagree about what a subject may see.
    const subject = 'consistency-subject';
    const mine = [nextId(), nextId(), nextId()];

    for (const id of mine) {
      await db.createDocument({ id, owner: subject });
    }

    const theirs = nextId();
    await db.createDocument({ id: theirs, owner: 'somebody-else' });

    const listed = await db.listDocumentsFor(subject);
    const listedIds = listed.map((document) => document.id);

    for (const id of mine) {
      expect(listedIds).toContain(id);
      await expect(db.canAccess(id, subject)).resolves.toBe(true);
    }

    expect(listedIds).not.toContain(theirs);
    await expect(db.canAccess(theirs, subject)).resolves.toBe(false);
  });
});
