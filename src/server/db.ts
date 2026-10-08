/**
 * Database layer — PostgreSQL via PGlite.
 *
 * ── Why PGlite ───────────────────────────────────────────────────────────
 * PGlite is the real PostgreSQL engine compiled to WebAssembly. Not SQLite in
 * Postgres's clothing: same parser, same planner, same SQL semantics. That
 * matters because the alternative here was genuinely worse, not merely
 * different.
 *
 * A native PostgreSQL install needs admin rights, a Windows service, a password
 * to remember, and a manual start on every reboot. On a laptop that means the
 * project silently stops working when the service is down, and CI needs a
 * service container to run the same tests.
 *
 * PGlite gives byte-identical SQL in both places with no setup. When Phase 5
 * deploys, `DATABASE_URL` points at Supabase and this file changes shape only
 * slightly — the SQL above does not move. See ADR-0005.
 *
 * ── Schema note ──────────────────────────────────────────────────────────
 * The document body is stored as plain text for Phase 1. From Phase 2 the
 * authoritative representation becomes the CRDT operation log, and
 * `documents.content` becomes a derived, disposable cache — rebuildable from
 * the log at any time.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { initialOperations, seedSiteFor } from '../core/crdt/seed.js';
import { RgaDocument, type Operation } from '../core/crdt/rga.js';
import {
  snapshotToOperations,
  type DocumentSnapshot,
  type SnapshotElement,
} from '../core/crdt/snapshot.js';
import { isValidSubject } from '../shared/subject.js';
import type { EncryptedOperationFrame } from '../shared/protocol.js';
import { DEFAULT_LIMITS } from './limits.js';

/** One saved document. */
export interface DocumentRecord {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  /** Highest CRDT clock applied. Always 0 until Phase 2. */
  readonly clock: number;
  readonly updatedAt: string;
  /**
   * Subject that created this document, or null when unowned.
   *
   * Null is not a failure. It means the document predates authentication, or was
   * created outside the API, and it is world-writable. See ADR-0012 and
   * {@link Database.claimOwnership}.
   */
  readonly owner: string | null;
  /**
   * Whether this document's operations are ciphertext. See ADR-0014.
   *
   * One-way: set by the first encrypted frame, never cleared. A document whose log mixes
   * plaintext and ciphertext has no defined replay, so flipping the flag back would
   * produce documents missing their first half rather than restoring anything.
   */
  readonly encrypted: boolean;
}

export interface CreateDocumentInput {
  readonly id: string;
  /** Optional - defaults to `'Untitled'`, matching the column default. */
  readonly title?: string;
  readonly content?: string;
  /**
   * Subject to record as owner. Omit or pass null to create an unowned document,
   * which anyone may then read and write.
   */
  readonly owner?: string | null;
}

export interface SaveResult {
  readonly updatedAt: string;
  /** False when the stored content already matched — saves a needless write. */
  readonly changed: boolean;
}

/**
 * Everything a reconnecting client needs to become current.
 *
 * See {@link Database.readForClient} for why the two shapes exist and what goes
 * wrong if the wrong one is chosen.
 */
export type ClientCatchUp =
  | {
      readonly kind: 'ops';
      /** Operations strictly after the client's cursor. */
      readonly ops: Operation[];
      /** Cursor the client should resume from. */
      readonly seq: number;
    }
  | {
      /**
       * Encrypted frames strictly after the client's cursor. See ADR-0014.
       *
       * A third kind rather than an optional `frames` on the first, for the same reason
       * the inbound message types are separate: a caller that handles `ops` cannot
       * accidentally handle `frames` too, and a document that is encrypted can never be
       * served by a path that does not know it.
       */
      readonly kind: 'ops-enc';
      readonly frames: EncryptedOperationFrame[];
      readonly seq: number;
    }
  | {
      readonly kind: 'snapshot';
      /** State at `seq`. The client must REPLACE its document with this. */
      readonly snapshot: DocumentSnapshot;
      /** Operations recorded after the snapshot. */
      readonly ops: Operation[];
      readonly seq: number;
    };

/**
 * Schema migrations.
 *
 * Applied in order, tracked in `_migrations`, and each runs inside a
 * transaction so a partial failure cannot leave the schema half-migrated.
 * Migrations are append-only: never edit a shipped one, add another.
 */
