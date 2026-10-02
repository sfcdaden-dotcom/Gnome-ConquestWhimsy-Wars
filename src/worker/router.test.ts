/**
 * The router's own rules (ACCOUNTS_SPEC_PHASE_2.md §4, §7; requirement P2-1),
 * over synthetic routes and over the real table. What the real routes do is
 * in index.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { Authenticate } from './auth/session';
import type { ActiveUser, Auth } from './auth/types';
import type { WorkerEnv } from './env';
import type { Route } from './router';
import { SELF_EXIT_ALLOWLIST, assertRouteTable, dispatch, route, routeKey } from './router';
import { ROUTES } from './routes';

const ORIGIN = 'https://gnomes.example';
const ACTIVE: Auth = { kind: 'user', user: { id: 'user-1' } as ActiveUser };
const SUSPENDED: Auth = { kind: 'unavailable', userId: 'user-2', status: 'suspended' };
const DELETING: Auth = { kind: 'unavailable', userId: 'user-3', status: 'deleting' };
const GUEST: Auth = { kind: 'guest' };

/** An `authenticate` that answers `auth` and counts its calls. */
function as(auth: Auth) {
  const calls = { n: 0 };
  const fn: Authenticate = async () => {
    calls.n++;
    return auth;
  };
  return { fn, calls };
}

function limiterEnv(allowed = true) {
  const limited: string[] = [];
  const env = {
    HEALTH_LIMIT: {
      async limit({ key }: { key: string }) {
        limited.push(key);
        return { success: allowed };
      },
    },
  } as unknown as WorkerEnv;
  return { env, limited };
}

function request(path: string, init: RequestInit & { origin?: string | null } = {}): Request {
  const { origin = ORIGIN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin !== null) headers.set('Origin', origin);
  return new Request(`${ORIGIN}${path}`, { ...rest, headers });
}

function run(routes: readonly Route[], req: Request, auth: Auth = GUEST, env = limiterEnv().env) {
  return dispatch(routes, req, env, {} as ExecutionContext, as(auth).fn);
}

/** A route that answers 200 with what it was handed. */
function echo(access: 'public' | 'user' | 'self-exit', path = '/api/thing', method: 'GET' | 'POST' = 'GET'): Route {
  switch (access) {
    case 'public':
      return route({ method, path, access, handler: async ({ auth }) => Response.json({ auth: auth.kind }) });
    case 'user':
      return route({ method, path, access, handler: async ({ user }) => Response.json({ user: user.id }) });
    case 'self-exit':
      return route({ method, path, access, handler: async ({ auth }) => Response.json({ auth: auth.kind }) });
  }
}

