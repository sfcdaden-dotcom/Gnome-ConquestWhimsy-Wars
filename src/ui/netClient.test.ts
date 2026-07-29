/** The plain-data half of the WebSocket client (netClient.ts). */

import { describe, expect, it } from 'vitest';
import {
  encodeClientMessage,
  NAME_KEY,
  parseServerMessage,
  reconnectDelayMs,
  roomSocketUrl,
  tokenStore,
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

describe('tokenStore', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    };
  }

  it('keys tokens per room — one seat per room, not one seat everywhere', () => {
    const s = memoryStorage();
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
