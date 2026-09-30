/**
 * The migrations on real local D1, in the Workers runtime.
 *
 * 0001_identity.sql was only ever tested on Node's SQLite, where its users.id
 * CHECK (one 251-byte GLOB) works. D1 refuses any LIKE or GLOB pattern over
 * 50 bytes, so on D1 that CHECK failed for every row and no user could ever be
 * created. 0002_users_id_check.sql replaces it. These tests pin both halves on
 * the engine production runs: the old constraint fails, and the new one
 * accepts exactly what the old one described.
 *
 * Each test starts MIGRATION_DB from nothing and applies the migrations it
 * names, so it can stop at 0001.
 */

import { applyD1Migrations } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { emptyMigrationDb, migrationsUpTo } from './d1TestEnv';

const NOW = 1_790_000_000_000;
const HASH = 'a'.repeat(64);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function at(migration: '0001_identity.sql' | '0002_users_id_check.sql'): Promise<D1Database> {
  const db = await emptyMigrationDb();
  await applyD1Migrations(db, migrationsUpTo(migration));
  return db;
}

function insertUser(db: D1Database, id: string) {
  return db.prepare('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)').bind(id, NOW, NOW).run();
}

/** 'ok', or the error message: for asserting which constraint refused. */
async function outcome(run: Promise<unknown>): Promise<string> {
  return run.then(
    () => 'ok',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

async function usersSql(db: D1Database): Promise<string> {
  return String((await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").first<{ sql: string }>())?.sql);
}

describe('0001_identity.sql on D1: the defect', () => {
  it('refuses every real id, because its CHECK is a pattern D1 will not evaluate', async () => {
    const db = await at('0001_identity.sql');
    for (let i = 0; i < 5; i++) {
      expect(await outcome(insertUser(db, crypto.randomUUID()))).toMatch(/LIKE or GLOB pattern too complex/);
    }
    expect(await db.prepare('SELECT count(*) AS n FROM users').first()).toEqual({ n: 0 });
  });

  it('so the sign-in batch cannot create an account either', async () => {
    const db = await at('0001_identity.sql');
    const { upsertGoogleUser } = await import('./identity');
    await expect(upsertGoogleUser(db, 'sub-1', NOW)).rejects.toThrow(/LIKE or GLOB pattern too complex/);
  });
});

describe('0002_users_id_check.sql on D1: the fix', () => {
  it('accepts ids exactly as crypto.randomUUID() makes them', async () => {
    const db = await at('0002_users_id_check.sql');
    const ids = Array.from({ length: 1000 }, () => crypto.randomUUID());
    for (let i = 0; i < ids.length; i += 100) {
      await db.batch(
        ids.slice(i, i + 100).map((id) => db.prepare('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)').bind(id, NOW, NOW)),
      );
    }
    expect(await db.prepare('SELECT count(*) AS n FROM users').first()).toEqual({ n: 1000 });
  });

  it('refuses every other id shape 0001 refused', async () => {
    // The same cases as migrations.test.ts, plus the ones only a
    // piecewise check could get wrong.
    const db = await at('0002_users_id_check.sql');
    const good = crypto.randomUUID();
    const bad = {
      uppercase: good.toUpperCase(),
      'version 1': '6fa459ea-ee8a-1ca4-894e-db77e160355e',
      'variant c': '6fa459ea-ee8a-4ca4-c94e-db77e160355e',
      nil: '00000000-0000-0000-0000-000000000000',
      braces: '{6fa459ea-ee8a-4ca4-894e-db77e16035}',
      'non-hex': '6fa459ea-ee8a-4ca4-894e-db77e160355g',
      'dashes moved': '6fa459eaee8a-4-ca4-894e-db77e160355e',
      'extra dash for a digit': '6fa459ea-ee8a-4ca4-894e-db77e160355-',
      'no dashes, padded to 36': '6fa459eaee8a4ca4894edb77e160355e0000',
      'trailing space': `${good.slice(0, 35)} `,
      'too long': `${good}0`,
      'x × 36': 'x'.repeat(36),
      empty: '',
    };
    for (const [label, id] of Object.entries(bad)) {
      expect(await outcome(insertUser(db, id)), label).toMatch(/CHECK constraint failed/);
    }
  });

  it('agrees with the definition of a v4 UUID on thousands of near misses', async () => {
    // Every string here is one edit away from a real id. The database must
    // accept a string exactly when the reference regex does.
    const db = await at('0002_users_id_check.sql');
    const alphabet = '0123456789abcdefABCDEFgxz- {}';
    const cases: string[] = [];
    for (let i = 0; i < 1500; i++) {
      const id = crypto.randomUUID();
      const pos = i % 36;
      const ch = alphabet[(i * 7 + Math.floor(i / 36)) % alphabet.length];
      cases.push(id.slice(0, pos) + ch + id.slice(pos + 1));
    }
    let accepted = 0;
    for (const id of cases) {
      const ok = (await outcome(insertUser(db, id))) === 'ok';
      expect(ok, id).toBe(UUID_V4.test(id));
      if (ok) accepted++;
    }
    // Both branches were exercised, not just one.
    expect(accepted).toBeGreaterThan(100);
    expect(accepted).toBeLessThan(cases.length - 100);
  });

  it('keeps every other users constraint exactly as 0001 wrote it', async () => {
    const db = await at('0002_users_id_check.sql');
    const ins = 'INSERT INTO users (id, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?)';
    const id = crypto.randomUUID();
    expect(await outcome(insertUser(db, id))).toBe('ok');
    expect(await db.prepare('SELECT status FROM users WHERE id = ?').bind(id).first()).toEqual({ status: 'active' });
    expect(await outcome(db.prepare(`UPDATE users SET status = 'banned' WHERE id = ?`).bind(id).run())).toMatch(/CHECK/);
    expect(await outcome(db.prepare(ins).bind(crypto.randomUUID(), 0, 0, null).run())).toMatch(/CHECK/);
    expect(await outcome(db.prepare(ins).bind(crypto.randomUUID(), NOW, NOW - 1, null).run())).toMatch(/CHECK/);
    expect(await outcome(db.prepare(ins).bind(crypto.randomUUID(), NOW, NOW, NOW - 1).run())).toMatch(/CHECK/);
    expect(await outcome(db.prepare(ins).bind(crypto.randomUUID(), 'yesterday', NOW, null).run())).toMatch(/cannot store TEXT/);
  });

  it('keeps the foreign keys and their cascade pointing at the rebuilt users', async () => {
    const db = await at('0002_users_id_check.sql');
    const orphan = db.prepare(`INSERT INTO auth_identities VALUES ('google', 's', ?, ?)`).bind(crypto.randomUUID(), NOW).run();
    expect(await outcome(orphan)).toMatch(/FOREIGN KEY constraint failed/);

    const u = crypto.randomUUID();
    await insertUser(db, u);
    await db.prepare(`INSERT INTO auth_identities VALUES ('google', 's', ?, ?)`).bind(u, NOW).run();
    await db
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(HASH, u, NOW, NOW, NOW + 1, NOW + 2)
      .run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(u).run();
    expect(
      await db.prepare('SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM auth_identities) AS n').first(),
    ).toEqual({ n: 0 });
  });

  it('leaves exactly the three identity tables, and no pattern longer than D1 accepts', async () => {
    const db = await at('0002_users_id_check.sql');
    const { results } = await db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name")
      .all<{ name: string; sql: string }>();
    expect(results.map((r) => r.name)).toEqual(['auth_identities', 'sessions', 'users']);
    for (const { name, sql } of results) {
      for (const m of sql.matchAll(/\b(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi)) {
        expect(new TextEncoder().encode(m[1]).length, `${name}: ${m[1]}`).toBeLessThanOrEqual(50);
      }
    }
  });
});

describe('0002_users_id_check.sql on D1: the guard', () => {
  it('fails, and changes nothing, if users unexpectedly holds a row', async () => {
    const db = await at('0001_identity.sql');
    // The only way a row can exist under 0001 on D1: with CHECKs switched off.
    await db.prepare('PRAGMA ignore_check_constraints = 1').run();
    await insertUser(db, crypto.randomUUID());
    await db.prepare('PRAGMA ignore_check_constraints = 0').run();
    const before = await usersSql(db);

    await expect(applyD1Migrations(db, migrationsUpTo('0002_users_id_check.sql'))).rejects.toThrow(
      /CHECK constraint failed: identity_rows = 0/,
    );

    // A migration is applied as one batch, so the failure rolled back all of
    // it: the old table, its row, no guard table, and 0002 not recorded.
    expect(await usersSql(db)).toBe(before);
    expect(await db.prepare('SELECT count(*) AS n FROM users').first()).toEqual({ n: 1 });
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users_0002', '_0002_guard')")
      .all();
    expect(results).toEqual([]);
    const { results: applied } = await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all<{ name: string }>();
    expect(applied.map((r) => r.name)).toEqual(['0001_identity.sql']);
  });

  it('passes on an empty database, the only state D1 can be in under 0001', async () => {
    const db = await at('0001_identity.sql');
    await applyD1Migrations(db, migrationsUpTo('0002_users_id_check.sql'));
    const { results } = await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['0001_identity.sql', '0002_users_id_check.sql']);
    expect(await outcome(insertUser(db, crypto.randomUUID()))).toBe('ok');
  });
});
