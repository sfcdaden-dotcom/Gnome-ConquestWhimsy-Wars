/**
 * The CPU's voice: how it tells you what it is up to.
 *
 * The objective layer gives the CPU an intention it holds across turns. That
 * only makes the opponent more readable if you can actually read it, and the
 * plan lives in a store beside the state where no player can see it. So the CPU
 * says it out loud: when it adopts a new objective it spends one quick chat on
 * the line that matches, and when it has nothing new to announce it falls back
 * to the rhetorical musings it always had.
 *
 *     turn 6   "That mushroom is mine."          ← adopted CAPTURE_GARDEN
 *     turn 9   "Why do we even wear the hats?"   ← still on it, nothing to say
 *     turn 11  "Get off my lawn!"                ← interrupted: DEFEND_HOME
 *     turn 14  "That mushroom is mine."          ← threat gone, plan resumed
 *
 * That transcript is the feature. A player who reads the log knows what the CPU
 * wants, knows when they knocked it off course, and knows when it went back.
 *
 * THIS LEAKS INFORMATION, ON PURPOSE. The previous rule was that the CPU only
 * ever said rhetorical lines, so a chatty CPU gave nothing away. That has been
 * traded deliberately: for a game this size a telegraphed opponent is a better
 * opponent than an inscrutable one, and knowing Blue is coming for your Home is
 * what lets you do something about it. Humans have the same lines and, unlike
 * the CPU, are free to lie with them.
 *
 * COSTS NOTHING. Quick chat changes no game state, so returning one costs the
 * turn nothing — the real action follows on the very next call. Two independent
 * latches stop it looping: the engine's own `quickChatsThisTurn` counter (at
 * most one CPU line per seat per turn) and `plan.announced`, which records what
 * was said so the same objective is never announced twice running.
 *
 * DETERMINISTIC, like everything else here: which line and whether to muse come
 * from a hash of (seed, turn, seat), so a seeded game still replays exactly.
 */

import type { Action, GameState, PlayerId, QuickChatId } from '../types';
import { QUICK_CHAT_MUSINGS, QUICK_CHAT_SCHEMES } from '../quickchat';
import { normalizeSeed } from '../rng';
import type { AiPlan, Objective } from './objectives';

/**
 * What to say for each kind of plan, most specific first. A CAPTURE_GARDEN
 * objective names the garden when it is one the catalogue has a line for, which
 * is what turns "Blue is doing something over there" into "Blue wants that
 * Mushroom".
 */
const SCHEME_LINES: Record<Objective['kind'], readonly QuickChatId[]> = {
  CAPTURE_GARDEN: ['eyeing-that-garden', 'staking-a-claim', 'that-one-there'],
  DEFEND_HOME: ['off-my-lawn', 'not-today', 'everyone-home'],
  ATTACK_ENEMY_HOME: ['coming-for-you', 'knock-knock', 'pack-your-pots'],
};

/** Garden-specific lines, which beat the generic CAPTURE_GARDEN ones. */
const GARDEN_LINES: Partial<Record<string, readonly QuickChatId[]>> = {
  mushroom: ['that-mushroom-is-mine', 'eyeing-that-garden', 'staking-a-claim'],
  dandelion: ['dandelion-calling', 'eyeing-that-garden', 'that-one-there'],
};

/** What to say about a posture, when there is no one target worth naming. */
const POSTURE_LINES: Record<AiPlan['strategy'], readonly QuickChatId[]> = {
  EXPAND: ['just-growing'],
  DEFEND: ['not-today'],
  PRESSURE: ['feeling-brave'],
  SURVIVE: ['regrouping'],
  FINISH: ['almost-there'],
};

/**
 * Turns of quiet after a scheme before the CPU will announce another of the
 * SAME kind.
 *
 * Without it the CPU narrates every re-target: it steps onto a garden, the
 * objective completes, it picks the next one, and says "I've got my eye on that
 * garden" again — four turns running, which reads as a gnome that cannot make
 * up its mind rather than one working through a plan. A change of KIND always
 * speaks through the cooldown, because that is the moment worth hearing about
 * ("…was coming for you, now it is running home").
 */
const SCHEME_COOLDOWN_TURNS = 4;

