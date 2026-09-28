/**
 * The connectome in the loop: the circuit behaves like the fly it came from,
 * the senses read the board the way the design says, the expected-harvest hum
 * dislikes the moves it should, and goals pay bliss.
 */

import { describe, expect, it } from 'vitest';
import type { Action, GameState, PlayerId, Pos } from '../types';
import { mutate, toActionPhase, withGarden, withGnome } from '../testkit';
import { loadCircuit, simulate } from './flySim';
import { FLY_CIRCUIT } from './flyCircuitData';
import { expectedBounty, flySenses } from './flyBrain';
import { FLY_ATTRACTION, goalOf, reinforce } from './flyGoals';

describe('the circuit', () => {
  const c = loadCircuit(FLY_CIRCUIT);
  const run = (rates: Parameters<typeof simulate>[1]) => simulate(c, rates, { duration: 300, seed: 1 });

  it('feeds on sugar, and does nothing else with it', () => {
    const r = run({ sugar: 100 });
    expect(r.feed).toBeGreaterThan(40);
    expect(r.escape).toBe(0);
  });

  it('fires the Giant Fiber on looming', () => {
    const r = run({ loom: 100 });
    expect(r.escape).toBeGreaterThan(80);
    expect(r.feed).toBe(0);
  });

  it('approaches an object', () => {
    expect(run({ object: 100 }).approach).toBeGreaterThan(30);
  });

  it('loses its appetite in danger or on the hunt', () => {
    const fed = run({ sugar: 100 }).feed;
    expect(run({ sugar: 100, loom: 100 }).feed).toBeLessThan(fed / 4);
    expect(run({ sugar: 100, object: 100 }).feed).toBeLessThan(fed / 4);
  });

  it('is deterministic for a seed', () => {
    expect(run({ sugar: 80, loom: 40 })).toEqual(run({ sugar: 80, loom: 40 }));
  });
});

/** The fly (active seat) with its gnomes cleared, and a helper to place things. */
function board(): { s: GameState; fly: PlayerId; enemy: PlayerId } {
  let s = toActionPhase(11);
  const fly = s.turn!.activePlayer;
  s = mutate(s, (d) => {
    d.players[fly].difficulty = 'fly';
    d.players[fly].wishes = 1;
    for (const id of Object.keys(d.units)) delete d.units[id];
  });
  return { s, fly, enemy: (1 - fly) as PlayerId };
}

const move = (fly: PlayerId, unitId: string, to: Pos): Action => ({ type: 'move', player: fly, unitId, to });

describe('the expected-harvest hum', () => {
  it('counts a held Dandelion, and drops when its holder walks off', () => {
    let { s, fly } = board();
    s = withGarden(s, { x: 2, y: 2 }, 'dandelion');
    const g = withGnome(s, fly, { x: 2, y: 2 });
    const held = expectedBounty(g.state, fly);
    expect(held).toBeGreaterThan(expectedBounty(s, fly));
    expect(expectedBounty(g.state, fly, move(fly, g.unitId, { x: 2, y: 3 }))).toBeLessThan(held);
  });

  it('dislikes stepping into Maize or an active Flytrap', () => {
    let { s, fly } = board();
    s = withGarden(withGarden(s, { x: 3, y: 2 }, 'maize'), { x: 1, y: 2 }, 'flytrap');
    const g = withGnome(s, fly, { x: 2, y: 2 });
    const now = expectedBounty(g.state, fly);
    expect(expectedBounty(g.state, fly, move(fly, g.unitId, { x: 3, y: 2 }))).toBeLessThan(now);
    expect(expectedBounty(g.state, fly, move(fly, g.unitId, { x: 1, y: 2 }))).toBeLessThan(now);
  });
});

describe('the senses', () => {
  it('tastes the harvest: more bounty, more sugar', () => {
    const { s, fly } = board();
    const lean = flySenses(s, fly, { wishes: 0, gnomes: 0 }, 0).sugar;
    const rich = flySenses(s, fly, { wishes: 2, gnomes: 1 }, 0).sugar;
    expect(rich).toBeGreaterThan(lean);
  });

  it('panics when enemy gnomes close in', () => {
    let { s, fly, enemy } = board();
    s = withGnome(s, fly, { x: 3, y: 3 }).state;
    const calm = flySenses(s, fly, { wishes: 0, gnomes: 0 }, 0).loom;
    s = withGnome(withGnome(s, enemy, { x: 3, y: 4 }).state, enemy, { x: 4, y: 3 }).state;
    expect(calm).toBe(0);
    expect(flySenses(s, fly, { wishes: 0, gnomes: 0 }, 0).loom).toBeGreaterThan(0);
  });

  it('sees a target in reach more brightly once it has learned to love the kill', () => {
    let { s, fly, enemy } = board();
    s = withGnome(withGnome(s, fly, { x: 3, y: 3 }).state, enemy, { x: 3, y: 4 }).state;
    const naive = flySenses(s, fly, { wishes: 0, gnomes: 0 }, 0, {}).object;
    const keen = flySenses(s, fly, { wishes: 0, gnomes: 0 }, 0, { killGnome: 1 }).object;
    expect(naive).toBeGreaterThan(0);
    expect(keen).toBeGreaterThan(naive);
  });
});

describe('goals', () => {
  it('recognises a kill', () => {
    const { s, fly, enemy } = board();
    expect(goalOf(s, fly, { type: 'unitDestroyed', player: enemy, unitId: 'u', unitKind: 'gnome', pos: { x: 0, y: 0 }, cause: 'fight' })).toBe('killGnome');
    expect(goalOf(s, fly, { type: 'unitDestroyed', player: fly, unitId: 'u', unitKind: 'gnome', pos: { x: 0, y: 0 }, cause: 'fight' })).toBeNull();
  });

  it('grows attraction with bliss, up to a cap', () => {
    const a = {};
    for (let i = 0; i < 1000; i++) reinforce(a, 'captureHome');
    expect(reinforce(a, 'killGnome')).toBeGreaterThan(0);
    expect(reinforce(a, 'captureHome')).toBe(FLY_ATTRACTION.cap);
  });
});
