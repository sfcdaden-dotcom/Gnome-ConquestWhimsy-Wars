/**
 * Unit-selection rules for the board.
 *
 * Extracted from `GameScreen` so the click-to-cycle path and the name-chip row
 * consume ONE ordered list. When those two disagreed about what "selectable"
 * means, a gnome could be reachable by clicking but missing from the chips (or
 * the reverse) — see the P1 entry in TECH_DEBT.md where a gnome that had
 * already moved dropped out of the selectable set and its Plant button became
 * unreachable for the rest of the turn.
 *
 * Pure functions over engine data: legality always comes from the caller's
 * enumerated legal actions, never recomputed here.
 */

import type { Action, GameState, PlayerId, Pos, Unit } from '../engine';
import { nameSaltOf, samePos, unitsAt } from '../engine';
import { gnomeFirstName, unitNameLive, withMarriageTitle } from './gnomeNames';

/**
 * The acting player's units on `pos` that can still do something this turn —
 * a legal move, OR a legal plant/upgrade on the space they stand on. All
 * count: a gnome that has already moved cannot move again but may still plant
 * or upgrade.
 *
 * Ordered by unit id (via `unitsAt`), so cycling and the chip row agree on
 * position and the order is stable across re-renders.
 */
export function actionableUnitsAt(
  state: GameState,
  player: PlayerId,
  pos: Pos,
  legal: readonly Action[],
): Unit[] {
  const canBuildHere = legal.some(
    (a) => (a.type === 'plant' || a.type === 'upgrade') && samePos(a.pos, pos),
  );
  return unitsAt(state, pos).filter(
    (u) =>
      u.owner === player &&
      (canBuildHere || legal.some((a) => a.type === 'move' && a.unitId === u.id)),
  );
}

/** The next unit in the cycle after `currentId` (wrapping), or the first. */
export function nextInCycle(units: readonly Unit[], currentId: string | null): Unit | null {
  if (units.length === 0) return null;
  if (currentId === null) return units[0];
  const i = units.findIndex((u) => u.id === currentId);
  return i >= 0 ? units[(i + 1) % units.length] : units[0];
}

export interface UnitChipLabel {
  unitId: string;
  /** Short text for the chip face. */
  short: string;
  /** Full name, for the tooltip and accessible name. */
  full: string;
}

/**
 * Chip labels for a stack: first names alone, because full names are
 * sentence-length and the action bar has to survive mobile widths.
 *
 * First names are only unique across consecutive unit ordinals, and a stack can
 * mix gnomes spawned far apart, so any first name shared by two units in THIS
 * stack promotes every chip to its full name — an ambiguous label is worse than
 * a long one when the whole point is telling them apart.
 */
export function unitChipLabels(state: GameState, units: readonly Unit[]): UnitChipLabel[] {
  const shorts = units.map((u) => gnomeFirstName(nameSaltOf(state), u.id));
  const ambiguous = shorts.some((s, i) => shorts.indexOf(s) !== i);
  return units.map((u, i) => {
    const full = unitNameLive(state, u.id);
    // Titled on the chip too — a married gnome reads as married wherever it
    // is named, and "Mr Bramblewick" still fits a chip.
    const short = withMarriageTitle(state, u.id, shorts[i]);
    return { unitId: u.id, short: ambiguous ? full : short, full };
  });
}
