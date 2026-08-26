/**
 * Small shared reads used by every AI module.
 *
 * Deliberately dependency-free beyond the engine's read-only helpers, so both
 * `scoring.ts` and `cardPlans.ts` can import it without either importing the
 * other (the AI package's dependency graph stays a tree: index → {decisions,
 * cardPlans, chatter} → scoring → util).
 */

import type { GameState, PlayerId, Pos, Unit } from '../types';
import { gardenAt, playerUnits } from '../helpers';

/** Is this seat playing on the sharpened 'hard' heuristics? */
export function isHard(state: GameState, player: PlayerId): boolean {
  return state.players[player].difficulty === 'hard';
}

/** Our Home Garden's space, or null if it has been destroyed. */
export function ownHomePos(state: GameState, player: PlayerId): Pos | null {
  const hp = state.players[player].homePos;
  const g = gardenAt(state, hp);
  return g && g.type === 'home' && g.owner === player ? hp : null;
}

/** Own gnomes, lowest-id first (deterministic). */
export function ownGnomes(state: GameState, player: PlayerId): Unit[] {
  return playerUnits(state, player).filter((u) => u.kind === 'gnome');
}

/** Enemy gnomes anywhere, lowest-id first. */
export function enemyGnomes(state: GameState, player: PlayerId): Unit[] {
  return Object.values(state.units)
    .filter((u) => u.kind === 'gnome' && u.owner !== player)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The late-game desperation ramp shared by the fight and hold heuristics. */
export function desperation(state: GameState): number {
  return Math.min(6, (state.turn?.number ?? 0) / 25);
}

/**
 * Turtle-breakers. The tactical heuristics already erode defensive caution with
 * `desperation` so a stalemate ends; the objective layer has to do the same or
 * it re-creates one at a higher level — two CPUs that each adopt DEFEND_HOME
 * because the other is loitering three spaces out, forever. These are the two
 * multipliers that ramp the objective layer's postures over a long game.
 */
export function defenseDecay(state: GameState): number {
  return Math.max(0.25, 1 - desperation(state) * 0.12);
}

/** The offensive counterpart of `defenseDecay`: pressure grows as time passes. */
export function offensePush(state: GameState): number {
  return 1 + desperation(state) * 0.25;
}

export const DIAGONALS: Pos[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
];
export const ORTHOGONALS: Pos[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];
export const STRAIGHT_TWOS: Pos[] = [
  { x: 0, y: -2 },
  { x: 2, y: 0 },
  { x: 0, y: 2 },
  { x: -2, y: 0 },
];

/** True when every unit of `player` has already moved this turn (AI helper). */
export function allUnitsMoved(state: GameState, player: PlayerId): boolean {
  const t = state.turn;
  if (!t) return true;
  return playerUnits(state, player).every((u) => u.movedOnTurn === t.number);
}
