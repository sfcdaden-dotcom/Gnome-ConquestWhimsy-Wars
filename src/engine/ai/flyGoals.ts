/**
 * Goals for the Fly, paid in bliss.
 *
 * A goal is something the fly should come to love: when it happens, bliss is
 * dumped into the brain — far more than any harvest treat — and the fly's
 * ATTRACTION to that kind of target grows. In a real fly, reward learning runs
 * through dopamine neurons that strengthen the link between what was sensed
 * and the reward that followed; the extracted circuit has no plasticity, so
 * the link is kept here, as a gain on the sense that saw the target:
 *
 *   attraction to a goal  →  its targets fire the object neurons (LC9/LC31)
 *                            harder  →  more approach (DNp09)  →  the fly goes
 *                            after them more eagerly
 *
 * Attraction lives in the FlyBrain, so it carries across games like the rest
 * of what the fly learns (and, like it, only grows while learning is on). A
 * success also gives an immediate burst on the next turn.
 */

import type { GameEvent, GameState, PlayerId } from '../types';
import { samePos } from '../helpers';

export type FlyGoalId = 'killGnome' | 'captureHome';

export interface FlyGoal {
  /** Shown in the fly's reward log. */
  label: string;
  /** Bliss per success: added to the next turn's object sense (Hz) and to attraction. */
  bliss: number;
  /** Reward in the post-game review (a harvested gnome is 2). */
  reward: number;
}

export const FLY_GOALS: Record<FlyGoalId, FlyGoal> = {
  killGnome: { label: 'killed an enemy gnome', bliss: 60, reward: 8 },
  captureHome: { label: 'captured an enemy Home', bliss: 200, reward: 40 },
};

/** How attraction follows bliss. */
export const FLY_ATTRACTION = {
  /** Attraction gained per unit of bliss. */
  perBliss: 0.002,
  /** Most extra gain a goal's targets can get on the object sense (×(1+cap)). */
  cap: 2,
};

/** Which goal, if any, an event completes for `player`. */
export function goalOf(state: GameState, player: PlayerId, ev: GameEvent): FlyGoalId | null {
  if (ev.type === 'unitDestroyed' && ev.unitKind === 'gnome' && ev.player !== player) return 'killGnome';
  if (ev.type === 'playerEliminated' && ev.player !== player && ev.reason === 'home-captured') {
    // Ours only if one of our units stands on their Home.
    const home = state.players[ev.player].homePos;
    const ours = Object.values(state.units).some((u) => u.owner === player && samePos(u.pos, home));
    return ours ? 'captureHome' : null;
  }
  return null;
}

/** Raise attraction after a success; returns the new value. */
export function reinforce(attraction: Partial<Record<FlyGoalId, number>>, goal: FlyGoalId): number {
  const next = Math.min(FLY_ATTRACTION.cap, (attraction[goal] ?? 0) + FLY_GOALS[goal].bliss * FLY_ATTRACTION.perBliss);
  attraction[goal] = next;
  return next;
}
