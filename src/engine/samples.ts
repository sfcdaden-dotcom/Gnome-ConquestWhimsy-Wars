/**
 * Sample extractor — Milestone 13 Phase 1 (learned CPU).
 *
 * Replays a MatchRecord (the Phase-0 recorder's `config + seed + actions`)
 * and, at every decision point, emits one training Sample:
 *
 *   { seat, obs, legalOptions, chosenIndex, reward }
 *
 * where `obs` is the acting seat's encoded information set, `legalOptions`
 * are the encoded entries of `getLegalActionIntents` (the SAME option set the
 * learned policy will score at play time), `chosenIndex` is the option the
 * recorded game actually took, and `reward` is the seat's terminal result
 * (+1 win / −1 loss / 0 draw).
 *
 * One-shot targeted plays are DECOMPOSED. The heuristic AI records a targeted
 * card play as a single action carrying its full `targets` payload, but the
 * learned policy acts through the engine's phased-targeting flow (play the
 * untargeted intent, then answer one `selectTarget` step at a time). So a
 * recorded `playCard`/`respondPlayCard` with targets becomes: one sample
 * choosing the untargeted intent, then — on a scratch branch that dispatches
 * that intent — one sample per targeting step, each picking the recorded
 * payload's next target from that step's live options. The real replay then
 * advances with the ORIGINAL recorded action, so extraction can never drift
 * from `replayMatch` (the scratch branch is discarded).
 *
 * Pure TS, no ML deps; uses only the public engine API.
 */

import type { Action, ActionType, CardTarget, CardTargets, GameState, PendingDecision, PlayerId } from './types';
import type { MatchRecord } from './selfplay';
import { createGame } from './setup';
import { applyAction } from './engine';
import { getLegalActionIntents } from './legalActions';
import { getPlayerToAct } from './turns';
import { getCardDef } from './cards';
import { encodeObservation, encodeOption } from './encode';

/** One decision point of one recorded game, ready for training. */
export interface Sample {
  /** The seat that made this decision (obs/options/reward are from its view). */
  seat: PlayerId;
  /** Encoded observation — see `encodeObservation`. */
  obs: Float32Array;
  /** Encoded legal options, aligned with the intent list at this state. */
  legalOptions: Float32Array[];
  /** Index into `legalOptions` of the option the recorded game took. */
  chosenIndex: number;
  /** Terminal reward for `seat`: +1 win, −1 loss, 0 draw. */
  reward: number;
  /** Action type of the chosen option (filtering/debugging). */
  actionType: ActionType;
  /** Pending-decision kind at this point, or null in the open Action Phase. */
  decisionKind: PendingDecision['kind'] | null;
  /** Global turn number (0 during the opening roll-off). */
  turnNumber: number;
}

export interface ExtractOptions {
  /**
   * Skip decision points with fewer than two legal options (they carry no
   * policy signal, though they still help value learning). Default false.
   */
  skipForced?: boolean;
  /**
   * How to treat records that hit the runaway guard (`reason: 'unfinished'`):
   * 'skip' (default) yields no samples; 'draw' emits them with reward 0.
   */
  unfinished?: 'skip' | 'draw';
}

/** Extract every decision point of one record. Throws (with the failing
 *  action's index) if the record does not replay as a legal game. */
export function extractSamples(record: MatchRecord, opts: ExtractOptions = {}): Sample[] {
  const skipForced = opts.skipForced ?? false;
  if (record.result.reason === 'unfinished' && (opts.unfinished ?? 'skip') === 'skip') return [];

  const winner = record.result.winner;
  const rewardFor = (seat: PlayerId) => (winner === null ? 0 : seat === winner ? 1 : -1);
  const samples: Sample[] = [];

  const emit = (state: GameState, seat: PlayerId, intents: Action[], chosenIndex: number) => {
    if (skipForced && intents.length < 2) return;
    samples.push({
      seat,
      obs: encodeObservation(state, seat),
      legalOptions: intents.map((a) => encodeOption(state, seat, a)),
      chosenIndex,
      reward: rewardFor(seat),
      actionType: intents[chosenIndex].type,
      decisionKind: state.pendingDecision?.kind ?? null,
      turnNumber: state.turn?.number ?? 0,
    });
  };

  let state = createGame(record.config, record.seed);
  record.actions.forEach((action, step) => {
    const fail = (msg: string): never => {
      throw new Error(`extractSamples: seed ${record.seed}, action ${step} (${action.type}): ${msg}`);
    };
    const seat = action.player;
    // Quick chat is not a decision point (it is never in the option set, and
    // "say nothing" is not an option the policy chooses): replay it, sample
    // nothing.
    if (action.type === 'quickChat') {
      state = applyAction(state, action);
      return;
    }
    // Decision-point model: the recorded actor must be the engine's player to
    // act. (A spontaneous out-of-turn Sudden Magic interrupt — possible for
    // humans, never emitted by the recorder's AI loop — has no well-defined
    // option set including "do nothing", so it is rejected, not mis-sampled.)
    if (getPlayerToAct(state) !== seat) {
      fail(`actor ${seat} is not the player to act (${getPlayerToAct(state)})`);
    }

    const intents = getLegalActionIntents(state);
    if (isTargetedPlay(action)) {
      const intent = stripTargets(action);
      const idx = intents.findIndex((a) => deepEqual(a, intent));
      if (idx < 0) fail(`untargeted intent for ${action.cardId} not in the legal intent list`);
      emit(state, seat, intents, idx);
      // Scratch branch: walk the phased-targeting flow this play compresses.
      let scratch = applyAction(state, intent);
      const consumed: CardTargets = {};
      for (;;) {
        const d = scratch.pendingDecision;
        if (d?.kind !== 'cardTargeting' || d.cardId !== action.cardId) break;
        const subIntents = getLegalActionIntents(scratch);
        const target =
          nextRecordedTarget(d, action.targets, consumed, subIntents) ??
          fail(`recorded targets for ${action.cardId} do not match step ${d.stepIndex + 1}/${d.stepCount} (${d.targetKind}) of its targeting flow`);
        const subIdx = subIntents.findIndex((a) => a.type === 'selectTarget' && deepEqual(a.target, target));
        if (subIdx < 0) fail(`target ${JSON.stringify(target)} not offered at step ${d.stepIndex + 1}`);
        emit(scratch, seat, subIntents, subIdx);
        consumeTarget(consumed, target);
        scratch = applyAction(scratch, subIntents[subIdx]);
      }
    } else {
      const idx = intents.findIndex((a) => deepEqual(a, action));
      if (idx < 0) fail('recorded action not in the legal intent list');
      emit(state, seat, intents, idx);
    }

    // The real replay always advances with the recorded action itself, so the
    // final state is exactly `replayMatch(record)`'s.
    state = applyAction(state, action);
  });

  return samples;
}

