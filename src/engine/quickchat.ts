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
      { id: 'coming-for-you', emoji: '⚔️', text: "I'm coming for you!" },
      { id: 'need-gnomes', emoji: '📦', text: 'I need more gnomes…' },
    ],
  },
  {
    // Rhetorical gnome chatter: says nothing about the board, answers nothing,
    // gives nothing away. This is the pool the CPU mutters from when it sits on
    // a playable card (see `idleChatter` in ai.ts) — and it is on every
    // player's menu too, because the CPU should not get better lines than you.
    id: 'musings',
    label: 'Musings',
    emoji: '🤔',
    phrases: [
      { id: 'why-the-hats', emoji: '🎩', text: 'Why do we even wear the hats?' },
      { id: 'under-a-mushroom', emoji: '🍄', text: "Ever wonder what's under a mushroom?" },
      { id: 'snail-dreams', emoji: '🐌', text: 'Do snails dream of faster gardens?' },
      { id: 'really-looked', emoji: '🌼', text: 'Have you ever really looked at a dandelion?' },
      { id: 'gnome-without-garden', emoji: '🧙', text: 'What is a gnome without a garden?' },
      { id: 'unmade-wishes', emoji: '✨', text: 'Where do Wishes go when nobody makes them?' },
      { id: 'where-tunnels-go', emoji: '🕳️', text: 'Where does that tunnel actually go?' },
      { id: 'grass-greener', emoji: '🌱', text: 'Is the grass greener over there?' },
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

/** The group id the CPU's idle chatter draws from (see ai.ts `idleChatter`). */
export const QUICK_CHAT_MUSINGS_GROUP = 'musings';

/** Rhetorical musings only — the CPU never comments on the actual board. */
export const QUICK_CHAT_MUSINGS: readonly QuickChatPhrase[] =
  QUICK_CHAT_GROUPS.find((g) => g.id === QUICK_CHAT_MUSINGS_GROUP)?.phrases ?? [];

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
