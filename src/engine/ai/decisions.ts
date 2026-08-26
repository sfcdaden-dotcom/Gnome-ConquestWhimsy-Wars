/**
 * Pending-decision policies: what the CPU answers when the engine is waiting on
 * exactly one typed decision from it.
 *
 * `chooseDecisionAction` is exhaustive over `PendingDecision['kind']` — a new
 * decision kind fails to compile here until it has a policy, which is the point
 * of keeping all of them in one file rather than scattered through the planner.
 *
 * The response-window policies (`planFightRespond`, `planCardResponse`) are
 * where the roll-influencing and shield cards that `cardPlans.ts` deliberately
 * holds actually get spent.
 */

import type { Action, CardId, CardTargets, GameState, PendingDecision, PlayerId } from '../types';
import { EngineError } from '../types';
import { getPendingDecisionOptions } from '../engine';
import { gardenAt, gnomesOnBoard, manhattan, playerUnitsAt, samePos, wishCap } from '../helpers';
import { cardKeepValue } from './cardPlans';
import type { PlanContext } from './objectiveScoring';
import { primaryTarget, scoreDestination } from './scoring';

/**
 * Answer the open decision. `legal` is the intent list for this state, passed in
 * so the policies that just take the engine's first offer (roll-off, sacrifice)
 * don't re-enumerate it.
 */
export function chooseDecisionAction(
  state: GameState,
  actor: PlayerId,
  d: PendingDecision,
  legal: readonly Action[],
  ctx: PlanContext,
): Action {
  switch (d.kind) {
    case 'rollOff':
      return legal[0];
    case 'discard':
      return chooseDiscard(state, actor);
    case 'fightRespond':
      return planFightRespond(state, actor, d);
    case 'cardResponse':
      return planCardResponse(state, actor, d);
    case 'cardTargeting': {
      // The AI normally attaches targets before dispatching, so it rarely
      // lands here; when it does (a card with no dedicated planner, or being
      // driven through the phased flow), take the first legal option each
      // step. Honest step options guarantee this reaches a valid completion.
      const options = getPendingDecisionOptions(state);
      return options.length > 0
        ? { type: 'selectTarget', player: actor, target: options[0] }
        : { type: 'cancelTargeting', player: actor };
    }
    case 'snailify':
      return { type: 'snailify', player: actor, accept: true };
    case 'sacrificeGnome':
      // Magic Drain: give up the first (lowest-id) gnome.
      return legal[0];
    case 'homeHarvest':
      return chooseHomeHarvest(state, actor, d, ctx);
    case 'chooseHarvest': {
      const order = ['dandelion', 'mushroom', 'maize', 'tunnel', 'slippery', 'home', 'flytrap'];
      const sorted = [...d.options].sort(
        (a, b) => order.indexOf(a.gardenType) - order.indexOf(b.gardenType),
      );
      return { type: 'chooseHarvest', player: actor, sourceKey: sorted[0].key };
    }
    case 'mushroomClones':
      return { type: 'mushroomClones', player: actor, count: d.max };
    case 'slide':
    case 'tunnel':
    case 'snailMove':
      return planHop(state, actor, d, legal);
    default: {
      // Exhaustiveness: a new PendingDecision kind must be handled here.
      const missing: never = d;
      throw new EngineError('INTERNAL', `AI has no policy for decision ${JSON.stringify(missing)}`);
    }
  }
}

/**
 * Slide / tunnel / Snailmaggedon relocation.
 *
 * Seed with declineEffect (score 0) when available so that a move is taken only
 * when it STRICTLY improves. Ties must favor declining.
 *
 * Optional entry effects CHAIN (tunnel → tunnel → …), and `scoreDestination`'s
 * target is recomputed from the mover's current position (`primaryTarget`), so
 * it can flip between two tunnels and rate the RETURN hop as "improving" too —
 * an unbounded A→B→A ping-pong. For declinable (chainable) hops, additionally
 * require strict progress toward a chain-STABLE anchor — the enemy home nearest
 * our own base, which does not move as the gnome hops. That is a monotonically
 * decreasing, bounded potential, so the chain always terminates. (The engine's
 * `MAX_ENTRY_EFFECT_HOPS` is the hard floor beneath this heuristic.)
 */
