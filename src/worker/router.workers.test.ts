// The router's rules inside the Workers runtime (ACCOUNTS_SPEC_PHASE_2.md §11,
// rows marked 2-B): the real Worker, the real room Durable Object from
// wrangler.jsonc, and workerd's own Request and WebSocket handling.

import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Authenticate } from './auth/session';
import type { ActiveUser, Auth } from './auth/types';
import type { WorkerEnv } from './env';
import worker from './index';
import { dispatch, route } from './router';
import { ROUTES } from './routes';

const ORIGIN = 'http://localhost:4173';
const realEnv = env as unknown as WorkerEnv;

function call(path: string, init: RequestInit & { origin?: string | null } = {}, e: WorkerEnv = realEnv) {
  const { origin = ORIGIN, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin !== null) headers.set('Origin', origin);
  return worker.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), e as never, createExecutionContext());
}

async function openRoom(): Promise<string> {
  const res = await call('/api/rooms', { method: 'POST' });
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

describe('Origin, through the real Worker and room', () => {
  it('opens a room for the page’s own origin, and refuses another or none', async () => {
    await openRoom();
    for (const origin of ['https://evil.example', 'http://localhost:5173', 'null', null]) {
      const res = await call('/api/rooms', { method: 'POST', origin });
      expect(res.status, String(origin)).toBe(403);
      expect(await res.json()).toEqual({ error: 'BAD_ORIGIN' });
    }
  });

  it('upgrades a socket from the page’s own origin, or with no Origin; refuses another', async () => {
    const code = await openRoom();
    for (const origin of [ORIGIN, null]) {
      const res = await call(`/api/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' }, origin });
      expect(res.status, String(origin)).toBe(101);
      res.webSocket!.accept();
      res.webSocket!.close();
    }
    const refused = await call(`/api/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' }, origin: 'https://evil.example' });
    expect(refused.status).toBe(403);
    expect(refused.webSocket).toBeNull();
  });
});

describe('the account header, in the runtime', () => {
  it('is deleted on both forwarded paths before the room sees the request', async () => {
    const seen: Array<string | null> = [];
    const rooms = {
      idFromName: (name: string) => realEnv.ROOMS.idFromName(name),
      get: () => ({
        async fetch(request: Request) {
          seen.push(request.headers.get('x-gw-account'));
          return Response.json({});
        },
      }),
    };
    const fake = { ...realEnv, ROOMS: rooms } as unknown as WorkerEnv;
    await call('/api/rooms/ABC234', { headers: { 'x-gw-account': 'someone' } }, fake);
    await call('/api/rooms/ABC234/ws', { headers: { Upgrade: 'websocket', 'X-Gw-Account': 'someone' } }, fake);
    expect(seen).toEqual([null, null]);
  });
});

describe('access levels, in the runtime (P2-1)', () => {
  it('a user route: 401 to a guest, 403 to suspended and deleting', async () => {
    const routes = [
      ...ROUTES,
      route({ method: 'GET', path: '/api/synthetic', access: 'user', handler: async ({ user }) => Response.json({ id: user.id }) }),
    ];
    const cases: Array<[Auth, number]> = [
      [{ kind: 'guest' }, 401],
      [{ kind: 'unavailable', userId: 'u', status: 'suspended' }, 403],
      [{ kind: 'unavailable', userId: 'u', status: 'deleting' }, 403],
      [{ kind: 'user', user: { id: 'u' } as ActiveUser }, 200],
    ];
    for (const [auth, status] of cases) {
      const authenticate: Authenticate = async () => auth;
      const res = await dispatch(routes, new Request(`${ORIGIN}/api/synthetic`), realEnv, createExecutionContext(), authenticate);
      expect(res.status, auth.kind).toBe(status);
    }
  });
});
