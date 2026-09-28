/**
 * The Fly seat: it plays whole games, learns from them, carries what it learned
 * into the next game, and keeps to its fight rules.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Action, GameState, PlayerId, Pos } from '../types';
import { applyAction, chooseAiAction, createAiMemory, createGame, isGameOver } from '../index';
import { mutate, toActionPhase, withGarden, withGnome } from '../testkit';
import type { FlyBrain } from './fly';
import {
  FLY_FIGHT_ODDS,
  FLY_THREAT,
  createFlyBrain,
  createFlyMemory,
  finishFlyGames,
  flyBias,
  flyBrake,
  flyDrives,
  flyObserve,
  flyRewardLog,
  flyTags,
  parseFlyBrain,
} from './fly';
import { END_TURN_SCORE } from './scoring';
import { FLY_BRAIN } from './flyBrain';

/**
 * The hand-written rules (fight odds, garden alarm) are tested with the
 * connectome switched off, so its urges do not move the thresholds under test;
 * flyBrain.test.ts covers the brain.
 */
function withoutBrain(): void {
  beforeAll(() => {
    FLY_BRAIN.enabled = false;
  });
  afterAll(() => {
    FLY_BRAIN.enabled = true;
  });
}

/** Fly (seat 0) against a Normal CPU (seat 1), to the end. */
function playFlyGame(seed: number, brain: FlyBrain): { state: GameState; memory: ReturnType<typeof createAiMemory> } {
  const memory = createAiMemory({ flyBrain: brain, flyLearn: true });
  let s = createGame(
    {
      players: [
        { name: 'Fly', controller: 'cpu', difficulty: 'fly' },
        { name: 'Steady', controller: 'cpu', difficulty: 'normal' },
      ],
      gardenPreset: 'fresh',
    },
    seed,
  );
  for (let i = 0; i < 6000 && !isGameOver(s); i++) s = applyAction(s, chooseAiAction(s, memory));
  finishFlyGames(s, memory.fly);
  return { state: s, memory };
}

describe('fly: whole games', () => {
  it('finishes games against a Normal CPU and learns from them', () => {
    const brain = createFlyBrain();
    for (const seed of [1, 2, 3]) {
      const { state, memory } = playFlyGame(seed, brain);
      expect(state.status).toBe('finished');
      expect(flyRewardLog(memory.fly, 0).length).toBeGreaterThan(0);
    }
    expect(brain.gamesPlayed).toBe(3);
    expect(Object.keys(brain.values).length).toBeGreaterThan(0);
  });

  it('carries the same brain from one game into the next', () => {
    const brain = createFlyBrain();
    playFlyGame(7, brain);
    const afterOne = structuredClone(brain.values);
    playFlyGame(8, brain);
    expect(brain.gamesPlayed).toBe(2);
    expect(brain.values).not.toEqual(afterOne);
  });

  it('learns nothing mid-match, only in the post-game review', () => {
    const brain = createFlyBrain();
    const memory = createAiMemory({ flyBrain: brain, flyLearn: true });
    let s = createGame(
      {
        players: [
          { name: 'Fly', controller: 'cpu', difficulty: 'fly' },
          { name: 'Steady', controller: 'cpu', difficulty: 'normal' },
        ],
        gardenPreset: 'fresh',
      },
      5,
    );
    for (let i = 0; i < 6000 && !isGameOver(s); i++) s = applyAction(s, chooseAiAction(s, memory));
    expect(s.status).toBe('finished');
    expect(brain.values).toEqual({});
    expect(flyRewardLog(memory.fly, 0).length).toBeGreaterThan(0);
    finishFlyGames(s, memory.fly);
    expect(Object.keys(brain.values).length).toBeGreaterThan(0);
  });

  it('counts a finished game only once', () => {
    const brain = createFlyBrain();
    const { state, memory } = playFlyGame(4, brain);
    finishFlyGames(state, memory.fly);
    expect(brain.gamesPlayed).toBe(1);
  });
});

describe('fly: brain file', () => {
  it('round-trips through JSON', () => {
    const brain: FlyBrain = { version: 2, gamesPlayed: 5, values: { 'calm:territory': 1.25 }, attraction: { killGnome: 0.4 } };
    expect(parseFlyBrain(JSON.stringify(brain))).toEqual(brain);
  });

  it('rejects anything that is not a current brain', () => {
    expect(parseFlyBrain('nope')).toBeNull();
    // Version 1 brains learned live, and their values mean something else.
    expect(parseFlyBrain('{"version":1,"gamesPlayed":0,"values":{}}')).toBeNull();
    expect(parseFlyBrain('{"version":2,"gamesPlayed":0,"values":{"calm:fight":"x"}}')?.values).toEqual({});
  });
});

