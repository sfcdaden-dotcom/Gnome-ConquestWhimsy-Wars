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
import { HIDDEN_CARD_ID, chooseAiAction, getPlayerToAct, isPlayerAppearance, replayMatch } from '../engine';
import { commitmentFor, verifySeal } from './commitment';
import type { PersistedRoom, RoomConnection, RoomHost } from './room';
import { Room, generateRoomCode } from './room';
import {
  CLOSE_RATE_LIMITED,
  CLOSE_ROOM_CLOSED,
  CLOSE_SEAT_TAKEN_OVER,
  CLOSE_TOO_MANY_CONNECTIONS,
  CONTROL_BUDGET_MS,
  EMPTY_ROOM_REAP_MS,
  HOST_GRACE_MS,
  ROOM_CODE_ALPHABET,
  SHOT_CLOCK_MS,
  TAKEOVER_AFTER_TIMEOUTS,
  TOMBSTONE_TTL_MS,
  TAKEOVER_DIFFICULTY,
} from './protocol';
import type { ClientMessage, ServerMessage } from './protocol';
import {
  CONN_BUCKET_CAPACITY,
  CONN_BUCKET_REFILL_PER_SEC,
  FLOOD_DISCONNECT_AFTER,
  MAX_CONNECTIONS,
  MESSAGE_COST,
  ROOM_BUCKET_CAPACITY,
} from './ratelimit';

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

