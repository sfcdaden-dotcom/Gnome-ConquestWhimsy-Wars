import { describe, expect, it } from 'vitest';
import type { Action, GameState, Pos } from '../engine';
import { newGame } from '../engine/testkit';
import { actionableUnitsAt, nextInCycle, unitChipLabels } from './selection';
import { gnomeFirstName } from './gnomeNames';

const HOME: Pos = { x: 0, y: 3 };

/** A state with `ids` all standing on `pos` for seat 0. */
function withStack(ids: string[], pos: Pos = HOME, owner = 0, seed = 12345): GameState {
  const s = newGame(seed);
  return {
    ...s,
    units: Object.fromEntries(
      ids.map((id) => [id, { id, owner, kind: 'gnome' as const, pos: { ...pos }, movedOnTurn: null }]),
    ),
  };
}

const move = (unitId: string): Action => ({ type: 'move', player: 0, unitId, to: { x: 1, y: 3 } });
const plant = (pos: Pos = HOME): Action => ({ type: 'plant', player: 0, pos, gardenType: 'dandelion' });

describe('actionableUnitsAt', () => {
  it('returns only the units with a legal move, in id order', () => {
    const state = withStack(['u3', 'u1', 'u2']);
    const units = actionableUnitsAt(state, 0, HOME, [move('u1'), move('u3')]);
    expect(units.map((u) => u.id)).toEqual(['u1', 'u3']);
  });

  it('filters out non-actionable gnomes sharing the space', () => {
    // u2 already moved this turn: no legal move, and no plant is legal here.
    const state = withStack(['u1', 'u2']);
    const units = actionableUnitsAt(state, 0, HOME, [move('u1')]);
    expect(units.map((u) => u.id)).toEqual(['u1']);
  });

  it('counts a legal plant on the space, so a moved gnome stays selectable', () => {
    // The TECH_DEBT P1 regression: a gnome that already moved has no legal
    // move but can still plant, and must not drop out of the selectable set.
    const state = withStack(['u1', 'u2']);
    const units = actionableUnitsAt(state, 0, HOME, [plant()]);
    expect(units.map((u) => u.id)).toEqual(['u1', 'u2']);
  });

  it('ignores a plant that is legal on a DIFFERENT space', () => {
    const state = withStack(['u1']);
    const units = actionableUnitsAt(state, 0, HOME, [plant({ x: 4, y: 4 })]);
    expect(units).toEqual([]);
  });

  it('excludes other players units on the space', () => {
    const s = withStack(['u1']);
    const state: GameState = {
      ...s,
      units: {
        ...s.units,
        u9: { id: 'u9', owner: 1, kind: 'gnome', pos: { ...HOME }, movedOnTurn: null },
      },
    };
    const units = actionableUnitsAt(state, 0, HOME, [move('u1'), move('u9'), plant()]);
    expect(units.map((u) => u.id)).toEqual(['u1']);
  });

  it('returns an empty list for an empty space', () => {
    expect(actionableUnitsAt(withStack([]), 0, HOME, [])).toEqual([]);
  });
});

describe('nextInCycle', () => {
  it('starts at the first unit when nothing is selected', () => {
    const units = actionableUnitsAt(withStack(['u1', 'u2']), 0, HOME, [plant()]);
    expect(nextInCycle(units, null)?.id).toBe('u1');
  });

  it('advances and wraps', () => {
    const units = actionableUnitsAt(withStack(['u1', 'u2', 'u3']), 0, HOME, [plant()]);
    expect(nextInCycle(units, 'u1')?.id).toBe('u2');
    expect(nextInCycle(units, 'u3')?.id).toBe('u1');
  });

  it('restarts when the selection is not in the list', () => {
    const units = actionableUnitsAt(withStack(['u1', 'u2']), 0, HOME, [plant()]);
    expect(nextInCycle(units, 'u77')?.id).toBe('u1');
  });

  it('returns null for an empty list', () => {
    expect(nextInCycle([], 'u1')).toBeNull();
  });
});

describe('unitChipLabels', () => {
  it('uses first names alone when they are unambiguous', () => {
    const state = withStack(['u1', 'u2']);
    const chips = unitChipLabels(state, actionableUnitsAt(state, 0, HOME, [plant()]));
    expect(chips.map((c) => c.short)).toEqual([
      gnomeFirstName(state.seed, 'u1'),
      gnomeFirstName(state.seed, 'u2'),
    ]);
    expect(chips[0].full).toContain(chips[0].short);
  });

  it('promotes every chip to a full name when a stack shares a first name', () => {
    // u1 and u41 are exactly one pool apart, so they share a first name — the
    // case the 40-consecutive-ordinal guarantee does not cover.
    const state = withStack(['u1', 'u41']);
    const units = actionableUnitsAt(state, 0, HOME, [plant()]);
    expect(gnomeFirstName(state.seed, 'u1')).toBe(gnomeFirstName(state.seed, 'u41'));
    const chips = unitChipLabels(state, units);
    expect(new Set(chips.map((c) => c.short)).size).toBe(2);
    expect(chips.map((c) => c.short)).toEqual(chips.map((c) => c.full));
  });
});
