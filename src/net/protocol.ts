/**
 * The room wire protocol: every message that crosses between a client and the
 * room Durable Object.
 *
 * Two rules shape all of it.
 *
 * **The server never trusts a client's word about who it is.** Actions carry a
 * `player` field because the engine needs one, but the room checks it against
 * the seat the *connection* holds, which was assigned server-side and is
 * remembered by a token the client cannot forge into another seat. A client
 * that sends `{ player: 1 }` from seat 0 is rejected, not obeyed. This is the
 * whole anti-cheat surface: everything else the client sends is either a
 * lobby setting the host owns or an engine action that `applyAction` validates
 * against the rules anyway.
 *
 * **The server never sends a client more than it may see.** Game state goes
 * out as `PlayerView` (see engine/view.ts), redacted per seat, so the hands
 * and the deck are gone before the bytes leave the room — not hidden by the
 * client afterwards.
 */

import type { Action, AiDifficulty, GameSeal, GardenPreset, PlayerView } from '../engine';
import type { MatchRecord } from '../engine';

/** Bumped on any breaking change to the messages below. */
export const PROTOCOL_VERSION = 1;

/** Room codes: 6 chars, no vowels (no accidental words) and no 0/O/1/I/L. */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export type RoomPhase = 'lobby' | 'playing' | 'finished';

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

/**
 * Why the room hung up. All in the 4000–4999 range WebSocket reserves for the
 * application, and all meaning "do not simply redial and carry on" to some
 * degree — which is the whole reason they are worth naming: a client that
 * treats every close as a dropped tunnel will fight a takeover forever, or
 * hammer a room that has just told it to slow down.
 */

/**
 * A newer connection presented this seat's token. The old socket is closed
 * rather than left sitting beside itself; the client must NOT redial, or two
 * tabs trade the seat back and forth indefinitely.
 */
export const CLOSE_SEAT_TAKEN_OVER = 4000;

/**
 * The room stopped reading this socket because it would not stop flooding.
 * Redialing is allowed — this is not a ban — but only after a long backoff.
 */
export const CLOSE_RATE_LIMITED = 4001;

/** The room is already holding as many connections as it will hold. */
export const CLOSE_TOO_MANY_CONNECTIONS = 4003;

// ---------------------------------------------------------------------------
// The shot clock
// ---------------------------------------------------------------------------

/**
 * How long a human seat has to send its next action. Every action that seat
 * takes restarts it, so this is a per-*action* budget, not a per-turn one: a
 * turn with eight moves in it gets eight minutes if it wants them, and nobody
 * is ever rushed for playing slowly. It only bites on a seat that has stopped
 * playing.
 */
export const SHOT_CLOCK_MS = 60_000;

/**
 * The backstop, and the reason the per-action clock is not enough on its own.
 *
 * Some actions are state-neutral by design — `playCard` → `cancelTargeting`
 * leaves the card in hand and the game exactly as it was (see TECH_DEBT.md,
 * "Stall vectors that rules cannot close"). A seat that spins that loop once a
 * minute would restart its per-action clock forever and hold the table
 * hostage. So a seat also gets a total budget for one uninterrupted stretch of
 * control, which nothing it does restarts; it resets only when control
 * genuinely passes to somebody else. It is set well above any honest turn.
 */
export const CONTROL_BUDGET_MS = 300_000;

/**
 * Consecutive timeouts before the room stops waiting for a seat and gives it
 * to a CPU for the rest of the game.
 *
 * More than one, because a single timeout is usually a phone call or a tunnel
 * and the conversion is not reversible mid-game. Few enough that the table is
 * not made to play three-quarters of a game around an empty chair. Any action
 * from the seat resets the count — coming back and playing is all it takes.
 */
export const TAKEOVER_AFTER_TIMEOUTS = 3;

/** The difficulty a taken-over seat is played at. */
export const TAKEOVER_DIFFICULTY: AiDifficulty = 'easy';

/**
 * The live clock as a client sees it. `now` is the SERVER's wall clock at the
 * moment the frame was built: a client that renders `deadline - now` as a
 * duration is immune to the two clocks disagreeing, which they routinely do by
 * enough to matter at this scale.
 */
export interface ShotClock {
  seat: number;
  deadline: number;
  now: number;
}

