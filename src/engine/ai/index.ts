/**
 * Objective-driven CPU player.
 *
 * `chooseAiAction(state, memory?)` returns one legal action for the player who
 * must act right now, using ONLY the public engine API (getLegalActionIntents +
 * read-only state queries). The engine remains the sole authority on what is
 * legal and what an action does; this package only decides which of the offered
 * actions to take.
 *
 * THE FOUR LAYERS. The CPU no longer judges each action in isolation. It keeps
 * an intention and picks the action that serves it:
 *
 *     strategic state   EXPAND / DEFEND / PRESSURE / SURVIVE / FINISH
 *            ↓          (posture — biases what goals are worth having)
 *     objective         CAPTURE_GARDEN(3,4) / DEFEND_HOME / ATTACK_ENEMY_HOME(red)
 *            ↓          (a concrete goal, REMEMBERED across turns)
 *     action scoring    existing tactical score + how much it serves the goal
 *            ↓
 *     existing engine   getLegalActionIntents → applyAction
 *
 * The point is legibility, not optimality: a watching player should be able to
 * say "Blue wants that Mushroom", and "Blue was attacking me until I threatened
 * its Home". The objective is held in a stack, so an emergency (DEFEND_HOME) is
 * pushed over the current plan and popped when it is resolved, uncovering the
 * plan the CPU was already on rather than a freshly-derived one.
 *
 * DETERMINISM. There is no `Math.random` anywhere: the controlled randomness in
 * `pickAction` is a hash of (seed, event count, seat), so a seeded game driven
 * from a fresh plan store replays identically (`aiFingerprint.test.ts`).
 *
 * STATE. The plan lives in an `AiMemory` the CALLER owns, never in `GameState`
 * — see `memory.ts` for why, and for what happens when it is lost (the CPU
 * re-reads the board and forms a new intention; nothing breaks). Callers that
 * pass nothing share one module-level store.
 *
 * MODULE LAYOUT (this file is the only entry point; the rest are internals):
 *
 * | File | Responsibility |
 * |---|---|
 * | `index.ts` | `chooseAiAction`: routing, the Action-Phase pick, controlled randomness, target completion |
 * | `objectives.ts` | strategic state, objective proposal, lifetimes, the interrupt stack |
 * | `objectiveScoring.ts` | how much a legal action serves the current objective |
 * | `personality.ts` | the weights that colour all three levels |
 * | `memory.ts` | where a seat's plan lives between actions and turns |
 * | `scoring.ts` | positional scoring — `scoreDestination`, `scoreActionPhase`, the BFS distance field |
 * | `cardPlans.ts` | `planCardPlay` + one deterministic target picker per card, and `cardKeepValue` |
 * | `decisions.ts` | one policy per `PendingDecision` kind, incl. both respond windows |
 * | `chatter.ts` | `idleChatter` — flavor only, changes no game state |
 * | `util.ts` | small shared reads (own/enemy gnomes, home, difficulty, the desperation and turtle-breaker ramps) |
 *
 * Dependencies run one way — `index → {objectives, objectiveScoring, decisions,
 * cardPlans, chatter} → scoring → util` — so there are no cycles.
 *
 * The tactical heuristics below are unchanged — they still judge each action on
 * its own merits, and the objective bonus is added on top of them:
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

import type { Action, GameState, PlayerId } from '../types';
import { EngineError } from '../types';
import { getLegalActionIntents, getPlayerToAct } from '../engine';
import { getCardDef } from '../cards';
import { firstCompleteTargets } from '../targeting';
import { normalizeSeed } from '../rng';
import { chooseDecisionAction } from './decisions';
import { planCardPlay } from './cardPlans';
import { idleChatter } from './chatter';
import { scoreActionPhase } from './scoring';
import type { AiMemory } from './memory';
import { planFor, sharedAiMemory } from './memory';

import { describeObjective, updatePlan } from './objectives';
import { cardObjectiveMultiplier, objectiveBonus, objectiveField } from './objectiveScoring';
import type { AiPersonality } from './personality';
import { personalityFor } from './personality';

export { allUnitsMoved } from './util';
export { createAiMemory, clearAiMemory, sharedAiMemory } from './memory';
export type { AiMemory } from './memory';
export type { AiPlan, Objective, ObjectiveKind, StrategicState } from './objectives';
export { PERSONALITIES, personalityFor } from './personality';
export type { AiPersonality } from './personality';

/**
 * Pick one legal action for the player who must act.
 *
 * The AI plans against `getLegalActionIntents` (card plays without targets)
 * and supplies targets itself through `planCardPlay` and the respond-window
 * policies, which is cheaper than expanding every target combination. As a
 * structural guarantee that it can never emit a half-built action, whatever it
 * picks goes through `completeTargets` before being returned.
 *
 * `memory` is where this seat's objective is remembered between calls. Pass one
 * store per game (see `createAiMemory`); omitting it uses a shared one, which is
 * what every existing caller and test does.
 */
export function chooseAiAction(state: GameState, memory: AiMemory = sharedAiMemory): Action {
  return completeTargets(state, chooseAiActionInner(state, memory));
}

