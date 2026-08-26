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
import type { Objective, StrategicState } from './objectives';
import { HOME_THREAT_RADIUS, homeThreat } from './objectives';
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

/**
 * Everything the plan knows, gathered once per action.
 *
 * Bundled rather than passed as six arguments because the POSTURE is now as
 * load-bearing as the objective: what a seat wants from its economy is a
 * question about EXPAND vs DEFEND, not about which garden it is walking
 * toward. Anything a future rule needs about the plan belongs here.
 */
export interface PlanContext {
  readonly strategy: StrategicState;
  readonly objective: Objective | null;
  readonly personality: AiPersonality;
  readonly field: ObjectiveField | null;
  /**
   * Is an enemy actually IN our Home, rather than merely near it? Precomputed
   * because `homeThreat` walks every enemy gnome and the answer is consulted
   * once per candidate move — a per-action fact asked a per-move number of
   * times is exactly the shape that belongs on the context. Optional so a test
   * can build a context without one; absent reads as "not stormed".
   */
  readonly homeStormed?: boolean;
}

/** Is this posture about holding what we have rather than taking more? */
function isDefensive(ctx: PlanContext): boolean {
  return ctx.strategy === 'DEFEND' || ctx.strategy === 'SURVIVE' || ctx.objective?.kind === 'DEFEND_HOME';
}

/** Is this posture about growing — bodies and gardens? */
function isGrowing(ctx: PlanContext): boolean {
  return ctx.strategy === 'EXPAND';
}

/** Dandelions and Mushrooms: the gardens that pay a Wish or a gnome per turn. */
function isResourceGarden(type: string | undefined): boolean {
  return type === 'dandelion' || type === 'mushroom';
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
  action: Action,
  ctx: PlanContext,
): number {
  if (ctx.personality.objectiveFocus === 0) return 0;
  return rawBonus(state, player, action, ctx) * ctx.personality.objectiveFocus;
}

function rawBonus(state: GameState, player: PlayerId, action: Action, ctx: PlanContext): number {
  const { objective, personality } = ctx;
  switch (action.type) {
    case 'move': {
      const unit = state.units[action.unitId];
      if (!unit) return 0;
      return moveBonus(state, player, unit.pos, action.to, ctx);
    }
    case 'plant': {
      // Planting is what EXPAND is FOR: a garden is the only thing on the board
      // that pays every turn, and a posture that is not spending its Wishes on
      // one is not expanding. Every other posture treats it as a turn it owes
      // somewhere else.
      if (isGrowing(ctx)) {
        return isResourceGarden(action.gardenType) ? 4 * personality.expansion : 2 * personality.expansion;
      }
      if (objective?.kind === 'ATTACK_ENEMY_HOME') return -3;
      if (isDefensive(ctx)) {
        // Only the gardens that actually wall our approach are worth the turn.
        const home = objective?.targetPos ?? state.players[player].homePos;
        const defensive = action.gardenType === 'maize' || action.gardenType === 'flytrap';
        const near = manhattan(action.pos, home) <= 2 && !samePos(action.pos, home);
        return defensive && near ? 5 * personality.defense : -4;
      }
      return -1;
    }
    case 'upgrade':
      // Deepening a resource garden is growth by another name, and it lands on
      // a tile we already hold — exactly what a defensive posture wants too.
      if (isGrowing(ctx)) return 2 * personality.expansion;
      if (isDefensive(ctx)) return 1.5 * personality.defense;
      return objective?.kind === 'CAPTURE_GARDEN' ? 1 : -1.5;
    case 'playCard':
      // `planCardPlay` has already scored and targeted the play; how much that
      // play matters to the plan is applied by `cardObjectiveMultiplier`.
      return 0;
    case 'drawCard': {
      // Dug in with the board already set, a hand is the only thing still
      // improving: cards are how a defended position answers something it did
      // not plan for, and a defensive seat will spend down to its last Wishes
      // for one. While expanding, the same Wish is worth more in the ground —
      // a garden pays every turn, a card pays once.
      //
      // Hand room is the one part of the tactical gate a posture does NOT
      // overrule (see `respectTactics`): drawing into an immediate discard is
      // churn whatever the posture wants.
      if (state.players[player].hand.length > state.config.handLimit - 2) return 0;
      if (isDefensive(ctx)) return 3 * personality.whimsyPreference;
      if (isGrowing(ctx)) return -1 * personality.expansion;
      return 0.5 * personality.whimsyPreference;
    }
    case 'endTurn':
      return 0;
    default:
      return 0;
  }
}

/**
 * The heart of the layer: does this move take us toward what we want?
 *
 *  - closing distance on the target (the persistent pull that reads as intent),
 *  - arriving on it (the payoff, big enough to beat a tempting detour),
 *  - clearing a defender that stands between us and it,
 *  - and the economy: a posture decides whether a gnome standing on a Dandelion
 *    is doing its job or wasting its turn (see `economyBonus`).
 *
 * With no objective there is no target to pull toward, but the economy still
 * has an opinion — so that half runs either way.
 */
