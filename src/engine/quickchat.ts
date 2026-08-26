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

import type { GameState, PlayerId, QuickChatId, QuickChatPhrase } from './types';
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
  emoji: string;
  phrases: readonly QuickChatPhrase[];
}

/** Phrase groups, in menu order. Ids are stable; only `text` is cosmetic. */
export const QUICK_CHAT_GROUPS: readonly QuickChatGroup[] = [
  {
    id: 'greetings',
    label: 'Greetings',
    emoji: '👋',
    phrases: [
      { id: 'hi', emoji: '👋', text: 'Hi!' },
      { id: 'good-luck', emoji: '🍀', text: 'Good luck!' },
      { id: 'have-fun', emoji: '🎉', text: 'Have fun!' },
      { id: 'gg', emoji: '🤝', text: 'Good game!' },
    ],
  },
  {
    id: 'compliments',
    label: 'Compliments',
    emoji: '👏',
    phrases: [
      { id: 'nice-move', emoji: '👏', text: 'Nice move!' },
      { id: 'great-garden', emoji: '🌻', text: 'Great garden!' },
      { id: 'well-played', emoji: '🏅', text: 'Well played!' },
      { id: 'wow', emoji: '😲', text: 'Wow!' },
    ],
  },
  {
    id: 'reactions',
    label: 'Reactions',
    emoji: '😱',
    phrases: [
      { id: 'oh-no', emoji: '😱', text: 'Oh no!' },
      { id: 'my-gnomes', emoji: '🧙', text: 'My gnomes!' },
      { id: 'so-lucky', emoji: '🎲', text: 'That was lucky!' },
      { id: 'close-one', emoji: '😅', text: 'Close one!' },
    ],
  },
  {
    id: 'tactics',
    label: 'Tactics',
    emoji: '🧭',
    phrases: [
      { id: 'watch-the-flytrap', emoji: '🪰', text: 'Watch the flytrap!' },
      { id: 'taking-the-tunnel', emoji: '🕳️', text: 'Taking the tunnel!' },
      { id: 'need-gnomes', emoji: '📦', text: 'I need more gnomes…' },
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
     * It follows that a CPU seat now leaks its intentions. That is deliberate:
     * telegraphing beats inscrutability for a game this size, and a human
     * reading these lines gets a chance to respond to the plan (which is what
     * makes the CPU feel like an opponent rather than a dice roll). Humans get
     * the same lines and, unlike the CPU, can lie with them.
     */
    id: 'schemes',
    label: 'Schemes',
    emoji: '🗺️',
    phrases: [
      // Going after a garden.
      { id: 'eyeing-that-garden', emoji: '🌷', text: "I've got my eye on that garden." },
      { id: 'that-mushroom-is-mine', emoji: '🍄', text: 'That mushroom is mine.' },
      { id: 'dandelion-calling', emoji: '🌼', text: 'That dandelion is calling my name.' },
      { id: 'staking-a-claim', emoji: '🚩', text: 'Staking my claim.' },
      { id: 'that-one-there', emoji: '👀', text: "That one. That's the one I want." },
      // Defending our own.
      { id: 'off-my-lawn', emoji: '🧹', text: 'Get off my lawn!' },
      { id: 'not-today', emoji: '🛡️', text: 'Not my home. Not today.' },
      { id: 'everyone-home', emoji: '🏡', text: 'Everyone back to the garden!' },
      // Marching on somebody else's.
      { id: 'coming-for-you', emoji: '⚔️', text: "I'm coming for you!" },
      { id: 'knock-knock', emoji: '🚪', text: 'Knock knock.' },
      { id: 'pack-your-pots', emoji: '📦', text: "Pack your pots, I'm moving in." },
      // Posture, when there is no one target to name.
      { id: 'just-growing', emoji: '🌱', text: 'Just growing quietly over here.' },
      { id: 'feeling-brave', emoji: '😈', text: 'Feeling brave today.' },
      { id: 'regrouping', emoji: '🐌', text: 'Regrouping. Ignore me.' },
      { id: 'almost-there', emoji: '🏁', text: 'Almost there…' },
    ],
  },
  {
    // Rhetorical gnome chatter: says nothing about the board, answers nothing,
    // gives nothing away. This is what the CPU mutters when it has nothing to
    // announce — the filler between schemes (see `idleChatter` in ai/chatter.ts).
    id: 'musings',
    label: 'Musings',
    emoji: '🤔',
    phrases: [
      { id: 'why-the-hats', emoji: '🎩', text: 'Why do we even wear the hats?' },
      { id: 'under-a-mushroom', emoji: '🍄', text: "Ever wonder what's under a mushroom?" },
      { id: 'snail-dreams', emoji: '🐌', text: 'Do snails dream of faster gardens?' },
      { id: 'gnome-without-garden', emoji: '🧙', text: 'What is a gnome without a garden?' },
      { id: 'unmade-wishes', emoji: '✨', text: 'Where do Wishes go when nobody makes them?' },
      { id: 'where-tunnels-go', emoji: '🕳️', text: 'Where does that tunnel actually go?' },
    ],
  },
  {
    id: 'manners',
    label: 'Manners',
    emoji: '🙇',
    phrases: [
      { id: 'sorry', emoji: '🙇', text: 'Sorry!' },
      { id: 'no-worries', emoji: '😊', text: 'No worries!' },
      { id: 'take-your-time', emoji: '⏳', text: 'Take your time.' },
      { id: 'thanks', emoji: '💚', text: 'Thanks!' },
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

export function doQuickChat(draft: GameState, player: PlayerId, phraseId: QuickChatId): void {
  const p = getPlayer(draft, player);
  const phrase = getQuickChatPhrase(phraseId);
  if (!phrase) badArg(`Unknown quick chat phrase: ${phraseId}`);
  if (p.quickChatsThisTurn >= QUICK_CHAT_PER_TURN) {
    illegal(`Quick chat limit reached (${QUICK_CHAT_PER_TURN} per turn) — wait for the next turn`);
  }
  p.quickChatsThisTurn += 1;
  pushEvent(draft, { type: 'quickChatSaid', player, phraseId: phrase.id });
}
