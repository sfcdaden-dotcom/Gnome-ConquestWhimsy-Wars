/**
 * The room's rules, driven directly — no Worker, no sockets, no network.
 *
 * The properties worth pinning are the ones a client could otherwise talk the
 * server out of:
 *  - a connection can only act for the seat the SERVER gave it;
 *  - what goes out to a seat is redacted for that seat;
 *  - the deck secret stays in the room until the game is over;
 *  - a dropped player gets their seat (and their hand) back, and a hibernated
 *    room rebuilds the same game from what it stored.
 */

import { describe, expect, it } from 'vitest';
import type { GameSeal, MatchRecord } from '../engine';
import { HIDDEN_CARD_ID, chooseAiAction, getPlayerToAct, replayMatch } from '../engine';
import { createSeal, verifySeal } from './commitment';
import type { PersistedRoom, RoomConnection, RoomHost } from './room';
import { Room, generateRoomCode } from './room';
import { ROOM_CODE_ALPHABET } from './protocol';
import type { ServerMessage } from './protocol';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class FakeConn implements RoomConnection {
  readonly id: string;
  sent: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(id: string) {
    this.id = id;
  }

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** The most recent message of a kind, or undefined. */
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].t === t) return this.sent[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }

  errors(): string[] {
    return this.sent.filter((m) => m.t === 'error').map((m) => (m as { code: string }).code);
  }
}

function makeHost(): RoomHost & { stored: PersistedRoom | null; alarms: number[] } {
  let counter = 1;
  const h = {
    stored: null as PersistedRoom | null,
    alarms: [] as number[],
    store: {
      async load() {
        return h.stored ? (structuredClone(h.stored) as PersistedRoom) : null;
      },
      async save(room: PersistedRoom) {
        h.stored = structuredClone(room) as PersistedRoom;
      },
    },
    randomBytes(n: number) {
      // Deterministic, but a full-period LCG read from its HIGH bits: the low
      // bits of an LCG cycle in single digits, which would hand every caller
      // the same "random" token.
      return new Uint8Array(
        Array.from({ length: n }, () => {
          counter = (Math.imul(counter, 1664525) + 1013904223) >>> 0;
          return (counter >>> 24) & 0xff;
        }),
      );
    },
    createSeal,
    scheduleAlarm(at: number) {
      h.alarms.push(at);
    },
    now: () => 1_000_000,
    cpuDelayMs: 0,
  };
  return h;
}

const HELLO = { t: 'hello', protocol: 1 } as const;

/** A room with one connected human host, seats as given. */
async function lobby(seats: Array<'human' | 'cpu'> = ['human', 'cpu']) {
  const host = makeHost();
  const room = await Room.open(host, 'ABC123');
  const c0 = new FakeConn('c0');
  await room.hello(c0, { ...HELLO });
  await room.handle('c0', {
    t: 'configure',
    seats: seats.map((controller, index) => ({ index, controller })),
  });
  return { host, room, c0 };
}

/** Run the CPU alarm loop until the game ends (or the cap trips). */
async function runToEnd(room: Room, max = 4000): Promise<void> {
  for (let i = 0; i < max && room.phase === 'playing'; i++) await room.onAlarm();
}

// ---------------------------------------------------------------------------

