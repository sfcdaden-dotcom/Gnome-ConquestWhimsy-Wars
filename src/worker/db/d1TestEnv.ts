/**
 * Shared set-up for the tests that run inside the Workers runtime
 * (*.workers.test.ts, `npm run test:workers`).
 *
 * The database is the real D1 binding from wrangler.jsonc, backed by
 * miniflare's local, in-memory D1: the engine production runs, reached by
 * nothing outside this test process.
 *
 * It lives in the db layer because it holds SQL (the table reset below), and
 * SQL lives only in src/worker/db/ (ACCOUNTS_SPEC_PHASE_1.md §5).
 *
 * Test-only. Nothing in the Worker imports this file.
 */

import type { D1Migration } from 'cloudflare:test';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { fromD1 } from './db';
import type { SuiteDb } from './suiteDb';
import { recording } from './suiteDb';

interface TestEnv {
  DB: D1Database;
  /** A second local D1, only for migrations.workers.test.ts (see vitest.workers.config.ts). */
  MIGRATION_DB: D1Database;
  /** The real migrations/ folder, read by vitest.workers.config.ts. */
  TEST_MIGRATIONS: D1Migration[];
}

export const testEnv = env as unknown as TestEnv;

/**
 * Tables emptied between tests, children before parents so no foreign key
 * objects. A migration that adds a table adds it here, or its rows would leak
 * from one test into the next; d1.workers.test.ts checks this list against the
 * database itself.
 */
export const TABLES_CHILDREN_FIRST = ['sessions', 'auth_identities', 'users'] as const;

/** Bring the local D1 to the latest migration. Idempotent. */
export async function migrate(): Promise<void> {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
}

/** A migrated, empty D1, as a repository suite sees it. */
export async function freshD1(): Promise<SuiteDb> {
  await migrate();
  await testEnv.DB.batch(TABLES_CHILDREN_FIRST.map((t) => testEnv.DB.prepare(`DELETE FROM ${t}`)));
  return recording(fromD1(testEnv.DB));
}

/** The migrations, up to and including `name`. */
export function migrationsUpTo(name: string): D1Migration[] {
  const all = testEnv.TEST_MIGRATIONS;
  const end = all.findIndex((m) => m.name === name);
  if (end < 0) throw new Error(`no migration named ${name}`);
  return all.slice(0, end + 1);
}

/**
 * MIGRATION_DB with nothing in it at all: every table dropped, the migrations
 * record included, so a test can start it at any migration it likes.
 */
export async function emptyMigrationDb(): Promise<D1Database> {
  const db = testEnv.MIGRATION_DB;
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all<{ name: string }>();
  // Children first, so no DROP has a foreign key to cascade through.
  const order = (n: string) => ['sessions', 'auth_identities'].indexOf(n);
  const names = results.map((r) => r.name).sort((a, b) => order(b) - order(a));
  for (const name of names) await db.prepare(`DROP TABLE "${name.replace(/"/g, '""')}"`).run();
  return db;
}
