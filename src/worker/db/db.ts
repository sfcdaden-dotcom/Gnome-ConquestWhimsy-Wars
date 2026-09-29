/**
 * The database, as the rest of the server sees it.
 *
 * This is the subset of Cloudflare's `D1Database` the repositories actually
 * use — nothing more — so that the same repository code runs against real D1
 * (production, staging, `wrangler dev`, `vite preview`) and against the
 * in-memory SQLite adapter the unit tests use (`testDb.ts`). `fromD1` is where
 * the compiler checks that D1 still satisfies it.
 *
 * Every SQL statement in the server lives in this directory (ACCOUNTS.md §5).
 * Values are always bound, never spliced into SQL text.
 */

/** What a statement may be bound to. */
export type DbValue = string | number | null;

export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
}

export interface DbStatement {
  bind(...values: DbValue[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run(): Promise<DbResult>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  /**
   * Run statements in order as ONE transaction: all of them, or — if any
   * fails — none. This is D1's batch contract, and the only transaction D1
   * offers; every multi-statement invariant in the repositories is a batch.
   */
  batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<DbResult<T>[]>;
}

/** The binding, as a `Db`. A compile error here means D1's API moved under us. */
export function fromD1(d1: D1Database): Db {
  return d1;
}