describe('access levels (P2-1)', () => {
  it('a user route: 401 to a guest, 403 to suspended and deleting, the user to an active account', async () => {
    const routes = [echo('user')];
    const cases: Array<[Auth, number, unknown]> = [
      [GUEST, 401, { error: 'SIGNED_OUT' }],
      [SUSPENDED, 403, { error: 'ACCOUNT_UNAVAILABLE' }],
      [DELETING, 403, { error: 'ACCOUNT_UNAVAILABLE' }],
      [ACTIVE, 200, { user: 'user-1' }],
    ];
    for (const [auth, status, body] of cases) {
      const res = await run(routes, request('/api/thing'), auth);
      expect(res.status, auth.kind).toBe(status);
      expect(await res.json()).toEqual(body);
    }
  });

  it('a self-exit route: 401 to a guest, and any signed-in account whatever its status', async () => {
    const routes = [echo('self-exit', '/api/me')];
    expect((await run(routes, request('/api/me'), GUEST)).status).toBe(401);
    for (const auth of [ACTIVE, SUSPENDED, DELETING]) {
      const res = await run(routes, request('/api/me'), auth);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ auth: auth.kind });
    }
  });

  it('a public route never asks who is calling', async () => {
    const { fn, calls } = as(ACTIVE);
    const res = await dispatch([echo('public')], request('/api/thing'), limiterEnv().env, {} as ExecutionContext, fn);
    expect(await res.json()).toEqual({ auth: 'guest' });
    expect(calls.n).toBe(0);
  });

  it('a public route with optional identity asks, and is never refused over the answer', async () => {
    const routes = [
      route({
        method: 'GET',
        path: '/api/thing',
        access: 'public',
        identity: 'optional',
        handler: async ({ auth }) => Response.json({ auth: auth.kind }),
      }),
    ];
    for (const auth of [GUEST, ACTIVE, SUSPENDED]) {
      const res = await run(routes, request('/api/thing'), auth);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ auth: auth.kind });
    }
  });

  it('an upgrade with no Origin is a guest, without asking', async () => {
    const routes = [
      route({
        method: 'GET',
        path: '/api/thing',
        access: 'public',
        identity: 'optional',
        handler: async ({ auth }) => Response.json({ auth: auth.kind }),
      }),
    ];
    const { fn, calls } = as(ACTIVE);
    const req = request('/api/thing', { origin: null, headers: { Upgrade: 'websocket' } });
    const res = await dispatch(routes, req, limiterEnv().env, {} as ExecutionContext, fn);
    expect(await res.json()).toEqual({ auth: 'guest' });
    expect(calls.n).toBe(0);

    // And on a route that needs an account, that means 401.
    const user = await dispatch([echo('user')], req.clone(), limiterEnv().env, {} as ExecutionContext, fn);
    expect(user.status).toBe(401);
  });
});

describe('the real route table', () => {
  it('passes the table rules', () => {
    expect(() => assertRouteTable(ROUTES)).not.toThrow();
  });

  it('declares an access level for every route', () => {
    for (const r of ROUTES) expect(['public', 'user', 'self-exit'], routeKey(r)).toContain(r.access);
  });

  it('pins the self-exit allowlist to exactly logout and /api/me', () => {
    expect([...SELF_EXIT_ALLOWLIST].sort()).toEqual(['GET /api/me', 'POST /api/auth/logout']);
    for (const r of ROUTES.filter((r) => r.access === 'self-exit')) {
      expect(SELF_EXIT_ALLOWLIST, routeKey(r)).toContain(routeKey(r));
    }
  });

  it('refuses guests and non-active accounts on every route that is not public or self-exit', async () => {
    // Phase 2 has no `user` routes, so this walk is empty today. It is here
    // so that Phase 3's routes are covered the day they are added.
    const env = { ...limiterEnv().env, ACCOUNTS_ENABLED: 'true' } as WorkerEnv;
    for (const r of ROUTES.filter((r) => r.access === 'user')) {
      const path = r.path.replace(/:[A-Za-z]+/g, 'ABC234');
      for (const [auth, status] of [
        [GUEST, 401],
        [SUSPENDED, 403],
        [DELETING, 403],
      ] as const) {
        const res = await run(ROUTES, request(path, { method: r.method }), auth, env);
        expect(res.status, `${routeKey(r)} as ${auth.kind}`).toBe(status);
      }
    }
  });

  it('refuses guests on every self-exit route, and has exactly the allowlisted ones', async () => {
    // With accounts on, so each route is reachable (off, they answer 404).
    const env = { ...limiterEnv().env, ACCOUNTS_ENABLED: 'true' } as WorkerEnv;
    const selfExit = ROUTES.filter((r) => r.access === 'self-exit');
    expect(selfExit.map(routeKey).sort()).toEqual([...SELF_EXIT_ALLOWLIST].sort());
    for (const r of selfExit) {
      const res = await run(ROUTES, request(r.path, { method: r.method }), GUEST, env);
      expect(res.status, routeKey(r)).toBe(401);
    }
  });

  it('hides every accounts route while accounts are off', async () => {
    for (const r of ROUTES.filter((r) => r.access !== 'public')) {
      for (const ACCOUNTS_ENABLED of [undefined, 'false']) {
        const env = { ...limiterEnv().env, ACCOUNTS_ENABLED } as WorkerEnv;
        const res = await run(ROUTES, request(r.path, { method: r.method }), ACTIVE, env);
        expect(res.status, `${routeKey(r)} with ${ACCOUNTS_ENABLED}`).toBe(404);
      }
    }
  });
});

