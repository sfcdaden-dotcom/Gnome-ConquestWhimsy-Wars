/**
 * The plain-data half of the WebSocket client: URL building, the room address
 * in the page URL, seat-token storage, and backoff. Kept out of the hook so it
 * is testable without React or a browser (see netClient.test.ts) and so
 * `useNetGame` stays readable.
 */

import type { ClientMessage, ServerMessage } from '../net/protocol';
import { ROOM_CODE_LENGTH } from '../net/protocol';

/** Same-origin WebSocket URL for a room. `loc` is injectable for tests. */
export function roomSocketUrl(code: string, loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/api/rooms/${encodeURIComponent(code)}/ws`;
}

// ---------------------------------------------------------------------------
// The room lives in the page URL
// ---------------------------------------------------------------------------

/**
 * The room code is carried in the query string, so a refresh, a bookmark or a
 * pasted link all land in the same room.
 *
 * Before this, the code lived only in React state: reloading the page — the
 * obvious thing to do when you are waiting to see whether a friend has arrived
 * — dropped you back on the home screen with no way back in except retyping a
 * six-character code you may no longer have. The seat token survived; the
 * address of the table did not.
 *
 * A query parameter rather than a path segment because the bundle is built
 * with a relative `base` (see vite.config.ts): served from `/room/ABC234`, its
 * own `./assets/...` links would resolve one directory too deep and the page
 * would come up blank.
 */
export const ROOM_PARAM = 'room';

/** The room code in a query string, or null when there isn't a usable one. */
export function roomCodeFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get(ROOM_PARAM);
  if (raw === null) return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === ROOM_CODE_LENGTH ? code : null;
}

/**
 * The same page, addressed at `code` (or with the room stripped off, for
 * `null`). Everything else in the URL is preserved — this rewrites one
 * parameter, it does not invent a new address.
 */
export function roomHref(
  loc: { origin: string; pathname: string; search: string },
  code: string | null,
): string {
  const params = new URLSearchParams(loc.search);
  if (code === null) params.delete(ROOM_PARAM);
  else params.set(ROOM_PARAM, code);
  const query = params.toString();
  return `${loc.origin}${loc.pathname}${query ? `?${query}` : ''}`;
}

// ---------------------------------------------------------------------------
// Seat tokens
// ---------------------------------------------------------------------------

/**
 * Seat tokens, one per room — and, deliberately, one per TAB.
 *
 * The token IS the seat (see MULTIPLAYER.md), and the room enforces one live
 * connection per token: a second socket presenting the same token takes the
 * seat over and the first is closed with 4000. Keeping tokens in
 * `localStorage` therefore made two tabs of one browser fight over a single
 * seat — the second tab evicted the first, the room still saw one player, and
 * the host's start button stayed greyed out forever. Two tabs are two people
 * at the table; that is how anyone tests a room alone, and how a household
 * shares a laptop.
 *
 * So the live token lives in `sessionStorage`, which is per tab and survives a
 * reload — exactly the lifetime of "this seat". `localStorage` keeps a *claim*
 * alongside it: the token, the tab holding it, and a heartbeat. A tab that
 * finds no token of its own adopts the claim only once the heartbeat has gone
 * stale, i.e. only once the tab that held the seat is gone. So closing a tab
 * and coming back gets your seat; opening a second one alongside gets a new
 * player.
 */
export const CLAIM_STALE_MS = 10_000;
/** How often a live tab refreshes its claim. Comfortably inside the stale window. */
export const CLAIM_HEARTBEAT_MS = 3_000;

type Slot = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface SeatStores {
  /** Per tab, survives a reload: where this tab's live token lives. */
  session: Slot;
  /** Shared across tabs: which tab is holding the seat, and when it last said so. */
  local: Slot;
  now: () => number;
  /** Identifies this tab within `local`. */
  tabId: string;
}

interface SeatClaim {
  token: string;
  tab: string;
  seen: number;
}

function readClaim(local: Slot, key: string): SeatClaim | null {
  const raw = local.getItem(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { token, tab, seen } = parsed as Partial<SeatClaim>;
    if (typeof token !== 'string' || typeof tab !== 'string' || typeof seen !== 'number') return null;
    return { token, tab, seen };
  } catch {
    return null;
  }
}

export const tokenStore = {
  key(code: string): string {
    return `ww:room:${code}:token`;
  },
  claimKey(code: string): string {
    return `ww:room:${code}:claim`;
  },

  /**
   * The token to present for `code`, or undefined to ask the room for a fresh
   * seat. Adopting a stale claim is what makes a closed-and-reopened tab land
   * back in its seat; refusing a live one is what stops a second tab stealing
   * it.
   */
  load(s: SeatStores, code: string): string | undefined {
    const mine = s.session.getItem(this.key(code));
    if (mine) {
      this.hold(s, code, mine);
      return mine;
    }
    const claim = readClaim(s.local, this.claimKey(code));
    if (!claim) return undefined;
    if (claim.tab !== s.tabId && s.now() - claim.seen <= CLAIM_STALE_MS) return undefined;
    s.session.setItem(this.key(code), claim.token);
    this.hold(s, code, claim.token);
    return claim.token;
  },

  save(s: SeatStores, code: string, token: string): void {
    s.session.setItem(this.key(code), token);
    this.hold(s, code, token);
  },

  /** Re-stamp this tab's claim, so other tabs can see the seat is in use. */
  hold(s: SeatStores, code: string, token: string): void {
    s.local.setItem(this.claimKey(code), JSON.stringify({ token, tab: s.tabId, seen: s.now() }));
  },

  /** Re-stamp whatever this tab holds. The heartbeat, called on a timer. */
  heartbeat(s: SeatStores, code: string): void {
    const token = s.session.getItem(this.key(code));
    if (token) this.hold(s, code, token);
  },

  /** Give up this tab's seat, to come back as somebody new. */
  forget(s: SeatStores, code: string): void {
    s.session.removeItem(this.key(code));
    const claim = readClaim(s.local, this.claimKey(code));
    if (claim && claim.tab === s.tabId) s.local.removeItem(this.claimKey(code));
  },
};

/**
 * The host credential for a room this browser opened.
 *
 * Unlike the seat token this lives in `localStorage`, not `sessionStorage`,
 * and deliberately: the seat token is "this tab is sitting here", but the host
 * key is "I opened this room", which should survive closing the tab. It only
 * ever binds a room that has no host yet, so a second tab presenting it while
 * the first tab is hosting changes nothing.
 */
export const hostKeyStore = {
  key(code: string): string {
    return `ww:room:${code}:hostkey`;
  },
  load(local: Slot, code: string): string | undefined {
    return local.getItem(this.key(code)) ?? undefined;
  },
  save(local: Slot, code: string, hostKey: string): void {
    local.setItem(this.key(code), hostKey);
  },
  forget(local: Slot, code: string): void {
    local.removeItem(this.key(code));
  },
};

const TAB_KEY = 'ww:tab';

/** This tab's id, minted once and remembered for as long as the tab lives. */
export function tabId(session: Slot, random: () => string): string {
  const existing = session.getItem(TAB_KEY);
  if (existing) return existing;
  const id = random();
  session.setItem(TAB_KEY, id);
  return id;
}

/** The real browser's stores. Built once per page, not per render. */
export function browserSeatStores(): SeatStores {
  return {
    session: sessionStorage,
    local: localStorage,
    now: () => Date.now(),
    tabId: tabId(sessionStorage, () => crypto.randomUUID()),
  };
}

/** The player's display name, shared across rooms and tabs. */
export const NAME_KEY = 'ww:name';

/**
 * Reconnect backoff: quick first retry (most drops are a blip), then doubling
 * to a ceiling — a room that is genuinely gone should not be hammered.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000);
}

/** Parse one server frame; null for anything unreadable (never throws). */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const raw: unknown = JSON.parse(data);
    if (typeof raw !== 'object' || raw === null) return null;
    if (typeof (raw as { t?: unknown }).t !== 'string') return null;
    return raw as ServerMessage;
  } catch {
    return null;
  }
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}