function planHop(
  state: GameState,
  actor: PlayerId,
  d: Extract<PendingDecision, { kind: 'slide' | 'tunnel' | 'snailMove' }>,
  legal: readonly Action[],
): Action {
  const canDecline = legal.some((a) => a.type === 'declineEffect');
  const anchor = primaryTarget(state, actor, state.players[actor].homePos);
  const fromDist = manhattan(d.from, anchor);
  let best: Action | null = canDecline ? { type: 'declineEffect', player: actor } : null;
  let bestScore = canDecline ? 0 : -Infinity;
  for (const a of legal) {
    if (a.type !== 'slide' && a.type !== 'tunnel' && a.type !== 'snailMove') continue;
    // Chainable hop that doesn't close on the anchor ⇒ not eligible to
    // chain (forced relocations aren't chainable, so they skip the gate).
    if (canDecline && manhattan(a.to, anchor) >= fromDist) continue;
    let score = scoreDestination(state, actor, d.from, a.to);
    if (samePos(a.to, d.from)) score = -0.25; // tunnel "stay" mildly discouraged
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best ?? legal[0];
}

/**
 * A gnome or a Wish from the Home Garden — the turn's one real economic choice,
 * and the place a posture shows up most plainly.
 *
 *  - EXPAND / PRESSURE / FINISH take the body. Growth is bodies: a gnome holds
 *    a garden, wins a fight and takes a Home, and none of those wait.
 *  - DEFEND / SURVIVE take the Wish. A dug-in position is not short of gnomes,
 *    it is short of answers — and Wishes are what buy the cards and the walls.
 *    A floor keeps a seat that is genuinely down to nothing taking bodies.
 *  - Either way, a Wish at the cap is a Wish thrown away (the engine logs it as
 *    "nothing"), so take the gnome instead whatever the posture wants.
 */
function chooseHomeHarvest(
  state: GameState,
  actor: PlayerId,
  d: Extract<PendingDecision, { kind: 'homeHarvest' }>,
  ctx: PlanContext,
): Action {
  const take = (choice: 'gnome' | 'wish'): Action => ({ type: 'homeHarvest', player: actor, take: choice });
  if (!d.options.includes('gnome')) return take('wish');

  const p = state.players[actor];
  if (p.wishes >= wishCap(state, actor)) return take('gnome'); // the Wish would be lost
  const board = gnomesOnBoard(state, actor);

  if (ctx.strategy === 'DEFEND' || ctx.strategy === 'SURVIVE') {
    return board < 3 ? take('gnome') : take('wish');
  }
  const growing = ctx.strategy === 'EXPAND';
  return board < (growing ? 7 : 4) || p.wishes >= 3 ? take('gnome') : take('wish');
}

/** Lowest-static-value card in hand — the AI's pick when forced to discard. */
export function chooseDiscard(state: GameState, player: PlayerId): Action {
  const hand = [...new Set(state.players[player].hand)];
  let pick = hand[0];
  let pickVal = cardKeepValue(pick);
  for (const id of hand) {
    const v = cardKeepValue(id);
    if (v < pickVal) {
      pickVal = v;
      pick = id;
    }
  }
  return { type: 'discardCard', player, cardId: pick };
}

/**
 * Fight Respond policy. Sudden cards only (no Nope here):
 *  - Gnomebody Dies shields our gnome in a flytrap fight — safe, since only our
 *    own gnome can be destroyed there (a flytrap loss just stuns it).
 *  - In a home-stakes or late-game fight, swing the dice: 4 Leaf Clover on
 *    ourselves, else Snake Eyes on a player opponent.
 * Otherwise pass and keep the cards.
 */
export function planFightRespond(
  state: GameState,
  actor: PlayerId,
  d: Extract<PendingDecision, { kind: 'fightRespond' }>,
): Action {
  const pass: Action = { type: 'respondPass', player: actor };
  if (state.players[actor].difficulty === 'easy') return pass; // never plays response cards
  const f = state.fight;
  if (!f) return pass;
  const playable = d.playableCards;

  const ourIdx =
    f.sides[0].kind === 'player' && f.sides[0].player === actor
      ? 0
      : f.sides[1].kind === 'player' && f.sides[1].player === actor
        ? 1
        : -1;
  if (ourIdx < 0) return pass;
  const opp = f.sides[ourIdx === 0 ? 1 : 0];
  const flytrapFight = f.sides[0].kind === 'flytrap' || f.sides[1].kind === 'flytrap';

  if (flytrapFight && state.preventionShields === 0 && playable.includes('gnomebody-dies')) {
    return { type: 'respondPlayCard', player: actor, cardId: 'gnomebody-dies' };
  }

  const g = gardenAt(state, f.pos);
  const important = (g !== null && g.type === 'home') || (state.turn?.number ?? 0) >= 60;
  if (important) {
    // Don't stack a second Clover while one is still pending (unconsumed).
    if ((state.rollModifiers[actor] ?? 0) <= 0 && playable.includes('four-leaf-clover')) {
      return { type: 'respondPlayCard', player: actor, cardId: 'four-leaf-clover' };
    }
    if (opp.kind === 'player' && playable.includes('snake-eyes')) {
      return {
        type: 'respondPlayCard',
        player: actor,
        cardId: 'snake-eyes',
        targets: { players: [opp.player] },
      };
    }
  }
  return pass;
}

/**
 * Card Respond policy: Nope-Gnome a card that would kill one of our gnomes
 * (Rocket Propelled Gnome aimed at us, or Mushroom Cloud on a space we occupy).
 * If we can't Nope but hold Gnomebody Dies, raise a shield instead. Otherwise
 * pass — Nope-Gnome is too valuable to burn on anything less.
 */
export function planCardResponse(
  state: GameState,
  actor: PlayerId,
  d: Extract<PendingDecision, { kind: 'cardResponse' }>,
): Action {
  const pass: Action = { type: 'respondPass', player: actor };
  if (state.players[actor].difficulty === 'easy') return pass; // never plays response cards
  const entry = state.cardStack[d.stackIndex];
  if (!entry || entry.cancelled) return pass;
  if (!cardWouldKillOurGnome(state, actor, entry.cardId, entry.targets)) return pass;

  if (d.playableCards.includes('nope-gnome')) {
    return { type: 'respondPlayCard', player: actor, cardId: 'nope-gnome' };
  }
  if (state.preventionShields === 0 && d.playableCards.includes('gnomebody-dies')) {
    return { type: 'respondPlayCard', player: actor, cardId: 'gnomebody-dies' };
  }
  return pass;
}

/** Would this stacked card destroy one of `actor`'s gnomes? */
export function cardWouldKillOurGnome(
  state: GameState,
  actor: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
): boolean {
  if (cardId === 'rocket-propelled-gnome') {
    const id = targets?.units?.[0];
    const u = id ? state.units[id] : undefined;
    return !!u && u.owner === actor && u.kind === 'gnome';
  }
  if (cardId === 'mushroom-cloud') {
    const pos = targets?.spaces?.[0];
    return !!pos && playerUnitsAt(state, pos, actor).some((u) => u.kind === 'gnome');
  }
  return false;
}
