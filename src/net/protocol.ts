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

import type {
  Action,
  ActionType,
  AiDifficulty,
  CardTarget,
  CardTargets,
  GameSeal,
  GardenPreset,
  HomeHarvestChoice,
  PlantableGardenType,
  PlayerId,
  PlayerView,
  Pos,
  QuickChatTarget,
} from '../engine';
import type { MatchRecord } from '../engine';
import { PLANTABLE_GARDEN_TYPES } from '../engine';
import { validateLookWire } from './lookSchema';

/** Bumped on any breaking change to the messages below. */
export const PROTOCOL_VERSION = 3;

/**
 * The board sizes a room will deal: odd, and between these two inclusive.
 *
 * The engine itself has no ceiling, but every client renders `boardSize²`
 * cells, so a host who could pick any odd number could freeze every browser at
 * the table with one `configure`. The top is the largest size the setup screen
 * offers (`BOARD_SIZES` in src/ui/advancedSettings.ts, whose test holds the two
 * together).
 */
export const MIN_BOARD_SIZE = 5;
export const MAX_BOARD_SIZE = 13;

export function isSupportedBoardSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n % 2 === 1 && n >= MIN_BOARD_SIZE && n <= MAX_BOARD_SIZE;
}

export const BOARD_SIZE_RULE = `boardSize must be an odd integer from ${MIN_BOARD_SIZE} to ${MAX_BOARD_SIZE}`;

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

/**
 * The client speaks a different version of this protocol than the room does —
 * one side is running an older build.
 *
 * A client must NOT redial: nothing about reconnecting changes which version
 * it speaks, so a retry loop is infinite by construction and every pass costs
 * the room a connection and the player another error. The only fix is loading
 * the app again, which is a thing to TELL somebody rather than something to
 * keep failing at quietly.
 *
 * In the application range rather than the standard 1002 so a client can tell
 * this apart from any other protocol-level close and say something useful.
 */
export const CLOSE_PROTOCOL = 4002;

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

/**
 * A player's gnome, as it travels between clients.
 *
 * The room checks its shape only (`validateLookWire` in ./lookSchema.ts —
 * exact keys, filename-shaped ids, small indices) and never its meaning, then
 * hands it back out with the rest of the seat. The receiving client validates
 * the meaning (`sanitizeLook` in src/ui/gnomeArt.ts) before drawing anything,
 * because an unknown hat id from a stranger's build must not be able to leave a
 * hole in your board.
 *
 * The shape is declared here rather than imported from the UI so the wire
 * format stays owned by the wire; `src/ui/gnomeLook.ts` asserts that its own
 * `GnomeLook` still matches this, so the two cannot drift apart in silence.
 */
