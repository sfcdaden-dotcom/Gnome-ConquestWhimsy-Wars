import { describe, expect, it } from 'vitest';
import type { DbValue } from './db';
import { getUser, upsertGoogleUser, upsertGoogleUserStatements } from './identity';
import type { TestDb } from './testDb';
import { createTestDb } from './testDb';

const NOW = 1_790_000_000_000;

function count(db: TestDb, table: 'users' | 'auth_identities'): number {
  return Number(db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
}

describe('upsertGoogleUser', () => {
  it('creates exactly one account and one identity for a new sub', async () => {
    const db = createTestDb();
    const signedIn = await upsertGoogleUser(db, 'sub-1', NOW);

    expect(signedIn).toMatchObject({ status: 'active', created: true });
    expect(signedIn.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(count(db, 'users')).toBe(1);
    expect(count(db, 'auth_identities')).toBe(1);
  });

  it('returns the same account, not a new one, when the sub signs in again', async () => {
    const db = createTestDb();
    const first = await upsertGoogleUser(db, 'sub-1', NOW);
    const again = await upsertGoogleUser(db, 'sub-1', NOW + 1000);

    expect(again).toEqual({ userId: first.userId, status: 'active', created: false });
    expect(count(db, 'users')).toBe(1);
    expect(count(db, 'auth_identities')).toBe(1);
  });

  it('gives different subs different accounts', async () => {
    const db = createTestDb();
    const a = await upsertGoogleUser(db, 'sub-a', NOW);
    const b = await upsertGoogleUser(db, 'sub-b', NOW);
    expect(a.userId).not.toBe(b.userId);
  });

  it('talks to the database in exactly one batch — one transaction', async () => {
    const db = createTestDb();
    await upsertGoogleUser(db, 'sub-1', NOW);
    await upsertGoogleUser(db, 'sub-1', NOW + 1);
    expect(db.batches).toHaveLength(2);
    for (const batch of db.batches) expect(batch).toHaveLength(5);
  });

  it('reports a non-active status as it is, and decides nothing about it', async () => {
    // Refusing suspended/deleting accounts is the router's single job (P2-1).
    const db = createTestDb();
    const { userId } = await upsertGoogleUser(db, 'sub-1', NOW);
    db.raw.prepare(`UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?`).run(NOW, userId);

    expect(await upsertGoogleUser(db, 'sub-1', NOW + 1)).toEqual({ userId, status: 'suspended', created: false });
    expect(await getUser(db, userId)).toEqual({ id: userId, status: 'suspended' });
  });

  it('updates updated_at and last_login_at on every sign-in', async () => {
    const db = createTestDb();
    const { userId } = await upsertGoogleUser(db, 'sub-1', NOW);
    await upsertGoogleUser(db, 'sub-1', NOW + 5000);

    expect(db.raw.prepare('SELECT created_at, updated_at, last_login_at FROM users WHERE id = ?').get(userId)).toEqual({
      created_at: NOW,
      updated_at: NOW + 5000,
      last_login_at: NOW + 5000,
    });
  });

  it('never moves time backwards when an isolate clock lags', async () => {
    const db = createTestDb();
    const { userId } = await upsertGoogleUser(db, 'sub-1', NOW + 5000);
    await upsertGoogleUser(db, 'sub-1', NOW); // an earlier clock

    expect(db.raw.prepare('SELECT updated_at, last_login_at FROM users WHERE id = ?').get(userId)).toEqual({
      updated_at: NOW + 5000,
      last_login_at: NOW + 5000,
    });
  });

  it('refuses an empty or oversized subject before touching the database', async () => {
    const db = createTestDb();
    await expect(upsertGoogleUser(db, '', NOW)).rejects.toThrow(/invalid subject/);
    await expect(upsertGoogleUser(db, 'x'.repeat(256), NOW)).rejects.toThrow(/invalid subject/);
    expect(db.batches).toHaveLength(0);
  });
});

describe('two first sign-ins for the same new sub, racing', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  /** Every order in which two sequences' steps can interleave, each keeping its own order. */
  function* interleavings<T>(a: T[], b: T[]): Generator<T[]> {
    if (a.length === 0) return yield [...b];
    if (b.length === 0) return yield [...a];
    for (const rest of interleavings(a.slice(1), b)) yield [a[0], ...rest];
    for (const rest of interleavings(a, b.slice(1))) yield [b[0], ...rest];
  }

  interface Step {
    who: 'A' | 'B';
    sql: string;
    values: DbValue[];
    last: boolean;
  }

  function steps(who: 'A' | 'B', id: string, now: number): Step[] {
    const list = upsertGoogleUserStatements(id, now, 'sub-race');
    return list.map((s, i) => ({ who, ...s, last: i === list.length - 1 }));
  }

  it('ends with one account, one identity, one answer and no orphan — in all 252 statement orders', async () => {
    // The strongest case: not two serialised batches (which is what D1 does)
    // but every statement-by-statement interleaving of the two, each statement
    // atomic. Safety must come from the schema and the statements themselves.
    let orders = 0;
    const winners = { A: 0, B: 0 };
    for (const order of interleavings(steps('A', A, NOW), steps('B', B, NOW + 1))) {
      orders++;
      const db = createTestDb();
      const answers: Partial<Record<'A' | 'B', { user_id: string; created: number }>> = {};
      for (const step of order) {
        const { results } = await db.prepare(step.sql).bind(...step.values).all<{ user_id: string; created: number }>();
        if (step.last) answers[step.who] = results[0];
      }

      const users = db.raw.prepare('SELECT id FROM users').all().map((r) => r.id);
      const identities = db.raw.prepare('SELECT user_id FROM auth_identities').all().map((r) => r.user_id);
      const context = order.map((s) => s.who).join('');
      expect(users, context).toHaveLength(1); // no orphan
      expect(identities, context).toEqual(users); // one identity, on that account
      expect(answers.A?.user_id, context).toBe(users[0]); // both told the same account
      expect(answers.B?.user_id, context).toBe(users[0]);
      expect((answers.A?.created ?? 0) + (answers.B?.created ?? 0), context).toBe(1); // one creator
      winners[users[0] === A ? 'A' : 'B']++;
    }
    expect(orders).toBe(252);
    expect(winners.A).toBeGreaterThan(0);
    expect(winners.B).toBeGreaterThan(0);
  });

  it('as two whole batches, in either order, the second finds the first account', async () => {
    const db = createTestDb();
    const [first, second] = await Promise.all([
      upsertGoogleUser(db, 'sub-race', NOW, A),
      upsertGoogleUser(db, 'sub-race', NOW, B),
    ]);
    expect(second.userId).toBe(first.userId);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(count(db, 'users')).toBe(1);
  });
});