describe('table rules', () => {
  it('refuses a self-exit route that is not on the allowlist', () => {
    expect(() => assertRouteTable([echo('self-exit', '/api/profile')])).toThrow(/allowlist/);
  });

  it('refuses a route declared twice', () => {
    expect(() => assertRouteTable([echo('public'), echo('public')])).toThrow(/twice/);
  });

  it('refuses a route with no access level', () => {
    const bad = { ...echo('public'), access: undefined } as unknown as Route;
    expect(() => assertRouteTable([bad])).toThrow(/access/);
  });
});

describe('order of checks', () => {
  it('refuses a bad Origin before spending the rate limit', async () => {
    const { env, limited } = limiterEnv();
    const routes = [{ ...echo('public', '/api/thing', 'POST'), limit: 'HEALTH_LIMIT' } as Route];
    const res = await run(routes, request('/api/thing', { method: 'POST', origin: 'https://evil.example' }), GUEST, env);
    expect(res.status).toBe(403);
    expect(limited).toHaveLength(0);
  });

  it('applies the rate limit before asking who is calling', async () => {
    const { env } = limiterEnv(false);
    const { fn, calls } = as(ACTIVE);
    const routes = [{ ...echo('user'), limit: 'HEALTH_LIMIT' } as Route];
    const res = await dispatch(routes, request('/api/thing'), env, {} as ExecutionContext, fn);
    expect(res.status).toBe(429);
    expect(calls.n).toBe(0);
  });

  it('refuses on access before reading the body', async () => {
    let parsed = 0;
    const routes = [
      route<{ n: number }>({
        method: 'POST',
        path: '/api/thing',
        access: 'user',
        body: {
          maxBytes: 100,
          parse: (v) => {
            parsed++;
            return v as { n: number };
          },
        },
        handler: async ({ body }) => Response.json(body),
      }),
    ];
    const res = await run(routes, request('/api/thing', { method: 'POST', body: '{"n":1}', headers: { 'content-type': 'application/json' } }), GUEST);
    expect(res.status).toBe(401);
    expect(parsed).toBe(0);
  });

  it('answers an unknown path or method with a JSON 404', async () => {
    for (const req of [request('/api/other'), request('/api/thing', { method: 'POST' })]) {
      const res = await run([echo('public')], req);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('matches a path parameter only on letters and digits', async () => {
    const routes = [
      route({ method: 'GET', path: '/api/rooms/:code', access: 'public', handler: async ({ params }) => Response.json(params) }),
    ];
    expect(await (await run(routes, request('/api/rooms/abc234'))).json()).toEqual({ code: 'abc234' });
    for (const path of ['/api/rooms/', '/api/rooms/a-b', '/api/rooms/abc/x', '/api/rooms/%2e%2e']) {
      expect((await run(routes, request(path))).status, path).toBe(404);
    }
  });
});

describe('body rules', () => {
  interface Body {
    name: string;
  }
  const routes = [
    route<Body>({
      method: 'POST',
      path: '/api/thing',
      access: 'public',
      body: {
        maxBytes: 64,
        parse: (v) =>
          typeof v === 'object' && v !== null && typeof (v as Body).name === 'string' ? { name: (v as Body).name } : undefined,
      },
      handler: async ({ body }) => Response.json({ got: body.name }),
    }),
  ];
  const post = (body: BodyInit, type = 'application/json') =>
    run(routes, request('/api/thing', { method: 'POST', body, headers: { 'content-type': type } }));

  it('hands the handler the parsed, validated body', async () => {
    const res = await post('{"name":"Pip","extra":1}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: 'Pip' });
    expect((await post('{"name":"Pip"}', 'application/json; charset=utf-8')).status).toBe(200);
  });

  it('refuses anything but JSON with 415', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await post('{"name":"Pip"}', type);
      expect(res.status, type).toBe(415);
      expect(await res.json()).toEqual({ error: 'UNSUPPORTED_MEDIA_TYPE' });
    }
  });

  it('refuses a body over the cap with 413, whatever Content-Length says', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(100) });
    expect((await post(big)).status).toBe(413);
    // Streamed, so no Content-Length: counted as it arrives.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const req = new Request(`${ORIGIN}/api/thing`, {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/json', Origin: ORIGIN },
      duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    expect((await run(routes, req)).status).toBe(413);
  });

  it('refuses malformed JSON, bad UTF-8, and a body the schema rejects, with 400', async () => {
    for (const body of ['{"name":', '', '{"name":7}', '[]', 'null', new Uint8Array([0x7b, 0xff, 0x7d])]) {
      const res = await post(body);
      expect(res.status, String(body)).toBe(400);
      expect(await res.json()).toEqual({ error: 'BAD_BODY' });
    }
  });
});

