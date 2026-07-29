/**
 * The plain-data half of the WebSocket client: URL building, reconnect-token
 * storage, and backoff. Kept out of the hook so it is testable without React
 * or a browser (see netClient.test.ts) and so `useNetGame` stays readable.
 */

import type { ClientMessage, ServerMessage } from '../net/protocol';

/** Same-origin WebSocket URL for a room. `loc` is injectable for tests. */
export function roomSocketUrl(code: string, loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/api/rooms/${encodeURIComponent(code)}/ws`;
}

/**
 * Reconnect tokens, one per room. The token IS the seat (see MULTIPLAYER.md),
 * so it is stored per room code — reusing one across rooms would be
 * meaningless — and kept in localStorage so a refresh does not cost the seat.
 */
export const tokenStore = {
  key(code: string): string {
    return `ww:room:${code}:token`;
  },
  load(storage: Pick<Storage, 'getItem'>, code: string): string | undefined {
    return storage.getItem(this.key(code)) ?? undefined;
  },
  save(storage: Pick<Storage, 'setItem'>, code: string, token: string): void {
    storage.setItem(this.key(code), token);
  },
};

/** The player's display name, shared across rooms. */
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
