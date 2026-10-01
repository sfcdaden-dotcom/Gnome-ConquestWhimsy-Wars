/**
 * The Worker's front door, driven directly — no wrangler, no miniflare.
 *
 * These pin the routing properties the rooms rely on, through the real route
 * table and router. The one that matters most: a room's host key can only be
 * minted by the Worker's own `POST /api/rooms`, never requested from outside.
 * The router's own rules (access levels, body rules) are in router.test.ts.
 */

import { describe, expect, it } from 'vitest';
import worker from './index';
import type { TestDb } from './db/testDb';
import { createTestDb, migrations, recordApplied } from './db/testDb';

interface Forwarded {
  room: string;
  url: URL;
  method: string;
  headers: Headers;
}

/** A fake env: rooms that record what reaches them, assets, and limiters. */
function makeEnv(opts: { createAllowed?: boolean; joinAllowed?: boolean; healthAllowed?: boolean; db?: TestDb } = {}) {
  const forwarded: Forwarded[] = [];
  const limited: Array<{ limiter: string; key: string }> = [];
  const limiter = (name: string, allowed: boolean) => ({
    async limit({ key }: { key: string }) {
      limited.push({ limiter: name, key });
      return { success: allowed };
    },
  });
  const env = {
    ROOMS: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        async fetch(request: Request) {
          const url = new URL(request.url);
          forwarded.push({ room: id.name, url, method: request.method, headers: request.headers });
          if (url.pathname.endsWith('/host-key')) return Response.json({ hostKey: 'f'.repeat(32) });
          return Response.json({ code: url.searchParams.get('code') });
        },
      }),
    },
    ASSETS: { fetch: async () => new Response('the bundle', { status: 200 }) },
    ROOM_CREATE_LIMIT: limiter('create', opts.createAllowed ?? true),
    ROOM_JOIN_LIMIT: limiter('join', opts.joinAllowed ?? true),
    HEALTH_LIMIT: limiter('health', opts.healthAllowed ?? true),
    DB: opts.db ?? createTestDb(),
  };
  return { env, forwarded, limited };
}

const ORIGIN = 'https://gnomes.example';

/**
 * A request as the game's own page sends it: from its own origin, so with
 * `Origin` set to it. `origin: null` sends none; a string sends that one.
 */
async function call(env: unknown, path: string, init: RequestInit & { origin?: string | null } = {}): Promise<Response> {
  const { origin = ORIGIN, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('CF-Connecting-IP', '203.0.113.7');
  if (origin !== null) headers.set('Origin', origin);
  const request = new Request(`${ORIGIN}${path}`, { ...rest, headers });
  // The handler is typed against the Workers runtime; these are Node's
  // Request/Response, which is all it touches.
  return (worker.fetch as unknown as (r: Request, e: unknown, c: unknown) => Promise<Response>)(request, env, {});
}

const UPGRADE = { Upgrade: 'websocket' };

describe('POST /api/rooms', () => {
  it('opens a room and hands back its code and host key', async () => {
    const { env, forwarded } = makeEnv();
    const res = await call(env, '/api/rooms', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; hostKey: string };
    expect(body.code).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ2-9]{6}$/);
    expect(body.hostKey).toBe('f'.repeat(32));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url.pathname).toBe(`/api/rooms/${body.code}/host-key`);
    expect(forwarded[0].room).toBe(body.code);
  });

  it('answers 429 when the caller is over the create limit, touching no room', async () => {
    const { env, forwarded, limited } = makeEnv({ createAllowed: false });
    const res = await call(env, '/api/rooms', { method: 'POST' });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(forwarded).toHaveLength(0);
    expect(limited).toEqual([{ limiter: 'create', key: '203.0.113.7' }]);
  });

  it('refuses another origin, or none, before spending the caller’s budget', async () => {
    for (const origin of ['https://evil.example', 'https://sub.gnomes.example', 'http://gnomes.example', 'null', null]) {
      const { env, forwarded, limited } = makeEnv();
      const res = await call(env, '/api/rooms', { method: 'POST', origin });
      expect(res.status, String(origin)).toBe(403);
      expect(await res.json()).toEqual({ error: 'BAD_ORIGIN' });
      expect(forwarded).toHaveLength(0);
      expect(limited).toHaveLength(0);
    }
  });
});

