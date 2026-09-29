/**
 * The schema itself: migrations apply, every constraint refuses what it exists
 * to refuse, and the indexes are the ones the queries actually use.
 *
 * These run on the node:sqlite adapter (testDb.ts), which applies the real
 * migration files. Node's SQLite is NOT D1: it accepted 0001's 251-byte GLOB,
 * which D1 refuses outright, and that is how 0001 shipped a users table D1
 * cannot insert into. The schema's behaviour on D1 itself is pinned in
 * migrations.workers.test.ts; the pattern-length test below is the one guard
 * against that class of mistake that runs here too.
 */

import { describe, expect, it } from 'vitest';
import type { TestDb } from './testDb';
import { createTestDb, migrations } from './testDb';

/**
 * The frozen 0001, byte for byte. Once a migration has been applied to
 * production it is never edited — every change is a new file — so an edit to
 * this one is a mistake this test exists to catch. Do not "fix" the hash.
 */
const FROZEN: Record<string, string> = {
  '0001_identity.sql': '51a24faaf3a3ba1460a062f49b515bcfa79a41081fa8b35df5cfec8336728c84',
  // Pinned at review, before it has been applied anywhere remote. An edit
  // during review updates this deliberately; once applied, it never changes.
  '0002_users_id_check.sql': '0642555e16bc09ad18173990275c633c0192a4d5c7601e57eace6709c22a502b',
};

/** D1 refuses any LIKE or GLOB pattern longer than this many bytes. */
const D1_PATTERN_LIMIT = 50;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const NOW = 1_790_000_000_000;
const HASH = 'a'.repeat(64);