/** A stable key for "this is the same plan I last announced". */
function announcementKey(objective: Objective | null, plan: AiPlan): string {
  if (!objective) return `posture:${plan.strategy}`;
  return `${objective.kind}:${objective.targetPos.x},${objective.targetPos.y}`;
}

/** The lines that fit this plan, best-fitting first. */
function linesFor(objective: Objective | null, plan: AiPlan): readonly QuickChatId[] {
  if (!objective) return POSTURE_LINES[plan.strategy];
  if (objective.kind === 'CAPTURE_GARDEN' && objective.gardenType) {
    const specific = GARDEN_LINES[objective.gardenType];
    if (specific) return specific;
  }
  return SCHEME_LINES[objective.kind];
}

/**
 * One quick chat to say before acting, or null to just act.
 *
 * Announcing a new plan comes first and does not care whether a card was held —
 * a scheme is worth saying whatever else is going on. The old musing behaviour
 * is the fallback: a gnome sitting on a card it won't play has to do something
 * with its mouth.
 *
 * `plan` is the seat's live plan and is MUTATED here to record what was said.
 * That is what makes the announcement fire once per plan rather than once per
 * turn for as long as the plan lasts.
 */
export function idleChatter(
  state: GameState,
  actor: PlayerId,
  legal: readonly Action[],
  chosen: Action,
  plan: AiPlan,
): Action | null {
  if (state.players[actor].quickChatsThisTurn > 0) return null; // already spoke this turn

  const h = normalizeSeed(state.seed + (state.turn?.number ?? 0) * 131 + actor * 7919);
  const objective = plan.stack.length > 0 ? plan.stack[plan.stack.length - 1] : null;

  // 1. A plan it has not announced yet — if it is a new KIND of plan, or it has
  //    been quiet long enough that saying so is news rather than noise.
  const turn = state.turn?.number ?? 0;
  const key = announcementKey(objective, plan);
  const kind = objective?.kind ?? `posture:${plan.strategy}`;
  const newKind = kind !== plan.announcedKind;
  const rested = turn - (plan.announcedOnTurn ?? -SCHEME_COOLDOWN_TURNS) >= SCHEME_COOLDOWN_TURNS;
  if (plan.announced !== key && (newKind || rested)) {
    // Record it even if the phrase lookup fails, so a catalogue gap cannot
    // leave the seat re-checking the same plan every action of every turn.
    plan.announced = key;
    plan.announcedKind = kind;
    plan.announcedOnTurn = turn;
    const lines = linesFor(objective, plan);
    const known = lines.filter((id) => SPEAKABLE.has(id));
    if (known.length > 0) {
      return { type: 'quickChat', player: actor, phraseId: known[(h >>> 4) % known.length] };
    }
  }

  // 2. Nothing new to say: the old musing, when it is sitting on a playable card.
  if (chosen.type === 'playCard') return null; // it DID play a card
  if (!legal.some((a) => a.type === 'playCard')) return null; // nothing to hold back
  if (QUICK_CHAT_MUSINGS.length === 0) return null;
  if (h % 3 !== 0) return null; // ~1 turn in 3: chatter, not chatterbox
  const phrase = QUICK_CHAT_MUSINGS[(h >>> 8) % QUICK_CHAT_MUSINGS.length];
  return { type: 'quickChat', player: actor, phraseId: phrase.id };
}

/**
 * Ids the catalogue actually has. The tables above are written by hand, so this
 * is what stops a typo becoming a `BAD_ARGUMENT` throw mid-game — an unknown id
 * is simply not said. `quickchat.test.ts` asserts the tables are complete, so a
 * typo fails the suite rather than silently muting the CPU.
 */
const SPEAKABLE = new Set<QuickChatId>(QUICK_CHAT_SCHEMES.map((p) => p.id));

/** Every phrase id the CPU can say for a plan — for tests and for the docs. */
export const CPU_SCHEME_LINES: readonly QuickChatId[] = [
  ...new Set([
    ...Object.values(SCHEME_LINES).flat(),
    ...Object.values(GARDEN_LINES).flatMap((v) => v ?? []),
    ...Object.values(POSTURE_LINES).flat(),
  ]),
];