export interface GnomeLookWire {
  torso: string;
  face: string;
  shoes: string;
  /** Optional layers; null means the gnome goes without. */
  beard: string | null;
  hair: string | null;
  cap: string;
  accessory: string;
  /** Indices into the palettes — see src/ui/gnomeLook.ts. */
  garment: number;
  hair_color: number;
  skin: number;
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
  /** The gnome this seat plays. Absent until its player sends one. */
  look?: GnomeLookWire;
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
   * The room was opened by a board view, which declined the lobby rather than
   * holding it: the first player to sit down becomes host. True only in the
   * window between that opening and that arrival, and never again once a host
   * exists — a host who later leaves is replaced by the deliberate takeover,
   * not by whoever walks in next.
   *
   * On the wire so a board view can say what it is waiting for, and so a
   * player's lobby does not read a hostless room as an abandoned one.
   */
  hostDelegated: boolean;
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
   *
   * `spectate` marks a screen rather than a player: a board view on a TV or a
   * projector, which shows the room to everyone around it and is touched by
   * nobody. It is sent on EVERY hello, reconnects included, because it is a
   * property of the screen and not of a moment — a projector that dropped and
   * redialled without it would be handed a seat on the way back in.
   *
   * A spectating connection is never seated, never becomes host, and cannot
   * take a hostless room over. What it CAN do is open the room: presenting a
   * valid `hostKey` while spectating delegates the lobby instead of claiming
   * it, so the first person to sit down gets the start button. That is what
   * makes "set the TV up first" the natural order rather than the trap it
   * would otherwise be — see `Room.settleHost`.
   */
  | {
      t: 'hello';
      protocol: number;
      token?: string;
      name?: string;
      look?: GnomeLookWire;
      hostKey?: string;
      spectate?: boolean;
    }
  /** Host only: lobby settings. Rejected once the game has started. */
  | { t: 'configure'; playerCount?: 2 | 4; boardSize?: number; gardenPreset?: GardenPreset; seats?: SeatConfig[] }
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
  look?: GnomeLookWire;
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
  | 'PROTOCOL' // unparseable or unknown message
  | 'STALE_CLIENT' // right messages, wrong protocol version: reload the app
  | 'NOT_YOUR_SEAT' // the action's player is not this connection's seat
  | 'NOT_HOST' // a lobby command from someone who does not own the lobby
  | 'WRONG_PHASE' // right message, wrong moment (start twice, act in a lobby)
  | 'ROOM_FULL' // the room will not hold another connection
  | 'BAD_CONFIG' // lobby settings the engine would reject
  | 'HAS_HOST' // a takeover attempt on a room that still has a host
  | 'ILLEGAL_ACTION' // the engine said no
  | 'RATE_LIMITED'; // sending faster than the room will serve (see ratelimit.ts)

// ---------------------------------------------------------------------------
// Validation at the boundary
// ---------------------------------------------------------------------------

/**
 * Why a message was refused before the room saw it. Distinguished from a
 * `ClientMessage` by its `error` key, which no message has.
 */
export interface ClientMessageError {
  error: RoomErrorCode;
  message: string;
}

/** Seat tokens and host keys are 16 random bytes, hex-encoded (see room.ts). */
const CREDENTIAL = /^[0-9a-f]{32}$/;

/**
 * A raw name may be longer than a stored one — the room cleans and caps it
 * (see names.ts) — but not unboundedly so. The real client caps input at 24.
 */
const MAX_RAW_NAME = 256;

/** Preset ids are short registry keys; the room checks the id exists. */
const MAX_PRESET_ID = 64;

/**
 * The largest action the room will accept, serialised. Real actions are a few
 * dozen bytes — a card with several targets is still well under a kilobyte —
 * and every accepted action is stored in the record and later broadcast in
 * `revealed`, so this bounds what one action can add to both.
 */
export const MAX_ACTION_BYTES = 2048;

/**
 * The largest frame the room will decode, in bytes for a binary frame and in
 * UTF-16 code units for a text one (never more than its UTF-8 byte count).
 *
 * Checked BEFORE the frame is decoded or parsed: the per-field caps below only
 * run once `JSON.parse` has already paid for the whole payload, and the rate
 * limiter only sees a message after that. The biggest honest message is a
 * four-seat `configure` with every name at `MAX_RAW_NAME` — under 9 KiB even
 * if every character were escaped — so this is headroom, not a squeeze.
 */
export const MAX_FRAME_BYTES = 16 * 1024;

/** Card, unit, phrase and harvest-source ids are short slugs; the longest today is 24. */
const MAX_ID = 64;

const CONTROLLERS: readonly string[] = ['human', 'cpu'];
/**
 * Every CPU difficulty the engine has — the one list both the boundary and the
 * room check against. Tied to `AiDifficulty` in both directions below, so a
 * difficulty added to the engine is a compile error here until it is listed,
 * rather than a value the room quietly refuses (which is exactly what
 * happened to 'fly' when this list was first written by hand).
 */
export const AI_DIFFICULTIES = ['easy', 'normal', 'hard', 'fly'] as const satisfies readonly AiDifficulty[];
type MissingDifficulty = Exclude<AiDifficulty, (typeof AI_DIFFICULTIES)[number]>;
const _everyDifficultyListed: [MissingDifficulty] extends [never] ? true : never = true;
void _everyDifficultyListed;
const DIFFICULTIES: readonly string[] = AI_DIFFICULTIES;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refuse(error: RoomErrorCode, message: string): ClientMessageError {
  return { error, message };
}

/**
 * Narrow an untrusted parsed JSON payload to a well-formed `ClientMessage`.
 *
 * It used to check the `t` field and nothing else, so `{ t: 'hello', name: 123 }`
 * reached the room and threw inside it, and a `look` of any size or shape was
 * stored and rebroadcast verbatim. Now every field is checked for type and
 * bounds, and the message handed on is BUILT here — unknown fields are never
 * copied, so nothing the room did not ask for can ride into its storage.
 *
 * Two things are dropped rather than refused, because refusing would lock a
 * player out of a room over something that cannot matter:
 *
 *  - a `hello.look` that is not a well-formed look: the player sits down with
 *    no gnome, and everyone's board draws a stand-in;
 *  - a `token` or `hostKey` that is a string but not a credential's shape: it
 *    cannot be a credential the room issued, so it means exactly what an
 *    unknown one means — a fresh seat, no host claim.
 *
 * Never throws.
 */
export function parseClientMessage(raw: unknown): ClientMessage | ClientMessageError {
  if (!isPlainObject(raw)) return refuse('PROTOCOL', 'Unreadable message');
  switch (raw.t) {
    case 'hello':
      return parseHello(raw);
    case 'configure':
      return parseConfigure(raw);
    case 'action':
      return parseAction(raw);
    case 'start':
      return { t: 'start' };
    case 'takeOverRoom':
      return { t: 'takeOverRoom' };
    case 'ping':
      return { t: 'ping' };
    default:
      return refuse('PROTOCOL', 'Unreadable message');
  }
}

function parseHello(raw: Record<string, unknown>): ClientMessage | ClientMessageError {
  const { protocol, token, hostKey, name, look, spectate } = raw;
  if (typeof protocol !== 'number' || !Number.isInteger(protocol)) {
    return refuse('PROTOCOL', 'hello needs a protocol version');
  }
  if (token !== undefined && typeof token !== 'string') return refuse('PROTOCOL', 'Malformed seat token');
  if (hostKey !== undefined && typeof hostKey !== 'string') return refuse('PROTOCOL', 'Malformed host key');
  if (name !== undefined && (typeof name !== 'string' || name.length > MAX_RAW_NAME)) {
    return refuse('PROTOCOL', 'Malformed name');
  }
  if (spectate !== undefined && typeof spectate !== 'boolean') return refuse('PROTOCOL', 'Malformed hello');

  const out: Extract<ClientMessage, { t: 'hello' }> = { t: 'hello', protocol };
  if (typeof token === 'string' && CREDENTIAL.test(token)) out.token = token;
  if (typeof hostKey === 'string' && CREDENTIAL.test(hostKey)) out.hostKey = hostKey;
  if (name !== undefined) out.name = name;
  const validLook = look === undefined ? null : validateLookWire(look);
  if (validLook) out.look = validLook;
  if (spectate === true) out.spectate = true;
  return out;
}

function parseConfigure(raw: Record<string, unknown>): ClientMessage | ClientMessageError {
  const { playerCount, boardSize, gardenPreset, seats } = raw;
  const out: Extract<ClientMessage, { t: 'configure' }> = { t: 'configure' };

  if (playerCount !== undefined) {
    if (playerCount !== 2 && playerCount !== 4) return refuse('BAD_CONFIG', 'Whimsy Wars seats exactly 2 or 4 players');
    out.playerCount = playerCount;
  }
  if (boardSize !== undefined) {
    if (!isSupportedBoardSize(boardSize)) return refuse('BAD_CONFIG', BOARD_SIZE_RULE);
    out.boardSize = boardSize;
  }
  if (gardenPreset !== undefined) {
    if (typeof gardenPreset !== 'string' || gardenPreset.length === 0 || gardenPreset.length > MAX_PRESET_ID) {
      return refuse('BAD_CONFIG', 'Unknown board layout');
    }
    out.gardenPreset = gardenPreset;
  }
  if (seats !== undefined) {
    if (!Array.isArray(seats) || seats.length > 4) return refuse('BAD_CONFIG', 'Malformed seat list');
    const parsed: SeatConfig[] = [];
    for (const seat of seats) {
      const one = parseSeatConfig(seat);
      if ('error' in one) return one;
      parsed.push(one);
    }
    out.seats = parsed;
  }
  return out;
}

function parseSeatConfig(raw: unknown): SeatConfig | ClientMessageError {
  if (!isPlainObject(raw)) return refuse('BAD_CONFIG', 'Malformed seat');
  const { index, controller, difficulty, name, look } = raw;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 3) {
    return refuse('BAD_CONFIG', 'Malformed seat index');
  }
  const out: SeatConfig = { index };
  if (controller !== undefined) {
    if (typeof controller !== 'string' || !CONTROLLERS.includes(controller)) {
      return refuse('BAD_CONFIG', `Seat ${index + 1}: a seat is either human or cpu`);
    }
    out.controller = controller as SeatConfig['controller'];
  }
  if (difficulty !== undefined) {
    if (typeof difficulty !== 'string' || !DIFFICULTIES.includes(difficulty)) {
      return refuse('BAD_CONFIG', `Seat ${index + 1}: unknown difficulty`);
    }
    out.difficulty = difficulty as AiDifficulty;
  }
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length > MAX_RAW_NAME) return refuse('BAD_CONFIG', `Seat ${index + 1}: malformed name`);
    out.name = name;
  }
  if (look !== undefined) {
    // The host sets a CPU seat's gnome deliberately, so a bad one is an error
    // to report rather than a cosmetic to drop.
    const validLook = validateLookWire(look);
    if (!validLook) return refuse('BAD_CONFIG', `Seat ${index + 1}: malformed gnome`);
    out.look = validLook;
  }
  return out;
}

