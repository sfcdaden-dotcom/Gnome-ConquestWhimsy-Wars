// The identity and session suites again, this time on real local D1 inside the
// Workers runtime: the fidelity check on testDb that ACCOUNTS.md §9.5 (P2-2)
// asks for. Same assertions as identity.test.ts and sessions.test.ts.

import { describe, expect, it } from 'vitest';
import { TABLES_CHILDREN_FIRST, freshD1, migrate, testEnv } from './d1TestEnv';
import { identitySuite } from './identity.suite';
import { sessionsSuite } from './sessions.suite';

describe('real local D1', () => {
  it('enforces foreign keys, as testDb does by PRAGMA', async () => {
    await freshD1();
    const orphan = testEnv.DB.prepare(
      `INSERT INTO auth_identities (provider, subject, user_id, created_at)
         VALUES ('google', 'sub-orphan', '00000000-0000-4000-8000-000000000000', 1)`,
    ).run();
    await expect(orphan).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('is emptied, between tests, of every table the migrations create', async () => {
    await migrate();
    const { results } = await testEnv.DB.prepare(
      `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'
         ORDER BY name`,
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([...TABLES_CHILDREN_FIRST].sort());
  });
});

identitySuite(freshD1);
sessionsSuite(freshD1);
