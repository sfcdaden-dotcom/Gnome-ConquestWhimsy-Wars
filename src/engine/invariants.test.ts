/**
 * The invariant validator.
 *
 * Two halves, and both matter:
 *  - **No false positives.** Every state a real game passes through must be
 *    clean, or the validator is noise nobody will run. Covered by driving full
 *    AI games and checking after EVERY action (not every hundredth, as the
 *    smoke tests do).
 *  - **No false negatives.** Each invariant is provoked with a hand-broken
 *    state, so a check that silently stops working is caught here rather than
 *    by the bug it was supposed to catch.
 */

import { describe, expect, it } from 'vitest';
import type { GameState } from './index';
import {
  EngineError,
  applyAction,
  assertInvariants,
  GARDEN_PRESETS,
  checkInvariants,
  chooseAiAction,
  createGame,
  invariantsHold,
  isGameOver,
} from './index';
import { mutate, newGame, toActionPhase, withGnome } from './testkit';

/** Codes reported for `state`, as a set (order is not part of the contract). */
function codes(state: GameState): string[] {
  return checkInvariants(state).map((v) => v.code).sort();
}

describe('well-formed states pass', () => {
  // Every REGISTERED preset, not a hand-listed few: this is what catches a
  // bad layout dropped into engine/presets/ (see that folder's README).
  it('a freshly created game (2p and 4p, every registered preset)', () => {
    for (const count of [2, 4] as const) {
      for (const { id } of GARDEN_PRESETS) {
        const s = newGame(3, { gardenPreset: id }, count);
        expect(checkInvariants(s), `${count}p ${id}`).toEqual([]);
      }
    }
  });

  it('every state of a full AI game — checked after each action', () => {
    let s: GameState = createGame(
      { players: [{ name: 'A', controller: 'cpu' }, { name: 'B', controller: 'cpu' }] },
      5,
    );
    let steps = 0;
    while (!isGameOver(s) && steps < 5000) {
      s = applyAction(s, chooseAiAction(s));
      steps += 1;
      const violations = checkInvariants(s);
      expect(violations, `after action ${steps}: ${JSON.stringify(violations)}`).toEqual([]);
    }
    expect(isGameOver(s)).toBe(true);
    expect(steps).toBeGreaterThan(20);
  }, 120_000);

  it('a finished 4-player game', () => {
    let s = newGame(2, { gardenPreset: 'few' }, 4);
    for (let i = 0; i < 5000 && !isGameOver(s); i++) s = applyAction(s, chooseAiAction(s));
    expect(isGameOver(s)).toBe(true);
    expect(checkInvariants(s)).toEqual([]);
  }, 120_000);
});

