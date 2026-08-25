/**
 * Worker entry: a room API in front of the same static bundle the game has
 * always been.
 *
 *   POST /api/rooms            → { code } for a fresh private room
 *   GET  /api/rooms/:code      → the room's public snapshot (does it exist?)
 *   GET  /api/rooms/:code/ws   → WebSocket upgrade into the room
 *   everything else            → the SPA assets, exactly as before
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
 * connection, and both endpoints below are reachable without one. So they get
 * a per-IP limiter each, for the two things a caller can do before any room
 * has agreed to hold it:
 *
 *  - `POST /api/rooms` mints a code. It touches no storage — the code is a
 *    CSPRNG draw and nothing else — so this limit is not protecting state; it
 *    is keeping one caller from turning a free endpoint into a code faucet.
 *  - Everything under `/api/rooms/:code` addresses a Durable Object, and
 *    addressing one is what BRINGS it into existence. That is the expensive
 *    door: a caller walking random codes creates a fresh object per request,
 *    each with its own storage and event loop, and no per-room cap can help
 *    because every request is a different room.
 */

import { ROOM_CODE_LENGTH } from '../net/protocol';
import { generateRoomCode } from '../net/room';

export { RoomDurableObject } from './room-do';

interface WorkerEnv {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  /**
   * Cloudflare rate-limit bindings (wrangler.jsonc). Optional in the type
   * because they are not always there: `vite dev` and older local runtimes
   * hand the Worker an env without them, and a game that will not run locally
   * because a production defence is missing is a worse trade than a local run
   * that is not rate limited.
   */
  ROOM_CREATE_LIMIT?: RateLimit;
  ROOM_JOIN_LIMIT?: RateLimit;
}

const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9]+)(\/ws)?$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * The caller, for limiting purposes.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client —
 * unlike `X-Forwarded-For`, which is why that one is not consulted. If it is
 * somehow absent every such request shares one bucket, which is the safe way
 * round: unattributable traffic is limited together rather than not at all.
 */
function callerKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unattributed';
}

/** True when this caller is over the limit. No binding means no limit. */
async function overLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

function tooManyRequests(): Response {
  return Response.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': '60' } },
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (await overLimit(env.ROOM_CREATE_LIMIT, callerKey(request))) return tooManyRequests();
      const code = generateRoomCode((n) => crypto.getRandomValues(new Uint8Array(n)));
      // Creating the room now, rather than lazily on first connect, is what
      // lets the host be the person who OPENED it: the object mints a
      // `hostKey` here and binds the host to whoever presents it, so a slow
      // socket cannot hand the room to a friend who clicked the link first.
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const claim = new URL(request.url);
      claim.pathname = `/api/rooms/${code}/host-key`;
      claim.searchParams.set('code', code);
      const res = await stub.fetch(new Request(claim, { method: 'POST' }));
      if (!res.ok) return json({ error: 'Could not open a room' }, 500);
      const { hostKey } = (await res.json()) as { hostKey: string };
      return json({ code, hostKey });
    }

    const match = ROOM_PATH.exec(url.pathname);
    if (match) {
      const code = match[1].toUpperCase();
      if (code.length !== ROOM_CODE_LENGTH) return json({ error: 'Unknown room' }, 404);
      // Checked after the shape of the code, so a malformed URL costs a regex
      // rather than a limiter round trip — and, more to the point, so nobody
      // can burn a real caller's budget with garbage that was never going to
      // reach a room anyway.
      if (await overLimit(env.ROOM_JOIN_LIMIT, callerKey(request))) return tooManyRequests();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      // The DO answers both the snapshot GET and the upgrade; it needs the
      // code because a freshly created object does not know its own name.
      const forwarded = new URL(request.url);
      forwarded.searchParams.set('code', code);
      return stub.fetch(new Request(forwarded, request));
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