describe('seats and identity', () => {
  it('seats the first connection and makes it the host', async () => {
    const { c0 } = await lobby();
    const welcome = c0.last('welcome');

    expect(welcome?.you.seat).toBe(0);
    expect(welcome?.you.isHost).toBe(true);
    expect(welcome?.you.token).toBeTruthy();
  });

  it('seats a second player in the next free human seat', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const c0 = new FakeConn('c0');
    const c1 = new FakeConn('c1');
    await room.hello(c0, { ...HELLO });
    await room.handle('c0', { t: 'configure', seats: [{ index: 1, controller: 'human' }] });
    await room.hello(c1, { ...HELLO });

    expect(c1.last('welcome')?.you.seat).toBe(1);
    expect(c1.last('welcome')?.you.isHost).toBe(false);
  });

  it('makes an extra arrival a spectator rather than turning one away', async () => {
    const { room } = await lobby(['human', 'cpu']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });

    expect(c1.last('welcome')?.you.seat).toBeNull();
    expect(c1.last('room')?.room.spectators).toBe(1);
  });

  it('never puts a token in anything broadcast', async () => {
    const { room, c0 } = await lobby();
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });

    const mine = c0.last('welcome')?.you.token;
    expect(mine).toBeTruthy();
    // c0's token appears only in c0's own welcome, never in c1's traffic.
    expect(JSON.stringify(c1.sent)).not.toContain(mine);
  });

  it('rejects a protocol version it does not speak', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const c = new FakeConn('c');
    await room.hello(c, { t: 'hello', protocol: 99 });

    expect(c.errors()).toContain('PROTOCOL');
    expect(c.closed).not.toBeNull();
  });

  it('generates room codes from the unambiguous alphabet', () => {
    const code = generateRoomCode((n) => new Uint8Array(Array.from({ length: n }, (_, i) => i * 7 + 3)));
    expect(code).toHaveLength(6);
    for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    // No vowels and no 0/O/1/I/L, so a code cannot spell a word or be misread.
    expect(code).not.toMatch(/[AEIOU01IL]/);
  });
});

describe('a room seats the people in it', () => {
  it('seats an arriving player without the host configuring anything', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const c0 = new FakeConn('c0');
    const c1 = new FakeConn('c1');
    await room.hello(c0, { ...HELLO });
    await room.hello(c1, { ...HELLO });

    // A fresh room is people, not bots: the friend who has the code sits down.
    expect(c0.last('welcome')?.you.seat).toBe(0);
    expect(c1.last('welcome')?.you.seat).toBe(1);
  });

  it('seats a waiting spectator when the host turns a CPU seat human', async () => {
    const { room } = await lobby(['human', 'cpu']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    expect(c1.last('welcome')?.you.seat).toBeNull();

    await room.handle('c0', { t: 'configure', seats: [{ index: 1, controller: 'human' }] });

    // The seat is not merely open — the person already waiting is IN it, and
    // has been told so.
    expect(c1.last('welcome')?.you.seat).toBe(1);
    expect(c1.last('room')?.room.seats[1].connected).toBe(true);
    expect(c1.last('room')?.room.spectators).toBe(0);
  });

  it('seats waiting spectators when the host opens the table to four', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    const c2 = new FakeConn('c2');
    const c3 = new FakeConn('c3');
    await room.hello(c1, { ...HELLO });
    await room.hello(c2, { ...HELLO });
    await room.hello(c3, { ...HELLO });
    expect(c2.last('welcome')?.you.seat).toBeNull();

    await room.handle('c0', { t: 'configure', playerCount: 4 });

    expect(c2.last('welcome')?.you.seat).toBe(2);
    expect(c3.last('welcome')?.you.seat).toBe(3);
    await room.handle('c0', { t: 'start' });
    expect(room.phase).toBe('playing');
  });

  it('unseats a player whose seat the host turned into a CPU', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    expect(c1.last('welcome')?.you.seat).toBe(1);

    await room.handle('c0', { t: 'configure', seats: [{ index: 1, controller: 'cpu' }] });

    expect(c1.last('welcome')?.you.seat).toBeNull();
    expect(c1.last('room')?.room.spectators).toBe(1);
  });

  it('gives an abandoned lobby seat to whoever is waiting', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    const c2 = new FakeConn('c2');
    await room.hello(c1, { ...HELLO });
    await room.hello(c2, { ...HELLO });
    expect(c2.last('welcome')?.you.seat).toBeNull();

    // c1 closes the tab before the deal. Nothing is invested yet, so the seat
    // is up for grabs rather than blocking the game forever.
    await room.disconnect('c1');

    expect(c2.last('welcome')?.you.seat).toBe(1);
    await room.handle('c0', { t: 'start' });
    expect(room.phase).toBe('playing');
  });

  it('does NOT give away a seat its player dropped from mid-game', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    await room.handle('c0', { t: 'start' });
    await room.disconnect('c1');

    const stranger = new FakeConn('x');
    await room.hello(stranger, { ...HELLO });

    // Seat 1 is still c1's: the token holds it, and they are reconnecting.
    expect(stranger.last('welcome')?.you.seat).toBeNull();
  });

  it('hands the lobby to someone who is still here when the host leaves', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    expect(c1.last('welcome')?.you.isHost).toBe(false);

    await room.disconnect('c0');

    expect(c1.last('welcome')?.you.isHost).toBe(true);
    await room.handle('c1', { t: 'configure', seats: [{ index: 0, controller: 'cpu' }] });
    await room.handle('c1', { t: 'start' });
    expect(room.phase).toBe('playing');
  });

  it('leaves a host who took a CPU seat in charge of the lobby', async () => {
    const { room, c0 } = await lobby(['cpu', 'cpu']);
    expect(c0.last('welcome')?.you.seat).toBeNull();
    expect(c0.last('welcome')?.you.isHost).toBe(true);

    await room.handle('c0', { t: 'start' });
    expect(room.phase).toBe('playing');
  });

  it('hands a promoted spectator the view for their new seat', async () => {
    const { room } = await lobby(['human', 'cpu']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    await room.handle('c0', { t: 'configure', seats: [{ index: 1, controller: 'human' }] });
    await room.handle('c0', { t: 'start' });

    const state = room.gameState!;
    state.players[1].hand.push('rocket-gnome');
    await room.handle('c0', { t: 'action', action: { type: 'rollOff', player: 0 } });

    // Seated, so no longer the spectator's null view: seat 1 sees seat 1's hand.
    expect(c1.last('state')!.view.players[1].hand).toContain('rocket-gnome');
  });
});

