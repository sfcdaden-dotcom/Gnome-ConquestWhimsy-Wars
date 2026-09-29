/**
 * The slice of Node's built-in `node:sqlite` that src/worker/db/testDb.ts uses.
 *
 * The Worker project loads no ambient @types (Node's globals collide with the
 * Cloudflare runtime's — see tsconfig.worker.json), yet its unit tests run
 * under Node and use node:sqlite as a stand-in for D1. Declaring only these
 * few members keeps the two worlds apart; if the adapter ever needs more,
 * declare it here rather than pulling in @types/node.
 */
declare module 'node:sqlite' {
  type SqlValue = null | number | bigint | string | Uint8Array;

  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync {
    all(...params: SqlValue[]): Array<Record<string, SqlValue>>;
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    run(...params: SqlValue[]): StatementResultingChanges;
  }

  class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
