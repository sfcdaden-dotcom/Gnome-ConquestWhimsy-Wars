/**
 * Heuristic CPU player.
 *
 * `chooseAiAction(state)` returns one legal action for the player who must
 * act right now, using ONLY the public engine API (getLegalActionIntents + read-only
 * state queries). It is deterministic: no randomness, stable tie-breaking by
 * enumeration order — so seeded games driven by the AI replay identically.
 *
 * MODULE LAYOUT (this file is the only entry point; the rest are internals):
 *
 * | File | Responsibility |
 * |---|---|
 * | `index.ts` | `chooseAiAction`: routing, the Action-Phase pick, target completion |
 * | `scoring.ts` | positional scoring — `scoreDestination`, `scoreActionPhase`, the BFS distance field |
 * | `cardPlans.ts` | `planCardPlay` + one deterministic target picker per card, and `cardKeepValue` |
 * | `decisions.ts` | one policy per `PendingDecision` kind, incl. both respond windows |
 * | `chatter.ts` | `idleChatter` — flavor only, changes no game state |
 * | `util.ts` | small shared reads (own/enemy gnomes, home, difficulty, the desperation ramp) |
 *
 * Dependencies run one way — `index → {decisions, cardPlans, chatter} →
 * scoring → util` — so there are no cycles. The split is behavior-preserving:
 * `aiFingerprint.test.ts` pins the exact action sequence of seeded games at
 * every difficulty, so any change in what the CPU plays fails the suite.
 *
 * Heuristics (intentionally simple, tuned for a playable opponent):
 *  - Roll-off: roll.
 *  - Home harvest: take a gnome while the board force is small or wishes are
 *    plentiful; otherwise take the wish.
 *  - Harvest order: economy first, dangerous flytrap harvests last.
 *  - Mushroom: clone the maximum.
 *  - Slides / tunnels / Snailmaggedon moves: score destinations (advance
 *    toward the nearest enemy home / center, avoid active flytraps, only
 *    attack favorably); entry effects are declined unless a destination
 *    scores positive. Piling friendly gnomes onto one square is penalized
 *    (spread out: ~1–2 per space, a 3rd only when it buys a fight), so the
 *    force fans out toward a target instead of marching as a single ball.
 *  - Respond windows:
 *      · fight — shield a gnome with Gnomebody Dies in a flytrap fight (only
 *        our own gnome can die there); in a home-stakes / late-game fight,
 *        swing the dice with 4 Leaf Clover (self) or Snake Eyes (opponent).
 *      · card — Nope-Gnome a card that would kill one of our gnomes
 *        (Rocket Propelled Gnome / Mushroom Cloud on our stack); failing a
 *        Nope, raise a Gnomebody Dies shield instead. Otherwise pass.
 *  - Action phase: build economy gardens as ONE defended cluster near home
 *    (mushroom with deep reserves, dandelion otherwise), capped by how many
 *    already sit near home — never dropped mid-march, which used to trail a
 *    line of abandoned gardens the AI never came back to hold. Plant a maize
 *    or flytrap near home to guard the approach, and a tunnel once one already
 *    exists elsewhere on the board (a lone tunnel has nowhere to link to);
 *    march gnomes toward the nearest enemy home / the Center Star while
 *    settling some onto the economy cluster to harvest it and digging in to
 *    defend it when an enemy closes in; attack when favorable; play Whimsy
 *    cards through `planCardPlay` (economy, removal, reinforcement and
 *    finisher moves — each with a deterministic target picker validated
 *    against the card's own `validate`); draw when wish-rich with hand room;
 *    end the turn when nothing scores above passing.
 *  - Discard (over hand limit): pitch the lowest static-value card.
 *  - Snailify: always continue as the Immortal Snail.
 *  - Idle chatter: when it could play a Whimsy Card this Action Phase and
 *    doesn't, it sometimes mutters one rhetorical quick-chat line first (see
 *    `idleChatter`) — flavor only; chat changes no game state.
 *
 * Roll-influencing / shield cards (Snake Eyes, 4 Leaf Clover, Gnomebody Dies)
 * are never spent proactively in the Action Phase — they are held for the
 * respond windows above, where they actually swing an outcome.
 *
 * Difficulty (`state.players[actor].difficulty`, per seat, default 'normal'):
 *  - 'easy'   — never plays a response-window card (fight or card), and its
 *    fight-commitment ignores the late-game desperation ramp while barely
 *    weighing being outnumbered, so it both stalls forever and walks into
 *    bad fights along the way. A deliberately weaker, exploitable opponent.
 *  - 'normal' — the heuristics described above; this is today's opponent.
 *  - 'hard'   — normal's heuristics, sharpened (see scoreDestination and
 *    planCardPlay for the hard-only branches). Positional rules of thumb Hard
 *    adds on top:
 *      · Don't wall yourself in: rather than planting maize/flytrap by its own
 *        home (which only limits its own movement), Hard drops them on an
 *        enemy's expected attack lane — a porch square facing us — as a Wish-tax
 *        (maize) or forced-detour wall (flytrap). Opportunistic: only when a
 *        forward gnome already stands there and isn't better off storming. See
 *        scoreForwardDeterrent.
 *      · Attack on multiple lanes without abandoning the start: this falls out
 *        of existing machinery rather than a Hard-only branch — the pathfinder
 *        routes the force AROUND a walled/occupied face (an automatic pincer
 *        exactly when one helps) and anti-balling keeps gnomes off a single
 *        square, while the standing home-garrison penalty and the economy-hold
 *        keep a defender back at the base. (A proactive pincer/spread bias was
 *        tried and removed as inert / tempo-negative — see primaryTarget.)
 */