describe('the lobby belongs to the host', () => {
  it('refuses configure and start from anyone else', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });

    await room.handle('c1', { t: 'configure', boardSize: 9 });
    await room.handle('c1', { t: 'start' });

    expect(c1.errors()).toEqual(['NOT_HOST', 'NOT_HOST']);
    expect(room.phase).toBe('lobby');
  });

  it('will not start with a human seat nobody is sitting in', async () => {
    const { room, c0 } = await lobby(['human', 'human']);
    await room.handle('c0', { t: 'start' });

    expect(room.phase).toBe('lobby');
    expect(c0.last('error')?.code).toBe('BAD_CONFIG');
    expect(c0.last('error')?.message).toMatch(/seat 2/);
  });

  it('rejects board sizes the engine would reject', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'configure', boardSize: 6 });
    expect(c0.last('error')?.code).toBe('BAD_CONFIG');
    expect(room.phase).toBe('lobby');
  });

  it('refuses lobby changes once the game is running', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'start' });
    await room.handle('c0', { t: 'configure', boardSize: 9 });
    await room.handle('c0', { t: 'start' });

    expect(c0.errors().filter((e) => e === 'WRONG_PHASE')).toHaveLength(2);
  });
});

describe('the room owns the secret', () => {
  it('publishes the commitment when play starts, and not the secret', async () => {
    const { room, c0 } = await lobby();
    expect(c0.last('room')?.room.commitment).toBeNull();

    await room.handle('c0', { t: 'start' });
    const commitment = c0.last('room')?.room.commitment;
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);

    // The secret itself is in nothing the client has received. It arrives
    // exactly once, in `revealed`, after the last move — see the game-over
    // test below.
    expect(c0.last('revealed')).toBeUndefined();
    expect(JSON.stringify(c0.sent)).not.toContain('"secret"');
  });

  it('picks the seed itself — a client is never asked for one', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'start' });

    // Nothing the player can see reveals the seed or the RNG stream.
    const view = c0.last('state')?.view;
    expect(view?.seed).toBe(0);
    expect(view?.rngState).toBe(0);
  });
});

