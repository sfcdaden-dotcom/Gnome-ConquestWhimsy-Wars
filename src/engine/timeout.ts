/**
 * Shot-clock enforcement: what a host applies when the player who must act
 * stops acting.
 *
 * The rules themselves are terminating — every legal action makes progress or
 * is bounded (1 move per unit per turn, Wishes gate planting/upgrading/drawing,
 * entry-effect chains are capped by MAX_ENTRY_EFFECT_HOPS). What the rules
 * cannot bound is a client that simply never sends an action, or that spins on
 * state-neutral actions (open card targeting → cancel → open it again). Those
 * need a clock, and a clock needs a defined default answer for every state the
 * engine can be waiting in — that default lives here so every host (and every
 * replay of a timed-out game) resolves it identically.
 *
 * The engine holds no wall clock and never times anything out by itself: the
 * host decides *when* the clock expires and calls `applyTimeout`.
 */

import type { Action, GameState, PlayerId } from './types';
import { applyAction } from './engine';
import { internal } from './helpers';
import { getLegalActionIntents } from './legalActions';
import { getPlayerToAct } from './turns';

/**
 * Safety bound on one `applyTimeout` call. A timed-out turn needs at most one
 * action per unit (Antsy Pants forces every gnome to move before the turn may
 * end) plus a handful of decisions, so this is a bug net, not a rule.
 */
export const MAX_TIMEOUT_STEPS = 500;

/**
 * The action to apply on behalf of a player whose clock expired: the most
 * passive legal option available, preferring in order
 *
 *   1. `declineEffect`   — decline an optional entry effect,
 *   2. `respondPass`     — pass a Respond window,
 *   3. `cancelTargeting` — back out of a half-built card play,
 *   4. `endTurn`         — end the Action Phase,
 *   5. otherwise the first action of the engine's own (deterministic) legal
 *      enumeration, which is what mandatory decisions offer: the first harvest
 *      source, `mushroomClones: 0`, the first slide/tunnel destination, the
 *      first forced move, and so on.
 *
 * Card plays are never chosen — a timed-out player never spends a card. Returns
 * null when nobody has to act (the game is over).
 */
export function getTimeoutAction(state: GameState): Action | null {
  const actor = getPlayerToAct(state);
  if (actor === null) return null;
  const legal = getLegalActionIntents(state, actor);
  if (legal.length === 0) return null;
  const prefer = (type: Action['type']) => legal.find((a) => a.type === type);
  return (
    prefer('declineEffect') ??
    prefer('respondPass') ??
    prefer('cancelTargeting') ??
    prefer('endTurn') ??
    legal.find((a) => a.type !== 'playCard' && a.type !== 'respondPlayCard') ??
    null
  );
}

/**
 * Play out a timeout for whoever must act right now: apply `getTimeoutAction`
 * repeatedly until control passes to somebody else (or the game ends). One call
 * therefore closes a whole stalled turn — including the forced moves Antsy Pants
 * demands before `endTurn` becomes legal — and is a no-op for a player who is
 * not the one on the clock.
 *
 * Pure like `applyAction`: the input state is never mutated.
 */
export function applyTimeout(state: GameState): GameState {
  const actor = getPlayerToAct(state);
  if (actor === null) return state;
  let s = state;
  for (let step = 0; step < MAX_TIMEOUT_STEPS; step++) {
    const next = getPlayerToAct(s);
    if (next === null || next !== actor) return s; // control moved on
    const action = getTimeoutAction(s);
    if (action === null) return s;
    s = applyAction(s, action);
  }
  internal(`timeout did not release player ${actor} within ${MAX_TIMEOUT_STEPS} actions (engine bug)`);
}

/** Is `player` the one on the clock right now? (Host convenience.) */
export function isOnTheClock(state: GameState, player: PlayerId): boolean {
  return getPlayerToAct(state) === player;
}
