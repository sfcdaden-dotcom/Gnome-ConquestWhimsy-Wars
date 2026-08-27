/**
 * Self-play match recorder — data generation for training a learned CPU.
 *
 * Because the engine is deterministic and JSON-serializable, the complete,
 * faithful record of a game is just `config + seed + the ordered list of
 * actions`: replaying `createGame(config, seed)` and re-applying the actions
 * reconstructs every intermediate state, event and the winner exactly (the core
 * engine contract). So a MatchRecord stores nothing that can be regenerated —
 * no per-state features, no event dump — only what a replay cannot derive.
 *
 * The action list is the WHOLE game (however long it runs); it is never capped.
 * `maxActions` is only a runaway guard — reaching it marks the record
 * 'unfinished' rather than truncating a real episode. A finished game is a few
 * hundred small actions ≈ single-digit KB.
 *
 * We store the actions explicitly even though `chooseAiAction` is deterministic
 * (so today's self-play games are reproducible from the seed alone) because the
 * record must outlive the exact policy that produced it: a future exploring or
 * learned policy is not seed-reproducible, and neither are human games.
 *
 * This module uses ONLY the public engine API, mirroring the AI itself.
 */

import type { Action, CreateGameOptions, GameConfig, GameState, PlayerController, PlayerId } from './types';
import type { GameSeal } from './setup';
import { createGame, sealHiddenState } from './setup';
import { applyAction, isGameOver } from './engine';
import { winningSeats } from './teams';
import { chooseAiAction } from './ai';

/** Bump when the MatchRecord shape changes; dataset loaders gate on this.
 *  2: optional `seal` — a networked game's deck no longer follows from the seed
 *  alone, so replaying one needs the secret (see GameSeal in setup.ts). */
export const MATCH_RECORD_SCHEMA = 2;

/** Default runaway guard. Real games finish far below this (see engine tests). */
export const DEFAULT_MAX_ACTIONS = 10_000;

export type MatchEndReason =
  | 'lastStanding' // a single player won
  | 'draw' // the game finished with no winner
  | 'unfinished'; // hit the maxActions guard without finishing

export interface MatchResult {
  /**
   * The sole winning seat, or null. Null is NOT the same as "nobody won" now
   * that a team can win: check `winningTeam` for that, and read `winners` for
   * who won. Kept as-is because a free-for-all still has exactly one.
   */
  winner: PlayerId | null;
  /** The winning team, or null for a draw / unfinished game. */
  winningTeam: number | null;
  /** Every winning seat, in seat order. One entry in a free-for-all, two in a 2v2. */
  winners: PlayerId[];
  /** Names of `winners`, same order — the convenience `winnerName` gives for one seat. */
  winnerNames: string[];
  /** Convenience copies derived from the winning seat (null when no winner). */
  winnerName: string | null;
  winnerController: PlayerController | null;
  /** Highest global turn number reached — a coarse game-length measure. */
  turns: number;
  /** Number of actions applied (= `actions.length`). */
  actionCount: number;
  reason: MatchEndReason;
}

export interface MatchRecord {
  schemaVersion: number;
  /**
   * The fully-resolved config the game ran with — everything `createGame` needs
   * to rebuild the initial state, including the full seating (name / controller
   * / difficulty per seat). GameConfig satisfies CreateGameOptions, so
   * `createGame(config, seed)` replays it directly.
   */
  config: GameConfig;
  seed: number;
  /**
   * Present for a game whose deck was sealed behind a host secret
   * (`sealHiddenState`) — i.e. every networked game. Without it, `config +
   * seed` rebuilds the right BOARD but the wrong deck, so the replay diverges
   * at the first draw. Absent for local and self-play games, where the seed
   * alone is the whole story.
   *
   * It carries the commit–reveal envelope, not just the secret, so a finished
   * game is self-verifying: replay it, and check the seal the host published
   * at the start against the secret it published at the end.
   */
  seal?: GameSeal;
  /** The entire ordered action list. Not capped; not trimmed. */
  actions: Action[];
  result: MatchResult;
}

function summarize(final: GameState, actions: Action[], turns: number): MatchResult {
  const finished = isGameOver(final);
  const winner = final.winner;
  const wp = winner !== null ? final.players[winner] : null;
  const winners = winningSeats(final);
  // A draw is "nobody won", which is `winningTeam === null` — NOT
  // `winner === null`. A 2v2 win has two winners and leaves `winner` null;
  // reading that as a draw would misreport every team game.
  const reason: MatchEndReason = !finished
    ? 'unfinished'
    : final.winningTeam === null
      ? 'draw'
      : 'lastStanding';
  return {
    winner,
    winnerName: wp?.name ?? null,
    winnerController: wp?.controller ?? null,
    winningTeam: final.winningTeam,
    winners,
    winnerNames: winners.map((id) => final.players[id].name),
    turns,
    actionCount: actions.length,
    reason,
  };
}

/**
 * Play one CPU-vs-CPU game to completion, recording every action.
 *
 * Deterministic: same `(options, seed)` always yields an identical record.
 */
export function playSelfPlayGame(
  options: CreateGameOptions,
  seed: number,
  opts: { maxActions?: number } = {},
): MatchRecord {
  const maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS;
  let state = createGame(options, seed);
  const config = state.config; // resolved defaults, captured once up front
  const actions: Action[] = [];
  let turns = 0;

  while (!isGameOver(state) && actions.length < maxActions) {
    const action = chooseAiAction(state);
    actions.push(action);
    state = applyAction(state, action);
    turns = Math.max(turns, state.turn?.number ?? turns);
  }

  return { schemaVersion: MATCH_RECORD_SCHEMA, config, seed, actions, result: summarize(state, actions, turns) };
}

/**
 * Generate one record per seed (a batch dataset).
 *
 * Pass a count to use seeds `1..count`, or an explicit list of seeds.
 */
export function simulateSelfPlay(
  options: CreateGameOptions,
  seeds: number | number[],
  opts: { maxActions?: number } = {},
): MatchRecord[] {
  const list = typeof seeds === 'number' ? Array.from({ length: seeds }, (_, i) => i + 1) : seeds;
  return list.map((seed) => playSelfPlayGame(options, seed, opts));
}

/**
 * Rebuild the final state from a record by replaying it — the faithfulness
 * check that proves a record is a complete description of its game, and the
 * entry point a future trainer uses to regenerate intermediate states/features
 * on demand instead of storing them.
 */
export function replayMatch(record: MatchRecord): GameState {
  let state = createGame(record.config, record.seed);
  // A sealed game's deck was reshuffled under the host's secret at creation;
  // rebuild that exact deck before replaying a single action.
  if (record.seal) state = sealHiddenState(state, record.seal.secret);
  for (const action of record.actions) state = applyAction(state, action);
  return state;
}

/** Serialize records as newline-delimited JSON (one record per line) — the
 *  natural streaming dataset format for training. */
export function toNdjson(records: MatchRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

/** Parse newline-delimited JSON back into records (blank lines ignored). */
export function fromNdjson(text: string): MatchRecord[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MatchRecord);
}
