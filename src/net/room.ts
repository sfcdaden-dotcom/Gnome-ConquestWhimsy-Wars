/**
 * The room: seats, identity, and the authoritative game.
 *
 * This is the whole of the multiplayer server's behaviour, and it deliberately
 * knows nothing about Cloudflare. Everything platform-shaped — sockets,
 * storage, alarms, randomness — arrives through `RoomHost`, so the rules of
 * the room can be driven directly in tests (`room.test.ts`) instead of only
 * through a live Worker. `src/worker/room-do.ts` is the thin Durable Object
 * that supplies a real host.
 *
 * WHAT THE ROOM OWNS
 *
 *  - **The state.** Clients never hold authoritative state; they receive
 *    `viewFor(state, seat)` and render it. An action is a request.
 *  - **Identity.** A connection is bound to a seat server-side, remembered by
 *    a token. Every action is checked against that binding before the engine
 *    sees it, so `{ player: 1 }` from seat 0 is rejected rather than obeyed.
 *  - **The secret.** The room draws the seed and the seal, publishes the
 *    commitment when play starts, and reveals the secret only when the game is
 *    over (see ../engine/setup.ts and ./commitment.ts).
 *  - **The CPU seats.** `chooseAiAction` runs here, on the same state, through
 *    the same `applyAction` path a human action takes. A CPU seat and a
 *    disconnected human seat are the same problem, and this is the machinery
 *    that answers both.
 *  - **The clock.** The engine holds no wall clock and never times anything
 *    out by itself, so the room is what decides a seat has stopped playing and
 *    applies the engine's timeout policy on its behalf. CPU pacing and the
 *    shot clock share one alarm, because a Durable Object has exactly one.
 *  - **The budget.** What a client may cost. Nothing a flood can send makes the
 *    room do something wrong, but every message costs work and every message
 *    that lands costs one send per connection — so the room meters its intake,
 *    per connection and per room, and hangs up on a sender that will not stop
 *    (see ./ratelimit.ts).
 *
 * PERSISTENCE. The room stores the *record* (config, seed, seal, actions), not
 * the state: replaying it rebuilds the state exactly, it stays small enough to
 * write on every action, and it is the same artifact the game is verified and
 * replayed from when it ends. See `hydrate`.
 */

import type {
  Action,
  AiDifficulty,
  GameConfig,
  GameSeal,
  GameState,
  GardenPreset,
  MatchRecord,
  PlayerSetup,
} from '../engine';
import {
  MATCH_RECORD_SCHEMA,
  MAX_TIMEOUT_STEPS,
  applyAction,
  chooseAiAction,
  createGame,
  getPlayerToAct,
  getTimeoutAction,
  isGameOver,
  sealHiddenState,
  viewFor,
} from '../engine';
import type {
  ClientMessage,
  RoomErrorCode,
  RoomPhase,
  RoomSnapshot,
  SeatConfig,
  SeatInfo,
  ServerMessage,
  ShotClock,
} from './protocol';
import {
  CLOSE_RATE_LIMITED,
  CLOSE_SEAT_TAKEN_OVER,
  CLOSE_TOO_MANY_CONNECTIONS,
  CONTROL_BUDGET_MS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SHOT_CLOCK_MS,
  TAKEOVER_AFTER_TIMEOUTS,
  TAKEOVER_DIFFICULTY,
} from './protocol';
import {
  CONN_BUCKET_CAPACITY,
  CONN_BUCKET_REFILL_PER_SEC,
  FLOOD_DISCONNECT_AFTER,
  MAX_CONNECTIONS,
  MESSAGE_COST,
  ROOM_BUCKET_CAPACITY,
  ROOM_BUCKET_REFILL_PER_SEC,
  TokenBucket,
} from './ratelimit';

// ---------------------------------------------------------------------------
// Host interface (everything platform-shaped)
// ---------------------------------------------------------------------------

