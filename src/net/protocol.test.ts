/**
 * The boundary: what `parseClientMessage` lets through to the room, and what
 * it builds. The room trusts the SHAPE of what it is handed from here on, so
 * every field a client controls is pinned below.
 */

import { describe, expect, it } from 'vitest';
import type { Action } from '../engine';
import { applyAction, createGame, getLegalActions, isGameOver } from '../engine';
import { defaultLook } from '../ui/gnomeArt';
import type { ClientMessage, ClientMessageError } from './protocol';
import {
  AI_DIFFICULTIES,
  MAX_ACTION_BYTES,
  MAX_BOARD_SIZE,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseClientFrame,
  parseClientMessage,
} from './protocol';

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

    it('passes every action the engine offers through unchanged', () => {
      const seen = new Set<string>();
      for (const playerCount of [2, 4] as const) {
        const players = Array.from({ length: playerCount }, (_, i) => ({ name: `P${i}`, controller: 'cpu' as const }));
        let state = createGame({ players }, 11);
        // A seeded random walk: any legal move will do, and the AI would be far
        // slower for no more coverage. Ending the turn is put off, or the walk
        // never gets past drawing a card.
        let r = 11;
        for (let i = 0; i < 400 && !isGameOver(state); i++) {
          const legal = getLegalActions(state);
          for (const action of legal) {
            seen.add(action.type);
            expect(ok({ t: 'action', action }), JSON.stringify(action)).toEqual({ t: 'action', action });
          }
          r = (Math.imul(r, 1103515245) + 12345) >>> 0;
          const moves = legal.filter((a) => a.type !== 'endTurn');
          const pool = moves.length > 0 && r % 6 !== 0 ? moves : legal;
          state = applyAction(state, pool[(r >>> 8) % pool.length]);
        }
      }
      // Enough of the catalogue that a builder dropping a real field would show.
      expect(seen.size).toBeGreaterThanOrEqual(12);
    });

    it('passes the shapes self-play rarely reaches through unchanged', () => {
      const actions: Action[] = [
        { type: 'playCard', player: 0, cardId: 'c', targets: { units: ['u1'], spaces: [{ x: 0, y: 1 }], players: [2], cards: ['d'], gardenType: 'maize' } },
        { type: 'respondPlayCard', player: 1, cardId: 'c', targets: {} },
        { type: 'selectTarget', player: 0, target: { kind: 'unit', unitId: 'u3' } },
        { type: 'selectTarget', player: 0, target: { kind: 'space', pos: { x: 12, y: 12 } } },
        { type: 'selectTarget', player: 0, target: { kind: 'player', playerId: 3 } },
        { type: 'selectTarget', player: 0, target: { kind: 'card', cardId: 'c' } },
        { type: 'selectTarget', player: 0, target: { kind: 'gardenType', gardenType: 'tunnel' } },
        { type: 'cancelTargeting', player: 0 },
        { type: 'homeHarvest', player: 0, take: 'gnome' },
        { type: 'discardCard', player: 0, cardId: 'c' },
        { type: 'sacrificeGnome', player: 0, unitId: 'u2' },
        { type: 'snailify', player: 0, accept: false },
        { type: 'snailMove', player: 0, to: { x: 0, y: 0 } },
        { type: 'snailEat', player: 0, accept: true },
        { type: 'quickChat', player: 0, phraseId: 'hello' },
        { type: 'quickChat', player: 0, phraseId: 'hello', target: { kind: 'player', player: 1 } },
        { type: 'quickChat', player: 0, phraseId: 'hello', target: { kind: 'space', pos: { x: 3, y: 4 } } },
      ];
      for (const action of actions) expect(ok({ t: 'action', action }), JSON.stringify(action)).toEqual({ t: 'action', action });
    });

    it('rebuilds a quick-chat target, so no text can ride beside its coordinate', () => {
      const out = ok({
        t: 'action',
        action: {
          type: 'quickChat',
          player: 0,
          phraseId: 'hello',
          target: { kind: 'space', pos: { x: 1, y: 2, note: 'free text' }, note: 'free text' },
          pos: { x: 1, y: 2 },
          cardId: 'smuggled',
        },
      });
      expect(out).toEqual({
        t: 'action',
        action: { type: 'quickChat', player: 0, phraseId: 'hello', target: { kind: 'space', pos: { x: 1, y: 2 } } },
      });
      expect(JSON.stringify(out)).not.toContain('free text');
    });

    it("keeps only the fields the action's own type carries", () => {
      expect(ok({ t: 'action', action: { type: 'endTurn', player: 0, to: { x: 1, y: 1 }, cardId: 'c' } })).toEqual({
        t: 'action',
        action: { type: 'endTurn', player: 0 },
      });
      expect(
        ok({
          t: 'action',
          action: { type: 'playCard', player: 0, cardId: 'c', targets: { units: ['u1'], extra: 'x' }, unitId: 'u9' },
        }),
      ).toEqual({ t: 'action', action: { type: 'playCard', player: 0, cardId: 'c', targets: { units: ['u1'] } } });
      expect(
        ok({ t: 'action', action: { type: 'selectTarget', player: 0, target: { kind: 'unit', unitId: 'u1', pos: { x: 0, y: 0 } } } }),
      ).toEqual({ t: 'action', action: { type: 'selectTarget', player: 0, target: { kind: 'unit', unitId: 'u1' } } });
    });

    it('refuses an action whose own fields are malformed', () => {
      const actions = [
        { type: 'launchRocket', player: 0 },
        { type: 'toString', player: 0 },
        { type: 'endTurn', player: 4 },
        { type: 'move', player: 0, unitId: 'u1' },
        { type: 'move', player: 0, unitId: 7, to: { x: 1, y: 1 } },
        { type: 'move', player: 0, unitId: 'u1', to: { x: 1.5, y: 1 } },
        { type: 'move', player: 0, unitId: 'u1', to: { x: -1, y: 1 } },
        { type: 'move', player: 0, unitId: 'u1', to: { x: MAX_BOARD_SIZE, y: 1 } },
        { type: 'move', player: 0, unitId: 'x'.repeat(65), to: { x: 1, y: 1 } },
        { type: 'plant', player: 0, pos: { x: 1, y: 1 }, gardenType: 'home' },
        { type: 'homeHarvest', player: 0, take: 'both' },
        { type: 'snailEat', player: 0, accept: 'yes' },
        { type: 'playCard', player: 0, cardId: 'c', targets: null },
        { type: 'playCard', player: 0, cardId: 'c', targets: { units: 'u1' } },
        { type: 'playCard', player: 0, cardId: 'c', targets: { spaces: [{ x: 1 }] } },
        { type: 'selectTarget', player: 0, target: { kind: 'unit' } },
        { type: 'selectTarget', player: 0, target: { kind: 'wish', amount: 3 } },
        { type: 'quickChat', player: 0, phraseId: 'hello', target: { kind: 'text', text: 'free text' } },
        { type: 'quickChat', player: 0, phraseId: 'hello', target: { kind: 'space' } },
        { type: 'quickChat', player: 0 },
      ];
      for (const action of actions) expect(refused({ t: 'action', action }).error, JSON.stringify(action)).toBe('PROTOCOL');
    });

    it('refuses an action too large to be a real one', () => {
      const targets = { units: Array.from({ length: MAX_ACTION_BYTES }, (_, i) => `u${i}`) };
      expect(refused({ t: 'action', action: { type: 'playCard', player: 0, cardId: 'c', targets } }).error).toBe(
        'PROTOCOL',
      );
    });
  });

  it('refuses a board no client should be asked to draw', () => {
    for (const boardSize of [3, MAX_BOARD_SIZE + 2, 10_001]) {
      expect(refused({ t: 'configure', boardSize }).error, String(boardSize)).toBe('BAD_CONFIG');
    }
    expect(ok({ t: 'configure', boardSize: MAX_BOARD_SIZE })).toEqual({ t: 'configure', boardSize: MAX_BOARD_SIZE });
  });

  it('builds the field-less messages fresh', () => {
    expect(ok({ t: 'start', extra: 1 })).toEqual({ t: 'start' });
    expect(ok({ t: 'ping', extra: 1 })).toEqual({ t: 'ping' });
    expect(ok({ t: 'takeOverRoom', extra: 1 })).toEqual({ t: 'takeOverRoom' });
  });
});

