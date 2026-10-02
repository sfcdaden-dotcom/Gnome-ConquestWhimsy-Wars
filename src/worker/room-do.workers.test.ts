// The room's Durable Object across a wake from hibernation, in the Workers
// runtime (ACCOUNTS_SPEC_PHASE_2.md §8.2 rule 3, review note N1).
//
// Eviction is simulated by building a fresh RoomDurableObject over the live
// object's own state: what survives a real eviction is exactly that state and
// its hibernated sockets, while the in-memory Room and the connection counter
// start over.

import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../net/protocol';
import type { RoomSnapshot } from '../net/protocol';
import worker from './index';
import { RoomDurableObject } from './room-do';

const ORIGIN = 'http://localhost:4173';
const ROOMS = (env as unknown as { ROOMS: DurableObjectNamespace }).ROOMS;

interface Client {
  ws: WebSocket;
  rooms: RoomSnapshot[];
  kinds: string[];
}

function listen(ws: WebSocket): Client {
  const client: Client = { ws, rooms: [], kinds: [] };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data as string) as { t: string; room?: RoomSnapshot };
    client.kinds.push(m.t);
    if (m.t === 'room' && m.room) client.rooms.push(m.room);
  });
  return client;
}

/** Let in-flight socket messages land. */
const settle = () => new Promise((r) => setTimeout(r, 50));
const connected = (c: Client) => c.rooms.at(-1)?.seats.map((s) => s.connected);
const hello = (extra: Record<string, unknown> = {}) => JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, ...extra });

async function openRoom(): Promise<{ code: string; hostKey: string }> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/rooms`, { method: 'POST', headers: { Origin: ORIGIN } }),
    env as never,
    createExecutionContext(),
  );
  return (await res.json()) as { code: string; hostKey: string };
}

/** A socket into the room through the real Worker and the live object. */
async function dial(code: string): Promise<Client> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/rooms/${code}/ws`, { headers: { Upgrade: 'websocket', Origin: ORIGIN } }),
    env as never,
    createExecutionContext(),
  );
  const ws = res.webSocket!;
  ws.accept();
  return listen(ws);
}

/** A socket into the room through a given (woken) instance, as the Worker would forward it. */
async function dialInto(room: RoomDurableObject, code: string): Promise<Client> {
  const res = await room.fetch(new Request(`${ORIGIN}/api/rooms/${code}/ws?code=${code}`, { headers: { Upgrade: 'websocket' } }));
  const ws = res.webSocket!;
  ws.accept();
  return listen(ws);
}

type Attachment = { connId: string; token: string };
const attachment = (ws: WebSocket) => ws.deserializeAttachment() as Attachment;

describe('a wake from hibernation', () => {
  it('a player joining after the wake does not replace the host (the stale-readiness bug)', async () => {
    const { code, hostKey } = await openRoom();
    const host = await dial(code);
    host.ws.send(hello({ hostKey, name: 'Host' }));
    await settle();
    expect(connected(host)).toEqual([true, false]);

    await runInDurableObject(ROOMS.get(ROOMS.idFromName(code)), async (_live: RoomDurableObject, state) => {
      const woken = new RoomDurableObject(state);
      const p2 = await dialInto(woken, code);
      const p2Server = state.getWebSockets().find((ws) => attachment(ws).token === '')!;
      await woken.webSocketMessage(p2Server, hello({ name: 'P2' }));
      await settle();

      // Before the fix: the host saw [true, false] and P2 saw [false, true].
      expect(connected(p2)).toEqual([true, true]);
      expect(connected(host)).toEqual([true, true]);

      // And the host's messages still reach the host, not P2.
      const hostServer = state.getWebSockets().find((ws) => ws !== p2Server)!;
      const [hostPongs, p2Pongs] = [host.kinds.length, p2.kinds.length];
      await woken.webSocketMessage(hostServer, JSON.stringify({ t: 'ping' }));
      await settle();
      expect(host.kinds.slice(hostPongs)).toEqual(['pong']);
      expect(p2.kinds.slice(p2Pongs)).not.toContain('pong');
    });
  });

  it('gives a connection arriving after a wake an id above every surviving one (N1)', async () => {
    const { code, hostKey } = await openRoom();
    const host = await dial(code);
    host.ws.send(hello({ hostKey, name: 'Host' }));
    const p2 = await dial(code);
    p2.ws.send(hello({ name: 'P2' }));
    const board = await dial(code);
    board.ws.send(hello({ spectate: true }));
    await settle();

    await runInDurableObject(ROOMS.get(ROOMS.idFromName(code)), async (_live: RoomDurableObject, state) => {
      const survivors = state.getWebSockets().map((ws) => Number(attachment(ws).connId));
      expect(new Set(survivors).size).toBe(3);

      const woken = new RoomDurableObject(state);
      await dialInto(woken, code);
      const ids = state.getWebSockets().map((ws) => Number(attachment(ws).connId));
      expect(new Set(ids).size).toBe(ids.length);
      const newcomer = ids.find((id) => !survivors.includes(id))!;
      expect(newcomer).toBeGreaterThan(Math.max(...survivors));
    });
  });

  it('keeps ids unique when the wake is a message rather than an upgrade', async () => {
    const { code, hostKey } = await openRoom();
    const host = await dial(code);
    host.ws.send(hello({ hostKey, name: 'Host' }));
    await settle();

    await runInDurableObject(ROOMS.get(ROOMS.idFromName(code)), async (_live: RoomDurableObject, state) => {
      const woken = new RoomDurableObject(state);
      const [hostServer] = state.getWebSockets();
      await woken.webSocketMessage(hostServer, JSON.stringify({ t: 'ping' })); // wakes the room first
      await dialInto(woken, code);
      const ids = state.getWebSockets().map((ws) => attachment(ws).connId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
