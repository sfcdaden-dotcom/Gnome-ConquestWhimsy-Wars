/**
 * Sample extractor tests (Milestone 13 Phase 1).
 *
 * Load-bearing properties:
 *  - COVERAGE: every recorded action yields at least one sample (more when a
 *    one-shot targeted play decomposes into targeting steps), each pointing
 *    at a real entry of the legal option list at that state.
 *  - DECISION SPACE: samples live in the SAME option space the learned policy
 *    will act in (`getLegalActionIntents`), so targeted plays appear as an
 *    intent pick plus per-step `selectTarget` picks — never as one giant
 *    combined action.
 *  - REWARD JOIN: every sample carries its seat's terminal reward.
 */

import { describe, expect, it } from 'vitest';
import type { CreateGameOptions, MatchRecord } from './index';
import {
  OPTION_SIZE,
  extractDataset,
  extractSamples,
  obsSize,
  playSelfPlayGame,
  simulateSelfPlay,
} from './index';

const TWO_HARD: CreateGameOptions = {
  players: [
    { name: 'North', controller: 'cpu', difficulty: 'hard' },
    { name: 'South', controller: 'cpu', difficulty: 'hard' },
  ],
};

/** A wish-rich economy: with garden upgrades in the game, the default-config
 *  AI sinks its wishes into planting + upgrading and (in the seeds scanned
 *  here) never draws a card, so this scenario raises the wish economy until
 *  card plays actually happen. The extractor is what's under test, not the
 *  AI's spending priorities. */
const TWO_HARD_CARD_RICH: CreateGameOptions = { ...TWO_HARD, startingWishes: 6, wishLimit: 6 };

/** First seed in 1..8 whose record contains a one-shot targeted card play —
 *  the case the extractor must decompose. Deterministic (fixed AI + seeds). */
function recordWithTargetedPlay(): MatchRecord {
  for (let seed = 1; seed <= 8; seed++) {
    const rec = playSelfPlayGame(TWO_HARD_CARD_RICH, seed);
    if (rec.actions.some((a) => (a.type === 'playCard' || a.type === 'respondPlayCard') && a.targets !== undefined)) {
      return rec;
    }
  }
  throw new Error('no seed in 1..8 produced a targeted card play');
}

describe('extractSamples', () => {
  it('emits one well-formed sample per decision point of a finished game', () => {
    const rec = playSelfPlayGame(TWO_HARD, 1);
    const samples = extractSamples(rec);
    // At least one sample per recorded action (decomposition only adds more).
    expect(samples.length).toBeGreaterThanOrEqual(rec.actions.length);

    const winner = rec.result.winner!;
    for (const s of samples) {
      expect(s.obs.length).toBe(obsSize(rec.config.boardSize));
      expect(s.legalOptions.length).toBeGreaterThan(0);
      for (const o of s.legalOptions) expect(o.length).toBe(OPTION_SIZE);
      expect(s.chosenIndex).toBeGreaterThanOrEqual(0);
      expect(s.chosenIndex).toBeLessThan(s.legalOptions.length);
      expect(s.reward).toBe(s.seat === winner ? 1 : -1);
    }
    // Both seats decided things; some decisions offered a real choice.
    expect(new Set(samples.map((s) => s.seat)).size).toBe(2);
    expect(samples.some((s) => s.legalOptions.length > 1)).toBe(true);
  });

  it('decomposes one-shot targeted plays into intent + selectTarget samples', () => {
    const rec = recordWithTargetedPlay();
    const samples = extractSamples(rec);
    const recordedSelects = rec.actions.filter((a) => a.type === 'selectTarget').length;
    const sampledSelects = samples.filter((s) => s.actionType === 'selectTarget').length;
    // The decomposition manufactures targeting-step samples that the record
    // itself never contained.
    expect(sampledSelects).toBeGreaterThan(recordedSelects);
    // Each manufactured step was sampled inside a live cardTargeting decision.
    for (const s of samples) {
      if (s.actionType === 'selectTarget') expect(s.decisionKind).toBe('cardTargeting');
    }
    // Decomposition adds samples beyond one-per-action.
    expect(samples.length).toBeGreaterThan(rec.actions.length);
  });

  it('skipForced drops single-option decision points (e.g. roll-off)', () => {
    const rec = playSelfPlayGame(TWO_HARD, 2);
    const all = extractSamples(rec);
    const choices = extractSamples(rec, { skipForced: true });
    expect(choices.length).toBeLessThan(all.length);
    expect(choices.every((s) => s.legalOptions.length >= 2)).toBe(true);
    // The default keeps forced points (they still train the value head).
    expect(all.some((s) => s.legalOptions.length === 1)).toBe(true);
  });

  it('skips unfinished records by default, or joins them as draws on request', () => {
    const rec = playSelfPlayGame(TWO_HARD, 1, { maxActions: 40 });
    expect(rec.result.reason).toBe('unfinished');
    expect(extractSamples(rec)).toEqual([]);
    const asDraws = extractSamples(rec, { unfinished: 'draw' });
    expect(asDraws.length).toBeGreaterThan(0);
    expect(asDraws.every((s) => s.reward === 0)).toBe(true);
  });

  it('is deterministic', () => {
    const rec = playSelfPlayGame(TWO_HARD, 3);
    expect(extractSamples(rec)).toEqual(extractSamples(rec));
  });

  it('handles a 4-player game: one winning seat, three losing seats', () => {
    const rec = playSelfPlayGame(
      {
        players: [
          { name: 'P0', controller: 'cpu', difficulty: 'hard' },
          { name: 'P1', controller: 'cpu', difficulty: 'hard' },
          { name: 'P2', controller: 'cpu', difficulty: 'hard' },
          { name: 'P3', controller: 'cpu', difficulty: 'hard' },
        ],
        gardenPreset: 'few',
      },
      1,
    );
    const samples = extractSamples(rec);
    expect(samples.length).toBeGreaterThanOrEqual(rec.actions.length);
    const winner = rec.result.winner!;
    const rewardsBySeat = new Map<number, Set<number>>();
    for (const s of samples) {
      rewardsBySeat.set(s.seat, (rewardsBySeat.get(s.seat) ?? new Set()).add(s.reward));
    }
    for (const [seat, rewards] of rewardsBySeat) {
      expect([...rewards]).toEqual([seat === winner ? 1 : -1]);
    }
  });

  it('rejects a record whose actions do not replay as legal choices', () => {
    const rec = playSelfPlayGame(TWO_HARD, 1);
    const broken: MatchRecord = structuredClone(rec);
    // An endTurn by the wrong seat at the first decision (a roll-off).
    broken.actions[0] = { type: 'endTurn', player: 1 - broken.actions[0].player };
    expect(() => extractSamples(broken)).toThrow(/action 0/);
  });
});

describe('extractDataset', () => {
  it('flattens a batch of records', () => {
    const recs = simulateSelfPlay(TWO_HARD, [1, 2]);
    const flat = extractDataset(recs);
    const separate = recs.flatMap((r) => extractSamples(r));
    expect(flat.length).toBe(separate.length);
    expect(flat).toEqual(separate);
  });
});
