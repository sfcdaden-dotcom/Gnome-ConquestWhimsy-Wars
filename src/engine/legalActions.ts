/**
 * Legal-action enumeration — the INTENT API, the one the UI and the CPU use.
 *
 * `getLegalActionIntents(state[, player])`: every legal move for the player who
 * must act, with card plays left UNTARGETED. It is cheap (no combinatorial
 * work). A targeted `playCard` / `respondPlayCard` entry is an *intent*:
 * dispatching it without a `targets` payload starts phased targeting (a
 * `cardTargeting` decision), and the engine then offers one target step at a
 * time (`getPendingDecisionOptions` → `selectTarget`). So the "how do I finish
 * this play" knowledge lives in the engine's phased flow, not in the caller.
 *
 * Everything returned here is dispatchable: for a targeted card that means its
 * targeting FLOW has a completable path, not merely that the card's cheap
 * `hasAnyPlay` hint passed (the two can disagree — see `legalActions.test.ts`).
 *
 * The exhaustive expansion — one fully-built action per valid `CardTargets`
 * payload — deliberately lives in a SEPARATE module, `actionExpansion.ts`, so
 * that the expensive path is never reached by autocompleting past the cheap
 * one. See that file's header for the side-by-side comparison.
 *
 * Enumeration is generic: candidates come from each card's `targetFlow` steps
 * and the card's own `validate` is the only judge of complete payloads. Adding
 * a card requires no change to this file.
 */

import type { Action, GameState, PlayerId, Pos } from './types';
import { deckHasCards, whyCannotPlayNow } from './cards';
import { getPendingDecisionOptions } from './targeting';
import { internal, plantWishCost, playerUnits, posKey } from './helpers';
import { canPlantAt, canUpgradeAt } from './gardens';
import { UPGRADE_WISH_COST } from './actions';
import { antsyPantsViolators, getPlayerToAct, moveDestinations } from './turns';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Legal actions with card plays left UNTARGETED. Cheap: no combinatorial
 * expansion. A `playCard` / `respondPlayCard` entry for a targeted card is an
 * intent — dispatch it to start phased targeting. While a `cardTargeting`
 * decision is open this returns the current step's `selectTarget` options plus
 * `cancelTargeting`.
 */
