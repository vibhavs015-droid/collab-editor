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

/** One saved document. */
export interface DocumentRecord {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  /** Highest CRDT clock applied. Always 0 until Phase 2. */
  readonly clock: number;
  readonly updatedAt: string;
}

export interface CreateDocumentInput {
  readonly id: string;
  /** Optional — defaults to `'Untitled'`, matching the column default. */
  readonly title?: string;
  readonly content?: string;
}

export interface SaveResult {
  readonly updatedAt: string;
  /** False when the stored content already matched — saves a needless write. */
  readonly changed: boolean;
}

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
      -- seq is per-document and monotonic. It is the cursor a reconnecting
      -- client resumes from, which is why it is part of the primary key rather
      -- than a per-site clock.
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
];

export class Database {
  readonly #pg: PGlite;

  private constructor(pg: PGlite) {
    this.#pg = pg;
  }

  /**
   * Open the database and bring the schema up to date.
   *
   * @param dataDir persistence location. Omit for a throwaway in-memory
   *   database, which is what the tests use — it is discarded on close, so tests
   *   cannot leak state into one another.
   */
  static async open(dataDir?: string): Promise<Database> {
    // Note: PGlite has no ':memory:' pseudo-path. Undefined selects its
    // internal in-memory filesystem; any string is treated as a real directory
    // and created on disk, so passing ':memory:' silently wrote a directory
    // literally named ':memory:'.
    const pg = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
    const db = new Database(pg);
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
  static async openAt(dataDir: string): Promise<Database> {
    await mkdir(dirname(resolve(dataDir)), { recursive: true });
    return Database.open(dataDir);
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
      `INSERT INTO documents (id, title, content)
       VALUES ($1, $2, $3)
       RETURNING id, title, content, clock, updated_at`,
      // Explicit fallbacks rather than relying on column DEFAULT. Postgres
      // applies a DEFAULT only when the column is *omitted* from the INSERT;
      // binding NULL passes a real NULL through, which violates NOT NULL.
      [input.id, input.title ?? 'Untitled', input.content ?? ''],
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
      'SELECT id, title, content, clock, updated_at FROM documents WHERE id = $1',
      [id],
    );

    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async listDocuments(limit = 50): Promise<DocumentRecord[]> {
    // Parameterised, not interpolated: `limit` is user-controlled from Phase 5.
    //
    // `id` is a tiebreaker, not decoration. Two documents written inside the same
    // clock tick have equal `updated_at`, and Postgres is free to return tied rows
    // in any order it likes — heap order, most often. A list endpoint whose order
    // silently changes between identical calls cannot be paginated against, and a
    // test asserting "newest first" on tied rows fails on a fast machine and passes
    // on a slow one, which is the worst possible failure mode for a test.
    const result = await this.#pg.query<DocumentRow>(
      `SELECT id, title, content, clock, updated_at
       FROM documents
       ORDER BY updated_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(toRecord);
  }

  /**
   * Persist document content.
   *
   * @returns `changed: false` when the stored content already matched, letting
   *   the client skip a redundant "Saved" notification on every autosave tick.
   */
  async saveDocument(id: string, content: string): Promise<SaveResult | null> {
    const result = await this.#pg.query<{ updated_at: Date; changed: boolean }>(
      `UPDATE documents
       SET content = $2, updated_at = now()
       WHERE id = $1 AND content IS DISTINCT FROM $2
       RETURNING updated_at`,
      [id, content],
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

  /** Tail of the in-process write queue. See {@link Database.appendOps}. */
  #writeQueue: Promise<unknown> = Promise.resolve();

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
    await this.#pg.exec('BEGIN');
    try {
      let seq = await this.#latestSeq(documentId);

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
    const ops = await this.readAllOps(documentId);

    if (ops.length === 0) {
      const existing = await this.getDocument(documentId);

      if (existing === null) {
        return null;
      }

      await this.saveDocument(documentId, '');
      return '';
    }

    const doc = new RgaDocument(seedSiteFor(documentId));
    const unplaced = doc.applyInAnyOrder(ops);

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

  /** Highest sequence stored for a document, or 0 when it has no operations. */
  async #latestSeq(documentId: string): Promise<number> {
    const result = await this.#pg.query<{ seq: string | number | null }>(
      'SELECT MAX(seq) AS seq FROM document_ops WHERE document_id = $1',
      [documentId],
    );

    const row = result.rows[0];
    return row?.seq === null || row?.seq === undefined ? 0 : toClock(row.seq);
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
  };
}
