/**
 * Canonical action identity.
 *
 * The property under test is the one the module exists for: an action's key
 * depends on its CONTENT and nothing else — not on where it sat in an
 * enumeration, not on the order its object fields were written in, not on a
 * JSON round-trip. Everything else here (injectivity, uniqueness across a real
 * enumeration, intent collapsing) follows from that.
 */

import { describe, expect, it } from 'vitest';
import type { Action, GameState } from './index';
import {
  actionKey,
  applyAction,
  byActionKey,
  canonicalTargets,
  chooseAiAction,
  createGame,
  enumerateCompleteCardActions,
  getLegalActionIntents,
  intentKey,
  isGameOver,
  sameAction,
  targetKey,
  targetsKey,
} from './index';
import { CARD_DEFINITIONS } from './cards';
import { mutate, toActionPhase, withGnome, withHand } from './testkit';

const TARGETED = CARD_DEFINITIONS.filter((c) => c.needsTargets).map((c) => c.id);

/** A state with both seats holding every targeted card and gnomes to aim at. */
function richState(seed = 7): { s: GameState; me: number } {
  let s = toActionPhase(seed);
  const me = s.turn!.activePlayer;
  s = withGnome(s, me, { x: 2, y: 3 }).state;
  s = withGnome(s, me === 0 ? 1 : 0, { x: 4, y: 3 }).state;
  s = withHand(s, me, ...TARGETED);
  s = mutate(s, (d) => {
    d.discard.push('four-leaf-clover');
  });
  return { s, me };
}

describe('actionKey is content-addressed', () => {
  it('ignores object key order', () => {
    const a: Action = { type: 'move', player: 0, unitId: 'u1', to: { x: 1, y: 2 } };
    const b = { to: { x: 1, y: 2 }, unitId: 'u1', player: 0, type: 'move' } as Action;
    expect(actionKey(a)).toBe(actionKey(b));
    expect(sameAction(a, b)).toBe(true);
  });

  it('survives a JSON round-trip', () => {
    const a: Action = {
      type: 'playCard',
      player: 1,
      cardId: 'plot-twist',
      targets: { spaces: [{ x: 1, y: 1 }, { x: 1, y: 2 }] },
    };
    expect(actionKey(JSON.parse(JSON.stringify(a)))).toBe(actionKey(a));
  });

  it('ignores position in the enumerated array', () => {
    const { s, me } = richState();
    const actions = getLegalActionIntents(s, me);
    const keys = actions.map(actionKey);
    const shuffledKeys = [...actions].reverse().map(actionKey);
    expect(new Set(shuffledKeys)).toEqual(new Set(keys));
    // And the key of each individual action is unchanged by the reordering.
    for (const a of actions) expect(actionKey(a)).toBe(keys[actions.indexOf(a)]);
  });

  it('distinguishes every field that distinguishes a play', () => {
    const variants: Action[] = [
      { type: 'move', player: 0, unitId: 'u1', to: { x: 1, y: 2 } },
      { type: 'move', player: 1, unitId: 'u1', to: { x: 1, y: 2 } }, // player
      { type: 'move', player: 0, unitId: 'u2', to: { x: 1, y: 2 } }, // unit
      { type: 'move', player: 0, unitId: 'u1', to: { x: 2, y: 1 } }, // destination
      { type: 'plant', player: 0, pos: { x: 1, y: 2 }, gardenType: 'maize' },
      { type: 'plant', player: 0, pos: { x: 1, y: 2 }, gardenType: 'tunnel' }, // garden type
      { type: 'upgrade', player: 0, pos: { x: 1, y: 2 } },
      { type: 'endTurn', player: 0 },
      { type: 'drawCard', player: 0 },
      { type: 'snailify', player: 0, accept: true },
      { type: 'snailify', player: 0, accept: false }, // accept flag
      { type: 'mushroomClones', player: 0, count: 1 },
      { type: 'mushroomClones', player: 0, count: 2 }, // count
      { type: 'homeHarvest', player: 0, take: 'wish' },
      { type: 'homeHarvest', player: 0, take: 'gnome' },
    ];
    expect(new Set(variants.map(actionKey)).size).toBe(variants.length);
  });

  it('does not confuse `(1,23)` with `(12,3)`', () => {
    // Position encoding must stay delimiter-safe, or two different squares
    // collapse onto one identity on boards ≥ 13.
    const a: Action = { type: 'upgrade', player: 0, pos: { x: 1, y: 23 } };
    const b: Action = { type: 'upgrade', player: 0, pos: { x: 12, y: 3 } };
    expect(actionKey(a)).not.toBe(actionKey(b));
  });
});

