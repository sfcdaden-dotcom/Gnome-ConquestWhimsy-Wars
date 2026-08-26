/**
 * Objective bias: how much a legal action helps the plan.
 *
 * The existing tactical scores in `scoring.ts` and `cardPlans.ts` are unchanged
 * and still do all the work of judging an action on its own merits. This module
 * adds ONE more term on top:
 *
 *     finalScore = existingTacticalScore + objectiveBonus(...)
 *
 * which is what turns "pick the best isolated move" into "pick the move that
 * best serves what I am trying to do". The same action gets a very different
 * bonus depending on the current objective — walking a gnome three spaces west
 * is worth a lot while heading for the Mushroom over there and nothing at all
 * while our home is being stormed.
 *
 * SCALE. Existing Action-Phase scores run roughly: endTurn 0.1, draw 0.5,
 * moves ±10, plants 5–9, home storm ~15–20. The bonus is capped in the same
 * band (about ±14 before personality) so it re-orders comparable actions and
 * overrides a clearly-better tactical move only when the plan is urgent. It is
 * a bias, not a veto.
 *
 * DISTANCE. The pull toward the objective uses the same BFS field as
 * `scoring.ts`, not Manhattan. That is not a refinement, it is a requirement: a
 * straight-line pull actively PENALISES the sideways step around a wall that
 * the pathfinder is recommending, and the two terms cancel. On a board where
 * one player has maized and flytrapped the direct lane, that cancellation
 * freezes the attacker in place — the whole force sits still, ending its turn
 * every turn, for as long as the game is allowed to run. The field is computed
 * once per action in `index.ts` and handed in, so this stays one BFS per
 * action rather than one per candidate move.
 */

import type { Action, CardId, GameState, PlayerId, Pos } from '../types';
import { enemyUnitsAt, gardenAt, manhattan, playerUnitsAt, samePos } from '../helpers';
import type { Objective } from './objectives';
import { HOME_THREAT_RADIUS } from './objectives';
import { distanceField } from './scoring';
import { defenseDecay, offensePush } from './util';

/**
 * A BFS distance field to the current objective's target, computed once per
 * action. `distanceField` routes around enemy stacks and live flytraps, so
 * "closer" here means closer along a route the gnome can actually walk.
 */
export interface ObjectiveField {
  readonly dist: readonly number[];
  readonly size: number;
}

export function objectiveField(
  state: GameState,
  player: PlayerId,
  objective: Objective | null,
): ObjectiveField | null {
  if (!objective) return null;
  return { dist: distanceField(state, player, objective.targetPos), size: state.config.boardSize };
}

/** Field distance at `p`; falls back to Manhattan if no field was supplied. */
function distanceTo(field: ObjectiveField | null, p: Pos, target: Pos): number {
  return field ? field.dist[p.y * field.size + p.x] : manhattan(p, target);
}
import type { AiPersonality } from './personality';

/**
 * How a card serves each objective, as a multiplier on the card's own plan
 * score. Only cards with an obvious directional use are listed; everything else
 * keeps its existing value (1). This table is the growth path the brief asks
 * for — objective-aware card play can be deepened one card at a time without
 * touching `cardPlans.ts`, which still decides targets and legality.
 */
const CARD_AFFINITY: Partial<Record<ObjectiveKindKey, Partial<Record<CardId, number>>>> = {
  DEFEND_HOME: {
    'rocket-propelled-gnome': 1.6, // delete the gnome standing on our porch
    'mushroom-cloud': 1.5,
    'gnome-place-like-home': 1.6, // bounce the invader back to their own home
    'lawnmower-of-doom': 1.4,
    'great-wall-of-whimsy': 1.5,
    'wild-growth': 1.3, // bodies where we need them
    'gust-of-wind': 1.3,
  },
  ATTACK_ENEMY_HOME: {
    'hidden-passage': 1.5, // get there
    'seeing-double': 1.4,
    'wild-growth': 1.3,
    'rocket-propelled-gnome': 1.3, // clear the garrison
    'mushroom-cloud': 1.3,
    'gust-of-wind': 1.2,
    'lost-in-the-maize': 1.2,
  },
  CAPTURE_GARDEN: {
    'hidden-passage': 1.3,
    'wild-growth': 1.2,
    'pocket-shovel': 1.3,
    'gust-of-wind': 1.2,
    'gnome-birthday-party': 1.1,
  },
};

type ObjectiveKindKey = Objective['kind'];

/**
 * The bonus `action` earns for serving `objective`, already multiplied by the
 * personality's `objectiveFocus`. Returns 0 when there is no plan, which makes
 * the whole layer a no-op rather than a special case at the call site.
 */
export function objectiveBonus(
  state: GameState,
  player: PlayerId,
  objective: Objective | null,
  action: Action,
  personality: AiPersonality,
  field: ObjectiveField | null = null,
): number {
  if (!objective || personality.objectiveFocus === 0) return 0;
  return rawBonus(state, player, objective, action, personality, field) * personality.objectiveFocus;
}

