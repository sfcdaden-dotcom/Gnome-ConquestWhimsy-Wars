/**
 * The objective layer's behaviour, stated as the things a watching player is
 * supposed to be able to see:
 *
 *   - the CPU picks a goal and is still on it several turns later,
 *   - it drops it when the goal is met, dead, or plainly not worth it any more,
 *   - it turns around when its Home is threatened, and goes back to what it was
 *     doing once the threat is gone.
 *
 * These are tests of the LAYER, driven through its own API rather than through
 * whole games: `updatePlan` is the single function that advances a plan, so a
 * test that calls it once per simulated turn tests exactly the thing the
 * feature is about. Full games are already covered by the AI-vs-AI smoke tests
 * and the fingerprint lock.
 */

import { describe, expect, it } from 'vitest';
import type { GameState, PlayerId } from '../types';
import { applyAction, chooseAiAction, createAiMemory, describeAiPlan } from '../index';
import { mutate, newGame, toActionPhase, withGarden, withGnome } from '../testkit';
import type { AiPlan } from './objectives';
import {
  HOME_THREAT_RADIUS,
  chooseStrategy,
  objectiveStatus,
  proposeObjectives,
  updatePlan,
  urgentInterrupt,
} from './objectives';
import { PERSONALITIES, personalityFor } from './personality';

const STEADY = PERSONALITIES.steady;

/** A fresh, empty plan — what a seat starts with and what a lost store rebuilds. */
function emptyPlan(): AiPlan {
  return { strategy: 'EXPAND', stack: [], plannedOnTurn: -1 };
}

/** Advance the game's turn counter without playing it out. */
function atTurn(state: GameState, turn: number): GameState {
  return mutate(state, (d) => {
    if (d.turn) d.turn.number = turn;
  });
}

/** A 2p board with one of our gnomes and a Mushroom Garden worth walking to. */
function boardWithMushroom(): { state: GameState; me: PlayerId; mushroom: { x: number; y: number } } {
  let s = toActionPhase(11);
  const me: PlayerId = s.turn!.activePlayer;
  const home = s.players[me].homePos;
  const mushroom = { x: home.x === 0 ? 3 : home.x - 3, y: home.y };
  s = withGarden(s, mushroom, 'mushroom');
  s = withGnome(s, me, { x: home.x === 0 ? 1 : home.x - 1, y: home.y }).state;
  return { state: s, me, mushroom };
}

describe('strategic state', () => {
  it('defends when an enemy is on the doorstep and expands when nobody is', () => {
    let s = toActionPhase(4);
    const me: PlayerId = s.turn!.activePlayer;
    const foe: PlayerId = me === 0 ? 1 : 0;
    const home = s.players[me].homePos;

    expect(chooseStrategy(s, me, STEADY, null)).toBe('EXPAND');

    // Three enemy gnomes right next to our Home is not an expansion opportunity.
    s = withGnome(s, foe, { x: home.x, y: home.y + 1 }).state;
    s = withGnome(s, foe, { x: home.x, y: home.y + 1 }).state;
    s = withGnome(s, foe, { x: home.x + 1, y: home.y }).state;
    expect(chooseStrategy(s, me, STEADY, null)).toBe('DEFEND');
  });

  it('keeps its posture on a one-point swing (hysteresis, not flicker)', () => {
    const s = toActionPhase(4);
    const me: PlayerId = s.turn!.activePlayer;
    // Whatever it would pick cold, it sticks with when told that is where it is.
    const cold = chooseStrategy(s, me, STEADY, null);
    expect(chooseStrategy(s, me, STEADY, cold)).toBe(cold);
  });
});

describe('objective persistence', () => {
  it('adopts a garden objective and is still on it turns later', () => {
    const { state, me, mushroom } = boardWithMushroom();
    const plan = emptyPlan();

    const first = updatePlan(state, me, plan, STEADY);
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('CAPTURE_GARDEN');
    expect(first!.targetPos).toEqual(mushroom);

    // Four more turns pass with nothing relevant changing: same target, and the
    // objective object itself is never rebuilt.
    for (const turn of [2, 3, 4, 5]) {
      const again = updatePlan(atTurn(state, turn), me, plan, STEADY);
      expect(again).toBe(first);
    }
    expect(plan.stack).toHaveLength(1);
  });

  it('does not re-plan between two actions of the same turn', () => {
    const { state, me } = boardWithMushroom();
    const plan = emptyPlan();
    const first = updatePlan(state, me, plan, STEADY);
    // Same turn, called again (the CPU takes many actions per turn).
    expect(updatePlan(state, me, plan, STEADY)).toBe(first);
  });

  it('completes the objective once a gnome stands on the garden', () => {
    const { state, me, mushroom } = boardWithMushroom();
    const plan = emptyPlan();
    const objective = updatePlan(state, me, plan, STEADY)!;
    expect(objectiveStatus(state, me, objective)).toBe('active');

    const taken = withGnome(state, me, mushroom).state;
    expect(objectiveStatus(taken, me, objective)).toBe('complete');
    // …and the next call retires it rather than pursuing a square we hold.
    const next = updatePlan(atTurn(taken, 6), me, plan, STEADY);
    expect(next?.targetPos).not.toEqual(mushroom);
  });

  it('fails the objective when the target garden stops existing', () => {
    const { state, me, mushroom } = boardWithMushroom();
    const plan = emptyPlan();
    const objective = updatePlan(state, me, plan, STEADY)!;

    const razed = mutate(state, (d) => {
      delete d.gardens[`${mushroom.x},${mushroom.y}`];
    });
    expect(objectiveStatus(razed, me, objective)).toBe('failed');
  });

  it('abandons a garden that a crowd has moved onto', () => {
    const { state, me, mushroom } = boardWithMushroom();
    const foe: PlayerId = me === 0 ? 1 : 0;
    const plan = emptyPlan();
    const before = proposeObjectives(state, me, 'EXPAND', STEADY).find(
      (c) => c.objective.targetPos.x === mushroom.x && c.objective.targetPos.y === mushroom.y,
    );
    expect(before).toBeDefined();

    let crowded = state;
    for (let i = 0; i < 6; i++) crowded = withGnome(crowded, foe, mushroom).state;
    const after = proposeObjectives(crowded, me, 'EXPAND', STEADY).find(
      (c) => c.objective.targetPos.x === mushroom.x && c.objective.targetPos.y === mushroom.y,
    );
    // Six defenders is the brief's own example: it was worth taking, now it is not.
    expect(after?.score ?? -Infinity).toBeLessThan(before!.score);

    updatePlan(state, me, plan, STEADY);
    const replanned = updatePlan(atTurn(crowded, 7), me, plan, STEADY);
    expect(replanned?.targetPos).not.toEqual(mushroom);
  });
});