describe('fly: fight rules', () => {
  withoutBrain();
  /** Fly's turn, Action Phase, with `defenders` enemy gnomes stacked on `at`. */
  function scene(defenders: number, gnomesLost = 0): { state: GameState; fly: PlayerId; at: Pos } {
    let s = toActionPhase(11);
    const fly = s.turn!.activePlayer;
    const enemy = (1 - fly) as PlayerId;
    s = mutate(s, (d) => {
      d.players[fly].difficulty = 'fly';
      d.players[fly].gnomesLost = gnomesLost;
    });
    const at = { x: 3, y: 3 };
    for (let i = 0; i < defenders; i++) s = withGnome(s, enemy, at).state;
    return { state: s, fly, at };
  }

  function brake(state: GameState, fly: PlayerId, at: Pos, fightsSoFar: number): number {
    const ctx = flyObserve(state, fly, createFlyMemory());
    ctx.episode.fightsThisTurn = fightsSoFar;
    const move: Action = { type: 'move', player: fly, unitId: 'any', to: at };
    return flyBrake(ctx, state, fly, move, 5);
  }

  const passed = (score: number) => score > END_TURN_SCORE;

  it('takes a fair 1v1 as its first fight of the turn', () => {
    const { state, fly, at } = scene(1);
    expect(FLY_FIGHT_ODDS[0]).toBeLessThan(0.5);
    expect(passed(brake(state, fly, at, 0))).toBe(true);
  });

  it('refuses a second coin-flip fight in the same turn', () => {
    const { state, fly, at } = scene(1);
    expect(passed(brake(state, fly, at, 1))).toBe(false);
  });

  it('refuses to attack into a stack of two', () => {
    const { state, fly, at } = scene(2);
    expect(passed(brake(state, fly, at, 0))).toBe(false);
  });

  it('refuses even a first coin flip when reinforcements run low', () => {
    const { state, fly, at } = scene(1, state0TotalMinus(2));
    expect(passed(brake(state, fly, at, 0))).toBe(false);
  });

  it('leaves non-fights alone', () => {
    const { state, fly } = scene(0);
    expect(brake(state, fly, { x: 0, y: 0 }, 2)).toBe(5);
  });
});

describe('fly: tags', () => {
  it('tags a move onto an unheld economy garden as territory and harvest', () => {
    let s = toActionPhase(11);
    const fly = s.turn!.activePlayer;
    s = mutate(s, (d) => {
      d.gardens['2,2'] = { type: 'mushroom', plantedOnTurn: 0, stunnedForPlayerTurn: null, doubledForPlayerTurn: null };
    });
    const move: Action = { type: 'move', player: fly, unitId: 'any', to: { x: 2, y: 2 } };
    expect(flyTags(s, fly, move)).toEqual(['territory', 'harvest']);
    expect(flyTags(s, fly, { type: 'endTurn', player: fly })).toEqual(['pass']);
  });
});

describe('fly: threats to held economy gardens', () => {
  withoutBrain();
  /**
   * Fly holds a Mushroom at (2,1). `raiders` enemy gnomes stand within the
   * threat radius of it; one more enemy stands far away, beside its own Home.
   */
  function raided(raiders: number): { state: GameState; fly: PlayerId; far: Pos } {
    let s = toActionPhase(11);
    const fly = s.turn!.activePlayer;
    const enemy = (1 - fly) as PlayerId;
    s = mutate(s, (d) => {
      d.players[fly].difficulty = 'fly';
    });
    s = withGarden(s, { x: 2, y: 1 }, 'mushroom');
    s = withGnome(s, fly, { x: 2, y: 1 }).state;
    const near: Pos[] = [
      { x: 3, y: 2 },
      { x: 2, y: 3 },
      { x: 1, y: 2 },
    ];
    for (const p of near.slice(0, raiders)) s = withGnome(s, enemy, p).state;
    // Beside the enemy's own Home, one step toward the center: far from
    // anything of the fly's.
    const eh = s.players[enemy].homePos;
    const c = Math.floor(s.config.boardSize / 2);
    const far = { x: eh.x + Math.sign(c - eh.x), y: eh.y + Math.sign(c - eh.y) };
    s = withGnome(s, enemy, far).state;
    return { state: s, fly, far };
  }

  const attack = (fly: PlayerId, to: Pos): Action => ({ type: 'move', player: fly, unitId: 'any', to });

  it(`rings the alarm at ${FLY_THREAT.alarmAt} raiders within ${FLY_THREAT.radius}`, () => {
    expect(flyDrives(raided(1).state, raided(1).fly).alarm).toBeLessThan(1);
    const { state, fly } = raided(FLY_THREAT.alarmAt);
    expect(flyDrives(state, fly).alarm).toBeGreaterThanOrEqual(1);
  });

  it('wants to kill a raider near its garden more than a distant enemy', () => {
    const { state, fly, far } = raided(2);
    const ctx = flyObserve(state, fly, createFlyMemory());
    expect(flyTags(state, fly, attack(fly, { x: 3, y: 2 }), ctx.intent)).toContain('defend');
    expect(flyTags(state, fly, attack(fly, far), ctx.intent)).not.toContain('defend');
    expect(flyBias(ctx, state, fly, attack(fly, { x: 3, y: 2 }))).toBeGreaterThan(
      flyBias(ctx, state, fly, attack(fly, far)) + 2,
    );
  });

  it('accepts worse odds to defend a garden than to attack elsewhere', () => {
    // A 1-vs-2 is refused on the attack (see "fight rules"), but under a loud
    // alarm the same odds are acceptable when the stack is a raiding party.
    let { state, fly } = raided(3);
    const enemy = (1 - fly) as PlayerId;
    state = withGnome(state, enemy, { x: 3, y: 2 }).state; // stack two at (3,2)
    const ctx = flyObserve(state, fly, createFlyMemory());
    expect(flyBrake(ctx, state, fly, attack(fly, { x: 3, y: 2 }), 5)).toBeGreaterThan(END_TURN_SCORE);
  });
});

/** gnomesLost leaving `left` of the default 16 reinforcements. */
function state0TotalMinus(left: number): number {
  return toActionPhase(11).config.totalReinforcements - left;
}
