/**
 * Quick chat: a fixed catalogue of phrases players can send each other.
 *
 * Free text is deliberately impossible — there is no "message" field anywhere
 * in the action, only a phrase id the engine looks up in this table. That kills
 * harassment, spoilers and out-of-band coordination in one move, and it means a
 * server never has to moderate anything: an unknown id is simply an illegal
 * action.
 *
 * Chat lives in the engine rather than beside it for the same reason the rest
 * of the game does — a multiplayer host already relays `applyAction`, so chat
 * relays, replays and (via the event log) renders with no extra plumbing, and
 * the anti-spam budget is enforced authoritatively instead of client-side.
 *
 * It is NOT a game action: `getLegalActionIntents` never lists it (chat is not
 * a move, and the AI/ML option space stays clean), it changes nothing but the
 * event log and the sender's remaining allowance, and any seat may send one at
 * any time — including out of turn, while a decision is open, or after the
 * game has finished.
 *
 * Two groups are load-bearing for the CPU rather than cosmetic: `schemes` is
 * how it announces the objective it just adopted, and `musings` is what it says
 * when it has nothing to announce. See `ai/chatter.ts`.
 *
 * PHRASE IDS ARE FOREVER. A `quickChat` action stores its id in the match
 * record, and `doQuickChat` rejects an id it cannot find — so deleting one
 * makes every stored record containing it un-replayable. Add freely; retire
 * only when you mean it.
 */

import type { GameState, PlayerId, QuickChatId, QuickChatPhrase, QuickChatTarget } from './types';
import { badArg, getPlayer, illegal, pushEvent } from './helpers';

/**
 * Quickchats one player may send per turn. Refilled for everyone at the start
 * of every turn (and once more when the game ends, so nobody is left unable to
 * say "gg"). Chat is the one action with no board cost, so without a budget it
 * would be the cheapest way left to grief a table.
 */
export const QUICK_CHAT_PER_TURN = 4;

/** Id of a phrase group (menu tab). */
export type QuickChatGroupId = string;

/** One menu tab of the quick-chat catalogue. */
export interface QuickChatGroup {
  id: QuickChatGroupId;
  label: string;
  phrases: readonly QuickChatPhrase[];
}

/** Phrase groups, in menu order. Ids are stable; only `text` is cosmetic. */
export const QUICK_CHAT_GROUPS: readonly QuickChatGroup[] = [
  {
    id: 'greetings',
    label: 'Greetings',
    phrases: [
      { id: 'yaaargh', text: 'YAAAARGH' },
      { id: 'hi', text: 'Hi!' },
      { id: 'good-luck', text: 'Good Luck!' },
      { id: 'good-game', text: 'Good Game!' },
    ],
  },
  {
    id: 'compliments',
    label: 'Compliments',
    phrases: [
      { id: 'nice-one', text: 'Nice One!' },
      { id: 'well-played', text: 'Well Played!' },
      { id: 'wow', text: 'Wow!' },
      { id: 'beautiful', text: 'Beautiful!' },
    ],
  },
  {
    id: 'reactions',
    label: 'Reactions',
    phrases: [
      { id: 'uh-oh', text: 'Uh Oh..' },
      { id: 'how-could-you', text: 'How could you!' },
      { id: 'hehe', text: 'Hehe' },
      { id: 'my-revenge', text: "I'll have my revenge!" },
    ],
  },
  {
    id: 'tactics',
    label: 'Tactics',
    phrases: [
      // The only line that names a person. `needs` is what makes the target
      // part of the phrase rather than an optional extra a client could attach
      // to anything (see `doQuickChat`).
      { id: 'coming-for-you', text: "I'm coming for you {{player.color}}...", needs: 'player' },
      { id: 'truce', text: 'Truce?' },
      { id: 'dig-dig-dig', text: 'Dig Dig Dig!' },
      { id: 'wheres-my-friends', text: "Where'd all my friends go?" },
    ],
  },
  {
    /**
     * What a gnome says when it has decided what it wants.
     *
     * This group is the CPU's voice for its plan: `idleChatter` picks the line
     * that matches the objective it just adopted, so a seat that turns around
     * to defend its Home says so, and says something different when it goes
     * back to the garden it was after. That is the whole point — the CPU is
     * meant to be READ, and a plan nobody can see is not a plan anybody enjoys
     * playing against.
     *
     * It follows that a CPU seat leaks its intentions. That is deliberate:
     * telegraphing beats inscrutability for a game this size, and a human
     * reading these lines gets a chance to respond to the plan. Humans get the
     * same lines and, unlike the CPU, can lie with them.
     */
    id: 'schemes',
    label: 'Schemes',
    phrases: [
      { id: 'need-a-wish', text: 'I could really use a wish right now...' },
      { id: 'staking-a-claim', text: "I'm staking my claim." },
      // Names a square. The CPU fills it from the objective it just adopted,
      // which is what turns "Blue is up to something" into "Blue wants (3,4)".
      { id: 'one-day-that-garden', text: "One day I'll have the garden on ({{space}})", needs: 'space' },
      { id: 'scram', text: 'SCRAM!' },
      { id: 'retreat', text: 'RETREAT!' },
      { id: 'love-gardening', text: 'I love gardening.' },
      { id: 'life-on-the-edge', text: "I'm gonna live life on the edge." },
    ],
  },
  {
    // Rhetorical gnome chatter: says nothing about the board, answers nothing,
    // gives nothing away. This is what the CPU mutters when it has nothing to
    // announce — the filler between schemes (see `idleChatter` in ai/chatter.ts).
    id: 'musings',
    label: 'Musings',
    phrases: [
      { id: 'why-fighting', text: 'Why are we fighting again?' },
      { id: 'ever-seen-a-snail', text: 'Has anyone ever SEEN a snail?' },
      { id: 'looove-gardening', text: 'I Looove Gardening!' },
      { id: 'wish-for-more-wishes', text: 'Can I wish for more wishes?' },
      { id: 'too-old-for-this', text: "I'm too old for this." },
    ],
  },
  {
    id: 'manners',
    label: 'Manners',
    phrases: [
      { id: 'sorry', text: 'Sorry!' },
      { id: 'thanks', text: 'Thanks!' },
      { id: 'no-worries', text: 'No Worries!' },
      { id: 'oops', text: 'Oops...' },
    ],
  },
];