/**
 * Decode and parse one WebSocket frame. The size is checked first, so an
 * oversized frame costs a length comparison rather than a decode and a parse.
 * Never throws.
 */
export function parseClientFrame(data: string | ArrayBuffer): ClientMessage | ClientMessageError {
  const size = typeof data === 'string' ? data.length : data.byteLength;
  if (size > MAX_FRAME_BYTES) return refuse('PROTOCOL', 'Message too large');
  let raw: unknown;
  try {
    raw = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
  } catch {
    raw = undefined;
  }
  return parseClientMessage(raw);
}

// --- actions ---------------------------------------------------------------
//
// Each action type has its own builder, which reads exactly the fields that
// type carries and builds a fresh object from them — nested targets included.
// It used to copy any key that SOME action had, so a `quickChat` could carry a
// `pos`, and a `target` of the right kind could carry any text beside its
// coordinate straight into the `quickChatSaid` event everyone receives.
//
// These check shape only. Whether the unit exists, the square is on this
// board, or the card is in hand is the engine's to say, exactly as before.

type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;
type Fields = Record<string, unknown>;

function id(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null;
}

function seat(v: unknown): PlayerId | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3 ? v : null;
}

function coord(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX_BOARD_SIZE;
}

function pos(v: unknown): Pos | null {
  return isPlainObject(v) && coord(v.x) && coord(v.y) ? { x: v.x, y: v.y } : null;
}