const MIGRATIONS: readonly { readonly name: string; readonly sql: string }[] = [
  {
    name: '0001_documents',
    sql: `
      CREATE TABLE IF NOT EXISTS documents (
        id          TEXT PRIMARY KEY,
        title       TEXT        NOT NULL DEFAULT 'Untitled',
        content     TEXT        NOT NULL DEFAULT '',
        clock       BIGINT      NOT NULL DEFAULT 0,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Title search is the Phase 5 list view; index it now so adding it later
      -- does not require a migration on a populated table.
      CREATE INDEX IF NOT EXISTS documents_title_idx ON documents (title);
      CREATE INDEX IF NOT EXISTS documents_updated_at_idx ON documents (updated_at DESC);
    `,
  },
  {
    name: '0002_document_ops',
    sql: `
      -- The authoritative representation of a document body.
      --
      -- Phase 1 stored plain text in documents.content. From Phase 4 the
      -- operation log is the source of truth and content is a derived cache:
      -- a client that has been offline for a week reconciles by replaying
      -- operations, never by diffing text. See ADR-0009.
      --
      -- seq is per-document and monotonic. It is the replay cursor a
      -- reconnecting client resumes from, which is why it is part of the primary
      -- key rather than a per-site clock.
      CREATE TABLE IF NOT EXISTS document_ops (
        document_id TEXT        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        seq         BIGINT      NOT NULL,
        site        TEXT        NOT NULL,
        op          JSONB       NOT NULL,
        element_key TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (document_id, seq)
      );

      -- Replay always asks for "everything after N", so this is the index that
      -- makes catching up cheap.
      CREATE INDEX IF NOT EXISTS document_ops_catchup_idx
        ON document_ops (document_id, seq);

      -- Deduping on redelivery, enforced rather than assumed. A relay that
      -- reconnects can hand us the same operation twice; applying it twice to a
      -- CRDT is harmless, but storing it twice would make seq a lie and every
      -- later resume-from-cursor would skip or repeat an operation.
      CREATE UNIQUE INDEX IF NOT EXISTS document_ops_element_idx
        ON document_ops (document_id, element_key);
    `,
  },
  {
    name: '0003_document_snapshots',
    sql: `
      -- Compaction state. See ADR-0011.
      --
      -- A snapshot stores the live ELEMENT SET with its IDs preserved, not the
      -- text. That distinction is the whole design: RGA anchors an insert to the
      -- element its origin names, so a text-only snapshot would leave every
      -- subsequent operation unplaceable and the peer silently behind.
      --
      -- Only the newest snapshot per document is kept. An older one can never be
      -- served to anyone, because a peer at an older cursor is served the newest
      -- snapshot plus the operations after it.
      CREATE TABLE IF NOT EXISTS document_snapshots (
        document_id TEXT        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        seq         BIGINT      NOT NULL,
        elements    JSONB       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (document_id)
      );

      -- One row per document, so the primary key already gives an O(1) lookup.
      -- A secondary index would only cost write time.
      COMMENT ON TABLE document_snapshots IS
        'Newest compaction snapshot per document. Replaces document_ops below its seq.';
    `,
  },
  {
    name: '0004_document_ownership',
    sql: `
      -- Who may touch a document. See ADR-0012.
      --
      -- Added as a migration rather than into 0001 because 0001 has shipped. A
      -- migration is append-only: editing a shipped one would leave existing
      -- databases on a schema no code expects.
      --
      -- owner IS NULL means UNOWNED, which means anyone may read and write. That
      -- is the pre-authentication behaviour and it is deliberately preserved, so
      -- every document created before this migration keeps working instead of
      -- becoming unreachable. claimOwnership() is how one becomes owned.
      --
      -- The alternative -- NOT NULL with a backfill -- would lock every existing
      -- document to an arbitrary sentinel owner, which is ownership by accident
      -- rather than by decision.
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner TEXT;

      -- Explicit grants. A collaborative editor where only the creator may write
      -- is not a collaborative editor, and building a share UI is CRUD, so the
      -- grant is the smallest thing that makes collaboration possible.
      CREATE TABLE IF NOT EXISTS document_collaborators (
        document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        subject     TEXT NOT NULL,
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (document_id, subject)
      );

      -- Authorisation reads every grant for one document. The primary key already
      -- serves that as an index scan, so this only exists to cover the reverse
      -- question: "what can this subject reach?", which the list endpoint asks.
      CREATE INDEX IF NOT EXISTS document_collaborators_subject_idx
        ON document_collaborators (subject);

      COMMENT ON COLUMN documents.owner IS
        'Subject that created this document. NULL means unowned and world-writable.';
      COMMENT ON TABLE document_collaborators IS
        'Explicit access grants. Owner is not repeated here; see canAccess.';
    `,
  },
  {
    name: '0005_document_encryption',
    sql: `
      -- Whether this document's operations are ciphertext. See ADR-0014.
      --
      -- The server stores and relays encrypted operations without ever decrypting them,
      -- which costs it two capabilities it otherwise has:
      --
      --   - compaction, because createSnapshot walks the live ELEMENT SET (ADR-0011)
      --   - the documents.content cache, because materialising it means replaying the
      --     log, and the log is ciphertext
      --
      -- So this flag is not decoration. It is how those two paths know to decline
      -- rather than produce garbage.
      --
      -- ONE-WAY ON PURPOSE. Set true by the first encrypted frame and never cleared,
      -- so a document cannot be flipped back and forth between modes. Two reasons:
      --
      --   - Flipping back would let anyone the server grants write access silently
      --     re-enable plaintext storage on a document its authors believed was private.
      --   - A document with a mixed log has no defined replay: the plaintext prefix and
      --     the ciphertext suffix do not combine into anything, and serving one to a
      --     client expecting the other produces a document missing its first half.
      --
      -- Once a document is encrypted it stays encrypted, and losing the key loses the
      -- document. That is the feature working, not a failure mode.
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;

      COMMENT ON COLUMN documents.encrypted IS
        'True once an encrypted frame has been stored. One-way; never reset to false.';
    `,
  },
];

/**
 * Outcome of a grant attempt.
 *
 * A union rather than a boolean, because the cases need different answers and
 * conflating them is a real bug rather than a tidiness preference. The benchmark
 * harness found this: re-running `setup()` against a warm database re-granted access
 * that already existed, and the API answered 400 as though the request were malformed.
 * A client retrying a grant got an error for something that had already succeeded.
 */
export type GrantResult =
  /** Access was not previously held and is now. */
  | { readonly outcome: 'granted' }
  /** Access was already held. Not an error: a grant is idempotent. */
  | { readonly outcome: 'already-granted' }
  /** No such document, so nothing was granted and none was created. */
  | { readonly outcome: 'no-document' }
  /** The subject cannot be stored, so the request was never valid. */
  | { readonly outcome: 'invalid-subject' }
  /** The caller does not own the document. */
  | { readonly outcome: 'not-owner' };
export class Database {
  readonly #pg: PGlite;

  /**
   * Rows a document's log may hold before new elements are refused, or null for no cap.
   *
   * Null rather than Infinity because a test can then say "no cap" by passing `null` and mean
   * it, while `Number.POSITIVE_INFINITY` would make every comparison a NaN-adjacent special case.
   *
   * Set at open time rather than read from the environment here, because this class is also
   * constructed directly by tests with a deliberate small cap; a cap that could only arrive from
   * `process.env` would be untestable at any size small enough to reach.
   */
  readonly #maxDocumentElements: number | null;

  private constructor(pg: PGlite, maxDocumentElements: number | null) {
    this.#pg = pg;
    this.#maxDocumentElements = maxDocumentElements;
  }

  /**
   * Open the database and bring the schema up to date.
   *
   * @param dataDir persistence location. Omit for a throwaway in-memory
   *   database, which is what the tests use — it is discarded on close, so tests
   *   cannot leak state into one another.
   * @param options.maxDocumentElements element cap per document. Omitted means the shipped
   *   default; pass `null` for no cap, which is only for tests that need to build a document
   *   past a million rows. The real server passes the value it resolved from the environment,
   *   so this class never reads `process.env` itself.
   */
  static async open(
    dataDir?: string,
    options: { readonly maxDocumentElements?: number | null } = {},
  ): Promise<Database> {
    // Note: PGlite has no ':memory:' pseudo-path. Undefined selects its
    // internal in-memory filesystem; any string is treated as a real directory
    // and created on disk, so passing ':memory:' silently wrote a directory
    // literally named ':memory:'.
    const pg = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
    const cap =
      options.maxDocumentElements === undefined
        ? DEFAULT_LIMITS.maxDocumentElements
        : options.maxDocumentElements;
    const db = new Database(pg, cap);
    await db.#migrate();
    return db;
  }

