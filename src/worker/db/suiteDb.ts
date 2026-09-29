/**
 * The database a repository suite runs against, whichever engine is under it.
 *
 * The identity and session suites run twice: on the in-memory SQLite adapter
 * (`testDb.ts`, inside `npm test`) and on real local D1 inside the Workers
 * runtime (`npm run test:workers`). That second run is the fidelity check
 * ACCOUNTS.md §9.5 (P2-2) asks for: the same assertions, against the engine
 * production uses. So a suite may reach the database only through `Db` — the
 * interface both engines satisfy — and never through `node:sqlite` directly.
 *
 * `recording` also keeps the SQL of every `batch()` call, so "this repository
 * talks to the database in one transaction" is checked on both engines too.
 *
 * Test-only. Nothing in the Worker imports this file.
 */

import type { Db, DbResult, DbStatement, DbValue } from './db';

export interface SuiteDb extends Db {
  /** Every `batch()` call made, as the SQL of its statements. */
  readonly batches: string[][];
  /** Rows from a query, for assertions. */
  rows(sql: string, ...values: DbValue[]): Promise<Record<string, unknown>[]>;
  /** The first row from a query, or undefined. */
  row(sql: string, ...values: DbValue[]): Promise<Record<string, unknown> | undefined>;
  /** Run a statement for its effect, e.g. setting up a suspended account. */
  exec(sql: string, ...values: DbValue[]): Promise<void>;
}

/** A fresh, migrated, empty database, handed to each test that asks. */
export type FreshDb = () => Promise<SuiteDb>;

class RecordingStatement implements DbStatement {
  readonly sql: string;
  readonly inner: DbStatement;

  constructor(sql: string, inner: DbStatement) {
    this.sql = sql;
    this.inner = inner;
  }

  bind(...values: DbValue[]): DbStatement {
    return new RecordingStatement(this.sql, this.inner.bind(...values));
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.inner.first<T>();
  }

  all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    return this.inner.all<T>();
  }

  run(): Promise<DbResult> {
    return this.inner.run();
  }
}

/** Wrap any `Db` so a suite can use it, recording batches as they go by. */
export function recording(db: Db): SuiteDb {
  const batches: string[][] = [];
  return {
    batches,
    prepare: (sql) => new RecordingStatement(sql, db.prepare(sql)),
    batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<DbResult<T>[]> {
      const list = statements as RecordingStatement[];
      batches.push(list.map((s) => s.sql));
      return db.batch<T>(list.map((s) => s.inner));
    },
    async rows(sql, ...values) {
      return (await db.prepare(sql).bind(...values).all()).results;
    },
    async row(sql, ...values) {
      return (await db.prepare(sql).bind(...values).first()) ?? undefined;
    },
    async exec(sql, ...values) {
      await db.prepare(sql).bind(...values).run();
    },
  };
}
