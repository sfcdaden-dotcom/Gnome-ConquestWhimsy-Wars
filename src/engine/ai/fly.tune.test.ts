/**
 * Evaluator for the Fly's win-rate tuner (scripts/tune-fly.mjs). Skipped in the
 * normal test run. Given FLY_TUNE_PARAMS (a JSON file of settings) it plays the
 * fly with those settings over a fixed training pool of games and writes the
 * win count to FLY_TUNE_OUT.
 *
 * Pool: seeds 20001–(20000+FLY_TUNE_GAMES), clear of the 1–200 benchmark and
 * the brain trainer's 10001+; opponent alternates Normal / Hard every two games
 * and the fly alternates seats. The brain is blank and does not learn, so only
 * the settings differ between candidates.
 */

import { readFileSync, writeFileSync } from 'fs';
import { it } from 'vitest';
import type { AiDifficulty } from '../types';
import { applyAction, chooseAiAction, createAiMemory, createGame, isGameOver } from '../index';
import { FLY_FIGHT_ODDS, FLY_PRIORITY, FLY_THREAT, createFlyBrain } from './fly';
import type { OpponentProfiles } from './flyIntent';
import { FLY_INTENT } from './flyIntent';
import type { TunedFlyParams } from './tunedFlyParams';

const PARAMS = process.env.FLY_TUNE_PARAMS;
const GAMES = Number(process.env.FLY_TUNE_GAMES ?? 200);

it.skipIf(!PARAMS)(
  'evaluates one set of fly settings',
  () => {
    const t = JSON.parse(readFileSync(PARAMS!, 'utf8')) as TunedFlyParams;
    Object.assign(FLY_PRIORITY, t.priority);
    if (t.fightOdds) FLY_FIGHT_ODDS.splice(0, FLY_FIGHT_ODDS.length, ...t.fightOdds);
    Object.assign(FLY_THREAT, t.threat);
    Object.assign(FLY_INTENT, t.intent);

    const opponents: OpponentProfiles = new Map();
    let wins = 0;
    for (let g = 0; g < GAMES; g++) {
      const flySeat = g % 2;
      const opponent: AiDifficulty = g % 4 < 2 ? 'normal' : 'hard';
      const memory = createAiMemory({ flyBrain: createFlyBrain(), flyOpponents: opponents });
      const players = [0, 1].map((i) => ({
        name: i === flySeat ? 'Fly' : 'CPU',
        controller: 'cpu' as const,
        difficulty: i === flySeat ? ('fly' as const) : opponent,
      }));
      let s = createGame({ players, gardenPreset: 'fresh' }, 20001 + g);
      for (let i = 0; i < 10_000 && !isGameOver(s); i++) s = applyAction(s, chooseAiAction(s, memory));
      if (s.winner === flySeat) wins += 1;
    }
    writeFileSync(process.env.FLY_TUNE_OUT!, JSON.stringify({ wins, games: GAMES }));
  },
  3_600_000,
);
