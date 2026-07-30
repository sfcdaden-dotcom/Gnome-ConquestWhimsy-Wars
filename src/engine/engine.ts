/**
 * Core engine: reducer-style API.
 *
 *   applyAction(state, action) → new GameState   (pure; input never mutated;
 *                                                 illegal actions throw EngineError)
 *   getLegalActionIntents(state[, player]) → Action[]  (cheap, primary: card
 *                                                 plays left untargeted)
 *   getLegalActions(state[, player]) → Action[]  (analysis: the same actions
 *                                                 with every card target expanded)
 *   getPlayerToAct(state) → PlayerId | null
 *
 * After applying the requested action, the engine "settles": it auto-advances
 * everything that needs no human input and stops when it either needs a
 * decision (`state.pendingDecision`) or is idle in the active player's Action
 * Phase.
 *
 * This file is the façade. The implementation is split by responsibility:
 *
 *   actions.ts       action dispatch + the Action-Phase handlers
 *   turns.ts         roll-off, turn start/end, movement legality
 *   settle.ts        the auto-advance loop and its convergence diagnostics
 *   elimination.ts   eliminations, snailify, win detection
 *   legalActions.ts  legal-action INTENTS (the cheap, primary enumeration)
 *   actionExpansion.ts  exhaustive expansion of targeted card plays (analysis)
 *   gardens.ts       harvests, planting, entry effects
 *   fights.ts        fight resolution
 *   cards.ts         the card framework and the card stack
 */

import type { Action, GameState, PlayerId } from './types';
import { gnomesOnBoard, illegal, internal } from './helpers';
import { dispatch } from './actions';
import { settle } from './settle';
import { isPlayerView } from './view';

// Re-exported so `./engine` stays the single import site for the core API.
export { getPlayerToAct } from './turns';
export { getLegalActionIntents } from './legalActions';
export { getLegalActions, enumerateCompleteCardActions } from './actionExpansion';
export { getPendingDecisionOptions } from './targeting';

/**
 * Events kept on the state (rolling window). Bounds the per-action clone cost
 * so thousands-of-actions simulations stay O(actions), not O(actions²).
 */
const MAX_EVENTS = 1000;

export function isGameOver(state: GameState): boolean {
  return state.status === 'finished';
}

/**
 * Validate and apply one action, returning a NEW state (the input is never
 * mutated). Illegal or malformed actions throw EngineError with a clear
 * message and leave the input state untouched.
 */
export function applyAction(state: GameState, action: Action): GameState {
  // A redacted view is not a game. Its rngState is zeroed and its hidden zones
  // are placeholders, so applying actions to one would quietly diverge from
  // the authoritative game instead of failing (see view.ts).
  if (isPlayerView(state)) {
    internal('Cannot apply actions to a redacted PlayerView — use the authoritative state');
  }
  // Quick chat is the one action a finished game still accepts — "gg" belongs
  // after the last fight, and it can touch nothing but the event log anyway.
  if (state.status === 'finished' && action.type !== 'quickChat') {
    illegal(`The game is over (winner: ${state.winner === null ? 'none' : state.winner})`);
  }
  const draft = structuredClone(state) as GameState;
  dispatch(draft, action);
  settle(draft);
  if (draft.events.length > MAX_EVENTS) {
    draft.events.splice(0, draft.events.length - MAX_EVENTS);
  }
  return draft;
}

/** Convenience: number of gnomes `player` currently has on the board. */
export function boardGnomes(state: GameState, player: PlayerId): number {
  return gnomesOnBoard(state, player);
}