describe('interrupts', () => {
  /** Put `count` enemy gnomes right beside our Home. */
  function threaten(state: GameState, me: PlayerId, count: number): GameState {
    const foe: PlayerId = me === 0 ? 1 : 0;
    const home = state.players[me].homePos;
    const spot = { x: home.x, y: home.y + (home.y === 0 ? 1 : -1) };
    let s = state;
    for (let i = 0; i < count; i++) s = withGnome(s, foe, spot).state;
    return s;
  }

  it('suspends the plan, defends, then resumes the SAME plan', () => {
    const { state, me, mushroom } = boardWithMushroom();
    const plan = emptyPlan();

    const original = updatePlan(state, me, plan, STEADY)!;
    expect(original.kind).toBe('CAPTURE_GARDEN');
    expect(original.targetPos).toEqual(mushroom);

    // An enemy arrives at our door. The plan is pushed down, not thrown away.
    const underThreat = atTurn(threaten(state, me, 2), 2);
    const interrupted = updatePlan(underThreat, me, plan, STEADY)!;
    expect(interrupted.kind).toBe('DEFEND_HOME');
    expect(interrupted.interrupt).toBe(true);
    expect(plan.stack).toHaveLength(2);
    expect(plan.stack[0]).toBe(original);

    // Threat dealt with: the interrupt retires and the original plan is back,
    // as the very same object — it was suspended, not re-derived.
    const resumed = updatePlan(atTurn(state, 3), me, plan, STEADY);
    expect(resumed).toBe(original);
    expect(plan.stack).toHaveLength(1);
  });

  it('does not stack a second DEFEND_HOME on top of the first', () => {
    const { state, me } = boardWithMushroom();

    const plan = emptyPlan();
    updatePlan(state, me, plan, STEADY);
    const underThreat = atTurn(threaten(state, me, 3), 2);
    updatePlan(underThreat, me, plan, STEADY);
    updatePlan(atTurn(underThreat, 3), me, plan, STEADY);
    expect(plan.stack.filter((o) => o.kind === 'DEFEND_HOME')).toHaveLength(1);
  });

  it('ignores a distant enemy: an interrupt is for an emergency', () => {
    const s = toActionPhase(11);
    const me: PlayerId = s.turn!.activePlayer;
    const foe: PlayerId = me === 0 ? 1 : 0;
    const home = s.players[me].homePos;
    const far = { x: home.x, y: home.y };
    // Place one enemy just outside the threat radius.
    const away = { x: far.x, y: far.y + (HOME_THREAT_RADIUS + 1) * (home.y === 0 ? 1 : -1) };
    if (away.y >= 0 && away.y < s.config.boardSize) {
      const withFoe = withGnome(s, foe, away).state;
      expect(urgentInterrupt(withFoe, me, [])).toBeNull();
    }
  });
});

describe('the plan store', () => {
  it('keeps a seat on the same objective across real turns of a real game', () => {
    const memory = createAiMemory();
    let s = newGame(11, { gardenPreset: 'random' });
    const seen = new Set<string>();
    for (let i = 0; i < 120 && s.status !== 'finished'; i++) {
      const actor = s.turn?.activePlayer;
      s = mutate(s, () => {});
      const action = chooseAiAction(s, memory);
      if (actor !== undefined && s.turn?.phase === 'action') seen.add(describeAiPlan(s, actor, memory));
      s = applyAction(s, action);
    }
    // It formed intentions, and not a different one every single time it acted.
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.size).toBeLessThan(40);
  });

  it('rebuilds a plan from the board when the store is lost', () => {
    const { state } = boardWithMushroom();
    const a = createAiMemory();
    const first = chooseAiAction(state, a);
    // A brand-new store — a reload, or a room woken from hibernation.
    const b = createAiMemory();
    expect(chooseAiAction(state, b)).toEqual(first);
  });

  it('gives every difficulty a personality', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const s = mutate(newGame(3), (d) => {
        d.players[0].difficulty = difficulty;
      });
      expect(personalityFor(s, 0).name).toBeTruthy();
    }
  });
});
