/**
 * Idle chatter — the CPU's entire personality, and the only AI output that
 * changes no game state.
 */

import type { Action, GameState, PlayerId } from '../types';
import { QUICK_CHAT_MUSINGS } from '../quickchat';
import { normalizeSeed } from '../rng';

/**
 * A gnome sitting on a card it won't play has to do *something* with its mouth.
 *
 * When the CPU could play a Whimsy Card this Action Phase but picked another
 * action instead, it sometimes says one rhetorical line first (the `musings`
 * group — questions about hats and mushrooms, never anything about the board,
 * so a chatty CPU leaks no information a human opponent could read). Quick chat
 * changes nothing but the log, so this costs the turn nothing: the real action
 * follows on the next call.
 *
 * Deterministic, like everything else here: the coin flip and the phrase come
 * from a hash of (seed, turn, seat), so a seeded game still replays exactly.
 * It fires at most once per turn per seat — the engine's own
 * `quickChatsThisTurn` counter is the latch, so the AI cannot loop on it.
 */
export function idleChatter(
  state: GameState,
  actor: PlayerId,
  legal: readonly Action[],
  chosen: Action,
): Action | null {
  if (chosen.type === 'playCard') return null; // it DID play a card
  if (!legal.some((a) => a.type === 'playCard')) return null; // nothing to hold back
  if (state.players[actor].quickChatsThisTurn > 0) return null; // already mused this turn
  if (QUICK_CHAT_MUSINGS.length === 0) return null;

  const h = normalizeSeed(state.seed + (state.turn?.number ?? 0) * 131 + actor * 7919);
  if (h % 3 !== 0) return null; // ~1 turn in 3: chatter, not chatterbox
  const phrase = QUICK_CHAT_MUSINGS[(h >>> 8) % QUICK_CHAT_MUSINGS.length];
  return { type: 'quickChat', player: actor, phraseId: phrase.id };
}
