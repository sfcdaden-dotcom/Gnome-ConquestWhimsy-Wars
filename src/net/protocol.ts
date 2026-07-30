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

/** A seat as everyone in the room sees it. Carries no tokens. */
export interface SeatInfo {
  index: number;
  name: string;
  /** 'human' seats are claimed by a connection; 'cpu' seats the room plays. */
  controller: 'human' | 'cpu';
  difficulty: AiDifficulty;
  /** Human seats only: is somebody connected to it right now? */
  connected: boolean;
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
  /** The game, redacted for the receiving seat. */
  | { t: 'state'; view: PlayerView }
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
  | 'ROOM_FULL' // no free human seat to claim
  | 'BAD_CONFIG' // lobby settings the engine would reject
  | 'ILLEGAL_ACTION'; // the engine said no

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
