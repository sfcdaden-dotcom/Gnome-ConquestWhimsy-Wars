/**
 * Does the database have the schema this build of the code expects?
 *
 * Wrangler records every applied migration in `d1_migrations`. The code knows
 * the newest migration it was written against; if that row is missing, the
 * code was deployed before its migration (or the local database was never
 * migrated), and `GET /api/health` says so with a 503. It is also how the
 * Playwright suite proves the database `npm run db:migrate:local` migrated is
 * the one the Worker it drives actually reads (e2e/schema.spec.ts).
 */

import type { Db } from './db';

/**
 * The newest file in migrations/. A unit test fails if this falls behind the
 * folder, so adding a migration means bumping it in the same change.
 */
export const LATEST_MIGRATION = '0001_identity.sql';

/** True when `migration` has been applied. False, never an error, when nothing has. */
export async function schemaIsCurrent(db: Db, migration: string = LATEST_MIGRATION): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT 1 AS applied FROM d1_migrations WHERE name = ?1').bind(migration).first();
    return row !== null;
  } catch {
    // No d1_migrations table at all: a database nobody has migrated.
    return false;
  }
}