export function getLegalActionIntents(state: GameState, player?: PlayerId): Action[] {
  if (state.status === 'finished') return [];
  const actor = player ?? getPlayerToAct(state);
  if (actor === null) return [];

  const d = state.pendingDecision;
  if (d) {
    if (d.player !== actor) return [];
    switch (d.kind) {
      case 'rollOff':
        return [{ type: 'rollOff', player: actor }];
      case 'chooseHarvest':
        return d.options.map((s) => ({ type: 'chooseHarvest', player: actor, sourceKey: s.key }));
      case 'homeHarvest':
        return d.options.map((take) => ({ type: 'homeHarvest', player: actor, take }));
      case 'mushroomClones': {
        const out: Action[] = [];
        for (let c = 0; c <= d.max; c++) out.push({ type: 'mushroomClones', player: actor, count: c });
        return out;
      }
      case 'slide': {
        const out: Action[] = d.options.map((to) => ({ type: 'slide', player: actor, to }));
        if (d.optional) out.push({ type: 'declineEffect', player: actor });
        return out;
      }
      case 'tunnel': {
        const out: Action[] = d.options.map((to) => ({ type: 'tunnel', player: actor, to }));
        if (d.optional) out.push({ type: 'declineEffect', player: actor });
        return out;
      }
      case 'fightRespond': {
        const out: Action[] = [{ type: 'respondPass', player: actor }];
        for (const cardId of d.playableCards) {
          out.push({ type: 'respondPlayCard', player: actor, cardId });
        }
        return out;
      }
      case 'cardResponse': {
        const out: Action[] = [{ type: 'respondPass', player: actor }];
        for (const cardId of d.playableCards) {
          out.push({ type: 'respondPlayCard', player: actor, cardId });
        }
        return out;
      }
      case 'cardTargeting': {
        // Answers to the current targeting step: one selectTarget per legal
        // option, plus the always-available cancel.
        const out: Action[] = getPendingDecisionOptions(state).map((target) => ({
          type: 'selectTarget',
          player: actor,
          target,
        }));
        out.push({ type: 'cancelTargeting', player: actor });
        return out;
      }
      case 'discard':
        return [...new Set(state.players[actor].hand)].map((cardId) => ({
          type: 'discardCard',
          player: actor,
          cardId,
        }));
      case 'snailify':
        return [
          { type: 'snailify', player: actor, accept: true },
          { type: 'snailify', player: actor, accept: false },
        ];
      case 'sacrificeGnome':
        return d.options.map((unitId) => ({ type: 'sacrificeGnome', player: actor, unitId }));
      case 'snailMove': {
        const out: Action[] = d.options.map((to) => ({ type: 'snailMove', player: actor, to }));
        // Snailmaggedon's bonus move is optional; a post-fight rout is not.
        if (d.context === 'snailmaggedon') out.push({ type: 'declineEffect', player: actor });
        return out;
      }
      default: {
        // Exhaustiveness: a new PendingDecision kind must be handled here.
        const missing: never = d;
        internal(`getLegalActions: unhandled decision kind ${JSON.stringify(missing)}`);
      }
    }
  }

  if (state.status === 'rolloff') return []; // decision covers roll-off; nothing else

  const t = state.turn;
  if (!t || t.phase !== 'action') return [];
  const p = state.players[actor];

  // Non-active players: sudden-magic interrupts only. (whyCannotPlayNow
  // already rejects respond-only cards and, for a non-active player, all
  // Ritual Magic — anything that passes is a playable Sudden interrupt.)
  if (t.activePlayer !== actor) {
    const out: Action[] = [];
    if (p.status === 'playing') {
      for (const cardId of new Set(p.hand)) {
        if (whyCannotPlayNow(state, actor, cardId) === null) {
          out.push({ type: 'playCard', player: actor, cardId });
        }
      }
    }
    return out;
  }

  const out: Action[] = [];

  // Moves (shared legality with doMove and the Antsy Pants check).
  for (const u of playerUnits(state, actor)) {
    if (u.movedOnTurn === t.number) continue;
    for (const to of moveDestinations(state, u)) {
      out.push({ type: 'move', player: actor, unitId: u.id, to });
    }
  }

  if (p.status === 'playing') {
    // Plants (from the player's own tile supply).
    if (p.wishes >= plantWishCost(state)) {
      const spots = new Map<string, Pos>();
      for (const u of playerUnits(state, actor)) {
        if (u.kind !== 'gnome') continue;
        if (canPlantAt(state, actor, u.pos)) spots.set(posKey(u.pos), u.pos);
      }
      const types = Object.keys(p.supply) as Array<keyof typeof p.supply>;
      for (const pos of spots.values()) {
        for (const gt of types) {
          if (p.supply[gt] > 0) out.push({ type: 'plant', player: actor, pos, gardenType: gt });
        }
      }
    }

    // Upgrades (garden you control, non-home, not already upgraded).
    if (p.wishes >= UPGRADE_WISH_COST) {
      const spots = new Map<string, Pos>();
      for (const u of playerUnits(state, actor)) {
        if (u.kind !== 'gnome') continue;
        if (canUpgradeAt(state, actor, u.pos)) spots.set(posKey(u.pos), u.pos);
      }
      for (const pos of spots.values()) out.push({ type: 'upgrade', player: actor, pos });
    }

    // Draw.
    if (p.wishes >= 1 && deckHasCards(state)) {
      out.push({ type: 'drawCard', player: actor });
    }

    // Play cards.
    for (const cardId of new Set(p.hand)) {
      if (whyCannotPlayNow(state, actor, cardId) === null) {
        out.push({ type: 'playCard', player: actor, cardId });
      }
    }
  }

  // Antsy Pants can forbid ending the turn while a gnome can still move.
  if (antsyPantsViolators(state, actor).length === 0) {
    out.push({ type: 'endTurn', player: actor });
  }
  return out;
}
