import { describe, expect, it } from 'vitest';
import type { GameState } from '../engine';
import { newGame } from '../engine/testkit';
import {
  EPITHETS,
  FIRST_NAMES,
  NAME_SPACE,
  gnomeFirstName,
  gnomeName,
  unitNameFromEvent,
  unitNameLive,
} from './gnomeNames';

/** A state carrying just the fields the name renderers are allowed to read. */
function stateWithSeed(seed: number): GameState {
  const s = newGame(1);
  return { ...s, seed };
}

describe('gnomeName', () => {
  it('matches known vectors (the naming scheme is a stable contract)', () => {
    // Checked in as literals: if the pools, the offset mixing or the index
    // scheme change, names shift for every existing seed and this fails loudly.
    expect([1, 2, 3, 4, 5].map((n) => gnomeName(12345, `u${n}`))).toEqual([
      'Tuffet the Unwashed',
      'Grumblenook the Unwashed',
      'Radishaw the Unwashed',
      'Cloverfoot the Unwashed',
      'Nettlespry the Unwashed',
    ]);
    expect([1, 2, 3].map((n) => gnomeName(0, `u${n}`))).toEqual([
      'Marrowick the Cross',
      'Puddlefoot the Cross',
      'Hazelnub the Cross',
    ]);
  });

  it('is deterministic for the same seed and id', () => {
    for (const n of [1, 7, 63, 200]) {
      expect(gnomeName(999, `u${n}`)).toBe(gnomeName(999, `u${n}`));
    }
  });

  it('gives 640 distinct full names over the first NAME_SPACE ordinals', () => {
    expect(NAME_SPACE).toBe(640);
    for (const seed of [1, 12345, 0, -7, 2 ** 31 - 1]) {
      const names = new Set(
        Array.from({ length: NAME_SPACE }, (_, i) => gnomeName(seed, `u${i + 1}`)),
      );
      expect(names.size).toBe(NAME_SPACE);
    }
  });

  it('keeps first names distinct across any 40 consecutive ordinals', () => {
    // Stated in ordinals, not spawns: snails consume ids too, so a set of live
    // gnomes can span a wider range than 40 and is NOT covered by this.
    for (const start of [1, 18, 137]) {
      const firsts = new Set(
        Array.from({ length: FIRST_NAMES.length }, (_, i) => gnomeFirstName(4242, `u${start + i}`)),
      );
      expect(firsts.size).toBe(FIRST_NAMES.length);
    }
  });

  it('reuses a first name only with a fresh epithet once the pool wraps', () => {
    // u1 and u41 are 40 apart, so they share a first name but must not collide.
    expect(gnomeFirstName(12345, 'u41')).toBe(gnomeFirstName(12345, 'u1'));
    expect(gnomeName(12345, 'u41')).not.toBe(gnomeName(12345, 'u1'));
  });

  it('two specific seeds land on different offsets', () => {
    // Deliberately NOT "different seeds always differ": any map from arbitrary
    // seeds into 640 configurations must collide, so that would be flaky or
    // vacuous. gnomeFirstName(1) and gnomeFirstName(2) genuinely DO collide.
    expect(gnomeName(12345, 'u1')).not.toBe(gnomeName(0, 'u1'));
  });

  it('handles seeds that are zero, negative, fractional or huge', () => {
    for (const seed of [0, -1, -999999, 2.9, -3.7, Number.MAX_SAFE_INTEGER, 2 ** 32]) {
      const name = gnomeName(seed, 'u1');
      const [first, ...rest] = name.split(' ');
      // A negative modulo would index out of the array and render "undefined".
      expect(FIRST_NAMES).toContain(first);
      expect(EPITHETS).toContain(rest.join(' '));
    }
  });

  it('truncates fractional seeds like the engine RNG does', () => {
    expect(gnomeName(2.9, 'u1')).toBe(gnomeName(2, 'u1'));
  });

  it('falls back to the raw id for ids outside the UnitId contract', () => {
    for (const bad of ['u0', 'u01', 'unit-3', 'red-u1', 'u42-clone', '', 'u']) {
      expect(gnomeName(1, bad)).toBe(bad);
      expect(gnomeFirstName(1, bad)).toBe(bad);
    }
  });
});

describe('unitNameFromEvent', () => {
  it('names a gnome without consulting state.units', () => {
    const state = stateWithSeed(12345);
    expect(Object.keys(state.units)).toHaveLength(0); // nothing on the board
    expect(unitNameFromEvent(state, { unitId: 'u1', player: 0, unitKind: 'gnome' })).toBe(
      'Tuffet the Unwashed',
    );
  });

  it('names a DESTROYED unit — the whole reason names are derived', () => {
    // The historical path must work when the unit is gone from state.units,
    // which is exactly the situation every `unitDestroyed` log line is in.
    const state = stateWithSeed(12345);
    const ref = { unitId: 'u3', player: 1, unitKind: 'gnome' as const };
    expect(state.units[ref.unitId]).toBeUndefined();
    expect(unitNameFromEvent(state, ref)).toBe('Radishaw the Unwashed');
  });

  it('labels a snail by its seat rather than giving it a gnome name', () => {
    const state = stateWithSeed(12345);
    expect(unitNameFromEvent(state, { unitId: 'u2', player: 1, unitKind: 'snail' })).toBe(
      "P1's Immortal Snail",
    );
  });

  it('survives a player index with no seat', () => {
    const state = stateWithSeed(1);
    expect(unitNameFromEvent(state, { unitId: 'u1', player: 9, unitKind: 'snail' })).toContain(
      'Immortal Snail',
    );
  });
});

describe('unitNameLive', () => {
  it('names a unit that is on the board', () => {
    const s = newGame(12345);
    const state: GameState = {
      ...s,
      units: { u1: { id: 'u1', owner: 0, kind: 'gnome', pos: { x: 0, y: 3 }, movedOnTurn: null } },
    };
    expect(unitNameLive(state, 'u1')).toBe(gnomeName(state.seed, 'u1'));
  });

  it('degrades to a gnome name instead of throwing when the unit is gone', () => {
    const state = stateWithSeed(12345);
    const name = unitNameLive(state, 'u1');
    expect(name).toBe('Tuffet the Unwashed');
    expect(name).not.toContain('undefined');
  });

  it('uses the snail label for a live snail', () => {
    const s = newGame(1);
    const state: GameState = {
      ...s,
      units: { u2: { id: 'u2', owner: 0, kind: 'snail', pos: { x: 0, y: 3 }, movedOnTurn: null } },
    };
    expect(unitNameLive(state, 'u2')).toBe("P0's Immortal Snail");
  });
});
