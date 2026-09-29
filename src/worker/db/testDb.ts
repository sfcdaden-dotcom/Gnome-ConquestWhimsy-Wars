/**
 * An in-memory `Db` for unit tests, on Node's built-in SQLite.
 *
 * D1 is SQLite, so the repositories and every constraint in migrations/ can be
 * exercised without the Workers runtime: this applies the REAL migration files,
 * in order, to a fresh in-memory database, and implements the D1 subset in
 * `db.ts` over it. Two D1 behaviours are reproduced on purpose:
 *
 *  - foreign keys are enforced (D1 enforces them; plain SQLite does not unless
 *    asked, so this asks);
 *  - `batch()` is one transaction — all statements or none.
 *
 * What it is NOT: the Workers runtime. Authentication gets tests through the
 * real Worker and local D1 as well (ACCOUNTS.md §9.5, requirement P2-2).
 *
 * Test-only. Nothing in the Worker imports this file.
 */

import { DatabaseSync } from 'node:sqlite';
import type { Db, DbResult, DbStatement, DbValue } from './db';

/** migrations/*.sql, as text, keyed by path. Resolved by Vite at test time. */
const MIGRATION_FILES = import.meta.glob('../../../migrations/*.sql', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export interface Migration {
  name: string;
  sql: string;
}

/** Every migration, in the order wrangler applies them (filename order). */
export function migrations(): Migration[] {
  return Object.entries(MIGRATION_FILES)
    .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf('/') + 1), sql }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface TestDb extends Db {
  /** The underlying connection, for tests that inspect SQLite directly. */
  readonly raw: DatabaseSync;
  /** Every `batch()` call made, as the SQL of its statements — for asserting how a repository talks to the database. */
  readonly batches: string[][];
}

class TestStatement implements DbStatement {
  private readonly db: DatabaseSync;
  readonly sql: string;
  private readonly values: DbValue[];

  constructor(db: DatabaseSync, sql: string, values: DbValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: DbValue[]): DbStatement {
    return new TestStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    return this.execute<T>();
  }

  async run(): Promise<DbResult> {
    return this.execute();
  }

  /**
   * Run and report like D1: rows (if any) and how many rows the statement
   * itself changed. `changes()` is only consulted when `total_changes()`
   * moved, so a read after a write does not report the write's count.
   */
  execute<T>(): DbResult<T> {
    const before = this.totalChanges();
    const results = this.db.prepare(this.sql).all(...this.values) as T[];
    const changes = this.totalChanges() === before ? 0 : Number(this.db.prepare('SELECT changes() AS n').get()?.n ?? 0);
    return { results, meta: { changes } };
  }

  private totalChanges(): number {
    return Number(this.db.prepare('SELECT total_changes() AS n').get()?.n ?? 0);
  }
}

/**
 * A fresh database with the migrations applied. `upTo` stops after the named
 * migration (inclusive), for testing a migration against the schema before it.
 */
export function createTestDb(options: { upTo?: string } = {}): TestDb {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const m of migrations()) {
    raw.exec(m.sql);
    if (m.name === options.upTo) break;
  }
  const batches: string[][] = [];
  return {
    raw,
    batches,
    prepare: (sql) => new TestStatement(raw, sql),
    async batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<DbResult<T>[]> {
      const list = statements as TestStatement[];
      batches.push(list.map((s) => s.sql));
      raw.exec('BEGIN');
      try {
        const out = list.map((s) => s.execute<T>());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