function rawBonus(
  state: GameState,
  player: PlayerId,
  objective: Objective,
  action: Action,
  personality: AiPersonality,
  field: ObjectiveField | null,
): number {
  const target = objective.targetPos;
  switch (action.type) {
    case 'move': {
      const unit = state.units[action.unitId];
      if (!unit) return 0;
      return moveBonus(state, player, objective, unit.pos, action.to, personality, field);
    }
    case 'plant': {
      // Gardens are an EXPAND-shaped commitment: they cost a turn we might owe
      // to the plan. Under an attack plan they are a distraction; under a
      // defensive one, only the ones that actually wall our approach help.
      if (objective.kind === 'ATTACK_ENEMY_HOME') return -3;
      if (objective.kind === 'DEFEND_HOME') {
        const defensive = action.gardenType === 'maize' || action.gardenType === 'flytrap';
        const near = manhattan(action.pos, target) <= 2 && !samePos(action.pos, target);
        return defensive && near ? 5 * personality.defense : -4;
      }
      // CAPTURE_GARDEN: planting elsewhere is fine, just not instead of going.
      return -1;
    }
    case 'upgrade':
      // Deepening a garden we hold never advances an attack or a defence.
      return objective.kind === 'CAPTURE_GARDEN' ? 1 : -1.5;
    case 'playCard': {
      // `planCardPlay` has already scored and targeted the play; the objective
      // layer only says how much that play matters to the current plan. The
      // multiplier is folded in by the caller (see `cardObjectiveMultiplier`),
      // so nothing is added here.
      return 0;
    }
    case 'drawCard':
      // Fresh cards are an investment. Worth a little while expanding, a waste
      // while something is standing on our doorstep.
      return objective.kind === 'DEFEND_HOME' ? -1 : 0.5 * personality.whimsyPreference;
    case 'endTurn':
      return 0;
    default:
      return 0;
  }
}

/**
 * The heart of the layer: does this move take us toward what we want?
 *
 * Three parts, all on the Action-Phase scale:
 *  - closing distance on the target (the persistent pull that reads as intent),
 *  - arriving on it (the payoff, big enough to beat a tempting detour),
 *  - objective-specific extras: clearing a defender that blocks the target,
 *    and, while defending, refusing to walk away from home.
 */
function moveBonus(
  state: GameState,
  player: PlayerId,
  objective: Objective,
  from: Pos,
  to: Pos,
  personality: AiPersonality,
  field: ObjectiveField | null,
): number {
  const target = objective.targetPos;
  const before = distanceTo(field, from, target);
  const after = distanceTo(field, to, target);
  // Same late-game ramp the postures use: standing guard is worth less, and
  // marching is worth more, the longer nobody has won.
  const urgency =
    objective.kind === 'DEFEND_HOME'
      ? 2.2 * personality.defense * defenseDecay(state)
      : objective.kind === 'ATTACK_ENEMY_HOME'
        ? 1.8 * personality.aggression * offensePush(state)
        : 1.6 * personality.gardenPreference;

  // Clamp the step: an unreachable square scores manhattan + 100 in the field,
  // so a raw difference can be enormous. One step is worth one step.
  let bonus = Math.max(-2, Math.min(2, before - after)) * urgency;

  if (samePos(to, target)) {
    // Landing on the objective is the point. A contested arrival is a fight the
    // plan explicitly wants, so it is not discounted here — `scoreDestination`
    // has already priced the fight itself.
    bonus += objective.kind === 'CAPTURE_GARDEN' ? 8 : 10;
  }

  // Removing a defender that sits between us and the target serves the plan
  // even though it moves nobody onto it.
  const enemies = enemyUnitsAt(state, to, player);
  if (enemies.length > 0 && after <= 2 && !samePos(to, target)) {
    bonus += 3 * personality.aggression;
  }

  if (objective.kind === 'DEFEND_HOME') {
    // Don't wander off while the house is on fire, and reward bodies coming home.
    const guard = personality.defense * defenseDecay(state);
    if (after > HOME_THREAT_RADIUS && before <= HOME_THREAT_RADIUS) bonus -= 6 * guard;
    const defenders = playerUnitsAt(state, target, player).filter((u) => u.kind === 'gnome').length;
    if (samePos(from, target) && defenders <= 1) bonus -= 8 * guard;
  }

  if (objective.kind === 'CAPTURE_GARDEN') {
    // Once a gnome stands on the objective the plan is complete; don't let a
    // second one be dragged across the board for the same square.
    const g = gardenAt(state, target);
    if (g && playerUnitsAt(state, target, player).some((u) => u.kind === 'gnome')) bonus = 0;
  }

  return bonus;
}

/**
 * Multiplier applied to a `planCardPlay` score once an objective is in play.
 *
 * Kept separate from `objectiveBonus` because a card's value is proportional to
 * what the card plan already judged it worth — doubling a 12-point removal is
 * meaningful, adding a flat 3 to a 1-point play is not.
 */
export function cardObjectiveMultiplier(
  objective: Objective | null,
  cardId: CardId,
  personality: AiPersonality,
): number {
  if (!objective || personality.objectiveFocus === 0) return 1;
  const affinity = CARD_AFFINITY[objective.kind]?.[cardId] ?? 1;
  if (affinity === 1) return 1;
  // Scale the affinity's DISTANCE from neutral by focus and taste, so a seat
  // that cares little about either barely moves off the card's own score.
  return 1 + (affinity - 1) * personality.objectiveFocus * personality.whimsyPreference;
}
