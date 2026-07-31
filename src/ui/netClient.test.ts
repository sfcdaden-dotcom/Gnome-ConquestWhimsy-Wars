/** The plain-data half of the WebSocket client (netClient.ts). */

import { describe, expect, it } from 'vitest';
import {
  CLAIM_STALE_MS,
  encodeClientMessage,
  NAME_KEY,
  parseServerMessage,
  reconnectDelayMs,
  roomCodeFromSearch,
  roomHref,
  roomSocketUrl,
  tabId,
  tokenStore,
  type SeatStores,
} from './netClient';

describe('roomSocketUrl', () => {
  it('matches the page scheme: wss under https, ws otherwise', () => {
    expect(roomSocketUrl('ABC234', { protocol: 'https:', host: 'game.example' })).toBe(
      'wss://game.example/api/rooms/ABC234/ws',
    );
    expect(roomSocketUrl('ABC234', { protocol: 'http:', host: 'localhost:8787' })).toBe(
      'ws://localhost:8787/api/rooms/ABC234/ws',
    );
  });

  it('escapes anything odd in a pasted code rather than trusting it', () => {
    expect(roomSocketUrl('a/b?c', { protocol: 'http:', host: 'x' })).toBe(
      'ws://x/api/rooms/a%2Fb%3Fc/ws',
    );
  });
});

describe('the room in the page URL', () => {
  it('reads a room code out of the query string, whatever case it arrives in', () => {
    expect(roomCodeFromSearch('?room=ABC234')).toBe('ABC234');
    expect(roomCodeFromSearch('?room=abc234')).toBe('ABC234');
    expect(roomCodeFromSearch('?x=1&room=ABC234&y=2')).toBe('ABC234');
  });

  it('refuses anything that is not a room code, rather than dialling it', () => {
    expect(roomCodeFromSearch('')).toBeNull();
    expect(roomCodeFromSearch('?room=')).toBeNull();
    expect(roomCodeFromSearch('?room=SHORT')).toBeNull();
    expect(roomCodeFromSearch('?room=WAYTOOLONG')).toBeNull();
    expect(roomCodeFromSearch('?room=../../etc')).toBeNull();
  });

  it('round-trips: the href it builds is one a fresh page can read back', () => {
    const loc = { origin: 'https://game.example', pathname: '/', search: '' };
    const href = roomHref(loc, 'ABC234');
    expect(href).toBe('https://game.example/?room=ABC234');
    expect(roomCodeFromSearch(new URL(href).search)).toBe('ABC234');
  });

  it('rewrites just the room, leaving the rest of the URL alone', () => {
    const loc = { origin: 'https://game.example', pathname: '/play/', search: '?debug=1&room=OLDCDE' };
    expect(roomHref(loc, 'ABC234')).toBe('https://game.example/play/?debug=1&room=ABC234');
    expect(roomHref(loc, null)).toBe('https://game.example/play/?debug=1');
  });

  it('leaves a clean URL behind when you leave the room', () => {
    expect(roomHref({ origin: 'https://g.example', pathname: '/', search: '?room=ABC234' }, null)).toBe(
      'https://g.example/',
    );
  });
});

