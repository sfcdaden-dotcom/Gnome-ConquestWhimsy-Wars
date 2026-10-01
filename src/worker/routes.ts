/**
 * Every `/api/*` route, declared once (ACCOUNTS_SPEC_PHASE_2.md §4). The
 * router (./router.ts) applies the `Origin` rule, the limit and the access
 * level before any handler here runs.
 *
 *   POST /api/rooms            → { code, hostKey } for a fresh private room
 *   GET  /api/rooms/:code      → the room's public snapshot (does it exist?)
 *   GET  /api/rooms/:code/ws   → WebSocket upgrade into the room
 *   GET  /api/health           → 200 when the database has the schema this code expects, else 503
 *
 * Rooms are private by construction: there is no list endpoint and no lobby.
 * Knowing the code is what gets you in, so codes are drawn from a CSPRNG over
 * a 28-character alphabet — ~29 bits, which is not a password, but a room only
 * matters for the length of one game and holds nothing but a board.
 *
 * Every room is one Durable Object, addressed by `idFromName(code)`:
 * Cloudflare guarantees a single instance per id worldwide, so the
 * "authoritative state" the whole design rests on is a platform guarantee
 * rather than a hopeful convention.
 *
 * RATE LIMITING, here and in the room. `Room` meters what a connected client
 * may cost (see ../net/ratelimit.ts), but it can only do that once there is a
 * connection, and these routes are reachable without one. So they get a
 * per-IP limiter each, for the things a caller can do before any room has
 * agreed to hold it:
 *
 *  - `POST /api/rooms` mints a code. It touches no storage — the code is a
 *    CSPRNG draw and nothing else — so this limit is not protecting state; it
 *    is keeping one caller from turning a free endpoint into a code faucet.
 *  - Everything under `/api/rooms/:code` addresses a Durable Object, and
 *    addressing one is what BRINGS it into existence. That is the expensive
 *    door: a caller walking random codes creates a fresh object per request,
 *    each with its own storage and event loop, and no per-room cap can help
 *    because every request is a different room.
 *  - `GET /api/health` reads D1 on every call.
 */

import { ROOM_CODE_LENGTH } from '../net/protocol';
import { generateRoomCode } from '../net/room';
import { ACCOUNT_HEADER } from './auth/types';
import { fromD1 } from './db/db';
import { schemaIsCurrent } from './db/schema';
import type { WorkerEnv } from './env';
import { json } from './http';
import type { Route } from './router';
import { route } from './router';

/**
 * Hand a request to its room. The DO answers both the snapshot GET and the
 * upgrade; it needs the code because a freshly created object does not know
 * its own name.
 *
 * Any `x-gw-account` header the client sent is deleted first, on every path:
 * a room may trust that header only because nothing but the Worker can set it
 * (§8.1).
 */
function forwardToRoom(request: Request, env: WorkerEnv, code: string): Promise<Response> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const url = new URL(request.url);
  url.searchParams.set('code', code);
  const forwarded = new Request(url, request);
  forwarded.headers.delete(ACCOUNT_HEADER);
  return stub.fetch(forwarded);
}

/**
 * A code of the wrong length is refused before the join limit, so a
 * malformed URL costs a regex rather than a limiter round trip, and nobody
 * can burn a real caller's budget with garbage that was never going to reach
 * a room anyway.
 */
function checkRoomCode(params: Record<string, string>): Response | null {
  return params.code.length === ROOM_CODE_LENGTH ? null : json({ error: 'Unknown room' }, 404);
}

export const ROUTES: readonly Route[] = [
  route({
    method: 'POST',
    path: '/api/rooms',
    access: 'public',
    limit: 'ROOM_CREATE_LIMIT',
    async handler({ request, env }) {
      const code = generateRoomCode((n) => crypto.getRandomValues(new Uint8Array(n)));
      // Creating the room now, rather than lazily on first connect, is what
      // lets the host be the person who OPENED it: the object mints a
      // `hostKey` here and binds the host to whoever presents it, so a slow
      // socket cannot hand the room to a friend who clicked the link first.
      // The path is one no client can reach: no route here matches it.
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const claim = new URL(request.url);
      claim.pathname = `/api/rooms/${code}/host-key`;
      claim.searchParams.set('code', code);
      const res = await stub.fetch(new Request(claim, { method: 'POST' }));
      if (!res.ok) return json({ error: 'Could not open a room' }, 500);
      const { hostKey } = (await res.json()) as { hostKey: string };
      return json({ code, hostKey });
    },
  }),

  route({
    method: 'GET',
    path: '/api/rooms/:code',
    access: 'public',
    limit: 'ROOM_JOIN_LIMIT',
    checkParams: checkRoomCode,
    handler: async ({ request, env, params }) => forwardToRoom(request, env, params.code.toUpperCase()),
  }),

  route({
    method: 'GET',
    path: '/api/rooms/:code/ws',
    access: 'public',
    // The room will learn which account a socket is signed in as (PR 2-E).
    // Until then the Worker resolves it and passes nothing on.
    identity: 'optional',
    limit: 'ROOM_JOIN_LIMIT',
    checkParams: checkRoomCode,
    handler: async ({ request, env, params }) => forwardToRoom(request, env, params.code.toUpperCase()),
  }),

  // Is the database migrated to what this code expects? 200 or 503, and
  // nothing else — no migration names, no counts. The post-deploy check in
  // DEPLOYMENT.md, and the e2e proof that the suite's Worker reads the
  // database the suite migrated.
  route({
    method: 'GET',
    path: '/api/health',
    access: 'public',
    limit: 'HEALTH_LIMIT',
    async handler({ env }) {
      const ok = await schemaIsCurrent(fromD1(env.DB));
      return json({ ok }, ok ? 200 : 503);
    },
  }),
];