import type { Action, GameState } from '../types';
import { EngineError } from '../types';
import { getLegalActionIntents, getPlayerToAct } from '../engine';
import { getCardDef } from '../cards';
import { firstCompleteTargets } from '../targeting';
import { chooseDecisionAction } from './decisions';
import { planCardPlay } from './cardPlans';
import { idleChatter } from './chatter';
import { scoreActionPhase } from './scoring';

export { allUnitsMoved } from './util';

/**
 * Pick one legal action for the player who must act.
 *
 * The AI plans against `getLegalActionIntents` (card plays without targets)
 * and supplies targets itself through `planCardPlay` and the respond-window
 * policies, which is cheaper than expanding every target combination. As a
 * structural guarantee that it can never emit a half-built action, whatever it
 * picks goes through `completeTargets` before being returned.
 */
export function chooseAiAction(state: GameState): Action {
  return completeTargets(state, chooseAiActionInner(state));
}

/**
 * Fill in targets for a card play that still needs them, using the engine's
 * own enumeration. A no-op for every action the planners target themselves;
 * it exists so that a future card without a dedicated planner degrades to
 * "play it with the first valid targets" instead of throwing at dispatch.
 */
function completeTargets(state: GameState, action: Action): Action {
  if (action.type !== 'playCard' && action.type !== 'respondPlayCard') return action;
  if (action.targets !== undefined) return action;
  const def = getCardDef(action.cardId);
  if (!def?.needsTargets) return action;
  // Greedily walk the card's targeting flow (first legal option per step). If
  // no complete payload validates, leave it untargeted — dispatch then opens a
  // cardTargeting decision, which the AI answers step by step (see
  // `decisions.ts`).
  const targets = firstCompleteTargets(state, action.player, action.cardId);
  return targets ? { ...action, targets } : action;
}

function chooseAiActionInner(state: GameState): Action {
  const actor = getPlayerToAct(state);
  if (actor === null) throw new EngineError('ILLEGAL_ACTION', 'Game is finished; no action to choose');
  const legal = getLegalActionIntents(state, actor);
  if (legal.length === 0) throw new EngineError('INTERNAL', 'No legal actions available for the player to act');

  const d = state.pendingDecision;
  if (d) return chooseDecisionAction(state, actor, d, legal);

  // Action Phase: pick the highest-scoring legal action. endTurn scores its
  // 0.1 baseline via scoreActionPhase; under Antsy Pants it may be absent
  // entirely, in which case the best remaining (forced) action is taken.
  //
  // `playCard` intents carry no targets; planCardPlay supplies a concrete,
  // `validate`-checked targeted action plus its score, so the action we return
  // is always dispatchable. Because getPlayerToAct only
  // routes here for the active player, `endTurn` or a forced move is always
  // present — `best` never falls back to an untargeted playCard.
  let best: Action | null = null;
  let bestScore = -Infinity;
  for (const a of legal) {
    let candidate: Action = a;
    let score: number;
    if (a.type === 'playCard') {
      const plan = planCardPlay(state, actor, a.cardId);
      if (!plan) continue;
      candidate = plan.action;
      score = plan.score;
    } else {
      score = scoreActionPhase(state, actor, a);
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const action = best ?? legal[0];
  return idleChatter(state, actor, legal, action) ?? action;
}
