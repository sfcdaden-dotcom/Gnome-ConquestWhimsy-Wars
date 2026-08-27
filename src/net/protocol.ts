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

import type { Action, AiDifficulty, GameSeal, GardenPreset, PlayerAppearance, PlayerView } from '../engine';
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

/**
 * The room no longer exists. A client must NOT redial: addressing a room is
 * what CREATES it, so a redial would quietly build a fresh empty lobby at the
 * same code — with the redialer as its host — rather than failing. The room
 * leaves a tombstone behind for the same reason.
 */
export const CLOSE_ROOM_CLOSED = 4004;

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

// ---------------------------------------------------------------------------
// The host's grace window
// ---------------------------------------------------------------------------

/**
 * How long a lobby waits for a host who has dropped.
 *
 * The host is static (see room.ts), so a lobby whose host has gone cannot
 * start — and without a limit it would sit there forever. When this expires
 * the room either hands itself to somebody still in it or, if nobody is, shuts
 * down.
 *
 * Lobby only. Mid-game a missing host is a non-event: there is no lobby left
 * to own, and a seat that has stopped playing is already the shot clock's
 * problem. Tearing down a game in progress because somebody's phone slept
 * would be far worse than the thing this prevents.
 */
export const HOST_GRACE_MS = 60_000;

/**
 * How long the host must be gone before anyone is TOLD they are gone.
 *
 * A reload drops the socket for about a second, and the most ordinary thing a
 * waiting host does is reload. Announcing that every time would make a
 * non-event look like a crisis. The clock runs from the actual disconnect;
 * only the announcement waits.
 */
export const HOST_ABSENCE_BANNER_MS = 5_000;

/**
 * How long a room with nobody in it is kept before it is closed.
 *
 * Nothing used to collect abandoned rooms at all: a lobby somebody opened and
 * wandered off from, or a finished game everyone closed, sat in Durable Object
 * storage indefinitely. Long enough that a whole table reconnecting after a
 * network blip finds its game where it left it; short enough that a room is
 * not a permanent object.
 */
export const EMPTY_ROOM_REAP_MS = 10 * 60_000;

/**
 * How long a closed room's tombstone is kept.
 *
 * The tombstone exists so a redial cannot rebuild a closed room from nothing
 * (see CLOSE_ROOM_CLOSED), which only matters while somebody might still have
 * the code in front of them. A day is far past that, and keeping them forever
 * would be the same slow leak the reaper is here to stop.
 */
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

/** The countdown on a lobby whose host has dropped. `now` is the server's clock. */
export interface HostGrace {
  until: number;
  now: number;
}

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
  /**
   * Always fully resolved, never partial: the room settles every seat's look
   * (and keeps the palettes distinct) before anyone sees the lobby, so the
   * gnomes on the lobby list are exactly the gnomes the game deals.
   */
  appearance: PlayerAppearance;
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
  /**
   * Seat that owns the lobby settings and the start button, or null when the
   * host holds no seat — which happens both when they are spectating and when
   * there is no host at all. `hasHost` is what tells those two apart.
   */
  hostSeat: number | null;
  /** Is anybody the host right now? False only between a host leaving and a takeover. */
  hasHost: boolean;
  /**
   * Set while a lobby is waiting out a dropped host. Null at every other time,
   * including mid-game. When it runs out the room is handed over or closed.
   */
  hostGrace: HostGrace | null;
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
  /**
   * `hostKey` is the credential `POST /api/rooms` handed whoever opened the
   * room. It binds the host ONCE, to the token of the connection that first
   * presents it, and is ignored ever after — the host does not move because
   * somebody reloaded. See `Room.hello`.
   */
  | { t: 'hello'; protocol: number; token?: string; name?: string; hostKey?: string }
  /** Host only: lobby settings. Rejected once the game has started. */
  | { t: 'configure'; playerCount?: 2 | 4; boardSize?: number; gardenPreset?: GardenPreset; seats?: SeatConfig[] }
  /**
   * Choose your own gnome. Unlike `configure` this is NOT host-only — it
   * applies to the seat the sending connection holds, because the one thing a
   * player should always control is their own character. Refused for a
   * spectator, once the game has started, or for a palette another seat holds.
   */
  | { t: 'setAppearance'; appearance: PlayerAppearance }
  /** Host only: deal the cards. The room picks the seed; no client ever does. */
  | { t: 'start' }
  /**
   * Claim a room whose host is gone. Refused unless the room actually has no
   * host — this is the deliberate, visible handover that replaced the silent
   * one, not a way to take a room off somebody who is still in it.
   */
  | { t: 'takeOverRoom' }
  /** A game action. `action.player` must be this connection's seat. */
  | { t: 'action'; action: Action }
  | { t: 'ping' };

export interface SeatConfig {
  index: number;
  controller?: 'human' | 'cpu';
  difficulty?: AiDifficulty;
  name?: string;
  /** Host-side character select — for CPU seats, mostly. A seated player uses `setAppearance`. */
  appearance?: PlayerAppearance;
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
  /**
   * Somebody claimed a room whose host had gone. Announced to everyone by
   * name: the old handover was silent, which is most of why it was confusing.
   */
  | { t: 'roomTakenOver'; seat: number | null; name: string | null }
  /**
   * The room is gone and is not coming back. Sent immediately before the
   * socket is closed with `CLOSE_ROOM_CLOSED`, so the client can say what
   * happened instead of showing a generic disconnect.
   */
  | { t: 'roomClosed'; reason: RoomClosedReason }
  | { t: 'error'; code: RoomErrorCode; message: string }
  | { t: 'pong' };

/** Why a room shut down. */
export type RoomClosedReason =
  /** The lobby's host never came back and nobody took the room over. */
  | 'host-left'
  /** Nobody has been connected for long enough that the room was reaped. */
  | 'abandoned';

export type RoomErrorCode =
  | 'PROTOCOL' // unparseable, unknown, or wrong-version message
  | 'NOT_YOUR_SEAT' // the action's player is not this connection's seat
  | 'NOT_HOST' // a lobby command from someone who does not own the lobby
  | 'NOT_SEATED' // a seat-owned command from a connection holding no seat
  | 'WRONG_PHASE' // right message, wrong moment (start twice, act in a lobby)
  | 'ROOM_FULL' // the room will not hold another connection
  | 'BAD_CONFIG' // lobby settings the engine would reject
  | 'HAS_HOST' // a takeover attempt on a room that still has a host
  | 'ILLEGAL_ACTION' // the engine said no
  | 'RATE_LIMITED'; // sending faster than the room will serve (see ratelimit.ts)

/** Narrow an untrusted parsed JSON payload to a ClientMessage. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as { t?: unknown }).t;
  switch (t) {
    case 'hello':
    case 'configure':
    case 'setAppearance':
    case 'start':
    case 'takeOverRoom':
    case 'action':
    case 'ping':
      return raw as ClientMessage;
    default:
      return null;
  }
}