function makeHost(): RoomHost & {
  stored: PersistedRoom | null;
  closed: boolean;
  purged: boolean;
  alarms: number[];
  clock: number;
} {
  let counter = 1;
  const h = {
    stored: null as PersistedRoom | null,
    /** Set when the room wiped itself: see `RoomStore.close`. */
    closed: false,
    /** Set when even the tombstone went: see `RoomStore.purge`. */
    purged: false,
    alarms: [] as number[],
    /** Wall clock, movable so the shot clock can be driven without waiting. */
    clock: 1_000_000,
    store: {
      async load() {
        return h.stored ? (structuredClone(h.stored) as PersistedRoom) : null;
      },
      async save(room: PersistedRoom) {
        h.stored = structuredClone(room) as PersistedRoom;
      },
      async close(room: PersistedRoom) {
        h.stored = structuredClone(room) as PersistedRoom;
        h.closed = true;
      },
      async purge() {
        h.stored = null;
        h.purged = true;
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
    /**
     * A real seal, drawn deterministically.
     *
     * `RoomHost.createSeal` exists to be injected, and handing it the live
     * `createSeal` quietly made every run play a DIFFERENT game: the secret is
     * what `sealHiddenState` shuffles the deck with, so a CSPRNG draw here
     * reshuffled it on each run while everything else in this harness — the
     * LCG above, the clock below — stayed pinned. The tests that drive a game
     * deep enough for the deck to matter (the shot clock's, mostly) therefore
     * failed a few runs in a hundred, on nothing that had changed.
     *
     * Drawn from the same LCG so it is reproducible, but still a genuine seal:
     * the commitment is the true hash of this secret and nonce, so `verifySeal`
     * and `replayMatch` are testing what they claim to test.
     */
    async createSeal(): Promise<GameSeal> {
      const s = h.randomBytes(4);
      const secret = ((s[0] << 24) | (s[1] << 16) | (s[2] << 8) | s[3]) >>> 0;
      const nonce = Array.from(h.randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
      return { secret, nonce, commitment: await commitmentFor(secret, nonce) };
    },
    scheduleAlarm(at: number) {
      h.alarms.push(at);
    },
    now: () => h.clock,
    cpuDelayMs: 0,
  };
  return h;
}

const HELLO = { t: 'hello', protocol: 1 } as const;

type FakeHost = ReturnType<typeof makeHost>;

/**
 * How long a person takes over one click. Not a real measurement — just a
 * number small enough that no test waits for it and large enough to be a
 * physically possible rate of play.
 */
const PLAY_TICK_MS = 400;

/**
 * One client message, with a beat of simulated time in front of it.
 *
 * The loops below drive entire games through `handle` in zero simulated
 * milliseconds, which is exactly the traffic the room's intake limiter
 * (ratelimit.ts) exists to refuse. Letting a moment pass per message keeps the
 * simulation honest about what a human hand can produce — and, more usefully,
 * keeps the limiter ARMED for every other test in this file rather than
 * switched off for the convenience of the harness.
 */
async function play(room: Room, host: FakeHost, connId: string, message: ClientMessage): Promise<void> {
  host.clock += PLAY_TICK_MS;
  await room.handle(connId, message);
}

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

  // The host used to be a loan that moved to whoever was present, which read
  // as the start button teleporting between players — and left both ends of a
  // two-player room waiting for each other. It is static now: it moves only
  // when somebody explicitly takes the room over.
  it('keeps the room with the host when they disconnect', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    expect(c1.last('welcome')?.you.isHost).toBe(false);

    await room.disconnect('c0');

    // The guest is not quietly promoted, and cannot deal in the host's place.
    expect(c1.last('welcome')?.you.isHost).toBe(false);
    await room.handle('c1', { t: 'start' });
    expect(c1.last('error')?.code).toBe('NOT_HOST');
    expect(room.phase).toBe('lobby');
  });

  it('is still the host after a refresh', async () => {
    const { room, c0 } = await lobby(['human', 'human']);
    const hostToken = c0.last('welcome')!.you.token;
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });

    await room.disconnect('c0');

    // The refreshed page: a new socket presenting the same token.
    const again = new FakeConn('c0-again');
    await room.hello(again, { ...HELLO, token: hostToken });

    expect(again.last('welcome')?.you.isHost).toBe(true);
    expect(c1.last('welcome')?.you.isHost).toBe(false);
    await room.handle('c0-again', { t: 'start' });
    expect(room.phase).toBe('playing');
  });

  it('binds the host to whoever holds the room key, not to whoever dials first', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const hostKey = await room.hostKeyForCreate();

    // The friend clicks the invite link before the host's own socket lands.
    const friend = new FakeConn('friend');
    await room.hello(friend, { ...HELLO });
    expect(friend.last('welcome')?.you.isHost).toBe(false);

    const opener = new FakeConn('opener');
    await room.hello(opener, { ...HELLO, hostKey });
    expect(opener.last('welcome')?.you.isHost).toBe(true);
  });

  it('binds the host key once and ignores it afterwards', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const hostKey = await room.hostKeyForCreate();

    const opener = new FakeConn('opener');
    await room.hello(opener, { ...HELLO, hostKey });
    expect(opener.last('welcome')?.you.isHost).toBe(true);

    // A copy of the key — a second tab, or somebody it was pasted to — does
    // not take the room off the person already holding it.
    const other = new FakeConn('other');
    await room.hello(other, { ...HELLO, hostKey });
    expect(other.last('welcome')?.you.isHost).toBe(false);
    expect(opener.last('welcome')?.you.isHost).toBe(true);
  });

  it('lets a host whose first dial failed present the key again', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const hostKey = await room.hostKeyForCreate();

    // The socket dies before `hello` ever lands, then the client redials.
    const retry = new FakeConn('retry');
    await room.hello(retry, { ...HELLO, hostKey });
    expect(retry.last('welcome')?.you.isHost).toBe(true);
  });

  it('makes the first connection the host in a room that has no key', async () => {
    // Rooms persisted before `hostKey` existed, and any path that skipped the
    // create endpoint. Still static — set once, and it does not move.
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const first = new FakeConn('first');
    await room.hello(first, { ...HELLO });
    expect(first.last('welcome')?.you.isHost).toBe(true);

    await room.disconnect('first');
    const second = new FakeConn('second');
    await room.hello(second, { ...HELLO });
    expect(second.last('welcome')?.you.isHost).toBe(false);
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

describe('character select', () => {
  const LOOK = {
    palette: 'teal' as const,
    cap: 'wide' as const,
    beard: 'wild' as const,
    weapon: 'staff' as const,
    accessory: 'lantern' as const,
  };

  it('gives every seat a settled gnome before anybody chooses', async () => {
    const { room } = await lobby(['human', 'cpu', 'cpu', 'cpu']);
    const seats = room.snapshot().seats;
    for (const s of seats) expect(isPlayerAppearance(s.appearance)).toBe(true);
    expect(new Set(seats.map((s) => s.appearance.palette)).size).toBe(seats.length);
  });

  it('lets a player dress their OWN seat without being host', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });

    await room.handle('c1', { t: 'setAppearance', appearance: LOOK });

    expect(c1.errors()).toEqual([]);
    expect(room.snapshot().seats[1].appearance).toEqual(LOOK);
  });

  it('lets two seats share a palette — that is how they team up', async () => {
    const { room } = await lobby(['human', 'human']);
    await room.handle('c0', { t: 'configure', playerCount: 4, seats: [{ index: 2, controller: 'cpu' }, { index: 3, controller: 'cpu' }] });
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });

    await room.handle('c0', { t: 'setAppearance', appearance: LOOK });
    await room.handle('c1', { t: 'setAppearance', appearance: LOOK });

    expect(c1.errors()).toEqual([]);
    expect(room.snapshot().seats[0].appearance.palette).toBe('teal');
    expect(room.snapshot().seats[1].appearance.palette).toBe('teal');
  });

  it('joining somebody\'s colour does not move them off it', async () => {
    // A seat that never opened character select still holds the colour it is
    // shown wearing. Without pinning, picking it would push that seat onto a
    // different colour and the two would never end up on a team.
    const { room } = await lobby(['human', 'human']);
    await room.handle('c0', {
      t: 'configure',
      playerCount: 4,
      seats: [{ index: 2, controller: 'cpu' }, { index: 3, controller: 'cpu' }],
    });
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });

    const hers = room.snapshot().seats[0].appearance;
    await room.handle('c1', { t: 'setAppearance', appearance: { ...hers } });

    expect(c1.errors()).toEqual([]);
    const after = room.snapshot().seats;
    expect(after[0].appearance.palette).toBe(hers.palette);
    expect(after[1].appearance.palette).toBe(hers.palette);
  });

  it('refuses the pick that would leave nobody on the other side', async () => {
    const { room, c0 } = await lobby(['human', 'cpu']);
    // Seat 1 is already some other colour; seat 0 joining it empties the
    // opposition, and createGame would reject the game at start.
    const other = room.snapshot().seats[1].appearance;
    await room.handle('c0', { t: 'setAppearance', appearance: { ...LOOK, palette: other.palette } });

    expect(c0.last('error')?.code).toBe('BAD_CONFIG');
    expect(c0.last('error')?.message).toMatch(/one team/i);
    expect(room.snapshot().seats[0].appearance.palette).not.toBe(other.palette);
  });

  it('starts a 2v2 and puts the partners on one team', async () => {
    const { room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'configure', playerCount: 4, seats: [{ index: 2, controller: 'cpu' }, { index: 3, controller: 'cpu' }] });
    const shared = room.snapshot().seats[0].appearance;
    await room.handle('c0', {
      t: 'configure',
      seats: [{ index: 2, appearance: { ...shared } }],
    });
    await room.handle('c0', { t: 'start' });

    expect(room.phase).toBe('playing');
    const view = c0.last('state')?.view;
    expect(view?.players[0].team).toBe(view?.players[2].team);
    expect(view?.players[0].team).not.toBe(view?.players[1].team);
  });

  it('refuses a gnome outside the catalogue', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', {
      t: 'setAppearance',
      appearance: { ...LOOK, cap: 'sombrero' },
    } as unknown as ClientMessage);
    expect(c0.last('error')?.code).toBe('BAD_CONFIG');
  });

  it('refuses a spectator, who has no seat to dress', async () => {
    const { room } = await lobby(['human', 'cpu']);
    const spec = new FakeConn('spec');
    await room.hello(spec, { ...HELLO });

    await room.handle('spec', { t: 'setAppearance', appearance: LOOK });
    expect(spec.last('error')?.code).toBe('NOT_SEATED');
  });

  it('refuses character select once the game has started', async () => {
    const { room, c0 } = await lobby();
    await room.handle('c0', { t: 'start' });
    await room.handle('c0', { t: 'setAppearance', appearance: LOOK });
    expect(c0.last('error')?.code).toBe('WRONG_PHASE');
  });

  it('lets the host dress a CPU seat through configure', async () => {
    const { room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'configure', seats: [{ index: 1, appearance: LOOK }] });
    expect(c0.errors()).toEqual([]);
    expect(room.snapshot().seats[1].appearance).toEqual(LOOK);
  });

  it('deals exactly the gnomes the lobby showed', async () => {
    // The load-bearing promise of resolving in the room rather than letting
    // createGame derive its own: what people picked is what they play.
    const { room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'setAppearance', appearance: LOOK });
    const shown = room.snapshot().seats.map((s) => s.appearance);

    await room.handle('c0', { t: 'start' });

    const view = c0.last('state')?.view;
    expect(view?.players.map((p) => p.appearance)).toEqual(shown);
  });

  it('keeps a seat\'s gnome across a reconnect', async () => {
    const { room } = await lobby(['human', 'human']);
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    await room.handle('c1', { t: 'setAppearance', appearance: LOOK });
    const token = c1.last('welcome')?.you.token;

    room.disconnect('c1');
    const again = new FakeConn('c1b');
    await room.hello(again, { ...HELLO, token });

    expect(again.last('welcome')?.you.seat).toBe(1);
    expect(room.snapshot().seats[1].appearance).toEqual(LOOK);
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

describe('the shot clock', () => {
  /** Two humans at the table — the only configuration the clock runs in. */
  async function duel() {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const conns = [new FakeConn('c0'), new FakeConn('c1')];
    await room.hello(conns[0], { ...HELLO });
    await room.hello(conns[1], { ...HELLO });
    await room.handle('c0', { t: 'start' });
    return { host, room, conns, id: (seat: number) => `c${seat}` };
  }

  /**
   * Play sensibly until a seat takes an action and STILL holds control — the
   * shape a state-neutral stall loop has, and the only moment at which the two
   * deadlines are distinguishable. Returns the clock as it was when control
   * first reached that seat, or null if the game ended first.
   */
  async function untilControlRetained(
    room: Room,
    host: ReturnType<typeof makeHost>,
    step = 20_000,
  ): Promise<{ seat: number; arrived: NonNullable<PersistedRoom['clock']> } | null> {
    for (let i = 0; i < 200 && room.phase === 'playing'; i++) {
      const seat = getPlayerToAct(room.gameState!);
      if (seat === null) return null;
      const arrived = host.stored!.clock!;
      host.clock += step;
      await room.handle(`c${seat}`, { t: 'action', action: chooseAiAction(room.gameState!) });
      const now = host.stored!.clock;
      if (now && now.seat === seat) return { seat, arrived };
    }
    return null;
  }

  it('puts the seat that must act on the clock and arms the alarm for it', async () => {
    const { host, room, conns } = await duel();
    const clock = conns[0].last('state')!.clock;

    expect(clock?.seat).toBe(getPlayerToAct(room.gameState!));
    expect(clock!.deadline - clock!.now).toBe(SHOT_CLOCK_MS);
    expect(host.alarms.at(-1)).toBe(host.clock + SHOT_CLOCK_MS);
  });

  it('leaves a seat alone while it still has time', async () => {
    const { host, room } = await duel();
    const before = room.gameState;

    host.clock += SHOT_CLOCK_MS - 1;
    await room.onAlarm();

    expect(room.gameState).toBe(before);
    expect(host.alarms.at(-1)).toBe(host.stored!.clock!.actionDeadline);
  });

  it('plays the turn out for a seat that stops sending actions', async () => {
    const { host, room, conns } = await duel();
    const stalled = getPlayerToAct(room.gameState!)!;
    const before = room.gameState!.eventCount;

    host.clock += SHOT_CLOCK_MS;
    await room.onAlarm();

    expect(room.gameState!.eventCount).toBeGreaterThan(before);
    expect(getPlayerToAct(room.gameState!)).not.toBe(stalled);
    // Everyone is told, not just the seat it happened to.
    expect(conns[0].last('timedOut')?.seat).toBe(stalled);
    expect(conns[1].last('timedOut')?.seat).toBe(stalled);
  });

  it('restarts the per-action clock on an action, but never the control budget', async () => {
    const { host, room } = await duel();
    const held = await untilControlRetained(room, host);
    expect(held).not.toBeNull();

    const clock = host.stored!.clock!;
    expect(clock.actionDeadline).toBe(host.clock + SHOT_CLOCK_MS);
    expect(clock.controlDeadline).toBe(held!.arrived.controlDeadline);
  });

  it('closes a seat that keeps acting but never gives up control', async () => {
    const { host, room, conns } = await duel();
    // Long enough between actions that the budget for this stretch of control
    // is spent — the seat is acting, just never releasing.
    const held = await untilControlRetained(room, host, CONTROL_BUDGET_MS);
    expect(held).not.toBeNull();

    // Its per-action clock is fresh, and a stall loop would keep it that way
    // forever. The budget is what closes the seat anyway.
    const clock = host.stored!.clock!;
    expect(host.clock).toBeLessThan(clock.actionDeadline);
    expect(host.clock).toBeGreaterThanOrEqual(clock.controlDeadline);
    await room.onAlarm();

    expect(conns[0].last('timedOut')?.seat).toBe(held!.seat);
    expect(getPlayerToAct(room.gameState!)).not.toBe(held!.seat);
  });

  it('does not let quick chat buy a stalling seat any time', async () => {
    const { host, room } = await duel();
    const seat = getPlayerToAct(room.gameState!)!;
    const before = host.stored!.clock!;

    host.clock += SHOT_CLOCK_MS - 1;
    await room.handle(`c${seat}`, { t: 'action', action: { type: 'quickChat', player: seat, phraseId: 'hi' } });

    expect(host.stored!.clock).toEqual(before);
  });

  it('never times out a CPU seat — it has its own alarm', async () => {
    const { host, room } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'start' });
    while (getPlayerToAct(room.gameState!) === 0) {
      await play(room, host, 'c0', { t: 'action', action: chooseAiAction(room.gameState!) });
    }
    expect(host.stored!.clock).toBeNull();
  });

  it('owes the same time after the room hibernates mid-turn', async () => {
    const { host, room } = await duel();
    const clock = host.stored!.clock!;

    const woken = await Room.open(host, 'ABC123');
    host.clock += SHOT_CLOCK_MS - 1;
    await woken.onAlarm(); // still in time: nothing is played
    expect(woken.gameState!.eventCount).toBe(room.gameState!.eventCount);

    host.clock = clock.actionDeadline;
    await woken.onAlarm();
    expect(woken.gameState!.eventCount).toBeGreaterThan(room.gameState!.eventCount);
  });

  /**
   * Let one seat run its clock out `times` times over, while every other seat
   * plays on sensibly — one person going quiet at a table that is otherwise
   * still playing, which is the case the takeover is for.
   */
  async function timeOutSeat(
    room: Room,
    host: ReturnType<typeof makeHost>,
    seat: number,
    times: number,
  ): Promise<void> {
    for (let i = 0; i < times && room.phase === 'playing'; i++) {
      for (let step = 0; step < 400; step++) {
        const actor = getPlayerToAct(room.gameState!);
        if (actor === null || actor === seat || room.phase !== 'playing') break;
        if (host.stored!.seats[actor].controller === 'cpu') await room.onAlarm();
        else await play(room, host, `c${actor}`, { t: 'action', action: chooseAiAction(room.gameState!) });
      }
      const clock = host.stored!.clock;
      if (room.phase !== 'playing' || clock === null || clock.seat !== seat) return;
      host.clock = clock.actionDeadline;
      await room.onAlarm();
    }
  }

  it('gives a seat to a CPU once it has timed out once too often', async () => {
    const { host, room, conns } = await duel();
    const quitter = getPlayerToAct(room.gameState!)!;

    await timeOutSeat(room, host, quitter, TAKEOVER_AFTER_TIMEOUTS - 1);
    // Not yet: one bad minute is a phone call, not a departure.
    expect(host.stored!.seats[quitter].controller).toBe('human');

    await timeOutSeat(room, host, quitter, 1);

    expect(host.stored!.seats[quitter].controller).toBe('cpu');
    expect(host.stored!.seats[quitter].takenOver).toBe(true);
    expect(conns[quitter].last('seatTakenOver')?.seat).toBe(quitter);
    expect(conns[quitter].last('room')?.room.seats[quitter].takenOver).toBe(true);
  });

  it('leaves the player in the room, watching, rather than throwing them out', async () => {
    const { host, room, conns } = await duel();
    const quitter = getPlayerToAct(room.gameState!)!;
    const token = conns[quitter].last('welcome')!.you.token;

    await timeOutSeat(room, host, quitter, TAKEOVER_AFTER_TIMEOUTS);
    expect(host.stored!.seats[quitter].controller).toBe('cpu');

    // Told immediately that the seat is no longer theirs...
    expect(conns[quitter].last('welcome')?.you.seat).toBeNull();
    expect(conns[quitter].closed).toBeNull();
    // ...and a reconnect with the very token that held the seat gets a view of
    // the game, not the seat back: nobody fights the AI for control.
    const back = new FakeConn('back');
    await room.hello(back, { ...HELLO, token });
    expect(back.last('welcome')?.you.seat).toBeNull();
    expect(back.last('state')).toBeDefined();
  });

  it('plays the taken-over seat at CPU speed instead of a minute a turn', async () => {
    const { host, room } = await duel();
    const quitter = getPlayerToAct(room.gameState!)!;
    await timeOutSeat(room, host, quitter, TAKEOVER_AFTER_TIMEOUTS);
    expect(host.stored!.seats[quitter].controller).toBe('cpu');

    // The seat is played by an alarm now, not by a deadline: no shot clock
    // runs while it is the one to act.
    const before = room.gameState!.eventCount;
    for (let i = 0; i < 20 && getPlayerToAct(room.gameState!) !== quitter; i++) {
      const actor = getPlayerToAct(room.gameState!)!;
      await room.handle(`c${actor}`, { t: 'action', action: chooseAiAction(room.gameState!) });
    }
    expect(getPlayerToAct(room.gameState!)).toBe(quitter);
    expect(host.stored!.clock).toBeNull();
    await room.onAlarm();

    expect(room.gameState!.eventCount).toBeGreaterThan(before);
    expect(host.stored!.seats[quitter].difficulty).toBe(TAKEOVER_DIFFICULTY);
  });

  /** Let everyone else play until `seat` is the one to act again. */
  async function untilTurnOf(room: Room, host: FakeHost, seat: number): Promise<void> {
    for (let i = 0; i < 400 && room.phase === 'playing'; i++) {
      const actor = getPlayerToAct(room.gameState!);
      if (actor === null || actor === seat) return;
      await play(room, host, `c${actor}`, { t: 'action', action: chooseAiAction(room.gameState!) });
    }
  }

  it('forgets the timeouts of somebody who comes back and plays', async () => {
    const { host, room } = await duel();
    const seat = getPlayerToAct(room.gameState!)!;

    await timeOutSeat(room, host, seat, TAKEOVER_AFTER_TIMEOUTS - 1);
    // Back at the table: the count is cleared by playing, not by being present.
    expect(host.stored!.seats[seat].timeouts).toBe(TAKEOVER_AFTER_TIMEOUTS - 1);
    await untilTurnOf(room, host, seat);
    await play(room, host, `c${seat}`, { t: 'action', action: chooseAiAction(room.gameState!) });
    expect(host.stored!.seats[seat].timeouts).toBe(0);

    await timeOutSeat(room, host, seat, TAKEOVER_AFTER_TIMEOUTS - 1);
    expect(host.stored!.seats[seat].controller).toBe('human');
  });

  it('does not let a rejected action buy back a seat', async () => {
    const { host, room, conns } = await duel();
    const seat = getPlayerToAct(room.gameState!)!;
    await timeOutSeat(room, host, seat, TAKEOVER_AFTER_TIMEOUTS - 1);
    const before = host.stored!.seats[seat].timeouts;
    expect(before).toBeGreaterThan(0);

    // Nonsense from the seat, and chat, are not playing. (The roll-off is long
    // over, so it is an action the engine refuses outright.)
    await untilTurnOf(room, host, seat);
    await play(room, host, `c${seat}`, { t: 'action', action: { type: 'rollOff', player: seat } });
    expect(conns[seat].last('error')?.code).toBe('ILLEGAL_ACTION');
    await play(room, host, `c${seat}`, { t: 'action', action: { type: 'quickChat', player: seat, phraseId: 'hi' } });

    expect(host.stored!.seats[seat].timeouts).toBe(before);
  });

  it('finishes a game against a seat that never acts, and the record still replays', async () => {
    const { host, room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'start' });

    for (let i = 0; i < 4000 && room.phase === 'playing'; i++) {
      host.clock += SHOT_CLOCK_MS;
      await room.onAlarm();
    }

    expect(room.phase).toBe('finished');
    // The clock's actions go into the record like any others, so the game the
    // room played is still the game anyone can replay and check.
    const record = c0.last('revealed')!.record;
    expect(replayMatch(record).eventCount).toBe(room.gameState!.eventCount);
  }, 60_000);
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
    const { host, room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'start' });
    await runToEnd(room, 4000);
    // Seat 0 is human, so drive the human turns too until somebody wins.
    for (let i = 0; i < 4000 && room.phase === 'playing'; i++) {
      const actor = getPlayerToAct(room.gameState!);
      if (actor === 0) {
        await play(room, host, 'c0', { t: 'action', action: chooseAiAction(room.gameState!) });
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

describe('rate limiting', () => {
  /** Flood one connection until the room drops something. Returns how many got through. */
  async function floodUntilRefused(room: Room, c: FakeConn, cap = 1000): Promise<number> {
    let sent = 0;
    while (c.errors().length === 0 && sent < cap) {
      await room.handle(c.id, { t: 'ping' });
      sent++;
    }
    return sent;
  }

  it('never limits a whole game played at a human pace', async () => {
    // The property that matters most: the defence must be invisible to the
    // people it is defending. A full game, every human action a `handle` with
    // a plausible pause in front of it, and not one refusal.
    const { host, room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'start' });
    for (let i = 0; i < 4000 && room.phase === 'playing'; i++) {
      const actor = getPlayerToAct(room.gameState!);
      if (actor === 0) await play(room, host, 'c0', { t: 'action', action: chooseAiAction(room.gameState!) });
      else await room.onAlarm();
    }

    expect(room.phase).toBe('finished');
    expect(c0.errors()).not.toContain('RATE_LIMITED');
  }, 60_000);

  it('answers a flood with one warning, not one warning per message', async () => {
    // One error frame per dropped message would be exactly the one-in-one-out
    // amplification the limit exists to stop.
    const { room, c0 } = await lobby();
    const served = await floodUntilRefused(room, c0);
    expect(served).toBeGreaterThan(20); // the budget was a real one

    for (let i = 0; i < FLOOD_DISCONNECT_AFTER - 2; i++) await room.handle('c0', { t: 'ping' });

    expect(c0.errors()).toEqual(['RATE_LIMITED']);
    expect(c0.closed).toBeNull(); // warned, not hung up on
  });

  it('stops reading a socket that will not slow down', async () => {
    const { room, c0 } = await lobby();
    for (let i = 0; i < CONN_BUCKET_CAPACITY + FLOOD_DISCONNECT_AFTER + 10; i++) {
      await room.handle('c0', { t: 'ping' });
    }

    expect(c0.closed?.code).toBe(CLOSE_RATE_LIMITED);
  });

  it('forgives a client that takes the hint', async () => {
    const { host, room, c0 } = await lobby();
    await floodUntilRefused(room, c0);
    const pongs = () => c0.sent.filter((m) => m.t === 'pong').length;
    const before = pongs();

    host.clock += CONN_BUCKET_CAPACITY / CONN_BUCKET_REFILL_PER_SEC * 1000;
    await room.handle('c0', { t: 'ping' });
    expect(pongs()).toBe(before + 1);

    // ...and the next episode gets its own warning, rather than being silent
    // because the client was told once half an hour ago.
    while (c0.errors().length === 1) await room.handle('c0', { t: 'ping' });
    expect(c0.errors()).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
  });

  it('never lets a dropped action reach the engine or the record', async () => {
    const { host, room, c0 } = await lobby(['human', 'cpu']);
    await room.handle('c0', { t: 'start' });
    await floodUntilRefused(room, c0);

    const events = room.gameState!.eventCount;
    const actions = host.stored!.actions.length;
    await room.handle('c0', { t: 'action', action: chooseAiAction(room.gameState!) });

    // A refused message is refused before anything is asked of the game: the
    // limit is on intake, not on outcomes.
    expect(room.gameState!.eventCount).toBe(events);
    expect(host.stored!.actions.length).toBe(actions);
  });

  it('bounds the whole room, not just each connection in it', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    // Each of these stays inside its OWN budget; together they are past the
    // room's. Per-connection limits multiply by the number of connections, and
    // this is the ceiling that does not.
    const each = (CONN_BUCKET_CAPACITY - MESSAGE_COST.hello) / MESSAGE_COST.ping;
    const conns = Array.from({ length: 6 }, (_, i) => new FakeConn(`f${i}`));
    for (const c of conns) await room.hello(c, { ...HELLO });
    expect(conns.length * each * MESSAGE_COST.ping).toBeGreaterThan(ROOM_BUCKET_CAPACITY);

    for (let i = 0; i < each; i++) {
      for (const c of conns) await room.handle(c.id, { t: 'ping' });
    }

    expect(conns.some((c) => c.errors().includes('RATE_LIMITED'))).toBe(true);
    // Nobody is hung up on for it: the drops were somebody else's doing, and
    // disconnecting the bystanders of a flood would hand any flooder the room.
    expect(conns.every((c) => c.closed === null)).toBe(true);

    // ...and the ceiling is a rate, not a ban.
    host.clock += ROOM_BUCKET_CAPACITY * 1000;
    const pongs = conns[0].sent.filter((m) => m.t === 'pong').length;
    await room.handle('f0', { t: 'ping' });
    expect(conns[0].sent.filter((m) => m.t === 'pong').length).toBe(pongs + 1);
  });

  it('will not hold more connections than it will broadcast to', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const conns = Array.from({ length: MAX_CONNECTIONS }, (_, i) => new FakeConn(`c${i}`));
    for (const c of conns) await room.hello(c, { ...HELLO });
    expect(conns.every((c) => c.closed === null)).toBe(true);

    const extra = new FakeConn('extra');
    await room.hello(extra, { ...HELLO });
    expect(extra.last('error')?.code).toBe('ROOM_FULL');
    expect(extra.closed?.code).toBe(CLOSE_TOO_MANY_CONNECTIONS);
  });

  it('always lets a player with a seat back in, however big the crowd', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const seated = new FakeConn('seated');
    await room.hello(seated, { ...HELLO });
    const token = seated.last('welcome')!.you.token;
    for (let i = 0; i < MAX_CONNECTIONS + 5; i++) await room.hello(new FakeConn(`x${i}`), { ...HELLO });

    const returning = new FakeConn('returning');
    await room.hello(returning, { ...HELLO, token });

    expect(returning.last('welcome')?.you.seat).toBe(0);
    // The exemption grants nothing: one token still holds one live connection,
    // so the crowd did not grow by letting them back in.
    expect(seated.closed?.code).toBe(CLOSE_SEAT_TAKEN_OVER);
  });

  it('meters hello, which the transport delivers outside `handle`', async () => {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const c = new FakeConn('c0');
    // Every hello re-settles identity, writes storage and broadcasts, so a
    // repeat is not free — and it is the one message that never passes through
    // the metered `handle` path.
    for (let i = 0; i < CONN_BUCKET_CAPACITY / MESSAGE_COST.hello + 2; i++) {
      await room.hello(c, { ...HELLO });
    }

    expect(c.errors()).toContain('RATE_LIMITED');
  });

  it('lets a whole room re-introduce itself at once after a wake', async () => {
    // Hibernation ends with every live socket replaying its `hello` in one
    // burst. If arrivals drew on the room's shared ceiling, that burst would
    // look exactly like an attack and the room would answer the reconnect it
    // exists to support by telling everybody to come back later.
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const conns = Array.from({ length: MAX_CONNECTIONS }, (_, i) => new FakeConn(`c${i}`));
    for (const c of conns) await room.hello(c, { ...HELLO });
    const tokens = conns.map((c) => c.last('welcome')!.you.token);

    const woken = await Room.open(host, 'ABC123');
    const back = tokens.map((_, i) => new FakeConn(`b${i}`));
    for (let i = 0; i < back.length; i++) await woken.hello(back[i], { ...HELLO, token: tokens[i] });

    expect(back.every((c) => c.errors().length === 0)).toBe(true);
    expect(back.every((c) => c.last('welcome') !== undefined)).toBe(true);
  });

  it('starts a woken room with a full budget rather than charging it for the wait', async () => {
    const { host, room, c0 } = await lobby();
    await floodUntilRefused(room, c0);

    // Eviction and wake: buckets are in memory, and a room that has been in
    // storage has not been earning tokens — but it has not been spending them
    // either, and the connections are new.
    const woken = await Room.open(host, 'ABC123');
    const back = new FakeConn('back');
    await woken.hello(back, { ...HELLO, token: c0.last('welcome')!.you.token });

    expect(back.errors()).not.toContain('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------

describe('a lobby whose host has gone', () => {
  /** A lobby with a bound host (c0) and a guest (c1), both seated. */
  async function hosted() {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const hostKey = await room.hostKeyForCreate();
    const c0 = new FakeConn('c0');
    await room.hello(c0, { ...HELLO, hostKey });
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    return { host, room, c0, c1, hostKey };
  }

  it('starts a countdown when the host drops, and arms the alarm for it', async () => {
    const { host, room, c1 } = await hosted();
    await room.disconnect('c0');

    const grace = c1.last('room')!.room.hostGrace!;
    expect(grace).not.toBeNull();
    expect(grace.until).toBe(host.clock + HOST_GRACE_MS);
    expect(host.alarms.at(-1)).toBe(host.clock + HOST_GRACE_MS);
  });

  it('stops the countdown when the host comes back', async () => {
    const { room, c0, c1 } = await hosted();
    const hostToken = c0.last('welcome')!.you.token;
    await room.disconnect('c0');
    expect(c1.last('room')!.room.hostGrace).not.toBeNull();

    const again = new FakeConn('c0-again');
    await room.hello(again, { ...HELLO, token: hostToken });

    expect(c1.last('room')!.room.hostGrace).toBeNull();
    expect(again.last('welcome')?.you.isHost).toBe(true);
  });

  it('does not start one when a guest drops', async () => {
    const { room, c0 } = await hosted();
    await room.disconnect('c1');
    expect(c0.last('room')!.room.hostGrace).toBeNull();
  });

  // The room must not be torn down around a game in progress because
  // somebody's phone slept: a seat that stops playing is the shot clock's
  // problem, and there is no lobby left to own.
  it('does not start one mid-game', async () => {
    const { room, c1 } = await hosted();
    await room.handle('c0', { t: 'start' });
    expect(room.phase).toBe('playing');

    await room.disconnect('c0');

    expect(c1.last('room')!.room.hostGrace).toBeNull();
    expect(c1.last('room')!.room.hasHost).toBe(true);
  });

  it('offers the room to whoever is left when the countdown runs out', async () => {
    const { host, room, c1 } = await hosted();
    await room.disconnect('c0');

    host.clock += HOST_GRACE_MS;
    await room.onAlarm();

    // Nobody is host now, which is what puts the takeover on c1's screen.
    expect(c1.last('room')!.room.hasHost).toBe(false);
    expect(c1.last('room')!.room.hostGrace).toBeNull();
    expect(host.closed).toBe(false);
  });

  it('closes the room when the countdown runs out and nobody is left', async () => {
    const { host, room } = await hosted();
    await room.disconnect('c1');
    await room.disconnect('c0');

    host.clock += HOST_GRACE_MS;
    await room.onAlarm();

    expect(room.isClosed).toBe(true);
    expect(host.closed).toBe(true);
  });

  it('leaves a room standing while anybody is still in it', async () => {
    const { host, room, c1 } = await hosted();
    await room.disconnect('c0');
    host.clock += HOST_GRACE_MS;
    await room.onAlarm();

    // The guest is still here, so the room is offered rather than closed.
    expect(room.isClosed).toBe(false);
    expect(host.closed).toBe(false);
    expect(c1.last('roomClosed')).toBeUndefined();
  });

  it('refuses everybody once it has closed, rather than rebuilding itself', async () => {
    const { host, room } = await hosted();
    await room.disconnect('c1');
    await room.disconnect('c0');
    host.clock += HOST_GRACE_MS;
    await room.onAlarm();

    // The tombstone survives a reload of the room — which is exactly what a
    // redial does, since addressing a Durable Object is what creates it.
    const reopened = await Room.open(host, 'ABC123');
    expect(reopened.isClosed).toBe(true);

    const redial = new FakeConn('redial');
    await reopened.hello(redial, { ...HELLO });
    expect(redial.last('roomClosed')?.reason).toBe('host-left');
    expect(redial.closed?.code).toBe(CLOSE_ROOM_CLOSED);
    expect(redial.last('welcome')).toBeUndefined();
  });

  it('does not hand the room to whoever redials a closed code', async () => {
    const { host, room } = await hosted();
    await room.disconnect('c1');
    await room.disconnect('c0');
    host.clock += HOST_GRACE_MS;
    await room.onAlarm();

    const reopened = await Room.open(host, 'ABC123');
    const redial = new FakeConn('redial');
    await reopened.hello(redial, { ...HELLO });
    expect(reopened.snapshot().hasHost).toBe(false);
    expect(redial.last('welcome')?.you.isHost).toBeUndefined();
  });
  it('lets somebody still in the room take it over once the host is gone', async () => {
    const { host, room, c1 } = await hosted();
    await room.disconnect('c0');
    host.clock += HOST_GRACE_MS;
    await room.onAlarm();

    await room.handle('c1', { t: 'takeOverRoom' });

    expect(c1.last('welcome')?.you.isHost).toBe(true);
    expect(c1.last('room')!.room.hasHost).toBe(true);
    // Announced by name — the old handover was silent, which is most of why
    // it was confusing.
    expect(c1.last('roomTakenOver')?.name).toBe('Thistle');

    await room.handle('c1', { t: 'configure', seats: [{ index: 0, controller: 'cpu' }] });
    await room.handle('c1', { t: 'start' });
    expect(room.phase).toBe('playing');
  });

  it('refuses a takeover while the room still has a host', async () => {
    const { room, c1 } = await hosted();
    await room.handle('c1', { t: 'takeOverRoom' });
    expect(c1.errors()).toContain('HAS_HOST');
    expect(c1.last('welcome')?.you.isHost).toBe(false);
  });

  it('refuses a takeover during the grace window', async () => {
    // The host is merely disconnected. A room is never taken off somebody who
    // might still be coming back.
    const { room, c1 } = await hosted();
    await room.disconnect('c0');
    await room.handle('c1', { t: 'takeOverRoom' });
    expect(c1.errors()).toContain('HAS_HOST');
  });

  it('does not let the original host silently reclaim the room', async () => {
    const { host, room, c0, c1, hostKey } = await hosted();
    const oldToken = c0.last('welcome')!.you.token;
    await room.disconnect('c0');
    host.clock += HOST_GRACE_MS;
    await room.onAlarm();
    await room.handle('c1', { t: 'takeOverRoom' });

    // Back with both credentials, and neither one takes the room back.
    const returning = new FakeConn('c0-back');
    await room.hello(returning, { ...HELLO, token: oldToken, hostKey });

    expect(returning.last('welcome')?.you.isHost).toBe(false);
    expect(c1.last('welcome')?.you.isHost).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('a room nobody is in', () => {
  async function hosted() {
    const host = makeHost();
    const room = await Room.open(host, 'ABC123');
    const hostKey = await room.hostKeyForCreate();
    const c0 = new FakeConn('c0');
    await room.hello(c0, { ...HELLO, hostKey });
    const c1 = new FakeConn('c1');
    await room.hello(c1, { ...HELLO });
    return { host, room, c0, c1, hostKey };
  }

  // In a LOBBY the host's 60s grace lands long before the ten-minute reap, so
  // an empty lobby closes as 'host-left'. The reaper is what catches every
  // other phase, where no grace window applies at all.
  it('closes an empty lobby by the host grace, not the reaper', async () => {
    const { host, room } = await hosted();
    await room.disconnect('c0');
    await room.disconnect('c1');

    host.clock += HOST_GRACE_MS;
    await room.onAlarm();

    expect(room.isClosed).toBe(true);
    expect(host.stored?.closed?.reason).toBe('host-left');
  });

  it('closes a room everyone walked away from', async () => {
    const { host, room } = await hosted();
    await room.handle('c0', { t: 'start' });
    await room.disconnect('c0');
    await room.disconnect('c1');

    host.clock += EMPTY_ROOM_REAP_MS;
    await room.onAlarm();

    expect(room.isClosed).toBe(true);
    expect(host.stored?.closed?.reason).toBe('abandoned');
  });

  it('is not closed while somebody is still in it', async () => {
    const { host, room } = await hosted();
    await room.disconnect('c0');

    host.clock += EMPTY_ROOM_REAP_MS * 2;
    await room.onAlarm();

    expect(room.isClosed).toBe(false);
  });

  it('stops counting when somebody comes back', async () => {
    const { host, room } = await hosted();
    await room.disconnect('c0');
    await room.disconnect('c1');
    expect(host.stored?.reapAt).not.toBeNull();

    const back = new FakeConn('back');
    await room.hello(back, { ...HELLO });
    expect(host.stored?.reapAt).toBeNull();

    host.clock += EMPTY_ROOM_REAP_MS;
    await room.onAlarm();
    expect(room.isClosed).toBe(false);
  });

  it('purges the tombstone once nobody could still be holding the code', async () => {
    const { host, room } = await hosted();
    await room.handle('c0', { t: 'start' });
    await room.disconnect('c0');
    await room.disconnect('c1');
    host.clock += EMPTY_ROOM_REAP_MS;
    await room.onAlarm();
    expect(room.isClosed).toBe(true);
    expect(host.purged).toBe(false);

    // Still a tombstone a day later minus a beat...
    host.clock += TOMBSTONE_TTL_MS - 1000;
    await room.onAlarm();
    expect(host.purged).toBe(false);

    host.clock += 1000;
    await room.onAlarm();
    expect(host.purged).toBe(true);
    expect(host.stored).toBeNull();
  });

  it('keeps refusing clients for as long as the tombstone stands', async () => {
    const { host, room } = await hosted();
    await room.handle('c0', { t: 'start' });
    await room.disconnect('c0');
    await room.disconnect('c1');
    host.clock += EMPTY_ROOM_REAP_MS;
    await room.onAlarm();

    const late = new FakeConn('late');
    await room.hello(late, { ...HELLO });
    expect(late.last('roomClosed')?.reason).toBe('abandoned');
    expect(late.closed?.code).toBe(CLOSE_ROOM_CLOSED);
  });
  it('leaves nothing replayable in a tombstone', async () => {
    const { host, room } = await hosted();
    await room.handle('c0', { t: 'start' });
    await room.disconnect('c0');
    await room.disconnect('c1');
    host.clock += EMPTY_ROOM_REAP_MS;
    await room.onAlarm();

    // `Room.open` rebuilds a game from `config` + `seed`; a tombstone that
    // kept them would replay itself into a live state on every load.
    expect(host.stored?.config).toBeNull();
    expect(host.stored?.seed).toBeNull();
    expect(host.stored?.actions).toEqual([]);
    const reopened = await Room.open(host, 'ABC123');
    expect(reopened.gameState).toBeNull();
  });

  it('reuses a tombstoned code when the server draws it again', async () => {
    const { host, room } = await hosted();
    await room.handle('c0', { t: 'start' });
    await room.disconnect('c0');
    await room.disconnect('c1');
    host.clock += EMPTY_ROOM_REAP_MS;
    await room.onAlarm();

    // The tombstone stops a CLIENT rebuilding a room from a stale code. A
    // fresh create is the server choosing the code, and gets a working room.
    const reopened = await Room.open(host, 'ABC123');
    const hostKey = await reopened.hostKeyForCreate();
    const opener = new FakeConn('opener');
    await reopened.hello(opener, { ...HELLO, hostKey });

    expect(reopened.isClosed).toBe(false);
    expect(opener.last('welcome')?.you.isHost).toBe(true);
  });
});
