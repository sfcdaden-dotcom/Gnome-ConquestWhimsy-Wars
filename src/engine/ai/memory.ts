/**
 * Where the CPU's plan lives between actions and between turns.
 *
 * `GameState` deliberately does not carry it. The state is cloned on every
 * action, encoded, hashed, sealed and shipped to clients — putting AI
 * bookkeeping in it would change the wire format, the match record and the
 * replay digest for something no rule depends on. So the plan lives beside the
 * state, in a store the caller owns:
 *
 *     const memory = createAiMemory();
 *     dispatch(chooseAiAction(state, memory));
 *
 * ADVISORY, NEVER AUTHORITATIVE. A store can always be empty — a fresh page
 * load, a Durable Object woken from hibernation, a room rebuilt by replaying
 * its record. Losing it costs the CPU its current intention and nothing else:
 * `updatePlan` immediately derives a new one from the board. That is what keeps
 * a stateful AI compatible with a system whose whole persistence model is
 * "store the actions, replay them" — the AI is never re-run during a replay,
 * and its memory is never part of the game's truth.
 *
 * The module-level `sharedAiMemory` backs the one-argument `chooseAiAction`
 * that most call sites (and every existing test) use. It self-resets when it
 * sees a different game: entries remember the seed they were built for and the
 * `eventCount` they last saw, and a state that is a different game — or the
 * same seed replayed from the start — clears the seat. Two DIFFERENT games with
 * the SAME seed interleaved in one process will thrash that guard; they get
 * correct but forgetful play, which is exactly the graceful degradation above.
 * Pass an explicit store to avoid it.
 */

import type { GameState, PlayerId } from '../types';
import type { AiPlan } from './objectives';

/** Opaque per-game, per-seat plan storage. Created by `createAiMemory`. */
export interface AiMemory {
  readonly seats: Map<PlayerId, SeatMemory>;
}

interface SeatMemory {
  seed: number;
  lastEventCount: number;
  plan: AiPlan;
}

export function createAiMemory(): AiMemory {
  return { seats: new Map() };
}

/** The default store, used when a caller does not supply one. */
export const sharedAiMemory: AiMemory = createAiMemory();

/**
 * The seat's plan, resetting it unless this state looks like a continuation of
 * the one we last saw: same seed, and neither the event count nor the turn
 * number has gone backwards. Both checks are cheap, and both are "is this the
 * same game still running?" rather than proof — see the module comment for what
 * a false positive costs (a forgotten intention, nothing more).
 */
export function planFor(memory: AiMemory, state: GameState, player: PlayerId): AiPlan {
  const existing = memory.seats.get(player);
  const turn = state.turn?.number ?? 0;
  if (
    existing &&
    existing.seed === state.seed &&
    state.eventCount >= existing.lastEventCount &&
    turn >= existing.plan.plannedOnTurn
  ) {
    existing.lastEventCount = state.eventCount;
    return existing.plan;
  }
  const fresh: SeatMemory = {
    seed: state.seed,
    lastEventCount: state.eventCount,
    plan: { strategy: 'EXPAND', stack: [], plannedOnTurn: -1 },
  };
  memory.seats.set(player, fresh);
  return fresh.plan;
}

/** Forget everything. Exposed for tests and for a host starting a new game. */
export function clearAiMemory(memory: AiMemory): void {
  memory.seats.clear();
}