describe('tokenStore', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
    data: Map<string, string>;
  } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  }

  /**
   * One browser. `tab()` opens a new tab in it (fresh sessionStorage, shared
   * localStorage); `reload` keeps the same tab's session, which is exactly the
   * distinction the store exists to make.
   */
  function browser(startMs = 1_000) {
    const local = memoryStorage();
    let clock = startMs;
    let nextTab = 1;
    return {
      tick: (ms: number) => void (clock += ms),
      tab(): SeatStores & { reload: () => SeatStores } {
        const session = memoryStorage();
        const id = `tab-${nextTab++}`;
        const make = (s: typeof session): SeatStores & { reload: () => SeatStores } => ({
          session: s,
          local,
          now: () => clock,
          tabId: id,
          // A reload is the same tab: same sessionStorage, same id.
          reload: () => make(s),
        });
        return make(session);
      },
    };
  }

  it('keys tokens per room — one seat per room, not one seat everywhere', () => {
    const s = browser().tab();
    tokenStore.save(s, 'AAAAAA', 't1');
    tokenStore.save(s, 'BBBBBB', 't2');
    expect(tokenStore.load(s, 'AAAAAA')).toBe('t1');
    expect(tokenStore.load(s, 'BBBBBB')).toBe('t2');
    expect(tokenStore.load(s, 'CCCCCC')).toBeUndefined();
  });

  it('uses a namespaced key that cannot collide with the name key', () => {
    expect(tokenStore.key('ABC234')).not.toBe(NAME_KEY);
    expect(tokenStore.key('ABC234')).toContain('ABC234');
  });

  it('keeps the seat across a reload of the same tab', () => {
    const b = browser();
    const tab = b.tab();
    tokenStore.save(tab, 'ABC234', 'seat-token');

    b.tick(500);
    expect(tokenStore.load(tab.reload(), 'ABC234')).toBe('seat-token');
  });

  // The bug that made a room untestable alone: the second tab presented the
  // first tab's token, the room evicted the first, and the table still had
  // exactly one player in it.
  it('does not hand a live tab’s seat to a second tab', () => {
    const b = browser();
    const first = b.tab();
    tokenStore.save(first, 'ABC234', 'seat-token');

    const second = b.tab();
    expect(tokenStore.load(second, 'ABC234')).toBeUndefined();
    // ...and the first tab still has its seat.
    expect(tokenStore.load(first, 'ABC234')).toBe('seat-token');
  });

  it('lets a reopened tab reclaim a seat nobody is holding any more', () => {
    const b = browser();
    tokenStore.save(b.tab(), 'ABC234', 'seat-token');

    b.tick(CLAIM_STALE_MS + 1); // the holder stopped beating: it is gone
    expect(tokenStore.load(b.tab(), 'ABC234')).toBe('seat-token');
  });

  it('keeps the claim alive while the tab beats, however long it sits there', () => {
    const b = browser();
    const held = b.tab();
    tokenStore.save(held, 'ABC234', 'seat-token');

    for (let i = 0; i < 10; i++) {
      b.tick(CLAIM_STALE_MS - 1);
      tokenStore.heartbeat(held, 'ABC234');
    }
    expect(tokenStore.load(b.tab(), 'ABC234')).toBeUndefined();
  });

  it('gives up the seat on `forget`, so the next dial is a new player', () => {
    const b = browser();
    const tab = b.tab();
    tokenStore.save(tab, 'ABC234', 'seat-token');

    tokenStore.forget(tab, 'ABC234');
    expect(tokenStore.load(tab, 'ABC234')).toBeUndefined();
    expect(tokenStore.load(b.tab(), 'ABC234')).toBeUndefined();
  });

  it('survives a corrupt claim rather than throwing on load', () => {
    const b = browser();
    const tab = b.tab();
    tab.local.setItem(tokenStore.claimKey('ABC234'), 'not json');
    expect(tokenStore.load(tab, 'ABC234')).toBeUndefined();
  });
});

describe('tabId', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
    const data = new Map<string, string>();
    return {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  }

  it('is minted once and then stable — a reload must not become a new tab', () => {
    const session = memoryStorage();
    let n = 0;
    const random = () => `id-${++n}`;
    expect(tabId(session, random)).toBe('id-1');
    expect(tabId(session, random)).toBe('id-1');
  });
});

describe('reconnectDelayMs', () => {
  it('starts fast and caps out instead of growing forever', () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(10)).toBe(10_000);
    expect(reconnectDelayMs(30)).toBe(10_000);
  });
});

describe('framing', () => {
  it('round-trips a client message', () => {
    const msg = { t: 'action', action: { type: 'endTurn', player: 0 } } as const;
    expect(JSON.parse(encodeClientMessage(msg))).toEqual(msg);
  });

  it('parses a server frame and refuses garbage without throwing', () => {
    expect(parseServerMessage(JSON.stringify({ t: 'pong' }))).toEqual({ t: 'pong' });
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(JSON.stringify('a string'))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ no: 't' }))).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
  });
});