describe('acting', () => {
  it('refuses an action for a seat the connection does not hold', async () => {
    const { room, c0 } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    await room.handle('c0', { t: 'start' });
    const before = room.gameState;

    // Seat 0 tries to roll off as seat 1 — the engine would happily validate
    // this action; the ROOM is what refuses to ask on seat 1's behalf.
    await room.handle('c0', { t: 'action', action: { type: 'rollOff', player: 1 } });

    expect(c0.last('error')?.code).toBe('NOT_YOUR_SEAT');
    expect(room.gameState).toBe(before);
  });

  it('refuses actions from spectators', async () => {
    const { room } = await lobby();
    const spec = new FakeConn('spec');
    await room.hello(spec, { ...HELLO });
    await room.handle('c0', { t: 'start' });

    await room.handle('spec', { t: 'action', action: { type: 'rollOff', player: 0 } });

    expect(spec.last('error')?.code).toBe('NOT_YOUR_SEAT');
  });

  it('passes an illegal action to the sender as an error, not to the table', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'start' });
    const before = room.gameState;

    await room.handle('c0', { t: 'action', action: { type: 'endTurn', player: 0 } });

    expect(c0.last('error')?.code).toBe('ILLEGAL_ACTION');
    expect(room.gameState).toBe(before);
  });

  it('refuses actions before the game starts', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'action', action: { type: 'rollOff', player: 0 } });
    expect(c0.last('error')?.code).toBe('WRONG_PHASE');
  });

  it('applies a legal action and broadcasts the new state', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'start' });
    const before = c0.last('state')?.view.eventCount ?? 0;

    await room.handle('c0', { t: 'action', action: { type: 'rollOff', player: 0 } });

    expect(c0.last('state')?.view.eventCount).toBeGreaterThan(before);
  });
});

describe('what each seat is told', () => {
  it('redacts the state per seat — my hand only', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const c0 = new FakeConn('c0');
    const c1 = new FakeConn('c1');
    await room.hello(c0, { ...HELLO });
    await room.handle('c0', { t: 'configure', seats: [{ index: 1, controller: 'human' }] });
    await room.hello(c1, { ...HELLO });
    await room.handle('c0', { t: 'start' });

    // Deal both seats a hand so there is something to hide.
    const state = room.gameState;
    expect(state).not.toBeNull();
    state!.players[0].hand.push('nope-gnome');
    state!.players[1].hand.push('rocket-gnome');
    await room.handle('c0', { t: 'action', action: { type: 'rollOff', player: 0 } });

    const v0 = c0.last('state')!.view;
    const v1 = c1.last('state')!.view;

    expect(v0.players[0].hand).toContain('nope-gnome');
    expect(v0.players[1].hand.every((c) => c === HIDDEN_CARD_ID)).toBe(true);
    expect(v1.players[1].hand).toContain('rocket-gnome');
    expect(v1.players[0].hand.every((c) => c === HIDDEN_CARD_ID)).toBe(true);
  });

  it('never sends the draw pile to anyone', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'start' });
    const view = c0.last('state')!.view;

    expect(view.deck.length).toBeGreaterThan(0);
    expect(view.deck.every((c) => c === HIDDEN_CARD_ID)).toBe(true);
  });
});

describe('CPU seats', () => {
  it('schedules a CPU seat rather than acting inline', async () => {
    const { host, room } = await lobby(['cpu', 'cpu']);
    await room.handle('c0', { t: 'start' });

    expect(host.alarms.length).toBeGreaterThan(0);
    const actor = getPlayerToAct(room.gameState!);
    expect(actor).not.toBeNull();

    await room.onAlarm();
    expect(room.gameState!.eventCount).toBeGreaterThan(0);
  });

  it('plays a whole CPU-vs-CPU game and finishes it', async () => {
    const { room, c0 } = await lobby(['cpu', 'cpu']);
    await room.handle('c0', { t: 'start' });
    await runToEnd(room);

    expect(room.phase).toBe('finished');
    expect(c0.last('revealed')).toBeDefined();
  }, 60_000);

  it('does nothing on an alarm when the seat to act is human', async () => {
    const { room } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'start' });
    const before = room.gameState;

    // The roll-off is seat 0's (human) — an alarm must not act for them.
    if (getPlayerToAct(before!) === 0) {
      await room.onAlarm();
      expect(room.gameState).toBe(before);
    }
  });
});