function plantable(v: unknown): PlantableGardenType | null {
  return (PLANTABLE_GARDEN_TYPES as readonly unknown[]).includes(v) ? (v as PlantableGardenType) : null;
}

/** Every element valid, or null. */
function listOf<T>(v: unknown, one: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const ok = one(x);
    if (ok === null) return null;
    out.push(ok);
  }
  return out;
}

function cardTarget(v: unknown): CardTarget | null {
  if (!isPlainObject(v)) return null;
  switch (v.kind) {
    case 'unit': {
      const unitId = id(v.unitId);
      return unitId === null ? null : { kind: 'unit', unitId };
    }
    case 'space': {
      const p = pos(v.pos);
      return p === null ? null : { kind: 'space', pos: p };
    }
    case 'player': {
      const playerId = seat(v.playerId);
      return playerId === null ? null : { kind: 'player', playerId };
    }
    case 'card': {
      const cardId = id(v.cardId);
      return cardId === null ? null : { kind: 'card', cardId };
    }
    case 'gardenType': {
      const gardenType = plantable(v.gardenType);
      return gardenType === null ? null : { kind: 'gardenType', gardenType };
    }
    default:
      return null;
  }
}

function cardTargets(v: unknown): CardTargets | null {
  if (!isPlainObject(v)) return null;
  const out: CardTargets = {};
  if (v.units !== undefined) {
    const units = listOf(v.units, id);
    if (!units) return null;
    out.units = units;
  }
  if (v.spaces !== undefined) {
    const spaces = listOf(v.spaces, pos);
    if (!spaces) return null;
    out.spaces = spaces;
  }
  if (v.players !== undefined) {
    const players = listOf(v.players, seat);
    if (!players) return null;
    out.players = players;
  }
  if (v.cards !== undefined) {
    const cards = listOf(v.cards, id);
    if (!cards) return null;
    out.cards = cards;
  }
  if (v.gardenType !== undefined) {
    const gardenType = plantable(v.gardenType);
    if (!gardenType) return null;
    out.gardenType = gardenType;
  }
  return out;
}

function quickChatTarget(v: unknown): QuickChatTarget | null {
  if (!isPlainObject(v)) return null;
  if (v.kind === 'player') {
    const player = seat(v.player);
    return player === null ? null : { kind: 'player', player };
  }
  if (v.kind === 'space') {
    const p = pos(v.pos);
    return p === null ? null : { kind: 'space', pos: p };
  }
  return null;
}

