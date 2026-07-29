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
 */

import { ROOM_CODE_LENGTH } from '../net/protocol';
import { generateRoomCode } from '../net/room';

export { RoomDurableObject } from './room-do';

interface WorkerEnv {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9]+)(\/ws)?$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const code = generateRoomCode((n) => crypto.getRandomValues(new Uint8Array(n)));
      // The DO is created lazily on first connect; handing back the code is
      // the whole of "creating" a room.
      return json({ code });
    }

    const match = ROOM_PATH.exec(url.pathname);
    if (match) {
      const code = match[1].toUpperCase();
      if (code.length !== ROOM_CODE_LENGTH) return json({ error: 'Unknown room' }, 404);
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