describe('target payloads', () => {
  it('keys an absent payload differently from an empty one', () => {
    expect(targetsKey(undefined)).not.toBe(targetsKey({}));
  });

  it('emits slots in a fixed order regardless of object key order', () => {
    const a = { spaces: [{ x: 1, y: 1 }], units: ['u1'] };
    const b = { units: ['u1'], spaces: [{ x: 1, y: 1 }] };
    expect(targetsKey(a)).toBe(targetsKey(b));
  });

  it('keeps list order significant — an ordered step means two different plays', () => {
    // Instigation's first gnome is the attacker: [a,b] and [b,a] are not the
    // same play, so they must not share an identity.
    expect(targetsKey({ units: ['u1', 'u2'] })).not.toBe(targetsKey({ units: ['u2', 'u1'] }));
  });

  it('canonicalTargets gives the order-insensitive form for unordered slots', () => {
    const a = canonicalTargets({ units: ['u2', 'u1'], spaces: [{ x: 2, y: 1 }, { x: 1, y: 1 }] });
    const b = canonicalTargets({ units: ['u1', 'u2'], spaces: [{ x: 1, y: 1 }, { x: 2, y: 1 }] });
    expect(targetsKey(a)).toBe(targetsKey(b));
  });

  it('keys each CardTarget kind distinctly', () => {
    const keys = [
      targetKey({ kind: 'unit', unitId: 'x' }),
      targetKey({ kind: 'space', pos: { x: 0, y: 0 } }),
      targetKey({ kind: 'player', playerId: 0 }),
      targetKey({ kind: 'card', cardId: 'x' }),
      targetKey({ kind: 'gardenType', gardenType: 'maize' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('intentKey collapses completions onto their intent', () => {
  it('strips the target payload', () => {
    const intent: Action = { type: 'playCard', player: 0, cardId: 'plot-twist' };
    const complete: Action = {
      type: 'playCard',
      player: 0,
      cardId: 'plot-twist',
      targets: { spaces: [{ x: 1, y: 1 }, { x: 1, y: 2 }] },
    };
    expect(intentKey(complete)).toBe(intentKey(intent));
    expect(intentKey(intent)).toBe(actionKey(intent));
    expect(actionKey(complete)).not.toBe(actionKey(intent));
  });

  it('every complete expansion maps back onto an offered intent', () => {
    const { s, me } = richState();
    const intents = new Set(getLegalActionIntents(s, me).map(intentKey));
    for (const a of enumerateCompleteCardActions(s, me)) {
      expect(intents.has(intentKey(a)), `${actionKey(a)} has no matching intent`).toBe(true);
    }
  });

  it('leaves non-card actions alone', () => {
    const a: Action = { type: 'move', player: 0, unitId: 'u1', to: { x: 1, y: 2 } };
    expect(intentKey(a)).toBe(actionKey(a));
  });
});

describe('enumerations are key-unique', () => {
  it('no duplicate keys in either API, at every state of a whole AI game', () => {
    let s: GameState = createGame(
      { players: [{ name: 'A', controller: 'cpu' }, { name: 'B', controller: 'cpu' }] },
      2024,
    );
    let checked = 0;
    for (let i = 0; i < 300 && !isGameOver(s); i++) {
      for (const list of [getLegalActionIntents(s), enumerateCompleteCardActions(s)]) {
        const keys = list.map(actionKey);
        expect(new Set(keys).size, `duplicate action key at step ${i}`).toBe(keys.length);
        expect(byActionKey(list).size).toBe(list.length);
        checked += keys.length;
      }
      s = applyAction(s, chooseAiAction(s));
    }
    expect(checked).toBeGreaterThan(500);
  }, 120_000);

  it('keys are stable across a state clone (identity is not object identity)', () => {
    const { s, me } = richState(43);
    const once = getLegalActionIntents(s, me).map(actionKey);
    const twice = getLegalActionIntents(structuredClone(s), me).map(actionKey);
    expect(twice).toEqual(once);
  });
});