describe('reconnect and hibernation', () => {
  it('gives a returning player their seat back with the token', async () => {
    const { room, c0 } = await lobby();
    const token = c0.last('welcome')!.you.token;
    await room.handle('c0', { t: 'start' });
    room.disconnect('c0');

    const again = new FakeConn('c0-again');
    await room.hello(again, { t: 'hello', protocol: 1, token });

    expect(again.last('welcome')?.you.seat).toBe(0);
    expect(again.last('welcome')?.you.isHost).toBe(true);
    // ...and they are handed the current game immediately.
    expect(again.last('state')).toBeDefined();
  });

  it('does not hand a seat to someone presenting an unknown token', async () => {
    const { room } = await lobby(['human', 'cpu']);
    const stranger = new FakeConn('x');
    await room.hello(stranger, { t: 'hello', protocol: 1, token: 'not-a-real-token' });

    // Seat 0 is taken and seat 1 is a CPU, so there is nothing to claim.
    expect(stranger.last('welcome')?.you.seat).toBeNull();
  });

  it('takes the seat over when the same token connects twice', async () => {
    const { room, c0 } = await lobby();
    const token = c0.last('welcome')!.you.token;

    const second = new FakeConn('c0-second');
    await room.hello(second, { t: 'hello', protocol: 1, token });

    expect(second.last('welcome')?.you.seat).toBe(0);
    expect(c0.closed).not.toBeNull();
  });

  it('rebuilds the same game from storage after the room is evicted', async () => {
    const { host, room } = await lobby(['cpu', 'cpu']);
    await room.handle('c0', { t: 'start' });
    for (let i = 0; i < 12; i++) await room.onAlarm();
    const live = room.gameState!;

    // A brand new Room over the same storage: nothing carried in memory.
    const woken = await Room.open(host, 'ABC123');

    expect(woken.phase).toBe(room.phase);
    expect(woken.gameState).toEqual(live);
  });
});

describe('game over', () => {
  it('reveals a record that verifies against the commitment and replays', async () => {
    const { room, c0 } = await lobby(['cpu', 'cpu']);
    await room.handle('c0', { t: 'start' });
    const commitment = c0.last('room')!.room.commitment!;
    await runToEnd(room);

    const revealed = c0.last('revealed');
    expect(revealed).toBeDefined();
    const { seal, record } = revealed as { seal: GameSeal; record: MatchRecord };

    // 1. The room was bound to this secret before the first card was dealt.
    expect(await verifySeal(seal, commitment)).toBe(true);
    // 2. ...and this is the game that was actually played under it.
    const replayed = replayMatch(record);
    expect(replayed.winner).toBe(room.gameState!.winner);
    expect(replayed.eventCount).toBe(room.gameState!.eventCount);
  }, 60_000);
});

describe('quick chat after the final fight', () => {
  it('still accepts "gg" once the game is over, and reveals only once', async () => {
    const { room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'start' });
    await runToEnd(room, 4000);
    // Seat 0 is human, so drive the human turns too until somebody wins.
    for (let i = 0; i < 4000 && room.phase === 'playing'; i++) {
      const actor = getPlayerToAct(room.gameState!);
      if (actor === 0) {
        await room.handle('c0', { t: 'action', action: chooseAiAction(room.gameState!) });
      } else {
        await room.onAlarm();
      }
    }
    expect(room.phase).toBe('finished');

    const revealsBefore = c0.sent.filter((m) => m.t === 'revealed').length;
    expect(revealsBefore).toBe(1);
    const eventsBefore = room.gameState!.eventCount;

    await room.handle('c0', { t: 'action', action: { type: 'quickChat', player: 0, phraseId: 'gg' } });

    expect(c0.last('error')).toBeUndefined();
    expect(room.gameState!.eventCount).toBeGreaterThan(eventsBefore);
    // The seal is published once, on the transition — not again per chat line.
    expect(c0.sent.filter((m) => m.t === 'revealed')).toHaveLength(1);
  }, 60_000);

  it('still refuses a real move once the game is over', async () => {
    const { room, c0 } = await lobby(['cpu', 'cpu']);
    await room.handle('c0', { t: 'start' });
    await runToEnd(room);
    expect(room.phase).toBe('finished');

    await room.handle('c0', { t: 'action', action: { type: 'endTurn', player: 0 } });
    expect(c0.last('error')?.code).toBe('WRONG_PHASE');
  }, 60_000);
});