/** Every phrase, flattened (menu order preserved). */
export const QUICK_CHAT_PHRASES: readonly QuickChatPhrase[] = QUICK_CHAT_GROUPS.flatMap((g) => g.phrases);

const phraseById = new Map<QuickChatId, QuickChatPhrase>(QUICK_CHAT_PHRASES.map((p) => [p.id, p]));

/** The two groups the CPU speaks from (see `ai/chatter.ts`). */
export const QUICK_CHAT_MUSINGS_GROUP = 'musings';
export const QUICK_CHAT_SCHEMES_GROUP = 'schemes';

const groupPhrases = (id: QuickChatGroupId): readonly QuickChatPhrase[] =>
  QUICK_CHAT_GROUPS.find((g) => g.id === id)?.phrases ?? [];

/** Rhetorical musings — what the CPU says when it has no plan to announce. */
export const QUICK_CHAT_MUSINGS: readonly QuickChatPhrase[] = groupPhrases(QUICK_CHAT_MUSINGS_GROUP);

/** Plan lines — what the CPU says when it has just decided what it wants. */
export const QUICK_CHAT_SCHEMES: readonly QuickChatPhrase[] = groupPhrases(QUICK_CHAT_SCHEMES_GROUP);

/** The phrase for an id, or null when the id is not in the catalogue. */
export function getQuickChatPhrase(id: QuickChatId): QuickChatPhrase | null {
  return phraseById.get(id) ?? null;
}

/** Quickchats `player` may still send before their allowance refills. */
export function quickChatsLeft(state: GameState, player: PlayerId): number {
  const p = state.players[player];
  if (!p) return 0;
  return Math.max(0, QUICK_CHAT_PER_TURN - p.quickChatsThisTurn);
}

/** Reset every seat's allowance (turn start, and once when the game ends). */
export function refillQuickChat(draft: GameState): void {
  for (const p of draft.players) p.quickChatsThisTurn = 0;
}

/**
 * Check a target against the phrase that is supposed to carry it.
 *
 * Both directions matter. A phrase that needs a target cannot be sent without
 * one, or its line renders with a hole in it. A phrase that needs none cannot
 * be sent WITH one, which is the part worth enforcing: the target travels in
 * the match record and out to every seat, so a line that never displays it
 * would otherwise be a free side-channel for pointing at a square.
 */
function checkTarget(
  draft: GameState,
  speaker: PlayerId,
  phrase: QuickChatPhrase,
  target?: QuickChatTarget,
): void {
  if (!phrase.needs) {
    if (target) badArg(`Quick chat phrase ${phrase.id} takes no target`);
    return;
  }
  if (!target) badArg(`Quick chat phrase ${phrase.id} needs a ${phrase.needs} target`);
  if (target.kind !== phrase.needs) {
    badArg(`Quick chat phrase ${phrase.id} needs a ${phrase.needs} target, got ${target.kind}`);
  }
  if (target.kind === 'player') {
    if (!draft.players[target.player]) badArg(`No such player: ${target.player}`);
    // Pointing this at yourself is a mis-click, not a taunt.
    if (target.player === speaker) badArg('Cannot aim that line at yourself');
  } else {
    const n = draft.config.boardSize;
    const { x, y } = target.pos;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
      badArg(`Target space (${x},${y}) is off the board`);
    }
  }
}

export function doQuickChat(
  draft: GameState,
  player: PlayerId,
  phraseId: QuickChatId,
  target?: QuickChatTarget,
): void {
  const p = getPlayer(draft, player);
  const phrase = getQuickChatPhrase(phraseId);
  if (!phrase) badArg(`Unknown quick chat phrase: ${phraseId}`);
  checkTarget(draft, player, phrase, target);
  if (p.quickChatsThisTurn >= QUICK_CHAT_PER_TURN) {
    illegal(`Quick chat limit reached (${QUICK_CHAT_PER_TURN} per turn) — wait for the next turn`);
  }
  p.quickChatsThisTurn += 1;
  pushEvent(draft, {
    type: 'quickChatSaid',
    player,
    phraseId: phrase.id,
    ...(target ? { target } : {}),
  });
}