function moveBonus(
  state: GameState,
  player: PlayerId,
  from: Pos,
  to: Pos,
  ctx: PlanContext,
): number {
  const { objective, personality, field } = ctx;
  let bonus = economyBonus(state, player, from, to, ctx);
  if (!objective) return bonus;

  // A gnome holding a resource garden while we are dug in ALREADY has a job,
  // and the plan does not get to call it away from it. Without this the
  // objective's own pull wins the argument every time — DEFEND_HOME is worth
  // +10 on arrival and the garden is worth −7 to leave — and the seat ends up
  // defending a Home with an economy that has quietly switched off. The one
  // thing that outranks the harvest is somebody actually in the house.
  if (isDefensive(ctx) && !ctx.homeStormed && holdsResourceGarden(state, player, from)) {
    return bonus;
  }

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
  bonus += Math.max(-2, Math.min(2, before - after)) * urgency;

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
 * What a posture thinks of a gnome standing on a Dandelion or a Mushroom.
 *
 * A resource garden only pays while somebody is standing on it, so "hold the
 * economy" and "bring everyone home" are the same instruction pulling in
 * different directions the moment a garden sits outside the ring around Home.
 * A defensive posture resolves it toward the garden: a dug-in position that
 * stopped harvesting is losing slowly, and the Wishes it produces are what buy
 * the cards and walls that hold the position at all.
 *
 * The base tactical heuristics already nudge both ways (`scoreActionPhase`'s
 * "work the cluster" / "hold the cluster"); this is the posture's opinion added
 * on top, deliberately stronger, and it applies to DEFEND and SURVIVE alike.
 */
/** Is this gnome the only one keeping a Dandelion/Mushroom switched on? */
function holdsResourceGarden(state: GameState, player: PlayerId, pos: Pos): boolean {
  if (!isResourceGarden(gardenAt(state, pos)?.type)) return false;
  return playerUnitsAt(state, pos, player).filter((u) => u.kind === 'gnome').length <= 1;
}

/**
 * Not "an enemy is nearby" but "an enemy is IN it" — an enemy standing on our
 * Home, or enough of them on the doorstep to take it next turn. `homeThreat`
 * scores an occupier 5 and an adjacent gnome 3, so this is the line between a
 * threat we answer with the gnomes already free and one worth abandoning the
 * harvest for.
 */
const STORM_LEVEL = 5;

/** Computed once per action for `PlanContext.homeStormed`. */
export function homeIsStormed(state: GameState, player: PlayerId): boolean {
  return homeThreat(state, player).level >= STORM_LEVEL;
}

function economyBonus(
  state: GameState,
  player: PlayerId,
  from: Pos,
  to: Pos,
  ctx: PlanContext,
): number {
  if (!isDefensive(ctx)) return 0;
  const weight = ctx.personality.defense;
  let bonus = 0;

  const leaving = gardenAt(state, from);
  if (isResourceGarden(leaving?.type) && !samePos(from, to)) {
    // Walking the last harvester off a garden turns it off. Anything else this
    // gnome could be doing has to beat that.
    const holders = playerUnitsAt(state, from, player).filter((u) => u.kind === 'gnome').length;
    if (holders <= 1) bonus -= 10 * weight;
  }

  const arriving = gardenAt(state, to);
  if (isResourceGarden(arriving?.type) && !samePos(from, to)) {
    // Manning an idle garden switches it back on; a second body on a working
    // one is just a gnome standing still.
    const holders = playerUnitsAt(state, to, player).filter((u) => u.kind === 'gnome').length;
    if (holders === 0) bonus += 7 * weight;
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
export function cardObjectiveMultiplier(cardId: CardId, ctx: PlanContext): number {
  const { objective, personality } = ctx;
  if (personality.objectiveFocus === 0) return 1;
  const affinity =
    (objective ? CARD_AFFINITY[objective.kind]?.[cardId] : undefined) ??
    POSTURE_CARD_AFFINITY[ctx.strategy]?.[cardId] ??
    1;
  if (affinity === 1) return 1;
  // Scale the affinity's DISTANCE from neutral by focus and taste, so a seat
  // that cares little about either barely moves off the card's own score.
  return 1 + (affinity - 1) * personality.objectiveFocus * personality.whimsyPreference;
}

/**
 * Posture-level card taste, consulted when the objective has no opinion.
 * EXPAND wants bodies and Wishes — the two things it turns into gardens.
 */
const POSTURE_CARD_AFFINITY: Partial<Record<StrategicState, Partial<Record<CardId, number>>>> = {
  EXPAND: {
    'wild-growth': 1.5, // more gnomes is the whole posture
    'gnome-birthday-party': 1.3, // Wishes, which become gardens
    'seeing-double': 1.3,
    'pocket-shovel': 1.2,
  },
};