  /**
   * Report a startup misconfiguration instead of crashing with a bare ENOENT.
   *
   * PGlite creates its own leaf directory but not the parent chain, so a nested
   * path like `./.data/pgdata` fails on a fresh clone with an error that points
   * at the wrong thing entirely. Creating the parent up front turns a
   * confusing runtime crash into a non-event.
   */
  static async openAt(
    dataDir: string,
    options: { readonly maxDocumentElements?: number | null } = {},
  ): Promise<Database> {
    await mkdir(dirname(resolve(dataDir)), { recursive: true });
    return Database.open(dataDir, options);
  }

  async #migrate(): Promise<void> {
    await this.#pg.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const result = await this.#pg.query<{ name: string }>('SELECT name FROM _migrations');
    const applied = new Set(result.rows.map((row: { name: string }) => row.name));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) {
        continue;
      }

      // One statement batch per transaction: a failure leaves no partial state.
      await this.#pg.exec('BEGIN');
      try {
        await this.#pg.exec(migration.sql);
        await this.#pg.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
        await this.#pg.exec('COMMIT');
      } catch (error) {
        await this.#pg.exec('ROLLBACK');
        throw new Error(`Migration ${migration.name} failed`, { cause: error });
      }
    }

    await this.#seedLegacyDocuments();
  }

  /**
   * Give every document whose text has no operation log behind it one.
   *
   * A Phase 1 document is a row of plain text with no operations. Once the log is
   * authoritative, such a row is a document every client treats as empty, which
   * would silently erase the user's work on the first sync.
   *
   * The existing text is converted into seed operations under a deterministic
   * site derived from the document id. Deterministic matters: two servers
   * backfilling the same row must produce identical element IDs, or a client that
   * synced against one would see the text twice against the other.
   *
   * Idempotent, so running it on every boot is free and running it after a crash
   * is safe. Exposed rather than private so the tests can drive it directly, and
   * so a future admin endpoint can repair a log without a migration.
   */
  async backfillOperationLogs(): Promise<void> {
    await this.#seedLegacyDocuments();
  }

  /**
   * Give every document created before Phase 4 an operation log.
   *
   * See {@link Database.backfillOperationLogs}.
   */
  async #seedLegacyDocuments(): Promise<void> {
    const pending = await this.#pg.query<{ id: string; content: string }>(
      `SELECT d.id, d.content
       FROM documents d
       WHERE d.content <> ''
         AND NOT EXISTS (SELECT 1 FROM document_ops o WHERE o.document_id = d.id)
       ORDER BY d.id`,
    );

    for (const row of pending.rows) {
      // The materialised text is passed along so the cache and the log are
      // written together; a document whose cache says X but whose log says
      // nothing is exactly the inconsistency this backfill exists to remove.
      await this.appendOps(row.id, initialOperations(row.id, row.content), {
        materializedText: row.content,
      });
    }
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    const result = await this.#pg.query<DocumentRow>(
      `INSERT INTO documents (id, title, content, owner)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, content, clock, updated_at, owner, encrypted`,
      // Explicit fallbacks rather than relying on column DEFAULT. Postgres
      // applies a DEFAULT only when the column is *omitted* from the INSERT;
      // binding NULL passes a real NULL through, which violates NOT NULL.
      [input.id, input.title ?? 'Untitled', input.content ?? '', input.owner ?? null],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('INSERT returned no row');
    }

    // A document created with a body needs an operation log immediately. Left
    // unlogged, it would look empty to every client until the boot-time backfill
    // noticed, which is a window where a collaborator's text could be duplicated
    // or lost depending on who connected first.
    if (row.content !== '') {
      await this.appendOps(row.id, initialOperations(row.id, row.content), {
        materializedText: row.content,
      });
    }

    return toRecord(row);
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    const result = await this.#pg.query<DocumentRow>(
      'SELECT id, title, content, clock, updated_at, owner, encrypted FROM documents WHERE id = $1',
      [id],
    );

    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Every document, regardless of owner.
   *
   * NOT wired to the HTTP list endpoint. A global list handed to an authenticated
   * caller discloses every title in the database to anyone who asks, which would be
   * a new leak created by adding authentication rather than closed by it. The
   * endpoint uses {@link listDocumentsFor}.
   *
   * Kept for tests, the boot-time backfill, and administrative tools, all of which
   * already have database access by definition.
   */
  async listDocuments(limit = 50): Promise<DocumentRecord[]> {
    // Parameterised, not interpolated: `limit` is user-controlled from Phase 5.
    //
    // The `id` tiebreaker is not decoration. `now()` is the *transaction* start
    // time, so every statement in one transaction stamps the same value — and
    // PGlite batches aggressively enough on CI that three sequential calls can
    // share a timestamp. Postgres then returns tied rows in whatever order the heap
    // gives it.
    //
    // Without a tiebreaker the order of a list endpoint silently changes between
    // identical calls, which makes it impossible to paginate against. This cost
    // two failed CI runs before it was understood; see db.test.ts.
    const result = await this.#pg.query<DocumentRow>(
      `SELECT id, title, content, clock, updated_at, owner, encrypted
       FROM documents
       ORDER BY updated_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(toRecord);
  }

  /**
   * Documents one subject may reach: the ones it owns, the ones it was granted, and
   * the unowned ones.
   *
   * The unowned rows are included deliberately. They are readable by everyone, so
   * omitting them from the list while allowing them in the detail endpoint would
   * make a document exist and not exist depending on which endpoint you asked.
   *
   * The same `updated_at DESC, id DESC` ordering as {@link listDocuments}, for the
   * same reason: without the tiebreaker the order silently changes between
   * identical calls and the endpoint cannot be paginated against.
   */
  async listDocumentsFor(subject: string, limit = 50): Promise<DocumentRecord[]> {
    const result = await this.#pg.query<DocumentRow>(
      `SELECT d.id, d.title, d.content, d.clock, d.updated_at, d.owner
       FROM documents d
       WHERE d.owner IS NULL
          OR d.owner = $1
          OR EXISTS (
            SELECT 1 FROM document_collaborators c
             WHERE c.document_id = d.id AND c.subject = $1
          )
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT $2`,
      [subject, limit],
    );

    return result.rows.map(toRecord);
  }

  /**
   * May `subject` read and write `documentId`?
   *
   * The single authorisation decision. Both the HTTP API and the WebSocket relay
   * call this, which is the point: two implementations of "may I touch this
   * document" would eventually disagree, and the one that disagrees in the
   * permissive direction is the one nobody notices.
   *
   * A document that does not exist returns false, so callers cannot use this to
   * probe which ids are real. `DOCUMENT_NOT_FOUND` is then only reachable by an
   * owner or a collaborator, which is the only situation where it is safe to say.
   *
   * Unowned documents return true for everyone. See ADR-0012 for why that is the
   * honest default rather than a hole to route around.
   */
  async canAccess(documentId: string, subject: string): Promise<boolean> {
    const result = await this.#pg.query<{ allowed: boolean }>(
      `SELECT TRUE AS allowed
         FROM documents d
        WHERE d.id = $1
          AND (d.owner IS NULL
               OR d.owner = $2
               OR EXISTS (
                 SELECT 1 FROM document_collaborators c
                  WHERE c.document_id = d.id AND c.subject = $2
               ))
        LIMIT 1`,
      [documentId, subject],
    );

    return result.rows.length > 0;
  }

  /**
   * Grant `subject` access to a document.
   *
   * Validated here, not only where tokens are verified. This arrives from a request
   * body, and without the check arbitrary text went straight into a primary key that is
   * also rendered in a collaborator list. See shared/subject.ts.
   *
   * Ownership and existence are asked separately, and in that order, because a single
   * statement cannot tell "you may not" from "you already have". That costs one extra
   * round trip on a path that runs once per human sharing a link, which is not where the
   * system's time goes.
   *
   * A grant can never create a document: `no-document` is the answer when none exists.
   */
  async grantAccess(documentId: string, subject: string, grantedBy: string): Promise<GrantResult> {
    // Checked before the document is looked up on purpose. A caller with no access to a
    // document must not learn whether that document exists by trying to grant on it, so
    // the body-validation failure is reported even for an id that does not exist.
    if (!isValidSubject(subject)) {
      return { outcome: 'invalid-subject' };
    }

    const ownership = await this.#ownershipOf(documentId);

    if (ownership === null) {
      return { outcome: 'no-document' };
    }

    if (ownership.owner !== null && ownership.owner !== grantedBy) {
      return { outcome: 'not-owner' };
    }

    const existing = await this.#pg.query<{ subject: string }>(
      'SELECT subject FROM document_collaborators WHERE document_id = $1 AND subject = $2',
      [documentId, subject],
    );

    if (existing.rows.length > 0) {
      return { outcome: 'already-granted' };
    }

    const inserted = await this.#pg.query<{ document_id: string }>(
      `INSERT INTO document_collaborators (document_id, subject)
       VALUES ($1, $2)
       ON CONFLICT (document_id, subject) DO NOTHING
       RETURNING document_id`,
      [documentId, subject],
    );

    return inserted.rows.length > 0 ? { outcome: 'granted' } : { outcome: 'already-granted' };
  }

  /**
   * Ownership of a document.
   *
   * A record rather than a string with a sentinel, because `'unowned'` is just another
   * string and would collide with a subject that happens to be called `unowned`.
   *
   * @returns null when there is no such document, `{ owner: null }` for one nobody owns
   *   (which anyone may grant on, matching `canAccess`), and the subject otherwise.
   */
  async #ownershipOf(documentId: string): Promise<{ owner: string | null } | null> {
    const result = await this.#pg.query<{ owner: string | null }>(
      'SELECT owner FROM documents WHERE id = $1',
      [documentId],
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return { owner: row.owner };
  }
  /**
   * Remove a grant.
   *
   * @returns false when the document does not exist. A revocation that silently
   *   did nothing would leave access in place while reporting success.
   */
  async revokeAccess(documentId: string, subject: string, revokedBy: string): Promise<boolean> {
    // Same rule as grantAccess: an unusable subject can never have been granted, so
    // this cannot revoke anything. Refused rather than run as a pointless query.
    if (!isValidSubject(subject)) {
      return false;
    }

    const owned = await this.#isOwner(documentId, revokedBy);

    if (!owned) {
      return false;
    }

    await this.#pg.query(
      'DELETE FROM document_collaborators WHERE document_id = $1 AND subject = $2',
      [documentId, subject],
    );

    return true;
  }

  /**
   * Take ownership of an unowned document.
   *
   * This is how a document created before authentication, or created by a script,
   * stops being world-writable.
   *
   * `owner IS NULL` in the WHERE clause is the whole point. Without it this would be
   * a takeover: any subject could seize any document and lock out its creator.
   *
   * @returns false when the document does not exist or is already owned.
   */
  async claimOwnership(documentId: string, subject: string): Promise<boolean> {
    if (!isValidSubject(subject)) {
      return false;
    }

    const result = await this.#pg.query<{ id: string }>(
      `UPDATE documents SET owner = $2
        WHERE id = $1 AND owner IS NULL
       RETURNING id`,
      [documentId, subject],
    );

    return result.rows.length > 0;
  }

  /** Subjects explicitly granted access, excluding the owner. */
  async listCollaborators(documentId: string): Promise<string[]> {
    const result = await this.#pg.query<{ subject: string }>(
      'SELECT subject FROM document_collaborators WHERE document_id = $1 ORDER BY subject',
      [documentId],
    );

    return result.rows.map((row: { subject: string }) => row.subject);
  }

  async #isOwner(documentId: string, subject: string): Promise<boolean> {
    const result = await this.#pg.query<{ id: string }>(
      'SELECT id FROM documents WHERE id = $1 AND owner = $2',
      [documentId, subject],
    );

    return result.rows.length > 0;
  }

  /**
   * Delete every document, and everything that cascades from it.
   *
   * For tests that would otherwise boot a fresh in-memory Postgres per case. Booting
   * PGlite costs roughly two seconds, which dominates any suite with more than a
   * handful of cases. Truncating keeps genuine isolation, because `documents`
   * cascades to `document_ops`, `document_collaborators` and `document_snapshots`.
   *
   * Not exposed over HTTP. An endpoint that empties the database is the kind of thing
   * that gets added "temporarily" and then, well, stays.
   */
  async truncateAll(): Promise<void> {
    // RESTART IDENTITY too. A leftover sequence would make ids differ between runs
    // in a way that stays invisible until something asserts on them.
    await this.#pg.exec('TRUNCATE documents RESTART IDENTITY CASCADE');
  }

  /**
   * Persist document content.
   *
   * @param options.updatedAt overrides the timestamp. Exists for two honest
   *   reasons: restoring a document's real age on import, and letting a test
   *   establish a known ordering instead of hoping the database's clock
   *   advanced. `now()` is the transaction start time, so statements batched into
   *   one transaction share a timestamp — which means a test that creates three
   *   documents and asserts on their order is testing Postgres's batching
   *   behaviour, not this code.
   *
   * @returns `changed: false` when the stored content already matched, letting
   *   the client skip a redundant "Saved" notification on every autosave tick.
   */
  async saveDocument(
    id: string,
    content: string,
    options: { readonly updatedAt?: Date } = {},
  ): Promise<SaveResult | null> {
    // COALESCE so the default path is unchanged: an absent option binds null and
    // falls back to now(), whereas binding a literal now() from JS would use the
    // client's clock rather than the server's.
    const stamp = options.updatedAt ?? null;

    const result = await this.#pg.query<{ updated_at: Date; changed: boolean }>(
      `UPDATE documents
       SET content = $2, updated_at = COALESCE($3::timestamptz, now())
       WHERE id = $1 AND content IS DISTINCT FROM $2
       RETURNING updated_at`,
      [id, content, stamp],
    );

    const row = result.rows[0];
    if (row) {
      return { updatedAt: toIso(row.updated_at), changed: true };
    }

    // No row means either the document is missing or the content was identical.
    // Distinguish the two: only the former is an error.
    const existing = await this.#pg.query<{ updated_at: Date }>(
      'SELECT updated_at FROM documents WHERE id = $1',
      [id],
    );

    const existingRow = existing.rows[0];
    if (!existingRow) {
      return null;
    }

    return { updatedAt: toIso(existingRow.updated_at), changed: false };
  }

  async renameDocument(id: string, title: string): Promise<SaveResult | null> {
    const result = await this.#pg.query<{ updated_at: Date }>(
      'UPDATE documents SET title = $2, updated_at = now() WHERE id = $1 RETURNING updated_at',
      [id, title],
    );

    const row = result.rows[0];
    return row ? { updatedAt: toIso(row.updated_at), changed: true } : null;
  }

  async deleteDocument(id: string): Promise<boolean> {
    const result = await this.#pg.query('DELETE FROM documents WHERE id = $1', [id]);
    return (result.affectedRows ?? 0) > 0;
  }

  // ── Operation log ─────────────────────────────────────────────────────────
  //
  // The log is append-only and sequenced per document. `seq` is assigned by the
  // database rather than by the client, because it doubles as the replay cursor:
  // if clients chose their own sequence numbers, two clients could claim the same
  // one and the ordering guarantee would be gone.

  /**
   * Append operations, ignoring any already present.
   *
   * Idempotence is not an optimisation here. A relay reconnects, a client
   * replays its outbox, and the same operation arrives twice. Applying it twice
   * to a CRDT is harmless, but storing it twice would make `seq` a lie and every
   * subsequent resume-from-cursor would skip or repeat an operation.
   *
   * Dedup key is the acted-on element's `(site, clock)`, which is globally unique
   * because element IDs are.
   *
   * The whole read-modify-write runs under an in-process lock. `SELECT ... FOR
   * UPDATE` would be the portable answer, but PGlite is a single embedded
   * connection: two callers each opening a transaction interleave their BEGIN and
   * COMMIT statements and the isolation is gone. A mutex is honest about what is
   * actually being protected. If this ever runs against a networked Postgres with
   * several server processes, the row lock has to come back.
   *
   * @param options.materializedText the document body after these operations,
   *   supplied by the caller because it already holds the replica. Passing it
   *   here keeps the operation log and the text cache in one transaction, which
   *   matters: a crash between the two writes would leave the cache stale, and
   *   the next HTTP GET would serve text that contradicts the log.
   * @returns the highest sequence actually stored, which is the cursor a client
   *   should resume from.
   */
  async appendOps(
    documentId: string,
    ops: readonly Operation[],
    options: { readonly materializedText?: string } = {},
  ): Promise<number> {
    if (ops.length === 0 && options.materializedText === undefined) {
      return this.#latestSeq(documentId);
    }

    return this.#serialise(() => this.#appendOpsLocked(documentId, ops, options));
  }

  /**
   * Append encrypted operations, ignoring any already present.
   *
   * ---------------------------------------------------------------------------
   * WHAT IS DIFFERENT FROM THE PLAINTEXT PATH, AND WHY
   * ---------------------------------------------------------------------------
   * Only two things, and both are forced rather than chosen:
   *
   *   - `element_key` and `site` come from the client, because the server cannot derive
   *     them from ciphertext. They are cleartext in the frame for exactly this reason,
   *     and `parseEncryptedFrame` has already checked that each agrees with the other.
   *   - No `materializedText`, because there is no text to materialise. The server cannot
   *     replay a log it cannot read.
   *
   * Everything else is deliberately identical: the same lock, the same per-document
   * sequence, the same `ON CONFLICT DO NOTHING`. Two implementations of "append and
   * dedupe" would be two places for seq to go wrong, and seq is the cursor every
   * reconnecting client resumes from.
   *
   * Mixing is refused rather than tolerated. A document with a plaintext prefix and a
   * ciphertext suffix has no defined replay, and serving either half to a client
   * expecting the other produces a document missing its first half with no error. So the
   * mode is decided by the first frame and never changes.
   *
   * @returns the highest sequence actually stored.
   */
  async appendEncryptedOps(
    documentId: string,
    frames: readonly EncryptedOperationFrame[],
  ): Promise<number> {
    if (frames.length === 0) {
      return this.#latestSeq(documentId);
    }

    return this.#serialise(() => this.#appendEncryptedOpsLocked(documentId, frames));
  }

  async #appendEncryptedOpsLocked(
    documentId: string,
    frames: readonly EncryptedOperationFrame[],
  ): Promise<number> {
    const existing = await this.getDocument(documentId);

    if (existing === null) {
      throw new Error(`appendEncryptedOps on a document that does not exist: ${documentId}`);
    }

    // NO encryption check here, deliberately. Appending encrypted frames to a document
    // that already holds encrypted frames is the ordinary case - every keystroke after
    // the first one does it. The guard belongs on the plaintext path, which is the one
    // that would actually mix the two.

    let seq = await this.#latestSeq(documentId);

    // Cap check before the loop, on the WHOLE batch.
    //
    // Checking per row would let a batch half-apply and then throw: the client would lose
    // some of its edits and be told the batch failed, with no way to know which half landed.
    // One check, one outcome.
    this.#assertRoom(documentId, seq, frames.filter((f) => f.type === 'insert').length);

    for (const frame of frames) {
      const result = await this.#pg.query<{ seq: string | number }>(
        `INSERT INTO document_ops (document_id, seq, site, op, element_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (document_id, element_key) DO NOTHING
         RETURNING seq`,
        // The frame is stored whole, exactly as it arrived. Re-serialising it would be a
        // chance to alter a frame that clients have already authenticated, and a client
        // would then fail to decrypt its own history.
        [documentId, seq + 1, frame.site, JSON.stringify(frame), frame.key],
      );

      const stored = result.rows[0];

      if (stored) {
        seq = toClock(stored.seq);
      }
    }

    // One-way. Once true, every later code path skips compaction and the text cache,
    // because both need a plaintext this process does not have.
    await this.#pg.query('UPDATE documents SET encrypted = true WHERE id = $1', [documentId]);

    return seq;
  }

  /** Tail of the in-process write queue. See {@link Database.appendOps}. */
  #writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * Refuse growth that would push a document past its element cap.
   *
   * ---------------------------------------------------------------------------
   * WHY `seq` IS A SAFE UPPER BOUND ON STORED ROWS
   * ---------------------------------------------------------------------------
   * `seq` is the highest sequence number ever handed out for the document, and it never moves
   * backwards - not when compaction prunes rows (it keeps the floor, and a snapshot preserves
   * element ids), and not when a duplicate is deduplicated (`ON CONFLICT DO NOTHING` does not
   * consume a number). So `seq` is the high-water mark of rows this document has ever held, and
   * therefore an upper bound on the rows it holds now.
   *
   * Over-counting is safe here and under-counting would not be: compaction can only make the
   * real row count SMALLER than `seq`, never larger, so a check against `seq` can refuse an
   * append that would technically have fitted. It cannot admit one that would not.
   *
   * ---------------------------------------------------------------------------
   * WHY ONLY INSERTS COUNT
   * ---------------------------------------------------------------------------
   * A document at its cap is still editable, and the way to edit it is to delete. Refusing
   * tombstones as well would leave a full document with no way to become smaller, which turns a
   * quota into a dead end: the user can neither add nor remove. So `growth` counts inserts only,
   * and deletions stay available at the cap so compaction can eventually reclaim the space.
   *
   * The encrypted frames carry their type in cleartext (`EncryptedOperationFrame.type`), which
   * is what lets this rule apply identically to a document the server cannot read. The design
   * would not support a per-element cap otherwise, which is a fair thing to note: this is a
   * shape that had to be chosen earlier for a rule written later.
   */
  #assertRoom(documentId: string, seq: number, growth: number): void {
    if (this.#maxDocumentElements === null || growth <= 0) {
      return;
    }

    if (seq + growth <= this.#maxDocumentElements) {
      return;
    }

    throw new DocumentTooLargeError(documentId, this.#maxDocumentElements);
  }

  /**
   * Run a write exclusively, in call order.
   *
   * A promise chain rather than a mutex class: appending to the tail is the
   * whole mechanism, and it cannot deadlock because nothing here ever takes two
   * locks at once.
   */
  async #serialise<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#writeQueue.then(work, work);
    // The tail must not reject, or one failed write would poison every write
    // queued behind it with the same error.
    this.#writeQueue = result.catch(() => undefined);

    return result;
  }

  async #appendOpsLocked(
    documentId: string,
    ops: readonly Operation[],
    options: { readonly materializedText?: string },
  ): Promise<number> {
    // Refuse plaintext on an encrypted document. The reverse of the guard in
    // #appendEncryptedOpsLocked, and for the same reason: a mixed log has no replay.
    //
    // This is not a hypothetical. A client that opens a shared link without its key has
    // no encrypted frame to send, and the natural-looking fallback is to send plaintext
    // anyway. That would put readable text into a document its other participants chose
    // to encrypt, which is precisely the harm the feature exists to prevent.
    const existing = await this.getDocument(documentId);

    if (existing === null) {
      throw new Error(`appendOps on a document that does not exist: ${documentId}`);
    }

    if (existing.encrypted) {
      throw new EncryptedDocumentError(documentId);
    }

    await this.#pg.exec('BEGIN');
    try {
      let seq = await this.#latestSeq(documentId);

      // See #appendEncryptedOpsLocked for why the whole batch is checked before any of it is
      // written. Same rule, same reason.
      this.#assertRoom(
        documentId,
        seq,
        ops.reduce((count, op) => (op.type === 'insert' ? count + 1 : count), 0),
      );

      for (const op of ops) {
        // ON CONFLICT DO NOTHING rather than an existence check: one round trip
        // per batch instead of one per operation, and race-free.
        //
        // RETURNING tells us whether the row was actually written. Without it,
        // a redelivered operation would still consume a sequence number, and the
        // high-water mark returned to the client would run ahead of the log. The
        // cursor would still be safe (gaps are harmless to a "since N" query) but
        // it would no longer mean what it says, which is worse than a cost.
        const result = await this.#pg.query<{ seq: string | number }>(
          `INSERT INTO document_ops (document_id, seq, site, op, element_key)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (document_id, element_key) DO NOTHING
           RETURNING seq`,
          [documentId, seq + 1, elementSite(op), JSON.stringify(op), elementKey(op)],
        );

        const stored = result.rows[0];
        if (stored) {
          seq = toClock(stored.seq);
        }
      }

      // documents.clock is the highest sequence applied. Kept in step so the
      // existing HTTP API can report progress without reading the log.
      await this.#pg.query(
        `UPDATE documents
         SET clock = GREATEST(clock, $2),
             content = COALESCE($3, content),
             updated_at = now()
         WHERE id = $1`,
        [documentId, seq, options.materializedText ?? null],
      );

      await this.#pg.exec('COMMIT');
      return seq;
    } catch (error) {
      await this.#pg.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Rebuild `documents.content` from the operation log.
   *
   * Exists to prove the text cache is genuinely derived. The relay keeps content
   * current on every append, so this is a repair tool and a test oracle rather
   * than part of the write path.
   */
  async materializeContent(documentId: string): Promise<string | null> {
    const snapshot = await this.readSnapshot(documentId);
    const ops = await this.readAllOps(documentId);

    if (snapshot === null && ops.length === 0) {
      const existing = await this.getDocument(documentId);

      if (existing === null) {
        return null;
      }

      await this.saveDocument(documentId, '');
      return '';
    }

    const doc = new RgaDocument(seedSiteFor(documentId));
    let unplaced = 0;

    // Snapshot FIRST, then the log. Since Phase 5 compaction prunes operations
    // below the newest snapshot, so replaying the log alone reconstructs only the
    // part that has not been compacted — on a fully compacted document, nothing.
    //
    // This failure is silent and destructive in a specific way: the method also
    // WRITES its result back to `documents.content`. Replaying only the log after
    // a compaction computed an empty document and overwrote a good cache with it.
    if (snapshot !== null) {
      unplaced += doc.applyInAnyOrder(
        snapshotToOperations({ seq: snapshot.seq, elements: snapshot.elements }),
      );
    }

    unplaced += doc.applyInAnyOrder(ops);

    if (unplaced > 0) {
      // A log that cannot be replayed is corrupt, and quietly writing a partial
      // document would turn a recoverable bug into permanent data loss.
      throw new Error(
        `Cannot materialise ${documentId}: ${unplaced} operation(s) could not be placed.`,
      );
    }

    const text = doc.toText();
    await this.saveDocument(documentId, text);

    return text;
  }

  /**
   * What a reconnecting client needs to become current.
   *
   * Two shapes, and choosing between them is the whole point of compaction
   * existing:
   *
   *   - `ops` — a delta from the client's cursor. The ordinary case.
   *   - `snapshot` — the client's cursor is below the newest snapshot, so the
   *     operations it is missing have been pruned and no delta can be produced.
   *     It is given the snapshot plus whatever came after, and must REPLACE its
   *     document rather than add to it.
   *
   * The failure this avoids is subtle and silent: serving a delta to a client
   * below the floor produces a document that is missing everything compacted
   * away, and nothing reports an error. The client's own operations still apply,
   * so it looks alive — it is just quietly wrong.
   */
  async readForClient(documentId: string, sinceSeq: number, limit = 1_000): Promise<ClientCatchUp> {
    // An encrypted document NEVER takes the snapshot branch, and cannot: the server
    // holds no elements, because it cannot read the log it stored.
    //
    // That is fine rather than broken. Snapshots only exist because compaction creates a
    // hole in the log, and compaction is skipped for encrypted documents (see
    // `maybeCompact`). With no hole, every sequence from 1 exists, so a delta from any
    // cursor is complete and the snapshot path is unreachable.
    //
    // If that ever stops being true - a compaction path that works on ciphertext, say -
    // this branch has to grow a fourth case, and the test that asserts an encrypted
    // document never returns `kind: 'snapshot'` is what will notice.
    const document = await this.getDocument(documentId);

    if (document?.encrypted === true) {
      const delta = await this.readEncryptedOpsSince(documentId, sinceSeq, limit);

      return { kind: 'ops-enc', frames: delta.frames, seq: delta.seq };
    }

    const snapshot = await this.readSnapshot(documentId);
    const base = snapshot?.seq ?? 0;

    // Strictly below: a client sitting exactly on the snapshot boundary has
    // everything the snapshot holds and wants only what came after.
    if (snapshot !== null && sinceSeq < base) {
      const delta = await this.readOpsSince(documentId, base, limit);

      return {
        kind: 'snapshot',
        snapshot: { seq: base, elements: snapshot.elements },
        ops: delta.ops,
        seq: delta.seq,
      };
    }

    const delta = await this.readOpsSince(documentId, sinceSeq, limit);

    return { kind: 'ops', ops: delta.ops, seq: delta.seq };
  }

  /**
   * Operations strictly after `sinceSeq`, in sequence order.
   *
   * @param limit hard cap on the batch size, so a client that has been offline
   *   for a week cannot be handed a million operations in one frame. The caller
   *   loops until fewer than `limit` come back.
   */
  async readOpsSince(
    documentId: string,
    sinceSeq: number,
    limit = 1_000,
  ): Promise<{ ops: Operation[]; seq: number }> {
    const result = await this.#pg.query<{ seq: string | number; op: unknown }>(
      `SELECT seq, op
       FROM document_ops
       WHERE document_id = $1 AND seq > $2
       ORDER BY seq
       LIMIT $3`,
      [documentId, sinceSeq, limit],
    );

    const ops = result.rows.map((row) => row.op as Operation);
    const last = result.rows.at(-1);

    return { ops, seq: last ? toClock(last.seq) : sinceSeq };
  }

  /** Every operation for a document, in sequence order. Used by tests and tools. */
  async readAllOps(documentId: string): Promise<Operation[]> {
    const result = await this.#pg.query<{ op: unknown }>(
      'SELECT op FROM document_ops WHERE document_id = $1 ORDER BY seq',
      [documentId],
    );

    return result.rows.map((row) => row.op as Operation);
  }

  /**
   * Encrypted frames strictly after `sinceSeq`, in sequence order.
   *
   * @returns frames exactly as they were stored. They are not re-serialised, not
   *   re-ordered internally, and not validated beyond what arrived: this process cannot
   *   check them, and rewriting them would invalidate the tag a client authenticates.
   *   The stored value is returned as parsed JSON, so the bytes are preserved.
   */
  async readEncryptedOpsSince(
    documentId: string,
    sinceSeq: number,
    limit = 1_000,
  ): Promise<{ frames: EncryptedOperationFrame[]; seq: number }> {
    const result = await this.#pg.query<{ seq: string | number; op: unknown }>(
      'SELECT seq, op FROM document_ops WHERE document_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
      [documentId, sinceSeq, limit],
    );

    const frames = result.rows.map((row) => row.op as EncryptedOperationFrame);
    const last = result.rows.at(-1);

    return { frames, seq: last === undefined ? sinceSeq : toClock(last.seq) };
  }

  /** Highest sequence stored for a document, or 0 when it has no operations. */
  async #latestSeq(documentId: string): Promise<number> {
    const result = await this.#pg.query<{ seq: string | number | null }>(
      'SELECT MAX(seq) AS seq FROM document_ops WHERE document_id = $1',
      [documentId],
    );

    const row = result.rows[0];
    return row?.seq === null || row?.seq === undefined ? 0 : toClock(row.seq);
  }

  // ── Compaction ─────────────────────────────────────────────────────────────
  //
  // Snapshot-then-prune, gated on causal stability (ADR-0011). The order matters:
  // the snapshot is written and committed BEFORE any operation is deleted, so a
  // crash in between leaves both — wasteful, never incorrect.

  /**
   * Store a snapshot, replacing any older one.
   *
   * UPSERT rather than delete-then-insert so there is never a moment with no
   * snapshot. A window without one would serve a peer below the floor a delta it
   * cannot use.
   */
  async writeSnapshot(
    documentId: string,
    snapshot: { readonly seq: number; readonly elements: readonly unknown[] },
  ): Promise<void> {
    return this.#serialise(() =>
      this.#pg
        .query(
          `INSERT INTO document_snapshots (document_id, seq, elements)
         VALUES ($1, $2, $3)
         ON CONFLICT (document_id)
         DO UPDATE SET seq = EXCLUDED.seq, elements = EXCLUDED.elements, created_at = now()`,
          [documentId, snapshot.seq, JSON.stringify(snapshot.elements)],
        )
        .then(() => undefined),
    );
  }

  /** Newest snapshot for a document, or `null` when it has never compacted. */
  async readSnapshot(
    documentId: string,
  ): Promise<{ readonly seq: number; readonly elements: readonly SnapshotElement[] } | null> {
    const result = await this.#pg.query<{ seq: string | number; elements: unknown }>(
      'SELECT seq, elements FROM document_snapshots WHERE document_id = $1',
      [documentId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return { seq: toClock(row.seq), elements: row.elements as SnapshotElement[] };
  }

  /**
   * Delete operations at or below `seq`.
   *
   * @returns how many rows were actually removed. Reported rather than assumed, so
   *   a caller can tell a working compaction from one that did nothing.
   */
  async pruneOpsThrough(documentId: string, seq: number): Promise<number> {
    return this.#serialise(async () => {
      const result = await this.#pg.query(
        'DELETE FROM document_ops WHERE document_id = $1 AND seq <= $2',
        [documentId, seq],
      );

      return result.affectedRows ?? 0;
    });
  }

  /** Row counts for a document, used by the compaction trigger and diagnostics. */
  async logStats(
    documentId: string,
  ): Promise<{ readonly ops: number; readonly snapshotSeq: number | null }> {
    const result = await this.#pg.query<{
      ops: string | number | null;
      snapshot_seq: string | number | null;
    }>(
      `SELECT (SELECT COUNT(*) FROM document_ops WHERE document_id = $1) AS ops,
              (SELECT seq FROM document_snapshots WHERE document_id = $1) AS snapshot_seq`,
      [documentId],
    );

    const row = result.rows[0];

    return {
      ops: row?.ops === null || row?.ops === undefined ? 0 : toClock(row.ops),
      snapshotSeq:
        row?.snapshot_seq === null || row?.snapshot_seq === undefined
          ? null
          : toClock(row.snapshot_seq),
    };
  }

  async close(): Promise<void> {
    await this.#pg.close();
  }
}

/** Raw row shape, matching what PGlite returns. */
interface DocumentRow {
  id: string;
  title: string;
  content: string;
  clock: string | number;
  updated_at: Date;
  owner: string | null;
  encrypted: boolean;
}

/**
 * Raised when a write would push a document past its element cap.
 *
 * A named error, for the same reason as {@link EncryptedDocumentError}: the relay has to answer
 * the client with something it can act on, and "DOCUMENT_TOO_LARGE" is actionable in a way
 * "append failed" is not. The client can still delete from the document, which is the only way
 * out of being full, so this is a temporary refusal of GROWTH rather than a lock.
 *
 * `documentId` and `limit` are on the error rather than in the message so the caller can decide
 * what to say without parsing a sentence.
 */
export class DocumentTooLargeError extends Error {
  readonly documentId: string;
  readonly limit: number;

  constructor(documentId: string, limit: number) {
    super(
      `Document ${documentId} is at its ${limit} element limit. It can still be read and ` +
        'edited by deleting from it.',
    );
    this.name = 'DocumentTooLargeError';
    this.documentId = documentId;
    this.limit = limit;
  }
}

/**
 * Raised when an operation would cross a document's encryption boundary.
 *
 * A named error rather than a generic one so the relay can answer with something
 * actionable. "Cannot append: mixed modes" is not something a client can fix;
 * "this document is encrypted, so this operation must be encrypted too" is.
 *
 * Deliberately thrown rather than silently ignored. Ignoring a plaintext operation on an
 * encrypted document would look like success to the client while dropping their edit,
 * which is worse than refusing it.
 */
export class EncryptedDocumentError extends Error {
  readonly documentId: string;

  /**
   * Why it was refused.
   *
   * Optional because there is exactly one reason today. A caller that wants to branch
   * should read `documentId` and the message; forcing a reason string through every call
   * site would be a parameter nobody could use to make a different decision.
   */
  readonly reason = 'plaintext-on-encrypted-document' as const;

  constructor(documentId: string) {
    super(
      `Document ${documentId} is encrypted; plaintext operations cannot be appended to it. ` +
        'The client is probably missing the key from the link, and must not fall back to plaintext.',
    );
    this.name = 'EncryptedDocumentError';
    this.documentId = documentId;
  }
}

/**
 * Site that authored an operation.
 *
 * An insert names its own site; a delete names the site of the element it
 * tombstones. Both are needed to dedupe, and both are stable across redelivery.
 */
function elementSite(op: Operation): string {
  return op.type === 'insert' ? op.id.site : op.target.site;
}

/**
 * Globally unique key for the element an operation acts on.
 *
 * The operation TYPE is part of the key. An insert and a delete of the same
 * character share an element ID, and keying on the element alone would make the
 * delete look like a redelivered insert: it would be silently dropped and the
 * character would survive a deletion the user had already made.
 *
 * With the type included:
 *   - a redelivered insert  dedupes against itself
 *   - a redelivered delete  dedupes against itself
 *   - an insert and a delete of the same element both survive, which is correct
 */
function elementKey(op: Operation): string {
  const id = op.type === 'insert' ? op.id : op.target;
  return `${op.type === 'insert' ? 'i' : 'd'}:${id.site}@${id.clock}`;
}

/** Postgres returns `BIGINT` as a string to avoid precision loss. */
function toClock(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toIso(value: Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    clock: toClock(row.clock),
    updatedAt: toIso(row.updated_at),
    owner: row.owner,
    encrypted: row.encrypted,
  };
}
