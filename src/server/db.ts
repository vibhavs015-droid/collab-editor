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
    const result = await this.#pg.query<DocumentRow>(
      `SELECT id, title, content, clock, updated_at
       FROM documents
       ORDER BY updated_at DESC
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