/** Flatten a batch of records into one dataset. */
export function extractDataset(records: MatchRecord[], opts: ExtractOptions = {}): Sample[] {
  return records.flatMap((r) => extractSamples(r, opts));
}

// ---------------------------------------------------------------------------
// Targeted-play decomposition helpers
// ---------------------------------------------------------------------------

type TargetedPlay = Extract<Action, { type: 'playCard' | 'respondPlayCard' }> & { targets: CardTargets };

/**
 * A recorded play carrying a `targets` payload for a card whose definition
 * actually takes targets — the one-shot form the extractor decomposes. (A
 * stray payload on an untargeted card would match no intent; there is no
 * such card play today, and the strict match would surface one loudly.)
 */
function isTargetedPlay(action: Action): action is TargetedPlay {
  return (
    (action.type === 'playCard' || action.type === 'respondPlayCard') &&
    action.targets !== undefined &&
    getCardDef(action.cardId)?.needsTargets === true
  );
}

function stripTargets(action: TargetedPlay): Action {
  return { type: action.type, player: action.player, cardId: action.cardId };
}

/**
 * The recorded payload's pick for the current targeting step. Positional
 * first (payload arrays are consumed in flow order); if that exact entry is
 * not among the step's live options, fall back to any not-yet-consumed
 * recorded entry of the step's kind that is (covers payloads whose
 * symmetric multi-picks were built in the opposite order).
 */
function nextRecordedTarget(
  d: Extract<PendingDecision, { kind: 'cardTargeting' }>,
  recorded: CardTargets,
  consumed: CardTargets,
  options: Action[],
): CardTarget | null {
  const offered = (t: CardTarget) => options.some((a) => a.type === 'selectTarget' && deepEqual(a.target, t));
  const pick = (candidates: CardTarget[], used: number): CardTarget | null => {
    const remaining = candidates.slice(used);
    if (remaining.length === 0) return null;
    if (offered(remaining[0])) return remaining[0];
    return remaining.find(offered) ?? null;
  };
  switch (d.targetKind) {
    case 'unit':
      return pick((recorded.units ?? []).map((unitId) => ({ kind: 'unit', unitId })), consumed.units?.length ?? 0);
    case 'space':
      return pick((recorded.spaces ?? []).map((pos) => ({ kind: 'space', pos })), consumed.spaces?.length ?? 0);
    case 'player':
      return pick((recorded.players ?? []).map((playerId) => ({ kind: 'player', playerId })), consumed.players?.length ?? 0);
    case 'card':
      return pick((recorded.cards ?? []).map((cardId) => ({ kind: 'card', cardId })), consumed.cards?.length ?? 0);
    case 'gardenType':
      return recorded.gardenType !== undefined ? { kind: 'gardenType', gardenType: recorded.gardenType } : null;
  }
}

/** Book a pick so the next same-kind step advances past it. */
function consumeTarget(consumed: CardTargets, t: CardTarget): void {
  if (t.kind === 'unit') (consumed.units ??= []).push(t.unitId);
  else if (t.kind === 'space') (consumed.spaces ??= []).push(t.pos);
  else if (t.kind === 'player') (consumed.players ??= []).push(t.playerId);
  else if (t.kind === 'card') (consumed.cards ??= []).push(t.cardId);
  else consumed.gardenType = t.gardenType;
}

// ---------------------------------------------------------------------------
// Structural action equality (plain JSON data by engine contract)
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
