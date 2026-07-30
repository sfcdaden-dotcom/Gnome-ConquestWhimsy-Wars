/**
 * Exhaustive legal-action expansion — the ANALYSIS path, deliberately kept in
 * its own module so it cannot be reached by accident.
 *
 * The engine has two legal-action APIs, and confusing them is the mistake this
 * file's existence is meant to prevent:
 *
 * | | `getLegalActionIntents` (`legalActions.ts`) | `enumerateCompleteCardActions` (here) |
 * |---|---|---|
 * | Card plays | left UNTARGETED (an *intent*) | expanded, one action per valid payload |
 * | Cost | proportional to units × destinations + hand size | additionally walks each targeted card's whole flow |
 * | Callers | the UI, the CPU, the shot clock, the sample extractor | tests, fuzzers, offline analysis |
 * | Answers | "what could this player do?" | "what are all the fully-built moves?" |
 *
 * Both return only dispatchable actions. The difference is *how much of the
 * play is decided up front*: an intent starts phased targeting (the engine then
 * offers one target step at a time), while an expanded action is immediately
 * executable with no further decisions.
 *
 * Use the intent API unless you specifically need every payload. Expansion is
 * bounded by a card's real branching rather than the product of every slot
 * (phased narrowing — Plot Twist expands to its 2·n·(n-1) adjacent pairs, not
 * C(n², 2)), so there is no global combination ceiling; it is still strictly
 * more work than the intent list, and on a hot path that work is wasted.
 */

import type { Action, GameState, PlayerId } from './types';
import { getCardDef } from './cards';
import { enumerateCardTargets } from './targeting';
import { getLegalActionIntents } from './legalActions';

/**
 * Every legal, fully-executable action for `player` (default: the player who
 * must act), with targeted card plays expanded into one action per valid
 * `CardTargets` payload.
 *
 * A targeted card with no valid payload contributes nothing — it is dropped,
 * matching the "everything returned is executable" contract both APIs keep.
 */
export function enumerateCompleteCardActions(state: GameState, player?: PlayerId): Action[] {
  const out: Action[] = [];
  for (const intent of getLegalActionIntents(state, player)) {
    if (intent.type !== 'playCard' && intent.type !== 'respondPlayCard') {
      out.push(intent);
      continue;
    }
    if (!cardNeedsTargets(intent.cardId)) {
      // Untargeted card — the intent is already complete.
      out.push(intent);
      continue;
    }
    for (const targets of enumerateCardTargets(state, intent.player, intent.cardId)) {
      out.push({ ...intent, targets });
    }
  }
  return out;
}

/**
 * Alias of `enumerateCompleteCardActions`, kept because it is the name the
 * original three-function engine API used and tests/tools still call it.
 *
 * NOTE the asymmetry the name hides: this is the *expensive* path. New code
 * should say `getLegalActionIntents` (cheap, what the UI and CPU use) or
 * `enumerateCompleteCardActions` (explicitly the analysis expansion) so the
 * choice is visible at the call site.
 */
export function getLegalActions(state: GameState, player?: PlayerId): Action[] {
  return enumerateCompleteCardActions(state, player);
}

function cardNeedsTargets(cardId: string): boolean {
  const def = getCardDef(cardId);
  return !!def && def.needsTargets;
}
