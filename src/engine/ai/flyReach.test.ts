/**
 * The fly's reach map and what it does with it: the Glacier catapult that beat
 * it in a playtest, tunnel hops, gnomes stuck in Maize, the Home watch, and
 * not walking into Maize it cannot pay to leave.
 */

import { describe, expect, it } from 'vitest';
import type { Action, GameState, PlayerId, Pos } from '../types';
import { posKey } from '../helpers';
import { mutate, toActionPhase, withGarden, withGnome } from '../testkit';
import { createFlyMemory, flyBrake, flyObserve, homeShortfall } from './fly';
import { enemyReach, reachersOf } from './flyReach';
import { END_TURN_SCORE } from './scoring';

/** The fly (active seat) and a direction pointing from its Home toward the center. */
function setup(): { s: GameState; fly: PlayerId; enemy: PlayerId; home: Pos; at: (n: number) => Pos } {
  let s = toActionPhase(11);
  const fly = s.turn!.activePlayer;
  const enemy = (1 - fly) as PlayerId;
  s = mutate(s, (d) => {
    d.players[fly].difficulty = 'fly';
  });
  const home = s.players[fly].homePos;
  const c = Math.floor(s.config.boardSize / 2);
  const dir = { x: Math.sign(c - home.x), y: Math.sign(c - home.y) };
  return { s, fly, enemy, home, at: (n) => ({ x: home.x + dir.x * n, y: home.y + dir.y * n }) };
}

function upgraded(s: GameState, pos: Pos): GameState {
  return mutate(s, (d) => {
    d.gardens[posKey(pos)].upgraded = true;
  });
}

describe('enemyReach', () => {
  it('sees the Glacier catapult: slide 2, then step 1, onto our Home', () => {
    const { s: s0, fly, enemy, home, at } = setup();
    let s = upgraded(withGarden(s0, at(3), 'slippery'), at(3));
    const { state, unitId } = withGnome(s, enemy, at(3));
    s = state;
    expect(enemyReach(s, fly).get(unitId)!.has(posKey(home))).toBe(true);
  });

  it('does not see a plain gnome three spaces away as a threat to our Home', () => {
    const { s: s0, fly, enemy, home, at } = setup();
    const { state, unitId } = withGnome(s0, enemy, at(3));
    expect(enemyReach(state, fly).get(unitId)!.has(posKey(home))).toBe(false);
  });

  it('follows a tunnel hop to a tunnel beside our Home', () => {
    const { s: s0, fly, enemy, home, at } = setup();
    let s = withGarden(withGarden(s0, at(5), 'tunnel'), at(1), 'tunnel');
    const { state, unitId } = withGnome(s, enemy, at(5));
    s = state;
    expect(reachersOf(enemyReach(s, fly), home)).toContain(unitId);
  });

  it('knows a gnome that cannot pay its Maize toll is going nowhere', () => {
    const { s: s0, fly, enemy, at } = setup();
    let s = withGarden(s0, at(3), 'maize');
    s = mutate(s, (d) => {
      d.players[enemy].wishes = 0;
    });
    const { state, unitId } = withGnome(s, enemy, at(3));
    expect([...enemyReach(state, fly).get(unitId)!]).toEqual([posKey(at(3))]);
  });
});

describe('fly: Home watch and Maize', () => {
  const move = (fly: PlayerId, unitId: string, to: Pos): Action => ({ type: 'move', player: fly, unitId, to });

  it('will not walk its last defender off the Home while a catapult is loaded', () => {
    const { s: s0, fly, enemy, home, at } = setup();
    let s = upgraded(withGarden(s0, at(3), 'slippery'), at(3));
    s = withGnome(s, enemy, at(3)).state;
    s = mutate(s, (d) => {
      for (const id of Object.keys(d.units)) if (d.units[id].owner === fly) delete d.units[id];
    });
    const guard = withGnome(s, fly, home);
    s = guard.state;
    const ctx = flyObserve(s, fly, createFlyMemory());
    expect(homeShortfall(s, fly, ctx.intent)).toBe(0);
    expect(homeShortfall(s, fly, ctx.intent, 1)).toBe(1);
    expect(flyBrake(ctx, s, fly, move(fly, guard.unitId, at(1)), 5)).toBeLessThan(END_TURN_SCORE);
  });

  it('will not walk into Maize it cannot pay to leave', () => {
    const { s: s0, fly, at } = setup();
    let s = withGarden(s0, at(2), 'maize');
    const walker = withGnome(s, fly, at(1));
    s = mutate(walker.state, (d) => {
      d.players[fly].wishes = 0;
    });
    const ctx = flyObserve(s, fly, createFlyMemory());
    expect(flyBrake(ctx, s, fly, move(fly, walker.unitId, at(2)), 5)).toBeLessThan(END_TURN_SCORE);
    const rich = mutate(s, (d) => {
      d.players[fly].wishes = 3;
    });
    expect(flyBrake(flyObserve(rich, fly, createFlyMemory()), rich, fly, move(fly, walker.unitId, at(2)), 5)).toBe(4);
  });
});