describe('broken states are reported', () => {
  const base = toActionPhase(11);

  it('a unit off the board', () => {
    const s = mutate(base, (d) => {
      Object.values(d.units)[0].pos = { x: 99, y: 0 };
    });
    expect(codes(s)).toContain('UNIT_OFF_BOARD');
  });

  it('a unit owned by a seat that does not exist', () => {
    const s = mutate(base, (d) => {
      Object.values(d.units)[0].owner = 7;
    });
    expect(codes(s)).toContain('UNIT_BAD_OWNER');
  });

  it('a unit whose map key and id disagree', () => {
    const s = mutate(base, (d) => {
      const u = Object.values(d.units)[0];
      d.units['zzz'] = { ...u, pos: { ...u.pos } };
    });
    expect(codes(s)).toContain('UNIT_KEY_MISMATCH');
  });

  it('two Home Gardens for one seat', () => {
    const s = mutate(base, (d) => {
      const home = d.players[0].homePos;
      const g = d.gardens[`${home.x},${home.y}`];
      d.gardens['6,6'] = { ...g };
    });
    expect(codes(s)).toContain('DUPLICATE_HOME');
  });

  it('a Home Garden with no owner', () => {
    const s = mutate(base, (d) => {
      const home = d.players[0].homePos;
      delete d.gardens[`${home.x},${home.y}`].owner;
    });
    expect(codes(s)).toContain('HOME_WITHOUT_OWNER');
  });

  it('negative wishes', () => {
    const s = mutate(base, (d) => {
      d.players[0].wishes = -1;
    });
    expect(codes(s)).toContain('NEGATIVE_WISHES');
  });

  it('a supply above its tile budget', () => {
    const s = mutate(base, (d) => {
      d.players[0].supply.tunnel = d.config.tilesPerType + 1;
    });
    expect(codes(s)).toContain('SUPPLY_OUT_OF_RANGE');
  });

  it('more reinforcements spawned than the budget allows', () => {
    const s = mutate(base, (d) => {
      d.players[0].gnomesSpawned = d.config.totalReinforcements + 1;
    });
    expect(codes(s)).toContain('SPAWNED_OUT_OF_RANGE');
  });

  it('more gnomes lost than were ever spawned', () => {
    const s = mutate(base, (d) => {
      d.players[0].gnomesLost = d.players[0].gnomesSpawned + 1;
    });
    expect(codes(s)).toContain('LOST_EXCEEDS_SPAWNED');
  });

  it('more gnomes standing than the spawn ledger accounts for', () => {
    // The ledger is what elimination counts on: a gnome that exists without
    // having been booked would make a player un-eliminatable.
    const s = mutate(withGnome(base, 0, { x: 3, y: 3 }).state, (d) => {
      d.players[0].gnomesSpawned -= 1;
    });
    expect(codes(s)).toContain('MORE_GNOMES_THAN_SPAWNED');
  });

  it('an unresolved card stack with nobody to act', () => {
    const s = mutate(base, (d) => {
      d.cardStack = [{ cardId: 'gnome-birthday-party', player: 0, cancelled: false }];
      d.pendingDecision = null;
    });
    expect(codes(s)).toContain('STUCK_CARD_STACK');
  });

  it('a decision owed by an eliminated seat', () => {
    const s = mutate(base, (d) => {
      d.players[1].status = 'out';
      d.pendingDecision = { kind: 'discard', player: 1, mustDiscard: 1 };
    });
    expect(codes(s)).toContain('DECISION_OWED_BY_ELIMINATED');
  });

  it('a winner recorded before the game ended', () => {
    const s = mutate(base, (d) => {
      d.winner = 0;
    });
    expect(codes(s)).toContain('WINNER_BEFORE_END');
  });

  it('an eliminated winner', () => {
    const s = mutate(base, (d) => {
      d.status = 'finished';
      d.winner = 0;
      d.players[0].status = 'out';
    });
    expect(codes(s)).toContain('ELIMINATED_WINNER');
  });

  it('a rollModifiers array that does not match the seat count', () => {
    const s = mutate(base, (d) => {
      d.rollModifiers = [0];
    });
    expect(codes(s)).toContain('ROLL_MODIFIERS_ARITY');
  });

  it('eventCount below the retained event window', () => {
    const s = mutate(base, (d) => {
      d.eventCount = 0;
    });
    expect(codes(s)).toContain('EVENT_COUNT');
  });

  it('a unit married to itself', () => {
    const s = mutate(base, (d) => {
      const id = Object.keys(d.units)[0];
      d.marriages.push([id, id]);
    });
    expect(codes(s)).toContain('SELF_MARRIAGE');
  });

  it('reports every violation at once, not just the first', () => {
    const s = mutate(base, (d) => {
      d.players[0].wishes = -1;
      d.preventionShields = -2;
      Object.values(d.units)[0].pos = { x: -1, y: 0 };
    });
    expect(codes(s)).toEqual(['NEGATIVE_SHIELDS', 'NEGATIVE_WISHES', 'UNIT_OFF_BOARD']);
  });
});

describe('wrappers', () => {
  it('invariantsHold mirrors an empty violation list', () => {
    const s = toActionPhase(13);
    expect(invariantsHold(s)).toBe(true);
    expect(invariantsHold(mutate(s, (d) => void (d.players[0].wishes = -1)))).toBe(false);
  });

  it('assertInvariants returns the state when it is clean', () => {
    const s = toActionPhase(13);
    expect(assertInvariants(s)).toBe(s);
  });

  it('assertInvariants throws INTERNAL, naming the context and every violation', () => {
    const s = mutate(toActionPhase(13), (d) => {
      d.players[0].wishes = -3;
      d.eventCount = 0;
    });
    try {
      assertInvariants(s, 'after applyAction(endTurn)');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      const err = e as EngineError;
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toContain('after applyAction(endTurn)');
      expect(err.message).toContain('NEGATIVE_WISHES');
      expect(err.message).toContain('EVENT_COUNT');
    }
  });
});

describe('the validator is a read-only diagnostic', () => {
  it('does not mutate the state it inspects', () => {
    const s = toActionPhase(17);
    const before = JSON.stringify(s);
    checkInvariants(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});