describe('/api/rooms/:code', () => {
  it('normalises the code and forwards it to that room', async () => {
    const { env, forwarded } = makeEnv();
    const res = await call(env, '/api/rooms/abc234');

    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].room).toBe('ABC234');
    expect(forwarded[0].url.searchParams.get('code')).toBe('ABC234');
  });

  it('forwards the socket path too', async () => {
    const { env, forwarded } = makeEnv();
    await call(env, '/api/rooms/ABC234/ws');
    expect(forwarded[0].url.pathname).toBe('/api/rooms/ABC234/ws');
  });

  it('rejects a code of the wrong length without spending the caller’s budget', async () => {
    const { env, forwarded, limited } = makeEnv();
    const res = await call(env, '/api/rooms/ABC23');

    expect(res.status).toBe(404);
    expect(forwarded).toHaveLength(0);
    expect(limited).toHaveLength(0);
  });

  it('answers 429 when the caller is over the join limit, creating no room', async () => {
    const { env, forwarded } = makeEnv({ joinAllowed: false });
    const res = await call(env, '/api/rooms/ABC234');

    expect(res.status).toBe(429);
    expect(forwarded).toHaveLength(0);
  });

  it('never lets a client ask a room for its host key', async () => {
    // The DO mints a key for any request whose path ends in /host-key; only the
    // Worker's own POST /api/rooms may send one. Every method, every casing.
    const { env, forwarded } = makeEnv();
    for (const method of ['GET', 'POST', 'PUT']) {
      for (const path of ['/api/rooms/ABC234/host-key', '/api/rooms/abc234/HOST-KEY', '/api/rooms/ABC234/ws/host-key']) {
        const res = await call(env, path, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(forwarded).toHaveLength(0);
  });
});

describe('the socket upgrade and its Origin', () => {
  it('forwards an upgrade from the page’s own origin', async () => {
    const { env, forwarded } = makeEnv();
    await call(env, '/api/rooms/ABC234/ws', { headers: UPGRADE });
    expect(forwarded).toHaveLength(1);
  });

  it('refuses an upgrade from another origin, on either room path, before the join limit', async () => {
    for (const path of ['/api/rooms/ABC234/ws', '/api/rooms/ABC234']) {
      const { env, forwarded, limited } = makeEnv();
      const res = await call(env, path, { headers: UPGRADE, origin: 'https://evil.example' });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: 'BAD_ORIGIN' });
      expect(forwarded).toHaveLength(0);
      expect(limited).toHaveLength(0);
    }
  });

  it('lets an upgrade with no Origin through: not a browser, so it can only be a guest', async () => {
    const { env, forwarded } = makeEnv();
    await call(env, '/api/rooms/ABC234/ws', { headers: UPGRADE, origin: null });
    expect(forwarded).toHaveLength(1);
  });

  it('does not check the Origin of a plain GET', async () => {
    const { env, forwarded } = makeEnv();
    const res = await call(env, '/api/rooms/ABC234', { origin: 'https://evil.example' });
    expect(res.status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });
});

describe('the account header', () => {
  it('is deleted from whatever the client sent, on both forwarded paths', async () => {
    const { env, forwarded } = makeEnv();
    for (const name of ['x-gw-account', 'X-GW-Account']) {
      await call(env, '/api/rooms/ABC234', { headers: { [name]: 'someone-else' } });
      await call(env, '/api/rooms/ABC234/ws', { headers: { ...UPGRADE, [name]: 'someone-else' } });
    }
    expect(forwarded).toHaveLength(4);
    for (const f of forwarded) expect(f.headers.has('x-gw-account')).toBe(false);
    // Everything else the client sent still arrives.
    expect(forwarded[1].headers.get('upgrade')).toBe('websocket');
  });
});

describe('GET /api/health', () => {
  it('answers 200 when the database has the schema the code expects', async () => {
    const db = createTestDb();
    recordApplied(db, ...migrations().map((m) => m.name));
    const res = await call(makeEnv({ db }).env, '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503, and says nothing more, when it does not', async () => {
    const res = await call(makeEnv().env, '/api/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('is metered per caller', async () => {
    const { env, limited } = makeEnv({ healthAllowed: false });
    const res = await call(env, '/api/health');
    expect(res.status).toBe(429);
    expect(limited).toEqual([{ limiter: 'health', key: '203.0.113.7' }]);
  });

  it('only answers GET', async () => {
    const res = await call(makeEnv().env, '/api/health', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('everything else', () => {
  it('answers a room path only to GET', async () => {
    const { env, forwarded } = makeEnv();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await call(env, '/api/rooms/ABC234', { method });
      expect(res.status, method).toBe(404);
    }
    expect(forwarded).toHaveLength(0);
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const { env } = makeEnv();
    const res = await call(env, '/api/nothing-here');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('serves the bundle for any other path', async () => {
    const { env, forwarded } = makeEnv();
    for (const path of ['/', '/?room=ABC234', '/assets/index.js', '/player/Someone']) {
      const res = await call(env, path);
      expect(await res.text(), path).toBe('the bundle');
    }
    expect(forwarded).toHaveLength(0);
  });
});
