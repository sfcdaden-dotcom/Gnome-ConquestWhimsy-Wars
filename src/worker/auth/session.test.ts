/**
 * Sessions on the wire (ACCOUNTS_SPEC_PHASE_2.md §6.1, §6.2), on Node against
 * the in-memory database. The same behaviour through the Workers runtime and
 * real D1 is in session.workers.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { upsertGoogleUser } from '../db/identity';
import { SESSION_ABSOLUTE_MS, SESSION_TOUCH_INTERVAL_MS, createSession, resolveSession } from '../db/sessions';
import type { TestDb } from '../db/testDb';
import { createTestDb, migrations, recordApplied } from '../db/testDb';
import type { WorkerEnv } from '../env';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_S,
  authenticate,
  clearedSessionCookie,
  hashSessionToken,
  newSessionToken,
  sessionCookie,
} from './session';

/** Every source file under src/, as text, keyed relative to this file. */
const SOURCES = import.meta.glob('../../**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' }) as Record<
  string,
  string
>;

describe('the session cookie is read in one place', () => {
  it('found the sources', () => {
    expect(Object.keys(SOURCES)).toContain('./session.ts');
    expect(Object.keys(SOURCES)).toContain('../routes.ts');
  });

  it('no module but session.ts names the cookie or reads the Cookie header', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => path !== './session.ts' && !/\.test\.tsx?$/.test(path))
      .filter(([, text]) => text.includes(SESSION_COOKIE) || /headers\.get\(\s*['"`]cookie['"`]\s*\)/i.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe('tokens and cookies', () => {
  it('a token is 256 random bits as 43 characters of base64url', () => {
    const tokens = new Set(Array.from({ length: 200 }, newSessionToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('stores the lowercase hex SHA-256 of the token', async () => {
    expect(await hashSessionToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashSessionToken(newSessionToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sets a __Host- cookie: Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, 90 days (D6)', () => {
    const c = sessionCookie('t'.repeat(43));
    expect(c.startsWith(`__Host-gw_session=${'t'.repeat(43)};`)).toBe(true);
    for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=7776000']) expect(c).toContain(attr);
    expect(c).not.toMatch(/domain/i);
    expect(SESSION_COOKIE_MAX_AGE_S * 1000).toBe(SESSION_ABSOLUTE_MS);
  });

  it('clears it with the same attributes and Max-Age=0', () => {
    const c = clearedSessionCookie();
    expect(c).toMatch(/^__Host-gw_session=;/);
    for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']) expect(c).toContain(attr);
  });
});

/** A database that fails the test if anything reads it. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was read');
    },
  },
) as unknown as D1Database;

function context() {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext, waits };
}

function request(cookie?: string): Request {
  return new Request('https://gnomes.example/api/me', { headers: cookie ? { Cookie: cookie } : {} });
}

const ON = { ACCOUNTS_ENABLED: 'true' };

async function seeded(): Promise<{ db: TestDb; token: string; userId: string; env: WorkerEnv }> {
  const db = createTestDb();
  recordApplied(db, ...migrations().map((m) => m.name));
  const userId = (await upsertGoogleUser(db, 'sub-1', Date.now() - 2 * SESSION_TOUCH_INTERVAL_MS)).userId;
  const token = newSessionToken();
  await createSession(db, userId, await hashSessionToken(token), Date.now() - 2 * SESSION_TOUCH_INTERVAL_MS);
  return { db, token, userId, env: { ...ON, DB: db as unknown as D1Database } as WorkerEnv };
}

describe('authenticate (§6.2)', () => {
  it('with accounts off, answers guest without reading the cookie or the database', async () => {
    const { token } = await seeded();
    for (const ACCOUNTS_ENABLED of [undefined, 'false', 'TRUE', '1', 'yes']) {
      const env = { ACCOUNTS_ENABLED, DB: untouchable } as WorkerEnv;
      expect(await authenticate(request(`${SESSION_COOKIE}=${token}`), env, context().ctx)).toEqual({ kind: 'guest' });
    }
  });

  it('a request with no session cookie is a guest, and reads nothing', async () => {
    const env = { ...ON, DB: untouchable } as WorkerEnv;
    for (const cookie of [undefined, '', 'other=1', 'gw_session=x', `${SESSION_COOKIE}x=${'a'.repeat(43)}`]) {
      expect(await authenticate(request(cookie), env, context().ctx), String(cookie)).toEqual({ kind: 'guest' });
    }
  });

  it('a malformed session cookie is a guest, and reads nothing', async () => {
    const env = { ...ON, DB: untouchable } as WorkerEnv;
    for (const value of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`]) {
      expect(await authenticate(request(`${SESSION_COOKIE}=${value}`), env, context().ctx), value).toEqual({
        kind: 'guest',
      });
    }
  });

  it('an unknown session is a guest whose cookie is to be cleared', async () => {
    const { env } = await seeded();
    const auth = await authenticate(request(`${SESSION_COOKIE}=${newSessionToken()}`), env, context().ctx);
    expect(auth).toEqual({ kind: 'guest', staleSession: true });
  });

  it('a live session of an active account is that user, and is touched off the request path', async () => {
    const { db, token, userId, env } = await seeded();
    const { ctx, waits } = context();
    const auth = await authenticate(request(`a=1; ${SESSION_COOKIE}=${token}; b=2`), env, ctx);
    expect(auth.kind).toBe('user');
    expect(auth.kind === 'user' && auth.user.id).toBe(userId);

    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    const hash = await hashSessionToken(token);
    const row = (await db.prepare('SELECT last_seen_at FROM sessions WHERE id_hash = ?1').bind(hash).first()) as {
      last_seen_at: number;
    };
    expect(row.last_seen_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a live session of a suspended or deleting account is unavailable, with its status', async () => {
    const { db, token, userId, env } = await seeded();
    for (const status of ['suspended', 'deleting'] as const) {
      db.raw.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), userId);
      expect(await authenticate(request(`${SESSION_COOKIE}=${token}`), env, context().ctx)).toEqual({
        kind: 'unavailable',
        userId,
        status,
      });
    }
  });

  it('an expired session is a guest whose cookie is to be cleared', async () => {
    const { db, token, env } = await seeded();
    db.raw.prepare('UPDATE sessions SET idle_expires_at = ?').run(Date.now() - 1);
    expect(await resolveSession(db, await hashSessionToken(token), Date.now())).toBeNull();
    expect(await authenticate(request(`${SESSION_COOKIE}=${token}`), env, context().ctx)).toEqual({
      kind: 'guest',
      staleSession: true,
    });
  });
});
