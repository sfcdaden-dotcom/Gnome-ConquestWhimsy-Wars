/**
 * CPU personality: the weights that colour every level of the objective system.
 *
 * One personality is a bag of multipliers, nothing more. It is read in three
 * places and nowhere else:
 *
 *  - `objectives.ts` — strategic-state scoring and objective selection,
 *  - `objectiveScoring.ts` — how hard a legal action is pulled toward the
 *    current objective,
 *  - `index.ts` — how much controlled randomness the final pick tolerates.
 *
 * That is the whole extension point. A new opponent ("Grimble: aggression 1.4,
 * defense 0.8") is a new entry in `PERSONALITIES` plus a way to name it on a
 * seat — no second AI implementation, no branch in the planner.
 *
 * Today the only selector is the seat's `difficulty`, so the three built-ins
 * double as the difficulty curve. `personalityFor` is deliberately the single
 * lookup: when seats gain a named-personality field, it changes here alone.
 */

import type { GameState, PlayerId } from '../types';

export interface AiPersonality {
  /** Display name — used by `describeAiPlan` and (later) the UI. */
  readonly name: string;
  /** Appetite for attacking: PRESSURE / FINISH scoring and fight-adjacent bonuses. */
  readonly aggression: number;
  /** Weight on DEFEND / SURVIVE and on protecting the home. */
  readonly defense: number;
  /** Weight on EXPAND and on garden/economy objectives. */
  readonly expansion: number;
  /** How much a Whimsy Card play is favoured once it serves the objective. */
  readonly whimsyPreference: number;
  /** Tolerance for pushing an objective whose target is well defended. */
  readonly riskTolerance: number;
  /** Extra pull toward CAPTURE_GARDEN specifically. */
  readonly gardenPreference: number;
  /** Extra pull toward ATTACK_ENEMY_HOME specifically. */
  readonly homeAttackPreference: number;
  /**
   * How strongly the objective layer is allowed to re-order the existing
   * tactical scores. 0 disables the layer entirely (pure legacy heuristics).
   */
  readonly objectiveFocus: number;
  /**
   * Width of the "good enough" band the final pick may choose randomly within,
   * in Action-Phase score points. 0 = always take the single best action.
   * Randomness applies AFTER scoring, never instead of it.
   */
  readonly explorationBand: number;
}

/**
 * The three built-ins, one per difficulty.
 *
 *  - `dawdle` (easy) — barely plans. It adopts objectives (so it still reads as
 *    having intentions) but weighs them lightly and wanders more, which keeps
 *    Easy the deliberately exploitable opponent it has always been.
 *  - `steady` (normal) — balanced; the reference personality.
 *  - `grimble` (hard) — aggressive and focused, holds a plan hard and explores
 *    almost not at all.
 */
export const PERSONALITIES: Record<string, AiPersonality> = {
  dawdle: {
    name: 'Dawdle',
    aggression: 0.8,
    defense: 0.7,
    expansion: 1.1,
    whimsyPreference: 0.8,
    riskTolerance: 1.4,
    gardenPreference: 1.1,
    homeAttackPreference: 0.7,
    objectiveFocus: 0.5,
    explorationBand: 2.5,
  },
  steady: {
    name: 'Steady',
    aggression: 1,
    defense: 1,
    expansion: 1,
    whimsyPreference: 1,
    riskTolerance: 1,
    gardenPreference: 1,
    homeAttackPreference: 1,
    objectiveFocus: 1,
    explorationBand: 1.2,
  },
  grimble: {
    name: 'Grimble',
    aggression: 1.4,
    defense: 0.9,
    expansion: 0.8,
    whimsyPreference: 1.1,
    riskTolerance: 1.2,
    gardenPreference: 0.9,
    homeAttackPreference: 1.3,
    objectiveFocus: 1.25,
    explorationBand: 0.4,
  },
};

const BY_DIFFICULTY = { easy: 'dawdle', normal: 'steady', hard: 'grimble' } as const;

/** The personality driving one seat. Deterministic; a pure read of the state. */
export function personalityFor(state: GameState, player: PlayerId): AiPersonality {
  const difficulty = state.players[player]?.difficulty ?? 'normal';
  return PERSONALITIES[BY_DIFFICULTY[difficulty]] ?? PERSONALITIES.steady;
}
