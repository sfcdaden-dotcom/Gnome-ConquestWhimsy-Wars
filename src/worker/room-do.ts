/**
 * The Durable Object wrapper around `Room`.
 *
 * Deliberately thin: every rule about seats, identity, secrets and the game
 * lives in `src/net/room.ts`, which knows nothing about Cloudflare and is
 * driven directly by tests. This file supplies the four platform-shaped things
 * the room asks for — sockets, storage, alarms, randomness — and nothing else.
 *
 * One DO instance is one room, addressed by `idFromName(roomCode)`. Cloudflare
 * guarantees a single instance per id worldwide, which is what makes
 * "authoritative state" a fact rather than an aspiration: there is exactly one
 * copy of the game, and every action is serialized through one event loop.
 *
 * HIBERNATION. Idle rooms are evicted and their sockets survive without
 * holding memory. On wake the DO has no `Room` and no attached connections, so
 * `roomFor()` rebuilds the room by replaying its stored record, and every live
 * socket is re-introduced through the same `hello` path a reconnect uses —
 * their identity rides along in the socket's attachment.
 */

import { createSeal } from '../net/commitment';
import type { PersistedRoom, RoomConnection, RoomStore } from '../net/room';
import { Room } from '../net/room';
import type { ClientMessage, ServerMessage } from '../net/protocol';
import { parseClientMessage } from '../net/protocol';

/** What a hibernating socket remembers about itself. */
interface SocketAttachment {
  connId: string;
  token: string;
}

/**
 * A Durable Object storage value is capped at 128 KiB, and a long game's
 * action list will outgrow that, so the list is written in chunks. Everything
 * else fits in one value comfortably.
 */
const ACTIONS_PER_CHUNK = 200;
const META_KEY = 'meta';
const ACTIONS_PREFIX = 'actions/';

export class RoomDurableObject implements DurableObject {
  private ctx: DurableObjectState;
  private room: Room | null = null;
  private nextConnId = 1;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  // --- storage -------------------------------------------------------------

  private store(): RoomStore {
    const storage = this.ctx.storage;
    return {
      async load(): Promise<PersistedRoom | null> {
        const meta = await storage.get<Omit<PersistedRoom, 'actions'>>(META_KEY);
        if (!meta) return null;
        const chunks = await storage.list<PersistedRoom['actions']>({ prefix: ACTIONS_PREFIX });
        // Keys are zero-padded, so lexicographic order is chunk order.
        const actions = [...chunks.keys()].sort().flatMap((k) => chunks.get(k) ?? []);
        return { ...meta, actions };
      },
      async save(room: PersistedRoom): Promise<void> {
        const { actions, ...meta } = room;
        // Only the chunk currently being filled can have changed.
        const chunkIndex = Math.max(0, Math.ceil(actions.length / ACTIONS_PER_CHUNK) - 1);
        const start = chunkIndex * ACTIONS_PER_CHUNK;
        await storage.put({
          [META_KEY]: meta,
          [`${ACTIONS_PREFIX}${String(chunkIndex).padStart(6, '0')}`]: actions.slice(start, start + ACTIONS_PER_CHUNK),
        });
      },
    };
  }

  private async roomFor(code: string): Promise<Room> {
    if (!this.room) {
      this.room = await Room.open(
        {
          store: this.store(),
          randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
          createSeal,
          scheduleAlarm: (at) => this.ctx.storage.setAlarm(at),
          now: () => Date.now(),
        },
        code,
      );
      await this.reattachSockets();
    }
    return this.room;
  }

  /**
   * Re-introduce sockets that outlived the room's memory. Each one replays the
   * `hello` it originally sent, carrying the token stored in its attachment,
   * so it lands back in the same seat by the same code path as a reconnect.
   */
  private async reattachSockets(): Promise<void> {
    const room = this.room;
    if (!room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const at = ws.deserializeAttachment() as SocketAttachment | null;
      if (!at) continue;
      this.nextConnId = Math.max(this.nextConnId, Number(at.connId) + 1 || this.nextConnId);
      await room.hello(this.connection(ws, at.connId), { t: 'hello', protocol: 1, token: at.token });
    }
  }

  private connection(ws: WebSocket, id: string): RoomConnection {
    return {
      id,
      send(message: ServerMessage) {
        try {
          ws.send(JSON.stringify(message));
        } catch {
          // A socket that died between broadcast and send is not an error the
          // room can act on; the close handler will clean it up.
        }
      },
      close(code, reason) {
        try {
          ws.close(code ?? 1000, reason ?? '');
        } catch {
          /* already gone */
        }
      },
    };
  }

  // --- HTTP / WebSocket ----------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? '';

    // Minting the host credential. Reachable only from the Worker's own
    // `POST /api/rooms` — the public route regex does not match this path, so
    // no client can ask a room for its host key.
    if (url.pathname.endsWith('/host-key') && request.method === 'POST') {
      const room = await this.roomFor(code);
      return Response.json({ hostKey: await room.hostKeyForCreate() });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      const room = await this.roomFor(code);
      return Response.json(room.snapshot());
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const connId = String(this.nextConnId++);

    await this.roomFor(code);
    // Hibernation-aware accept: the DO can be evicted while this socket stays
    // open, and wakes on the next message rather than holding memory idle.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connId, token: '' } satisfies SocketAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const at = (ws.deserializeAttachment() ?? { connId: '0', token: '' }) as SocketAttachment;
    const room = await this.roomFor('');
    const conn = this.connection(ws, at.connId);

    let parsed: ClientMessage | null = null;
    try {
      parsed = parseClientMessage(JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      conn.send({ t: 'error', code: 'PROTOCOL', message: 'Unreadable message' });
      return;
    }

    if (parsed.t === 'hello') {
      await room.hello(conn, parsed);
      // Remember who this socket is, so hibernation cannot lose the seat.
      const token = room.tokenFor(at.connId);
      if (token) ws.serializeAttachment({ connId: at.connId, token } satisfies SocketAttachment);
      return;
    }
    await room.handle(at.connId, parsed);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const at = ws.deserializeAttachment() as SocketAttachment | null;
    if (at && this.room) await this.room.disconnect(at.connId);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  /** Both timers — CPU pacing and the shot clock — wake the room here. */
  async alarm(): Promise<void> {
    const room = await this.roomFor('');
    await room.onAlarm();
  }
}
