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
  applyAction,
  chooseAiAction,
  createGame,
  getPlayerToAct,
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
} from './protocol';
import { PROTOCOL_VERSION, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './protocol';

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
  /** token → seat index, or null for a spectator. Never leaves the server. */
  tokens: Record<string, number | null>;
  boardSize: number;
  gardenPreset: GardenPreset;
  /** Set when play starts. */
  seed: number | null;
  seal: GameSeal | null;
  config: GameConfig | null;
  actions: Action[];
}

export interface PersistedSeat {
  name: string;
  controller: 'human' | 'cpu';
  difficulty: AiDifficulty;
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

function defaultSeats(count: 2 | 4): PersistedSeat[] {
  const names = ['Rose', 'Thistle', 'Marigold', 'Bramble'];
  return Array.from({ length: count }, (_, i) => ({
    name: names[i],
    controller: i === 0 ? ('human' as const) : ('cpu' as const),
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
}

export class Room {
  private host: RoomHost;
  private data: PersistedRoom;
  private state: GameState | null = null;
  private readonly conns = new Map<string, ConnState>();

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
      stored ?? {
        code,
        phase: 'lobby',
        seats: defaultSeats(2),
        hostToken: null,
        tokens: {},
        boardSize: 7,
        gardenPreset: 'random',
        seed: null,
        seal: null,
        config: null,
        actions: [],
      },
    );
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
   * fresh one and the next free human seat, or spectator status if the table
   * is full.
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
    const token = known ? (message.token as string) : this.mintToken();
    let seat: number | null;

    if (known) {
      seat = this.data.tokens[token];
      // A seat flipped to CPU while its player was away is not theirs to take
      // back mid-game; they return as a spectator rather than fighting the AI
      // for control.
      if (seat !== null && this.data.seats[seat]?.controller !== 'human') seat = null;
    } else {
      seat = this.claimSeat();
      this.data.tokens[token] = seat;
      if (this.data.hostToken === null && seat !== null) this.data.hostToken = token;
    }

    if (message.name && seat !== null) this.data.seats[seat].name = message.name.slice(0, 24);

    // One token, one live connection. A second tab (or a reconnect the room
    // has not noticed dropping yet) takes the seat over rather than sitting
    // beside itself — otherwise `seatIsOccupied` sees a ghost forever.
    for (const [id, existing] of this.conns) {
      if (existing.token !== token || id === conn.id) continue;
      this.conns.delete(id);
      existing.conn.close(4000, 'seat taken over by a newer connection');
    }

    this.conns.set(conn.id, { conn, token, seat });
    await this.save();

    conn.send({
      t: 'welcome',
      you: { seat, token, isHost: token === this.data.hostToken },
      room: this.snapshot(),
    });
    if (this.state) conn.send({ t: 'state', view: viewFor(this.state, seat) });
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

  /** First human seat nobody is connected to, or null when the table is full. */
  private claimSeat(): number | null {
    for (let i = 0; i < this.data.seats.length; i++) {
      if (this.data.seats[i].controller !== 'human') continue;
      if (this.seatIsOccupied(i)) continue;
      return i;
    }
    return null;
  }

  private seatIsOccupied(seat: number): boolean {
    for (const c of this.conns.values()) if (c.seat === seat) return true;
    return false;
  }

  /**
   * The reconnect token a connection was issued. The transport stores this
   * with the socket so a hibernating room can put the player back in its seat;
   * it is private to that client and never appears in a broadcast.
   */
  tokenFor(connId: string): string | null {
    return this.conns.get(connId)?.token ?? null;
  }

  /** A connection dropped. The seat stays theirs — the token is what holds it. */
  disconnect(connId: string): void {
    this.conns.delete(connId);
    this.broadcastRoom();
  }

  // --- messages ------------------------------------------------------------

  async handle(connId: string, message: ClientMessage): Promise<void> {
    const c = this.conns.get(connId);
    if (!c) return;
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

    // Nobody is left holding a seat the host just turned into a CPU.
    for (const conn of this.conns.values()) {
      if (conn.seat !== null && this.data.seats[conn.seat]?.controller !== 'human') {
        conn.seat = null;
        this.data.tokens[conn.token] = null;
      }
    }

    await this.save();
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

    await this.save();
    this.broadcastRoom();
    this.broadcastState();
    await this.driveCpu();
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
    await this.apply(action);
  }

  /** The single path every action takes — human, CPU, and later the clock. */
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
    await this.driveCpu();
  }

  // --- CPU seats -----------------------------------------------------------

  /**
   * Hand control to the CPU when the seat to act is one. Scheduled rather than
   * run inline so the humans see the board move at a readable pace, and so a
   * chain of CPU turns cannot hold a message handler open.
   */
  private async driveCpu(): Promise<void> {
    if (!this.state || this.data.phase !== 'playing') return;
    const actor = getPlayerToAct(this.state);
    if (actor === null) return;
    if (this.data.seats[actor]?.controller !== 'cpu') return;
    await this.host.scheduleAlarm(this.host.now() + (this.host.cpuDelayMs ?? DEFAULT_CPU_DELAY_MS));
  }

  /** The scheduled wake-up: play one CPU action, then re-arm if still theirs. */
  async onAlarm(): Promise<void> {
    if (!this.state || this.data.phase !== 'playing') return;
    const actor = getPlayerToAct(this.state);
    if (actor === null) return;
    if (this.data.seats[actor]?.controller !== 'cpu') return;
    await this.apply(chooseAiAction(this.state));
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

  /** Each connection gets the state redacted for ITS seat, never a shared one. */
  private broadcastState(): void {
    if (!this.state) return;
    for (const c of this.conns.values()) {
      c.conn.send({ t: 'state', view: viewFor(this.state, c.seat) });
    }
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