describe('parseClientFrame', () => {
  it('parses a text or binary frame like the message inside it', () => {
    const text = JSON.stringify({ t: 'ping' });
    expect(parseClientFrame(text)).toEqual({ t: 'ping' });
    expect(parseClientFrame(new TextEncoder().encode(text).buffer)).toEqual({ t: 'ping' });
    expect(parseClientFrame('{not json')).toMatchObject({ error: 'PROTOCOL' });
  });

  it('refuses an oversized frame without parsing it', () => {
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      parses++;
      return parse(...args);
    };
    try {
      const huge = JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_FRAME_BYTES) });
      expect(parseClientFrame(huge)).toEqual({ error: 'PROTOCOL', message: 'Message too large' });
      expect(parseClientFrame(new TextEncoder().encode(huge).buffer)).toEqual({ error: 'PROTOCOL', message: 'Message too large' });
      expect(parses).toBe(0);
    } finally {
      JSON.parse = parse;
    }
  });

  it('has room for the largest honest message', () => {
    // Four seats, every name at the cap and every character one JSON escapes.
    const name = '\u0001'.repeat(256);
    const seats = [0, 1, 2, 3].map((index) => ({ index, controller: 'cpu', difficulty: 'normal', name, look: defaultLook() }));
    const frame = JSON.stringify({ t: 'configure', playerCount: 4, boardSize: 13, gardenPreset: 'x'.repeat(64), seats });
    expect(frame.length).toBeLessThan(MAX_FRAME_BYTES);
    expect('error' in parseClientFrame(frame)).toBe(false);
  });
});
