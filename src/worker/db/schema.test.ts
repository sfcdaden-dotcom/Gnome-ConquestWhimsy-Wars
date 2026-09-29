import { describe, expect, it } from 'vitest';
import { LATEST_MIGRATION, schemaIsCurrent } from './schema';
import { createTestDb, migrations, recordApplied } from './testDb';

describe('schemaIsCurrent', () => {
  it('names the newest migration in the folder — bump it when adding one', () => {
    expect(LATEST_MIGRATION).toBe(migrations().at(-1)?.name);
  });

  it('is true once the newest migration is recorded as applied', async () => {
    const db = createTestDb();
    recordApplied(db, ...migrations().map((m) => m.name));
    expect(await schemaIsCurrent(db)).toBe(true);
  });

  it('is false for a database nobody has migrated, rather than an error', async () => {
    expect(await schemaIsCurrent(createTestDb())).toBe(false);
  });

  it('is false when the code expects a migration the database does not have', async () => {
    const db = createTestDb();
    recordApplied(db, '0001_identity.sql');
    expect(await schemaIsCurrent(db, '0002_not_yet.sql')).toBe(false);
  });
});
