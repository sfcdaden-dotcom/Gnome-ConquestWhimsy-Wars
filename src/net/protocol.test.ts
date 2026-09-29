/**
 * The boundary: what `parseClientMessage` lets through to the room, and what
 * it builds. The room trusts the SHAPE of what it is handed from here on, so
 * every field a client controls is pinned below.
 */

import { describe, expect, it } from 'vitest';
import { defaultLook } from '../ui/gnomeArt';
import type { ClientMessage, ClientMessageError } from './protocol';
import { AI_DIFFICULTIES, MAX_ACTION_BYTES, PROTOCOL_VERSION, parseClientMessage } from './protocol';

const TOKEN = 'a'.repeat(32);

function ok(raw: unknown): ClientMessage {
  const out = parseClientMessage(raw);
  if ('error' in out) throw new Error(`expected a message, got ${out.error}: ${out.message}`);
  return out;
}

function refused(raw: unknown): ClientMessageError {
  const out = parseClientMessage(raw);
  if (!('error' in out)) throw new Error(`expected a refusal, got ${JSON.stringify(out)}`);
  return out;
}

describe('parseClientMessage', () => {
  it('refuses what is not a message at all', () => {
    for (const raw of [undefined, null, 'hello', 42, [], [{ t: 'ping' }], {}, { t: 'nope' }, { t: 7 }]) {
      expect(refused(raw).error, JSON.stringify(raw)).toBe('PROTOCOL');
    }
  });

  it('never throws, whatever it is handed', () => {
    const nasty = [
      { t: 'hello', protocol: PROTOCOL_VERSION, name: { toString: 1 } },
      { t: 'configure', seats: [null, 3, 'x'] },
      { t: 'action', action: { type: 'endTurn', player: 0, targets: { get: 1 } } },
      Object.create(null),
    ];
    for (const raw of nasty) expect(() => parseClientMessage(raw)).not.toThrow();
  });

  describe('hello', () => {
    const HELLO = { t: 'hello', protocol: PROTOCOL_VERSION };

    it('passes a well-formed hello through, field for field', () => {
      const look = defaultLook();
      expect(ok({ ...HELLO, token: TOKEN, hostKey: TOKEN, name: 'Ada', look, spectate: true })).toEqual({
        ...HELLO,
        token: TOKEN,
        hostKey: TOKEN,
        name: 'Ada',
        look,
        spectate: true,
      });
    });

    it('refuses a hello without an integer protocol', () => {
      expect(refused({ t: 'hello' }).error).toBe('PROTOCOL');
      expect(refused({ t: 'hello', protocol: '3' }).error).toBe('PROTOCOL');
      expect(refused({ t: 'hello', protocol: 2.5 }).error).toBe('PROTOCOL');
    });

    it('refuses the non-string name that used to crash the room', () => {
      expect(refused({ ...HELLO, name: 123 }).error).toBe('PROTOCOL');
      expect(refused({ ...HELLO, name: ['Ada'] }).error).toBe('PROTOCOL');
    });

    it('refuses an absurdly long raw name, but leaves trimming a normal one to the room', () => {
      expect(refused({ ...HELLO, name: 'x'.repeat(257) }).error).toBe('PROTOCOL');
      expect((ok({ ...HELLO, name: 'x'.repeat(100) }) as { name?: string }).name).toHaveLength(100);
    });

    it('refuses credentials and flags of the wrong type', () => {
      expect(refused({ ...HELLO, token: 5 }).error).toBe('PROTOCOL');
      expect(refused({ ...HELLO, hostKey: {} }).error).toBe('PROTOCOL');
      expect(refused({ ...HELLO, spectate: 'yes' }).error).toBe('PROTOCOL');
    });

    it('drops a string credential that cannot be one the room issued', () => {
      // Same meaning as an unknown token: a fresh seat, no host claim.
      expect(ok({ ...HELLO, token: 'not-a-token', hostKey: 'A'.repeat(32) })).toEqual(HELLO);
    });

    it('drops a malformed look rather than refusing the player', () => {
      expect(ok({ ...HELLO, look: { ...defaultLook(), torso: 'x'.repeat(200_000) } })).toEqual(HELLO);
      expect(ok({ ...HELLO, look: { ...defaultLook(), extra: true } })).toEqual(HELLO);
      expect(ok({ ...HELLO, look: 'wizard' })).toEqual(HELLO);
    });

    it('never copies a field the room did not ask for', () => {
      expect(ok({ ...HELLO, junk: 'x'.repeat(10_000), __proto__: { admin: true } })).toEqual(HELLO);
    });
  });

  describe('configure', () => {
    it('passes a well-formed configure through', () => {
      const look = defaultLook();
      const msg = {
        t: 'configure',
        playerCount: 4,
        boardSize: 9,
        gardenPreset: 'random',
        seats: [{ index: 1, controller: 'cpu', difficulty: 'hard', name: 'Bot', look }],
      };
      expect(ok(msg)).toEqual(msg);
    });

    it('accepts every CPU difficulty the engine has, the Fly included', () => {
      // The list was once written by hand without 'fly', and every online
      // lobby that picked the Fly seat was refused. AI_DIFFICULTIES is now tied
      // to the engine's AiDifficulty type at compile time.
      expect(AI_DIFFICULTIES).toContain('fly');
      for (const difficulty of AI_DIFFICULTIES) {
        const msg = { t: 'configure', seats: [{ index: 1, controller: 'cpu', difficulty }] };
        expect(ok(msg), difficulty).toEqual(msg);
      }
    });

    it('refuses values that do not exist', () => {
      const cases: unknown[] = [
        { t: 'configure', playerCount: 3 },
        { t: 'configure', boardSize: 7.5 },
        { t: 'configure', boardSize: '7' },
        { t: 'configure', gardenPreset: 42 },
        { t: 'configure', gardenPreset: '' },
        { t: 'configure', gardenPreset: 'x'.repeat(65) },
        { t: 'configure', seats: 'all' },
        { t: 'configure', seats: [{}, {}, {}, {}, {}] },
        { t: 'configure', seats: [{ index: 4 }] },
        { t: 'configure', seats: [{ index: -1 }] },
        { t: 'configure', seats: [{ index: 0, controller: 'robot' }] },
        { t: 'configure', seats: [{ index: 0, difficulty: 'impossible' }] },
        { t: 'configure', seats: [{ index: 0, name: 7 }] },
        { t: 'configure', seats: [{ index: 0, look: { cap: 'x' } }] },
      ];
      for (const raw of cases) expect(refused(raw).error, JSON.stringify(raw)).toBe('BAD_CONFIG');
    });

    it('never copies a field the room did not ask for', () => {
      expect(ok({ t: 'configure', seats: [{ index: 0, token: TOKEN, extra: 1 }], hostToken: TOKEN })).toEqual({
        t: 'configure',
        seats: [{ index: 0 }],
      });
    });
  });

  describe('action', () => {
    it('passes a real action through unchanged', () => {
      const action = { type: 'move', player: 0, unitId: 'u1', to: { x: 1, y: 2 } };
      expect(ok({ t: 'action', action })).toEqual({ t: 'action', action });
    });

    it('refuses an action with no type or no integer player', () => {
      for (const action of [undefined, null, 'endTurn', { player: 0 }, { type: 'endTurn' }, { type: 'endTurn', player: '0' }]) {
        expect(refused({ t: 'action', action }).error, JSON.stringify(action)).toBe('PROTOCOL');
      }
    });

    it('drops top-level fields no action has, so they never reach the record', () => {
      const out = ok({ t: 'action', action: { type: 'endTurn', player: 0, junk: 'x'.repeat(10_000) } });
      expect(out).toEqual({ t: 'action', action: { type: 'endTurn', player: 0 } });
    });

    it('refuses an action too large to be a real one', () => {
      const targets = { units: Array.from({ length: MAX_ACTION_BYTES }, (_, i) => `u${i}`) };
      expect(refused({ t: 'action', action: { type: 'playCard', player: 0, cardId: 'c', targets } }).error).toBe(
        'PROTOCOL',
      );
    });
  });

  it('builds the field-less messages fresh', () => {
    expect(ok({ t: 'start', extra: 1 })).toEqual({ t: 'start' });
    expect(ok({ t: 'ping', extra: 1 })).toEqual({ t: 'ping' });
    expect(ok({ t: 'takeOverRoom', extra: 1 })).toEqual({ t: 'takeOverRoom' });
  });
});