describe('routes that are off (D2)', () => {
  const gated = route({
    method: 'GET',
    path: '/api/me',
    access: 'self-exit',
    enabled: (env) => env.ACCOUNTS_ENABLED === 'true',
    handler: async () => Response.json({ ok: true }),
  });

  it('answer the same JSON 404 as an unknown path, before anything else is checked', async () => {
    const { fn, calls } = as(ACTIVE);
    const { env, limited } = limiterEnv();
    const limitedRoute = { ...gated, limit: 'HEALTH_LIMIT' } as Route;
    const res = await dispatch([limitedRoute], request('/api/me', { origin: 'https://evil.example' }), env, {} as ExecutionContext, fn);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(calls.n).toBe(0);
    expect(limited).toHaveLength(0);
  });

  it('run normally once on', async () => {
    const env = { ...limiterEnv().env, ACCOUNTS_ENABLED: 'true' } as WorkerEnv;
    const res = await dispatch([gated], request('/api/me'), env, {} as ExecutionContext, as(ACTIVE).fn);
    expect(res.status).toBe(200);
  });
});

describe('a stale session cookie', () => {
  const STALE: Auth = { kind: 'guest', staleSession: true };

  it('is cleared on a refusal', async () => {
    const res = await run([echo('self-exit', '/api/me')], request('/api/me'), STALE);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-gw_session=;.*Max-Age=0/);
  });

  it('is cleared on a public route that looked, and not on one that did not', async () => {
    const looking = route({
      method: 'GET',
      path: '/api/thing',
      access: 'public',
      identity: 'optional',
      handler: async () => Response.json({}),
    });
    expect((await run([looking], request('/api/thing'), STALE)).headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await run([echo('public')], request('/api/thing'), STALE)).headers.get('set-cookie')).toBeNull();
  });

  it('is never set for a live session or a plain guest', async () => {
    for (const auth of [GUEST, ACTIVE, SUSPENDED]) {
      const res = await run([echo('self-exit', '/api/me')], request('/api/me'), auth);
      expect(res.headers.get('set-cookie'), auth.kind).toBeNull();
    }
  });
});

describe('when the session lookup itself fails', () => {
  const failing: Authenticate = async () => {
    throw new Error('D1 unreachable');
  };

  it('a public route still runs, as a guest', async () => {
    const looking = route({
      method: 'GET',
      path: '/api/thing',
      access: 'public',
      identity: 'optional',
      handler: async ({ auth }) => Response.json({ auth: auth.kind }),
    });
    const res = await dispatch([looking], request('/api/thing'), limiterEnv().env, {} as ExecutionContext, failing);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auth: 'guest' });
  });

  it('a route that needs an account answers 503, not 401', async () => {
    for (const r of [echo('user'), echo('self-exit', '/api/thing')]) {
      const res = await dispatch([r], request('/api/thing'), limiterEnv().env, {} as ExecutionContext, failing);
      expect(res.status, r.access).toBe(503);
      expect(await res.json()).toEqual({ error: 'UNAVAILABLE' });
    }
  });
});