/**
 * What the CPU currently intends, in one line — "take the mushroom at (3,4)",
 * "defend home". Reads the plan without advancing it, so a UI or a test can ask
 * without changing what the CPU does. Empty until the seat has acted once.
 */
export function describeAiPlan(state: GameState, player: PlayerId, memory: AiMemory = sharedAiMemory): string {
  const plan = planFor(memory, state, player);
  const top = plan.stack.length > 0 ? plan.stack[plan.stack.length - 1] : null;
  return `${plan.strategy}: ${describeObjective(top)}`;
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

function chooseAiActionInner(state: GameState, memory: AiMemory): Action {
  const actor = getPlayerToAct(state);
  if (actor === null) throw new EngineError('ILLEGAL_ACTION', 'Game is finished; no action to choose');
  const legal = getLegalActionIntents(state, actor);
  if (legal.length === 0) throw new EngineError('INTERNAL', 'No legal actions available for the player to act');

  const d = state.pendingDecision;
  if (d) return chooseDecisionAction(state, actor, d, legal);

  // Action Phase.
  //
  // The plan comes first: `updatePlan` retires anything finished, re-reads the
  // posture, pushes an interrupt if our home is in trouble, and otherwise keeps
  // the objective this seat already had — the persistence the whole layer
  // exists for. It is advisory; a null objective just means every bonus below
  // is 0 and the CPU falls back to its original tactical heuristics.
  const personality = personalityFor(state, actor);
  const objective = updatePlan(state, actor, planFor(memory, state, actor), personality);
  // One BFS to the objective's target for the whole decision, shared by every
  // candidate move (see `objectiveField`).
  const field = objectiveField(state, actor, objective);

  // Then the pick: every legal action keeps its existing tactical score and
  // gains one objective term on top. endTurn scores its 0.1 baseline via
  // scoreActionPhase; under Antsy Pants it may be absent entirely, in which
  // case the best remaining (forced) action is taken.
  //
  // `playCard` intents carry no targets; planCardPlay supplies a concrete,
  // `validate`-checked targeted action plus its score, so the action we return
  // is always dispatchable. Because getPlayerToAct only routes here for the
  // active player, `endTurn` or a forced move is always present — `best` never
  // falls back to an untargeted playCard.
  const scored: Array<{ action: Action; score: number }> = [];
  for (const a of legal) {
    if (a.type === 'playCard') {
      const plan = planCardPlay(state, actor, a.cardId);
      if (!plan) continue;
      scored.push({
        action: plan.action,
        score: plan.score * cardObjectiveMultiplier(objective, a.cardId, personality),
      });
    } else {
      scored.push({
        action: a,
        score:
          scoreActionPhase(state, actor, a) +
          objectiveBonus(state, actor, objective, a, personality, field),
      });
    }
  }

  const action = pickAction(state, actor, scored, personality) ?? legal[0];
  return idleChatter(state, actor, legal, action) ?? action;
}

/**
 * Take the best action — but not always the same one.
 *
 * Randomness happens AFTER scoring, never instead of it. An action is eligible
 * only if it is BOTH within `explorationBand` points of the winner AND worth at
 * least `EXPLORE_FLOOR` of its score — two tests of the same idea, because the
 * Action-Phase scale is not uniform. A flat band alone would treat "5 versus 2"
 * as a near-tie the way it treats "91 versus 89", and a ratio alone would call
 * every pair of near-zero scores equivalent. Together they mean the CPU explores
 * genuine ties (maize 7 vs flytrap 6 — both guard the approach, pick one with
 * some character) and never a play it rates half as good.
 *
 * At most three candidates, weighted by rank, so the top action still wins most
 * of the time.
 *
 * The coin is a hash of (seed, event count, seat) rather than `Math.random`, so
 * the CPU stays deterministic and a seeded game still replays identically —
 * the same requirement every other part of this package is built around.
 *
 * `endTurn` is excluded from the band: passing is always "close enough" to a
 * marginal action, and randomly giving up a turn reads as a bug, not character.
 */
/** Fraction of the winning score an action must still reach to be explored. */
const EXPLORE_FLOOR = 0.8;

function pickAction(
  state: GameState,
  actor: PlayerId,
  scored: ReadonlyArray<{ action: Action; score: number }>,
  personality: AiPersonality,
): Action | null {
  if (scored.length === 0) return null;
  let best = scored[0];
  for (const s of scored) if (s.score > best.score) best = s;
  if (personality.explorationBand <= 0) return best.action;

  const floor = best.score > 0 ? best.score * EXPLORE_FLOOR : -Infinity;
  const band = scored
    .filter(
      (s) =>
        s.action.type !== 'endTurn' &&
        s.score > best.score - personality.explorationBand &&
        s.score >= floor,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (band.length <= 1) return best.action;

  // Weight by rank (3 / 2 / 1).
  const weights = band.map((_, i) => band.length - i);
  const total = weights.reduce((a, b) => a + b, 0);
  const roll = normalizeSeed(state.seed + state.eventCount * 2654435761 + actor * 40503) % total;
  let acc = 0;
  for (let i = 0; i < band.length; i++) {
    acc += weights[i];
    if (roll < acc) return band[i].action;
  }
  return best.action;
}