const HOME_HARVEST: readonly unknown[] = ['wish', 'gnome'] satisfies HomeHarvestChoice[];

/** Actions that carry nothing but who is acting. */
function bare<T extends ActionType>(type: T) {
  return (_a: Fields, player: PlayerId) => ({ type, player }) as ActionOf<T>;
}

function toPos<T extends 'slide' | 'tunnel' | 'snailMove'>(type: T) {
  return (a: Fields, player: PlayerId) => {
    const to = pos(a.to);
    return to && ({ type, player, to } as ActionOf<T>);
  };
}

function accepting<T extends 'snailify' | 'snailEat'>(type: T) {
  return (a: Fields, player: PlayerId) =>
    typeof a.accept === 'boolean' ? ({ type, player, accept: a.accept } as ActionOf<T>) : null;
}

function withCard<T extends 'playCard' | 'respondPlayCard'>(type: T) {
  return (a: Fields, player: PlayerId) => {
    const cardId = id(a.cardId);
    if (cardId === null) return null;
    if (a.targets === undefined) return { type, player, cardId } as ActionOf<T>;
    const targets = cardTargets(a.targets);
    return targets && ({ type, player, cardId, targets } as ActionOf<T>);
  };
}

/**
 * One builder per action type. Keyed by `ActionType`, so an action added to
 * the engine is a compile error here until it has a builder.
 */
const ACTION_BUILDERS: { [T in ActionType]: (a: Fields, player: PlayerId) => ActionOf<T> | null } = {
  rollOff: bare('rollOff'),
  declineEffect: bare('declineEffect'),
  respondPass: bare('respondPass'),
  cancelTargeting: bare('cancelTargeting'),
  drawCard: bare('drawCard'),
  endTurn: bare('endTurn'),
  slide: toPos('slide'),
  tunnel: toPos('tunnel'),
  snailMove: toPos('snailMove'),
  snailify: accepting('snailify'),
  snailEat: accepting('snailEat'),
  playCard: withCard('playCard'),
  respondPlayCard: withCard('respondPlayCard'),
  chooseHarvest: (a, player) => {
    const sourceKey = id(a.sourceKey);
    return sourceKey === null ? null : { type: 'chooseHarvest', player, sourceKey };
  },
  homeHarvest: (a, player) =>
    HOME_HARVEST.includes(a.take) ? { type: 'homeHarvest', player, take: a.take as HomeHarvestChoice } : null,
  discardCard: (a, player) => {
    const cardId = id(a.cardId);
    return cardId === null ? null : { type: 'discardCard', player, cardId };
  },
  sacrificeGnome: (a, player) => {
    const unitId = id(a.unitId);
    return unitId === null ? null : { type: 'sacrificeGnome', player, unitId };
  },
  selectTarget: (a, player) => {
    const target = cardTarget(a.target);
    return target && { type: 'selectTarget', player, target };
  },
  move: (a, player) => {
    const unitId = id(a.unitId);
    const to = pos(a.to);
    return unitId === null || to === null ? null : { type: 'move', player, unitId, to };
  },
  plant: (a, player) => {
    const p = pos(a.pos);
    const gardenType = plantable(a.gardenType);
    return p && gardenType && { type: 'plant', player, pos: p, gardenType };
  },
  upgrade: (a, player) => {
    const p = pos(a.pos);
    return p && { type: 'upgrade', player, pos: p };
  },
  quickChat: (a, player) => {
    const phraseId = id(a.phraseId);
    if (phraseId === null) return null;
    if (a.target === undefined) return { type: 'quickChat', player, phraseId };
    const target = quickChatTarget(a.target);
    return target && { type: 'quickChat', player, phraseId, target };
  },
};

function parseAction(raw: Record<string, unknown>): ClientMessage | ClientMessageError {
  const action = raw.action;
  if (!isPlainObject(action) || typeof action.type !== 'string' || !Object.hasOwn(ACTION_BUILDERS, action.type)) {
    return refuse('PROTOCOL', 'Malformed action');
  }
  const player = seat(action.player);
  if (player === null) return refuse('PROTOCOL', 'Malformed action');
  const built = ACTION_BUILDERS[action.type as ActionType](action, player);
  if (!built || JSON.stringify(built).length > MAX_ACTION_BYTES) return refuse('PROTOCOL', 'Malformed action');
  return { t: 'action', action: built };
}