/** A seat as everyone in the room sees it. Carries no tokens. */
export interface SeatInfo {
  index: number;
  name: string;
  /** 'human' seats are claimed by a connection; 'cpu' seats the room plays. */
  controller: 'human' | 'cpu';
  difficulty: AiDifficulty;
  /** Human seats only: is somebody connected to it right now? */
  connected: boolean;
  /**
   * The room took this seat over mid-game because its player stopped playing —
   * as opposed to a CPU seat the host set up in the lobby. Its original player
   * may still be in the room, watching.
   */
  takenOver: boolean;
}

/** The room as everyone in it sees it. Public by construction. */
export interface RoomSnapshot {
  protocol: number;
  code: string;
  phase: RoomPhase;
  seats: SeatInfo[];
  /** Seat that owns the lobby settings and the start button. */
  hostSeat: number | null;
  boardSize: number;
  gardenPreset: GardenPreset;
  /**
   * Published the moment the game starts, and NOT before: SHA-256 of the
   * secret the deck was sealed with. The secret itself arrives in `revealed`
   * when the game ends — see src/net/commitment.ts.
   */
  commitment: string | null;
  spectators: number;
}

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export type ClientMessage =
  /**
   * First message on every connection, including reconnects. A returning
   * player presents the `token` it was given, which is what restores its seat
   * (and its hand) after a refresh, a tunnel, or the room hibernating.
   */
  | { t: 'hello'; protocol: number; token?: string; name?: string }
  /** Host only: lobby settings. Rejected once the game has started. */
  | { t: 'configure'; playerCount?: 2 | 4; boardSize?: number; gardenPreset?: GardenPreset; seats?: SeatConfig[] }
  /** Host only: deal the cards. The room picks the seed; no client ever does. */
  | { t: 'start' }
  /** A game action. `action.player` must be this connection's seat. */
  | { t: 'action'; action: Action }
  | { t: 'ping' };

export interface SeatConfig {
  index: number;
  controller?: 'human' | 'cpu';
  difficulty?: AiDifficulty;
  name?: string;
}

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export type ServerMessage =
  /**
   * Identity: who this connection is. Sent on `hello`, and again whenever the
   * room changes it — a spectator being seated, a seat turned into a CPU, the
   * host badge moving. It is the only message carrying a seat, so a client
   * should treat each one as replacing what it knew. `token` is this client's
   * private reconnect credential — never included in anything broadcast.
   */
  | { t: 'welcome'; you: { seat: number | null; token: string; isHost: boolean }; room: RoomSnapshot }
  | { t: 'room'; room: RoomSnapshot }
  /**
   * The game, redacted for the receiving seat. `clock` is the shot clock for
   * whoever must act — null when nobody is on it (a CPU seat is thinking, or
   * the game is over). It rides on `state` rather than on `room` because it
   * changes with every action, which is exactly when `state` goes out.
   */
  | { t: 'state'; view: PlayerView; clock: ShotClock | null }
  /** A seat ran out of time and the room played its turn out for it. */
  | { t: 'timedOut'; seat: number }
  /**
   * A seat timed out once too often and now belongs to a CPU for the rest of
   * the game. Its player is not thrown out of the room — they keep watching,
   * and `welcome` will have moved them to `seat: null`.
   */
  | { t: 'seatTakenOver'; seat: number }
  /**
   * Game over: the host reveals the secret it committed to at the start, with
   * the full record. Replay it and check it against `room.commitment` — see
   * verifySeal / replayMatch.
   */
  | { t: 'revealed'; seal: GameSeal; record: MatchRecord }
  | { t: 'error'; code: RoomErrorCode; message: string }
  | { t: 'pong' };

export type RoomErrorCode =
  | 'PROTOCOL' // unparseable, unknown, or wrong-version message
  | 'NOT_YOUR_SEAT' // the action's player is not this connection's seat
  | 'NOT_HOST' // a lobby command from someone who does not own the lobby
  | 'WRONG_PHASE' // right message, wrong moment (start twice, act in a lobby)
  | 'ROOM_FULL' // the room will not hold another connection
  | 'BAD_CONFIG' // lobby settings the engine would reject
  | 'ILLEGAL_ACTION' // the engine said no
  | 'RATE_LIMITED'; // sending faster than the room will serve (see ratelimit.ts)

/** Narrow an untrusted parsed JSON payload to a ClientMessage. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as { t?: unknown }).t;
  switch (t) {
    case 'hello':
    case 'configure':
    case 'start':
    case 'action':
    case 'ping':
      return raw as ClientMessage;
    default:
      return null;
  }
}
