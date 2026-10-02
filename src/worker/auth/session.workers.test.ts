// Sessions, /api/me, logout and the purge cron, through the real Worker in the
// Workers runtime, on real local D1 (ACCOUNTS_SPEC_PHASE_2.md §11, rows marked
// 2-C). The Node half, the full authenticate matrix, is session.test.ts.

import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fromD1 } from '../db/db';
import { freshD1, testEnv } from '../db/d1TestEnv';
import { upsertGoogleUser } from '../db/identity';
import { SESSION_IDLE_MS, createSession, issueSession, resolveSession } from '../db/sessions';
import type { WorkerEnv } from '../env';
import worker from '../index';
import { SESSION_COOKIE, hashSessionToken, newSessionToken } from './session';

const ORIGIN = 'http://localhost:4173';
const ON = { ...(testEnv as unknown as WorkerEnv), ACCOUNTS_ENABLED: 'true' } as WorkerEnv;

/** `env` with its database wrapped to count every statement prepared or batched. */
function counting(env: WorkerEnv): { env: WorkerEnv; reads: () => number } {
  let n = 0;
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare' || key === 'batch') n++;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB } as WorkerEnv, reads: () => n };
}

async function call(env: WorkerEnv, path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Origin', ORIGIN);
  if (token) headers.set('Cookie', `${SESSION_COOKIE}=${token}`);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A user with a live session; returns the cookie token. */
async function signedIn(sub = 'sub-1'): Promise<{ token: string; userId: string }> {
  const db = await freshD1();
  const userId = (await upsertGoogleUser(db, sub, Date.now())).userId;
  const token = newSessionToken();
  expect(await issueSession(db, userId, await hashSessionToken(token), null, Date.now())).toBe(true);
  return { token, userId };
}

const cleared = (res: Response) => /^__Host-gw_session=;.*Max-Age=0/.test(res.headers.get('set-cookie') ?? '');

describe('GET /api/me', () => {
  it('answers a signed-in, active account with its status, and nothing else', async () => {
    const { token } = await signedIn();
    const res = await call(ON, '/api/me', { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'active' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('answers a suspended or deleting account with its status, so the page can say why', async () => {
    const { token, userId } = await signedIn();
    for (const status of ['suspended', 'deleting'] as const) {
      await testEnv.DB.prepare('UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3').bind(status, Date.now(), userId).run();
      const res = await call(ON, '/api/me', { token });
      expect(res.status, status).toBe(200);
      expect(await res.json()).toEqual({ status });
    }
  });

  it('answers a guest with 401 SIGNED_OUT, and a guest with no cookie costs no D1 read', async () => {
    await freshD1();
    const { env, reads } = counting(ON);
    const res = await call(env, '/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'SIGNED_OUT' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(reads()).toBe(0);
  });

  it('treats an unknown session as a guest, and clears its cookie', async () => {
    await freshD1();
    const res = await call(ON, '/api/me', { token: newSessionToken() });
    expect(res.status).toBe(401);
    expect(cleared(res)).toBe(true);
  });

  it('treats an expired session as a guest, and clears its cookie', async () => {
    const db = await freshD1();
    const userId = (await upsertGoogleUser(db, 'sub-1', Date.now())).userId;
    const token = newSessionToken();
    await createSession(db, userId, await hashSessionToken(token), Date.now() - SESSION_IDLE_MS - 1);
    const res = await call(ON, '/api/me', { token });
    expect(res.status).toBe(401);
    expect(cleared(res)).toBe(true);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session: 204, the cookie cleared, and the same cookie is a guest afterwards', async () => {
    const { token } = await signedIn();
    const res = await call(ON, '/api/auth/logout', { method: 'POST', token });
    expect(res.status).toBe(204);
    expect(cleared(res)).toBe(true);
    expect(await resolveSession(fromD1(testEnv.DB), await hashSessionToken(token), Date.now())).toBeNull();

    const after = await call(ON, '/api/me', { token });
    expect(after.status).toBe(401);
  });

  it('still signs out a suspended account (self-exit)', async () => {
    const { token, userId } = await signedIn();
    await testEnv.DB.prepare("UPDATE users SET status = 'suspended', updated_at = ?1 WHERE id = ?2").bind(Date.now(), userId).run();
    expect((await call(ON, '/api/auth/logout', { method: 'POST', token })).status).toBe(204);
    expect(await resolveSession(fromD1(testEnv.DB), await hashSessionToken(token), Date.now())).toBeNull();
  });

  it('refuses a guest with 401, and another origin with 403 before anything else', async () => {
    await freshD1();
    expect((await call(ON, '/api/auth/logout', { method: 'POST' })).status).toBe(401);
    const { token } = await signedIn();
    const foreign = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', Cookie: `${SESSION_COOKIE}=${token}` },
      }),
      ON as never,
      createExecutionContext(),
    );
    expect(foreign.status).toBe(403);
    expect(await resolveSession(fromD1(testEnv.DB), await hashSessionToken(token), Date.now())).not.toBeNull();
  });
});

describe('with accounts off (ACCOUNTS_ENABLED not "true")', () => {
  it('/api/me and logout answer 404, even with a live session, and read nothing', async () => {
    const { token } = await signedIn();
    for (const ACCOUNTS_ENABLED of ['false', undefined]) {
      const { env, reads } = counting({ ...ON, ACCOUNTS_ENABLED } as WorkerEnv);
      expect((await call(env, '/api/me', { token })).status, String(ACCOUNTS_ENABLED)).toBe(404);
      expect((await call(env, '/api/auth/logout', { method: 'POST', token })).status).toBe(404);
      expect(reads()).toBe(0);
    }
    // The session survived: the 404s did nothing.
    expect(await resolveSession(fromD1(testEnv.DB), await hashSessionToken(token), Date.now())).not.toBeNull();
  });

  it('a room socket with a session cookie is a guest, and reads nothing', async () => {
    const { token } = await signedIn();
    const create = await call(ON, '/api/rooms', { method: 'POST' });
    const { code } = (await create.json()) as { code: string };
    const { env, reads } = counting({ ...ON, ACCOUNTS_ENABLED: 'false' } as WorkerEnv);
    const res = await call(env, `/api/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' }, token });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
    expect(reads()).toBe(0);
  });
});

describe('the daily purge (§6.6)', () => {
  it('removes only expired sessions when the cron fires', async () => {
    const db = await freshD1();
    const userId = (await upsertGoogleUser(db, 'sub-1', Date.now())).userId;
    const [live, stale] = [newSessionToken(), newSessionToken()];
    await createSession(db, userId, await hashSessionToken(live), Date.now());
    await createSession(db, userId, await hashSessionToken(stale), Date.now() - SESSION_IDLE_MS - 1);

    await worker.scheduled(createScheduledController({ cron: '17 3 * * *', scheduledTime: Date.now() }), testEnv as never);

    const { results } = await testEnv.DB.prepare('SELECT id_hash FROM sessions').all<{ id_hash: string }>();
    expect(results).toEqual([{ id_hash: await hashSessionToken(live) }]);
  });
});