/** One live client. The room never assumes a send arrives. */
export interface RoomConnection {
  readonly id: string;
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

/** What the room persists: the record, from which the state is rebuilt. */
export interface PersistedRoom {
  code: string;
  phase: RoomPhase;
  seats: PersistedSeat[];
  hostToken: string | null;
  /** Whoever opened the room. Gets the lobby back whenever they are present. */
  founderToken: string | null;
  /** token → seat index, or null for a spectator. Never leaves the server. */
  tokens: Record<string, number | null>;
  boardSize: number;
  gardenPreset: GardenPreset;
  /** Set when play starts. */
  seed: number | null;
  seal: GameSeal | null;
  config: GameConfig | null;
  actions: Action[];
  /** The running shot clock, or null when no human seat is on it. */
  clock: RoomClock | null;
}

/**
 * The two deadlines a seat on the clock is running against, both absolute
 * epoch ms. Persisted, so a room that hibernates mid-turn wakes up owing the
 * same time it owed when it went to sleep rather than handing the stalling
 * seat a fresh minute.
 */
export interface RoomClock {
  seat: number;
  /** Restarts on every action this seat takes. */
  actionDeadline: number;
  /** Set once when control reaches the seat; nothing the seat does moves it. */
  controlDeadline: number;
}

export interface PersistedSeat {
  name: string;
  controller: 'human' | 'cpu';
  difficulty: AiDifficulty;
  /** The room took this seat over for inactivity (not a lobby CPU seat). */
  takenOver?: boolean;
  /** Consecutive shot-clock timeouts. Any action by the seat resets it. */
  timeouts?: number;
}

export interface RoomStore {
  load(): Promise<PersistedRoom | null>;
  save(room: PersistedRoom): Promise<void>;
}

export interface RoomHost {
  store: RoomStore;
  /** Cryptographic randomness — tokens and room codes are guessing targets. */
  randomBytes(n: number): Uint8Array;
  /** Draws the commit–reveal seal. Injected so tests can pin it. */
  createSeal(): Promise<GameSeal>;
  /** Ask to be woken at `atMs`; the host calls back into `onAlarm`. */
  scheduleAlarm(atMs: number): void | Promise<void>;
  now(): number;
  /** Pause before a CPU seat acts, so humans can follow the board. */
  cpuDelayMs?: number;
}

const DEFAULT_CPU_DELAY_MS = 700;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A room code from the unambiguous alphabet (no vowels, no 0/O/1/I/L). */
export function generateRoomCode(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * A fresh table.
 *
 * Every seat starts **human**, and this matters more than it looks: a room
 * exists so that people can sit in it. Defaulting the other seats to CPU meant
 * a friend who arrived with the code found the table already "full" of bots
 * and was made a spectator, which is not what either of them asked for. The
 * host can turn any seat into a CPU in one click; nobody can un-spectate
 * themselves.
 */
function defaultSeats(count: 2 | 4): PersistedSeat[] {
  const names = ['Rose', 'Thistle', 'Marigold', 'Bramble'];
  return Array.from({ length: count }, (_, i) => ({
    name: names[i],
    controller: 'human' as const,
    difficulty: 'normal' as AiDifficulty,
  }));
}

class RoomError extends Error {
  code: RoomErrorCode;

  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

interface ConnState {
  conn: RoomConnection;
  token: string;
  seat: number | null;
  /** The last identity this connection was told, so `welcome` is re-sent only
   *  when it actually changed (see `announceIdentities`). */
  announced: { seat: number | null; isHost: boolean } | null;
}

/**
 * One connection's intake budget, and what it has done with it.
 *
 * Kept beside `conns` rather than inside `ConnState` because it starts earlier:
 * `hello` is itself metered, and a connection has no `ConnState` until its
 * `hello` has been accepted.
 */
interface Meter {
  bucket: TokenBucket;
  /**
   * Has this connection already been told it is over budget? One warning per
   * episode, not one per dropped message: answering every message of a flood
   * with an error frame is the same one-in-one-out amplification the limit
   * exists to prevent. Cleared as soon as a message gets through.
   */
  warned: boolean;
  /** Consecutive messages dropped on this connection's OWN bucket. */
  dropped: number;
}

export class Room {
  private host: RoomHost;
  private data: PersistedRoom;
  private state: GameState | null = null;
  private readonly conns = new Map<string, ConnState>();
  /**
   * When the CPU seat currently to act should play. In memory only: it is a
   * pacing nicety, and a room that wakes from hibernation with it lost should
   * play the CPU's move immediately rather than sit on it.
   */
  private cpuWakeAt: number | null = null;
  /** Per-connection intake budgets, by connection id. Never persisted. */
  private readonly meters = new Map<string, Meter>();
  /**
   * Everyone's intake budget, together. Built on first use rather than in the
   * constructor so it starts full at the moment the room starts being used —
   * a room that has been sitting in storage for an hour has not been earning
   * tokens, and charging it for the wait would be the wrong sign.
   */
  private roomBucket: TokenBucket | null = null;

  private constructor(host: RoomHost, data: PersistedRoom) {
    this.host = host;
    this.data = data;
  }

  /**
   * Load a room from storage, or create a fresh lobby under `code`.
   *
   * A stored room comes back as `config + seed + seal + actions`; the state is
   * rebuilt by replaying it. That is why the record is what gets persisted:
   * determinism means the replay is exact, and it keeps every write small
   * enough that saving on every action stays cheap.
   */
  static async open(host: RoomHost, code: string): Promise<Room> {
    const stored = await host.store.load();
    const room = new Room(
      host,
      // A room written before `founderToken` existed comes back without one;
      // normalise it here so `ensureHost` never sees `undefined` and mistakes
      // it for a founder who is present.
      (stored && { ...stored, founderToken: stored.founderToken ?? null }) ?? {
        code,
        phase: 'lobby',
        seats: defaultSeats(2),
        hostToken: null,
        founderToken: null,
        tokens: {},
        boardSize: 7,
        gardenPreset: 'random',
        seed: null,
        seal: null,
        config: null,
        actions: [],
        clock: null,
      },
    );
    // A room stored before the shot clock existed has no `clock` field.
    room.data.clock ??= null;
    if (stored && stored.config && stored.seed !== null) room.hydrate();
    return room;
  }

  /** Rebuild the authoritative state by replaying the stored record. */
  private hydrate(): void {
    const { config, seed, seal, actions } = this.data;
    if (!config || seed === null) return;
    let s = createGame(config, seed);
    if (seal) s = sealHiddenState(s, seal.secret);
    for (const action of actions) s = applyAction(s, action);
    this.state = s;
  }

  // --- connection lifecycle ------------------------------------------------

  /**
   * Attach a connection and settle who it is.
   *
   * A `token` the room already knows restores that seat — this is reconnect,
   * and it is the same path used when the Durable Object wakes from
   * hibernation and re-attaches its sockets. An unknown or absent token gets a
   * fresh one. Either way, anyone who ends up without a seat is offered the
   * next free one, so a returning spectator is seated if the table has opened
   * up while they were away.
   */
  async hello(conn: RoomConnection, message: Extract<ClientMessage, { t: 'hello' }>): Promise<void> {
    if (message.protocol !== PROTOCOL_VERSION) {
      conn.send({
        t: 'error',
        code: 'PROTOCOL',
        message: `Unsupported protocol ${message.protocol}; this room speaks ${PROTOCOL_VERSION}`,
      });
      conn.close(1002, 'protocol');
      return;
    }

    const known = message.token !== undefined && message.token in this.data.tokens;

    // A crowd cap, checked before anything is minted or stored. Broadcast is
    // O(connections), so an uncapped room is an amplifier with an adjustable
    // gain. Anyone holding a token the room already knows is exempt: coming
    // back to your own seat must not depend on how many spectators arrived
    // while you were gone, and the exemption grants nothing — the takeover
    // below means one token still holds exactly one live connection.
    if (!known && !this.conns.has(conn.id) && this.conns.size >= MAX_CONNECTIONS) {
      conn.send({
        t: 'error',
        code: 'ROOM_FULL',
        message: 'This room is already holding as many connections as it will hold',
      });
      conn.close(CLOSE_TOO_MANY_CONNECTIONS, 'too many connections');
      return;
    }

    // Metered like any other message — `hello` writes storage and broadcasts,
    // and the transport hands every one of them straight here rather than
    // through `handle`, so this is the only place it can be charged.
    if (!this.admit(conn.id, conn, 'hello')) return;

    const token = known ? (message.token as string) : this.mintToken();

    // One token, one live connection. A second tab (or a reconnect the room
    // has not noticed dropping yet) takes the seat over rather than sitting
    // beside itself — otherwise `seatIsOccupied` sees a ghost forever. This
    // happens BEFORE the seat is worked out, so the ghost does not make the
    // returning player's own seat look occupied to `claimSeat`.
    for (const [id, existing] of this.conns) {
      if (existing.token !== token || id === conn.id) continue;
      this.conns.delete(id);
      this.meters.delete(id);
      existing.conn.close(CLOSE_SEAT_TAKEN_OVER, 'seat taken over by a newer connection');
    }

    let seat: number | null;
    if (known) {
      seat = this.data.tokens[token] ?? null;
      // A seat flipped to CPU while its player was away is not theirs to take
      // back mid-game; they return as a spectator rather than fighting the AI
      // for control.
      if (seat !== null && this.data.seats[seat]?.controller !== 'human') seat = null;
    } else {
      seat = null;
    }
    // A returning spectator is a player who never got a seat (or lost one to a
    // CPU flip). If the table has opened up since, sit them down — there is no
    // other moment at which their seat is ever reconsidered.
    if (seat === null) seat = this.claimSeat();
    this.data.tokens[token] = seat;

    if (message.name && seat !== null) this.data.seats[seat].name = message.name.slice(0, 24);

    this.conns.set(conn.id, { conn, token, seat, announced: null });
    if (this.data.founderToken === null) this.data.founderToken = token;
    this.ensureHost();
    await this.save();

    this.announceIdentities();
    this.broadcastRoom();
  }

  /**
   * A fresh reconnect token. Uniqueness is checked rather than assumed: a
   * collision would silently rebind an existing player's seat to the newcomer,
   * which is too sharp an edge to leave to probability even when the
   * probability is negligible.
   */
  private mintToken(): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = hex(this.host.randomBytes(16));
      if (!(token in this.data.tokens)) return token;
    }
    throw new Error('Room: could not mint a unique token — is randomBytes actually random?');
  }

  /**
   * The first human seat free to claim, or null when there is none.
   *
   * "Free" means no live connection is in it and — once the game is running —
   * no token holds it either. A player who drops mid-game keeps their seat;
   * that is the entire point of the token, and handing it to a stranger while
   * they reconnect would be worse than making the stranger wait. In the lobby
   * nothing is invested yet, so a seat whose holder closed their tab is
   * claimable again; otherwise one person opening and closing a browser would
   * lock a seat and the host could never start.
   */
  private claimSeat(): number | null {
    for (let i = 0; i < this.data.seats.length; i++) {
      if (this.data.seats[i].controller !== 'human') continue;
      if (this.seatIsOccupied(i)) continue;
      if (this.data.phase !== 'lobby' && this.seatIsHeld(i)) continue;
      this.releaseSeat(i);
      return i;
    }
    return null;
  }

  private seatIsOccupied(seat: number): boolean {
    for (const c of this.conns.values()) if (c.seat === seat) return true;
    return false;
  }

  /** Does any token still lay claim to this seat, connected or not? */
  private seatIsHeld(seat: number): boolean {
    for (const held of Object.values(this.data.tokens)) if (held === seat) return true;
    return false;
  }

  /**
   * Turn every seat a human no longer owns loose: the connection sitting in it
   * becomes a spectator and no token keeps a claim on it. Used both when the
   * host edits the lobby and when the clock takes a seat over mid-game.
   */
  private vacateNonHumanSeats(): void {
    for (const conn of this.conns.values()) {
      if (conn.seat !== null && this.data.seats[conn.seat]?.controller !== 'human') {
        conn.seat = null;
        this.data.tokens[conn.token] = null;
      }
    }
    for (let i = 0; i < this.data.seats.length; i++) {
      if (this.data.seats[i].controller !== 'human') this.releaseSeat(i);
    }
  }

  /** Drop every token's claim on a seat; its holders return as spectators. */
  private releaseSeat(seat: number): void {
    for (const token of Object.keys(this.data.tokens)) {
      if (this.data.tokens[token] === seat) this.data.tokens[token] = null;
    }
  }

  /**
   * Sit waiting spectators down in seats that have opened up.
   *
   * Without this, a seat is decided once — at `hello` — and never revisited,
   * so somebody who arrived while the table was full (or before the host
   * turned a CPU seat back into a human one) stayed a spectator for the life
   * of the room no matter what the host did. Earlier arrivals get first
   * refusal, since `conns` is in arrival order.
   */
  private seatSpectators(): void {
    for (const c of this.conns.values()) {
      if (c.seat !== null) continue;
      const seat = this.claimSeat();
      if (seat === null) return; // no seats left; the rest keep watching
      c.seat = seat;
      this.data.tokens[c.token] = seat;
    }
  }

  /**
   * Keep the lobby owned by somebody who is actually at the table.
   *
   * Only the host token can `configure` or `start`, so if its holder walked
   * away before the deal the room would be frozen for everyone still in it.
   * A host who is *here* keeps the room even with no seat — turning your own
   * seat into a CPU to watch two bots play is a thing hosts do, and it must
   * not cost them the start button. Mid-game the host may also be away: their
   * seat is still theirs, and there is no lobby left to own.
   *
   * The handover is a loan, not a transfer: the founder takes the lobby back
   * the moment they are present again. Otherwise the single most ordinary
   * thing a host does while waiting — reload the page to see whether anyone
   * has arrived — silently and permanently moved the start button to the
   * guest, and both ends sat looking at "waiting for the host to start".
   */
  private ensureHost(): void {
    const founder = this.data.founderToken;
    if (founder !== null && [...this.conns.values()].some((c) => c.token === founder)) {
      this.data.hostToken = founder;
      return;
    }
    const current = this.data.hostToken;
    if (current !== null) {
      const live = [...this.conns.values()].some((c) => c.token === current);
      if (live) return;
      if (this.data.phase !== 'lobby' && (this.data.tokens[current] ?? null) !== null) return;
    }
    // Whoever is here, seated first — a spectator running the lobby is odd,
    // but an unstartable room is worse.
    let next: ConnState | null = null;
    for (const c of this.conns.values()) {
      if (next === null) next = c;
      else if (c.seat !== null && (next.seat === null || c.seat < next.seat)) next = c;
    }
    this.data.hostToken = next?.token ?? null;
  }

  /**
   * The reconnect token a connection was issued. The transport stores this
   * with the socket so a hibernating room can put the player back in its seat;
   * it is private to that client and never appears in a broadcast.
   */
  tokenFor(connId: string): string | null {
    return this.conns.get(connId)?.token ?? null;
  }

  /**
   * A connection dropped. Mid-game the seat stays theirs — the token is what
   * holds it. In the lobby a seat nobody is sitting in is up for grabs again,
   * so somebody who has been watching can take it and the game can start.
   */
  async disconnect(connId: string): Promise<void> {
    this.conns.delete(connId);
    this.meters.delete(connId);
    if (this.data.phase === 'lobby') this.seatSpectators();
    this.ensureHost();
    await this.save();
    this.announceIdentities();
    this.broadcastRoom();
  }

  // --- intake metering -----------------------------------------------------

  /**
   * Should this message be served? Charges for it if so.
   *
   * Two buckets, in this order. The connection's own budget is checked first,
   * and only a message it could afford is charged to the room's — so a client
   * already over its limit cannot drain the shared ceiling on its way out, and
   * one flooder cannot spend everybody else's budget for them.
   *
   * A refusal is quiet after the first: one error frame per episode, cleared by
   * the next message that gets through. Answering a flood message-for-message
   * would be the same amplification the limit exists to stop.
   */
  private admit(connId: string, conn: RoomConnection, t: ClientMessage['t']): boolean {
    const now = this.host.now();
    let meter = this.meters.get(connId);
    if (!meter) {
      meter = {
        bucket: new TokenBucket(CONN_BUCKET_CAPACITY, CONN_BUCKET_REFILL_PER_SEC, now),
        warned: false,
        dropped: 0,
      };
      this.meters.set(connId, meter);
    }
    this.roomBucket ??= new TokenBucket(ROOM_BUCKET_CAPACITY, ROOM_BUCKET_REFILL_PER_SEC, now);
    const cost = MESSAGE_COST[t];

    if (!meter.bucket.take(now, cost)) {
      meter.dropped++;
      if (meter.dropped >= FLOOD_DISCONNECT_AFTER) {
        // Told to slow down, and did not. The parse is all this connection can
        // still cost us, and hanging up is the only way to stop paying it. The
        // meter stays behind until the transport reports the close, so a
        // message already in flight cannot arrive to a fresh, full bucket.
        this.conns.delete(connId);
        conn.close(CLOSE_RATE_LIMITED, 'rate limited');
      } else {
        this.warn(meter, conn, 'You are sending faster than the room will serve — slow down.');
      }
      return false;
    }

    // `hello` is charged to the connection and NOT to the room.
    //
    // The shared ceiling is about sustained work from clients already in the
    // room; arrivals are bounded by a different mechanism, and by a hard one —
    // a fresh connection's bucket always covers its first `hello`, and
    // `MAX_CONNECTIONS` caps how many fresh connections there can be. Charging
    // arrivals to the ceiling as well would mean that every legitimate mass
    // reconnect — the whole room re-introducing itself after the Durable
    // Object wakes from hibernation, or a table's worth of phones coming back
    // from one flaky access point — looked precisely like an attack, and the
    // room would answer the reconnect it exists to support with "try later".
    if (t !== 'hello' && !this.roomBucket.take(now, cost)) {
      this.warn(meter, conn, 'The room is busier than it will serve right now — try again in a moment.');
      return false;
    }

    meter.warned = false;
    meter.dropped = 0;
    return true;
  }

  private warn(meter: Meter, conn: RoomConnection, message: string): void {
    if (meter.warned) return;
    meter.warned = true;
    conn.send({ t: 'error', code: 'RATE_LIMITED', message });
  }

  // --- messages ------------------------------------------------------------

  async handle(connId: string, message: ClientMessage): Promise<void> {
    const c = this.conns.get(connId);
    if (!c) return;
    if (!this.admit(connId, c.conn, message.t)) return;
    try {
      switch (message.t) {
        case 'hello':
          return; // identity is settled once per connection
        case 'ping':
          return c.conn.send({ t: 'pong' });
        case 'configure':
          return await this.configure(c, message);
        case 'start':
          return await this.start(c);
        case 'action':
          return await this.act(c, message.action);
      }
    } catch (err) {
      if (err instanceof RoomError) {
        c.conn.send({ t: 'error', code: err.code, message: err.message });
        return;
      }
      throw err;
    }
  }

  private requireHost(c: ConnState): void {
    if (c.token !== this.data.hostToken) {
      throw new RoomError('NOT_HOST', 'Only the room host can change the setup');
    }
  }

  private async configure(c: ConnState, message: Extract<ClientMessage, { t: 'configure' }>): Promise<void> {
    this.requireHost(c);
    if (this.data.phase !== 'lobby') {
      throw new RoomError('WRONG_PHASE', 'The game has already started');
    }

    if (message.playerCount !== undefined) {
      if (message.playerCount !== 2 && message.playerCount !== 4) {
        throw new RoomError('BAD_CONFIG', 'Whimsy Wars seats exactly 2 or 4 players');
      }
      this.data.seats = this.resizeSeats(message.playerCount);
    }
    if (message.boardSize !== undefined) {
      const n = message.boardSize;
      if (!Number.isInteger(n) || n < 5 || n % 2 === 0) {
        throw new RoomError('BAD_CONFIG', 'boardSize must be an odd integer >= 5');
      }
      this.data.boardSize = n;
    }
    if (message.gardenPreset !== undefined) this.data.gardenPreset = message.gardenPreset;
    for (const seat of message.seats ?? []) this.applySeatConfig(seat);

    // Nobody is left holding a seat the host just turned into a CPU (or a seat
    // that a shrink to two players removed).
    this.vacateNonHumanSeats();
    for (const token of Object.keys(this.data.tokens)) {
      const held = this.data.tokens[token];
      if (held !== null && held >= this.data.seats.length) this.data.tokens[token] = null;
    }

    // ...and the seats this just opened go to whoever is waiting. Turning a
    // CPU seat human is how a host makes room for a friend who is already
    // here, so it has to actually seat them.
    this.seatSpectators();
    this.ensureHost();

    await this.save();
    this.announceIdentities();
    this.broadcastRoom();
  }

  private resizeSeats(count: 2 | 4): PersistedSeat[] {
    const next = defaultSeats(count);
    for (let i = 0; i < next.length && i < this.data.seats.length; i++) next[i] = this.data.seats[i];
    return next;
  }

  private applySeatConfig(cfg: SeatConfig): void {
    const seat = this.data.seats[cfg.index];
    if (!seat) throw new RoomError('BAD_CONFIG', `No seat ${cfg.index}`);
    if (cfg.controller) seat.controller = cfg.controller;
    if (cfg.difficulty) seat.difficulty = cfg.difficulty;
    if (cfg.name) seat.name = cfg.name.slice(0, 24);
  }

  /**
   * Deal the cards.
   *
   * The room picks both the map seed and the deck secret, and no client is
   * ever offered a seed field: a player who knows the seed knows the deck and
   * every die roll for the rest of the game. The commitment goes out now; the
   * secret waits for the final move.
   */
  private async start(c: ConnState): Promise<void> {
    this.requireHost(c);
    if (this.data.phase !== 'lobby') {
      throw new RoomError('WRONG_PHASE', 'The game has already started');
    }

    // An unclaimed human seat would sit there doing nothing and stall the
    // game. Say which, rather than silently filling or silently refusing.
    const empty = this.data.seats
      .map((s, i) => (s.controller === 'human' && !this.seatIsOccupied(i) ? i + 1 : 0))
      .filter((n) => n > 0);
    if (empty.length > 0) {
      throw new RoomError(
        'BAD_CONFIG',
        `Nobody is sitting in seat ${empty.join(', ')} — wait for them, or switch the seat to a CPU`,
      );
    }

    const players: PlayerSetup[] = this.data.seats.map((s) => ({
      name: s.name,
      controller: s.controller,
      difficulty: s.difficulty,
    }));

    const b = this.host.randomBytes(4);
    const seed = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const seal = await this.host.createSeal();
    let state: GameState;
    try {
      state = sealHiddenState(
        createGame(
          { players, boardSize: this.data.boardSize, gardenPreset: this.data.gardenPreset },
          seed,
        ),
        seal.secret,
      );
    } catch (err) {
      throw new RoomError('BAD_CONFIG', err instanceof Error ? err.message : String(err));
    }

    this.state = state;
    this.data.config = state.config;
    this.data.seed = seed;
    this.data.seal = seal;
    this.data.actions = [];
    this.data.phase = 'playing';

    this.retime(true);
    await this.save();
    this.broadcastRoom();
    this.broadcastState();
    await this.arm();
  }

  /**
   * Apply one action from a player.
   *
   * The seat check is the anti-cheat line: the engine will happily validate an
   * action for seat 1, so the room has to be the thing that refuses to ask it
   * on seat 1's behalf. Everything past this point is the same code path a
   * local game runs.
   */
  private async act(c: ConnState, action: Action): Promise<void> {
    if (typeof action !== 'object' || action === null || typeof action.type !== 'string') {
      throw new RoomError('PROTOCOL', 'Malformed action');
    }
    // Quick chat is the one action a finished game still accepts — "gg"
    // belongs after the last fight, and the engine allows it (see
    // applyAction). Blocking it here would be the room overriding the rules.
    const open =
      this.data.phase === 'playing' ||
      (this.data.phase === 'finished' && action.type === 'quickChat');
    if (!open || !this.state) {
      throw new RoomError('WRONG_PHASE', 'No game is running');
    }
    if (c.seat === null) throw new RoomError('NOT_YOUR_SEAT', 'Spectators cannot act');
    if (action.player !== c.seat) {
      throw new RoomError('NOT_YOUR_SEAT', `You are seat ${c.seat + 1} and cannot act for another seat`);
    }
    const seat = this.data.seats[c.seat];
    const timeouts = seat?.timeouts ?? 0;
    await this.apply(action);
    // Coming back and PLAYING clears the record — but only a real, legal move
    // does it. Not chat (it buys no time on the clock either) and not a
    // rejected action, or spamming nonsense would be a way to keep a seat.
    // Saving again is worth it because it essentially never happens twice.
    if (timeouts > 0 && seat && action.type !== 'quickChat') {
      seat.timeouts = 0;
      await this.save();
    }
  }

  /** The single path every action takes — human, CPU, and the shot clock. */
  private async apply(action: Action): Promise<void> {
    if (!this.state) return;
    let next: GameState;
    try {
      next = applyAction(this.state, action);
    } catch (err) {
      throw new RoomError('ILLEGAL_ACTION', err instanceof Error ? err.message : String(err));
    }
    const wasFinished = this.data.phase === 'finished';
    this.state = next;
    this.data.actions.push(action);
    if (isGameOver(next)) this.data.phase = 'finished';
    const justFinished = !wasFinished && this.data.phase === 'finished';

    // Quick chat is the one action that must NOT buy time: it is sendable out
    // of turn and after the game ends, so letting it restart the clock would
    // hand any seat an unlimited stall for the price of saying "hmm" every
    // fifty seconds.
    this.retime(action.type !== 'quickChat');
    await this.save();
    this.broadcastState();

    if (this.data.phase === 'finished') {
      // Reveal on the transition only; chat continues afterwards.
      if (justFinished) {
        this.reveal();
        this.broadcastRoom();
      }
      return;
    }
    await this.arm();
  }

  // --- the timer (CPU pacing and the shot clock share one alarm) ------------

  /**
   * Re-derive both timers for whoever must act now.
   *
   * A CPU seat gets a short pause so humans can follow the board; a human seat
   * gets the shot clock. `restartAction` is false for actions that must not
   * buy their sender time (see `apply`). The control budget survives a restart
   * — it is set once, when control ARRIVES at the seat, and is what a
   * state-neutral action loop cannot escape.
   */
  private retime(restartAction: boolean): void {
    this.cpuWakeAt = null;
    const actor = this.state && this.data.phase === 'playing' ? getPlayerToAct(this.state) : null;
    if (actor === null) {
      this.data.clock = null;
      return;
    }
    const now = this.host.now();
    if (this.data.seats[actor]?.controller !== 'human') {
      this.data.clock = null;
      this.cpuWakeAt = now + (this.host.cpuDelayMs ?? DEFAULT_CPU_DELAY_MS);
      return;
    }
    const held = this.data.clock?.seat === actor ? this.data.clock : null;
    this.data.clock = {
      seat: actor,
      actionDeadline: restartAction || !held ? now + SHOT_CLOCK_MS : held.actionDeadline,
      controlDeadline: held ? held.controlDeadline : now + CONTROL_BUDGET_MS,
    };
  }

  /** When the seat on the clock runs out: whichever deadline lands first. */
  private expiryAt(): number | null {
    const c = this.data.clock;
    return c === null ? null : Math.min(c.actionDeadline, c.controlDeadline);
  }

  /** Ask the host to wake us for the next thing that is due, if anything is. */
  private async arm(): Promise<void> {
    const at = this.cpuWakeAt ?? this.expiryAt();
    if (at !== null) await this.host.scheduleAlarm(at);
  }

  /**
   * The scheduled wake-up. One alarm serves both timers, because a Durable
   * Object has exactly one: whichever is due gets run, and anything still
   * pending is re-armed.
   */
  async onAlarm(): Promise<void> {
    if (!this.state || this.data.phase !== 'playing') return;
    const actor = getPlayerToAct(this.state);
    if (actor === null) return;
    const now = this.host.now();

    if (this.data.seats[actor]?.controller !== 'human') {
      // A room woken from hibernation has forgotten `cpuWakeAt`; that means
      // "due now", not "wait another beat".
      if (this.cpuWakeAt !== null && now < this.cpuWakeAt) return await this.arm();
      return await this.apply(chooseAiAction(this.state));
    }

    if (this.data.clock === null || this.data.clock.seat !== actor) {
      // The clock and the game disagree — only possible after a wake that lost
      // it. Start it now rather than leaving the seat untimed.
      this.retime(true);
      return await this.arm();
    }
    const due = this.expiryAt();
    if (due === null) return;
    if (now < due) return await this.arm(); // woken for the other timer
    await this.expire(actor);
  }

  /**
   * A seat ran out of time: play the engine's default answer on its behalf
   * until control leaves it. `getTimeoutAction` is the whole policy (the most
   * passive legal option, never a card play — see engine/timeout.ts); the room
   * applies it one action at a time rather than calling `applyTimeout`, so
   * every action still lands in the record and the game replays exactly.
   */
  private async expire(seat: number): Promise<void> {
    for (const c of this.conns.values()) c.conn.send({ t: 'timedOut', seat });
    const info = this.data.seats[seat];
    if (info) info.timeouts = (info.timeouts ?? 0) + 1;

    for (let step = 0; step < MAX_TIMEOUT_STEPS; step++) {
      if (!this.state || this.data.phase !== 'playing') break;
      if (getPlayerToAct(this.state) !== seat) break; // control moved on
      const action = getTimeoutAction(this.state);
      if (action === null) break;
      await this.apply(action);
    }

    if (this.data.phase === 'playing' && (info?.timeouts ?? 0) >= TAKEOVER_AFTER_TIMEOUTS) {
      await this.takeOverSeat(seat);
    }
  }

  /**
   * Stop waiting for a seat and give it to a CPU for the rest of the game.
   *
   * Playing every one of somebody's turns for them one timeout at a time is a
   * bad game for everyone else: the table spends a minute per turn watching a
   * clock run down to reach the same move a CPU would have made instantly. So
   * after enough consecutive timeouts the seat becomes a CPU seat and the
   * game goes back to running at the speed of the people who are still here.
   *
   * The player is NOT thrown out of the room. They lose the seat — `hello`
   * already refuses to hand back a seat that has become a CPU mid-game, which
   * is what stops a returning player and the AI fighting over one seat — and
   * they come back as a spectator, watching the rest of the game out.
   */
  private async takeOverSeat(seat: number): Promise<void> {
    const info = this.data.seats[seat];
    if (!info || info.controller !== 'human') return;
    info.controller = 'cpu';
    info.difficulty = TAKEOVER_DIFFICULTY;
    info.takenOver = true;
    info.timeouts = 0;

    this.vacateNonHumanSeats();
    this.ensureHost();
    for (const c of this.conns.values()) c.conn.send({ t: 'seatTakenOver', seat });
    // The seat may be the one to act right now — a timeout that ends the game
    // aside, control passes on, but a Respond window can come straight back.
    this.retime(true);
    await this.save();
    this.announceIdentities();
    this.broadcastRoom();
    await this.arm();
  }

  // --- game over -----------------------------------------------------------

  /**
   * Publish the secret and the full record. Anyone can now check the seal
   * against the commitment they were given when the game started, and replay
   * the record to see the deck they played against was the one it bound the
   * room to.
   */
  private reveal(): void {
    if (!this.state || !this.data.seal || !this.data.config || this.data.seed === null) return;
    const winner = this.state.winner;
    const record: MatchRecord = {
      schemaVersion: MATCH_RECORD_SCHEMA,
      config: this.data.config,
      seed: this.data.seed,
      seal: this.data.seal,
      actions: this.data.actions,
      result: {
        winner,
        winnerName: winner !== null ? this.state.players[winner].name : null,
        winnerController: winner !== null ? this.state.players[winner].controller : null,
        turns: this.state.turn?.number ?? 0,
        actionCount: this.data.actions.length,
        reason: winner === null ? 'draw' : 'lastStanding',
      },
    };
    for (const c of this.conns.values()) c.conn.send({ t: 'revealed', seal: this.data.seal, record });
  }

  // --- outbound ------------------------------------------------------------

  /**
   * Tell each connection who it is, when that has changed.
   *
   * `welcome` is the only message carrying a client's seat, and a seat is no
   * longer settled once and for all: spectators get seated, seats get turned
   * into CPUs, and the host badge moves when its holder leaves. Re-sending
   * `welcome` — to that connection alone, since it contains that client's
   * private token — is how the client learns. Unchanged identities are
   * skipped so a lobby edit does not spray tokens around for no reason.
   */
  private announceIdentities(): void {
    for (const c of this.conns.values()) {
      const isHost = c.token === this.data.hostToken;
      if (c.announced && c.announced.seat === c.seat && c.announced.isHost === isHost) continue;
      c.announced = { seat: c.seat, isHost };
      c.conn.send({
        t: 'welcome',
        you: { seat: c.seat, token: c.token, isHost },
        room: this.snapshot(),
      });
      // A new seat means a differently redacted view — a promoted spectator
      // must be handed the hand they can now see.
      if (this.state) c.conn.send({ t: 'state', view: viewFor(this.state, c.seat), clock: this.shotClock() });
    }
  }

  /** Each connection gets the state redacted for ITS seat, never a shared one. */
  private broadcastState(): void {
    if (!this.state) return;
    const clock = this.shotClock();
    for (const c of this.conns.values()) {
      c.conn.send({ t: 'state', view: viewFor(this.state, c.seat), clock });
    }
  }

  /**
   * The clock as clients render it: one deadline (the earlier of the two the
   * room tracks — the distinction is the room's business) stamped with the
   * server's own `now`, so a client with a skewed wall clock still counts down
   * the right number of seconds.
   */
  private shotClock(): ShotClock | null {
    const at = this.expiryAt();
    if (at === null || this.data.clock === null) return null;
    return { seat: this.data.clock.seat, deadline: at, now: this.host.now() };
  }

  private broadcastRoom(): void {
    const room = this.snapshot();
    for (const c of this.conns.values()) c.conn.send({ t: 'room', room });
  }

  snapshot(): RoomSnapshot {
    const seats: SeatInfo[] = this.data.seats.map((s, i) => ({
      index: i,
      name: s.name,
      controller: s.controller,
      difficulty: s.difficulty,
      connected: s.controller === 'human' && this.seatIsOccupied(i),
      takenOver: s.takenOver === true,
    }));
    let spectators = 0;
    for (const c of this.conns.values()) if (c.seat === null) spectators++;
    return {
      protocol: PROTOCOL_VERSION,
      code: this.data.code,
      phase: this.data.phase,
      seats,
      hostSeat: this.hostSeat(),
      boardSize: this.data.boardSize,
      gardenPreset: this.data.gardenPreset,
      // The commitment, never the secret — that waits for `revealed`.
      commitment: this.data.seal?.commitment ?? null,
      spectators,
    };
  }

  private hostSeat(): number | null {
    if (this.data.hostToken === null) return null;
    const seat = this.data.tokens[this.data.hostToken];
    return seat === undefined ? null : seat;
  }

  private async save(): Promise<void> {
    await this.host.store.save(this.data);
  }

  // --- test/inspection surface ---------------------------------------------

  /** The authoritative state. Server-side only — clients get views. */
  get gameState(): GameState | null {
    return this.state;
  }

  get phase(): RoomPhase {
    return this.data.phase;
  }
}