function tryExec(db: TestDb, sql: string, ...values: Array<string | number | null>): 'ok' | string {
  try {
    db.raw.prepare(sql).run(...values);
    return 'ok';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function addUser(db: TestDb, id: string = crypto.randomUUID()): string {
  db.raw
    .prepare('INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(id, NOW, NOW);
  return id;
}

function plan(db: TestDb, sql: string): string {
  return db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String(r.detail))
    .join(' | ');
}

describe('the migrations folder', () => {
  it('holds numbered migrations, applied in filename order', () => {
    const names = migrations().map((m) => m.name);
    expect(names[0]).toBe('0001_identity.sql');
    for (const name of names) expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect([...names].sort()).toEqual(names);
  });

  it('never changes a frozen migration', async () => {
    for (const m of migrations()) {
      if (FROZEN[m.name]) expect(await sha256(m.sql), m.name).toBe(FROZEN[m.name]);
    }
    expect(migrations().filter((m) => FROZEN[m.name])).toHaveLength(Object.keys(FROZEN).length);
  });

  it('applies cleanly to an empty database, creating exactly the 0001 tables as STRICT', () => {
    const db = createTestDb({ upTo: '0001_identity.sql' });
    const tables = db.raw
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    expect(tables).toEqual([
      { name: 'auth_identities', strict: 1 },
      { name: 'sessions', strict: 1 },
      { name: 'users', strict: 1 },
    ]);
  });

  it('leaves exactly the identity tables, as STRICT, once every migration has run', () => {
    const db = createTestDb();
    const tables = db.raw
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    expect(tables).toEqual([
      { name: 'auth_identities', strict: 1 },
      { name: 'sessions', strict: 1 },
      { name: 'users', strict: 1 },
    ]);
  });

  it('leaves no LIKE or GLOB pattern longer than D1 accepts anywhere in the schema', () => {
    // The mistake 0001 made. Checked on the schema as it stands after every
    // migration (0001's pattern is gone), because that is what D1 evaluates.
    const db = createTestDb();
    const patterns = db.raw
      .prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL")
      .all()
      .flatMap((r) => [...String(r.sql).matchAll(/\b(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi)].map((m) => ({ table: r.name, pattern: m[1] })));
    expect(patterns.length).toBeGreaterThan(0);
    for (const { table, pattern } of patterns) {
      expect(new TextEncoder().encode(pattern).length, `${table}: ${pattern}`).toBeLessThanOrEqual(D1_PATTERN_LIMIT);
    }
    // The detector itself: 0001's own id pattern is over the limit.
    const before = createTestDb({ upTo: '0001_identity.sql' });
    const old = String(before.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get()?.sql);
    expect(/GLOB '([^']{51,})'/.test(old)).toBe(true);
  });

  it('runs with foreign keys enforced', () => {
    const db = createTestDb();
    expect(db.raw.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(tryExec(db, `INSERT INTO auth_identities VALUES ('google', 's', ?, ?)`, crypto.randomUUID(), NOW)).toMatch(
      /FOREIGN KEY/,
    );
  });
});

describe('users', () => {
  it('accepts ids exactly as crypto.randomUUID() makes them', () => {
    const db = createTestDb();
    for (let i = 0; i < 1000; i++) addUser(db);
    expect(db.raw.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1000 });
  });

  it('refuses any other id shape', () => {
    const db = createTestDb();
    const good = crypto.randomUUID();
    const bad = {
      uppercase: good.toUpperCase(),
      'version 1': '6fa459ea-ee8a-1ca4-894e-db77e160355e',
      'variant c': '6fa459ea-ee8a-4ca4-c94e-db77e160355e',
      nil: '00000000-0000-0000-0000-000000000000',
      braces: '{6fa459ea-ee8a-4ca4-894e-db77e16035}',
      'non-hex': '6fa459ea-ee8a-4ca4-894e-db77e160355g',
      'dashes moved': '6fa459eaee8a-4-ca4-894e-db77e160355e',
      'trailing space': `${good.slice(0, 35)} `,
      'too long': `${good}0`,
      empty: '',
    };
    for (const [label, id] of Object.entries(bad)) {
      expect(tryExec(db, 'INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)', id, NOW, NOW), label).toMatch(
        /CHECK/,
      );
    }
  });

  it('defaults to active, and refuses a status that does not exist', () => {
    const db = createTestDb();
    const id = addUser(db);
    expect(db.raw.prepare('SELECT status FROM users WHERE id = ?').get(id)).toEqual({ status: 'active' });
    expect(tryExec(db, `UPDATE users SET status = 'banned' WHERE id = ?`, id)).toMatch(/CHECK/);
    for (const status of ['suspended', 'deleting', 'active']) {
      expect(tryExec(db, 'UPDATE users SET status = ? WHERE id = ?', status, id)).toBe('ok');
    }
  });

  it('refuses times out of order, and values of the wrong type', () => {
    const db = createTestDb();
    const ins = 'INSERT INTO users (id, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?)';
    expect(tryExec(db, ins, crypto.randomUUID(), 0, 0, null)).toMatch(/CHECK/);
    expect(tryExec(db, ins, crypto.randomUUID(), NOW, NOW - 1, null)).toMatch(/CHECK/);
    expect(tryExec(db, ins, crypto.randomUUID(), NOW, NOW, NOW - 1)).toMatch(/CHECK/);
    expect(tryExec(db, ins, crypto.randomUUID(), 'yesterday', NOW, null)).toMatch(/cannot store TEXT/);
    expect(tryExec(db, ins, crypto.randomUUID(), NOW, NOW, NOW)).toBe('ok');
  });
});

describe('auth_identities', () => {
  const ins = 'INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)';

  it('links one Google identity to exactly one account', () => {
    const db = createTestDb();
    const a = addUser(db);
    const b = addUser(db);
    expect(tryExec(db, ins, 'google', 'sub-1', a, NOW)).toBe('ok');
    expect(tryExec(db, ins, 'google', 'sub-1', b, NOW)).toMatch(/UNIQUE|PRIMARY KEY/);
  });

  it('gives an account at most one Google identity', () => {
    const db = createTestDb();
    const a = addUser(db);
    expect(tryExec(db, ins, 'google', 'sub-1', a, NOW)).toBe('ok');
    expect(tryExec(db, ins, 'google', 'sub-2', a, NOW)).toMatch(/UNIQUE/);
  });

  it('refuses unknown providers and empty or oversized subjects', () => {
    const db = createTestDb();
    const a = addUser(db);
    expect(tryExec(db, ins, 'github', 'x', a, NOW)).toMatch(/CHECK/);
    expect(tryExec(db, ins, 'google', '', a, NOW)).toMatch(/CHECK/);
    expect(tryExec(db, ins, 'google', 'x'.repeat(256), a, NOW)).toMatch(/CHECK/);
    expect(tryExec(db, ins, 'google', 'x'.repeat(255), a, NOW)).toBe('ok');
  });
});

describe('sessions', () => {
  const ins =
    'INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)';

  it('stores only a lowercase hex SHA-256, never anything else', () => {
    const db = createTestDb();
    const u = addUser(db);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}g`, 'raw-cookie-value']) {
      expect(tryExec(db, ins, bad, u, NOW, NOW, NOW + 1, NOW + 2), bad).toMatch(/CHECK/);
    }
    expect(tryExec(db, ins, HASH, u, NOW, NOW, NOW + 1, NOW + 2)).toBe('ok');
  });

  it('keeps idle expiry after the last sighting and never past the absolute limit', () => {
    const db = createTestDb();
    const u = addUser(db);
    expect(tryExec(db, ins, HASH, u, NOW, NOW, NOW + 5, NOW + 3)).toMatch(/CHECK/); // idle > absolute
    expect(tryExec(db, ins, HASH, u, NOW, NOW, NOW, NOW + 3)).toMatch(/CHECK/); // idle not after last seen
    expect(tryExec(db, ins, HASH, u, NOW, NOW - 1, NOW + 1, NOW + 3)).toMatch(/CHECK/); // seen before created
    expect(tryExec(db, ins, HASH, u, NOW, NOW, NOW + 3, NOW + 3)).toBe('ok'); // idle capped at absolute
  });

  it('goes when its user goes', () => {
    const db = createTestDb();
    const u = addUser(db);
    db.raw.prepare(`INSERT INTO auth_identities VALUES ('google', 's', ?, ?)`).run(u, NOW);
    db.raw.prepare(ins).run(HASH, u, NOW, NOW, NOW + 1, NOW + 2);
    db.raw.prepare('DELETE FROM users WHERE id = ?').run(u);
    expect(db.raw.prepare('SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM auth_identities) AS n').get()).toEqual({
      n: 0,
    });
  });
});

describe('indexes serve the queries that need them', () => {
  // Plans are checked on the empty schema; SQLite's choice here is by
  // structure, which is what the indexes were designed for.
  it('purges expired sessions from the expiry index, not a scan', () => {
    const db = createTestDb();
    expect(plan(db, 'DELETE FROM sessions WHERE idle_expires_at <= ?')).toMatch(/USING COVERING INDEX sessions_by_expiry/);
  });

  it('would scan if the purge tested both expiry columns — which the idle cap makes unnecessary', () => {
    const db = createTestDb();
    expect(plan(db, 'DELETE FROM sessions WHERE idle_expires_at <= ?1 OR absolute_expires_at <= ?1')).toMatch(/SCAN sessions/);
  });

  it('resolves a session by its hash and signs a user out everywhere by index', () => {
    const db = createTestDb();
    expect(
      plan(db, 'SELECT s.user_id, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.idle_expires_at > ?'),
    ).not.toMatch(/SCAN/);
    expect(plan(db, 'DELETE FROM sessions WHERE user_id = ?')).toMatch(/INDEX sessions_by_user/);
  });
});

describe('0002_users_id_check.sql', () => {
  const m0002 = () => migrations().find((m) => m.name === '0002_users_id_check.sql')!.sql;
  const usersSql = (db: TestDb) => String(db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get()?.sql);

  it('fails, rather than rebuild over them, when the identity tables hold data', () => {
    // Node's SQLite accepts 0001's CHECK, so here a row can exist under 0001.
    const db = createTestDb({ upTo: '0001_identity.sql' });
    const before = usersSql(db);
    addUser(db);

    expect(() => db.raw.exec(m0002())).toThrow(/CHECK constraint failed: identity_rows = 0/);

    // Nothing the guard protects was touched. `exec` here is NOT one
    // transaction, the worst case the file is written for: all that is left is
    // the guard's own table, empty, which a retry reuses.
    expect(usersSql(db)).toBe(before);
    expect(db.raw.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 });
    const leftovers = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users_0002', '_0002_guard')")
      .all();
    expect(leftovers).toEqual([{ name: '_0002_guard' }]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM _0002_guard').get()).toEqual({ n: 0 });
  });

  it('can be retried after that failure once the tables are empty, and then leaves nothing behind', () => {
    const db = createTestDb({ upTo: '0001_identity.sql' });
    const id = addUser(db);
    expect(() => db.raw.exec(m0002())).toThrow(/identity_rows = 0/);

    db.raw.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.raw.exec(m0002());

    expect(usersSql(db)).not.toMatch(/GLOB '\[0-9a-f\]\[0-9a-f\]/);
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables).toEqual([{ name: 'auth_identities' }, { name: 'sessions' }, { name: 'users' }]);
  });

  it('keeps the foreign keys, and their cascade, pointing at the rebuilt users', () => {
    const db = createTestDb();
    expect(tryExec(db, `INSERT INTO auth_identities VALUES ('google', 's', ?, ?)`, crypto.randomUUID(), NOW)).toMatch(/FOREIGN KEY/);
    const u = addUser(db);
    db.raw.prepare(`INSERT INTO auth_identities VALUES ('google', 's', ?, ?)`).run(u, NOW);
    db.raw
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(HASH, u, NOW, NOW, NOW + 1, NOW + 2);
    db.raw.prepare('DELETE FROM users WHERE id = ?').run(u);
    expect(db.raw.prepare('SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM auth_identities) AS n').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
