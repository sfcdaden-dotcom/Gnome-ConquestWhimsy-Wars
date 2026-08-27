/**
 * Teams: seats that share a palette share a side.
 *
 * The claim these tests defend is that a free-for-all is a 4-team game and
 * behaves EXACTLY as it did before teams existed, while a 2v2 changes four
 * things and only four: partners do not fight, partners do not capture each
 * other's homes, the game ends when a team is left rather than a player, and
 * both partners win.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  areAllies,
  assignTeams,
  chooseAiAction,
  createGame,
  enemyUnitsAt,
  livingTeams,
  teamCount,
  teamOf,
  teammates,
  winningSeats,
  type GameState,
  type PlayerAppearance,
  type PlayerId,
} from './index';
import { checkInvariants } from './invariants';
import { processNextElimination } from './elimination';
import { playSelfPlayGame, replayMatch } from './selfplay';
import { mutate, withGnome } from './testkit';

const look = (palette: string): PlayerAppearance =>
  ({ palette, cap: 'pointy', beard: 'bushy', weapon: 'shovel', accessory: 'none' }) as PlayerAppearance;

/** A 4-seat game whose seats wear the given palettes. */
function game(palettes: string[], seed = 42): GameState {
  return createGame(
    {
      players: palettes.map((p, i) => ({
        name: `P${i}`,
        controller: 'cpu' as const,
        appearance: look(p),
      })),
      gardenPreset: 'none',
    },
    seed,
  );
}

/** Seats 0+2 vs seats 1+3 — partners sit opposite, as a 4-player board seats them. */
const TWO_V_TWO = ['red', 'blue', 'red', 'blue'];
const FREE_FOR_ALL = ['red', 'blue', 'yellow', 'purple'];

describe('assignTeams', () => {
  it('numbers teams by first appearance in seat order', () => {
    expect(assignTeams(['red', 'blue', 'red', 'blue'])).toEqual([0, 1, 0, 1]);
    expect(assignTeams(['red', 'red', 'blue', 'blue'])).toEqual([0, 0, 1, 1]);
    expect(assignTeams(['red', 'blue', 'yellow', 'purple'])).toEqual([0, 1, 2, 3]);
  });

  it('makes every seat its own team in a free-for-all', () => {
    expect(teamCount(assignTeams(FREE_FOR_ALL))).toBe(4);
  });

  it('counts a 2v2 as two teams and a 3v1 as two', () => {
    expect(teamCount(assignTeams(TWO_V_TWO))).toBe(2);
    expect(teamCount(assignTeams(['red', 'red', 'red', 'blue']))).toBe(2);
  });
});

describe('createGame', () => {
  it('puts shared-palette seats on one team', () => {
    const s = game(TWO_V_TWO);
    expect(s.players.map((p) => p.team)).toEqual([0, 1, 0, 1]);
  });

  it('refuses a table where everyone is on one side', () => {
    // Nothing could be fought, no home captured, and the win condition would
    // already hold before the first roll.
    expect(() => game(['red', 'red', 'red', 'red'])).toThrow(/at least two teams/i);
    expect(() => game(['red', 'red'])).toThrow(/at least two teams/i);
  });

  it('allows a lopsided 3v1', () => {
    expect(() => game(['red', 'red', 'red', 'blue'])).not.toThrow();
  });
});

describe('areAllies', () => {
  it('is true for a seat and itself, always', () => {
    const s = game(FREE_FOR_ALL);
    for (const p of s.players) expect(areAllies(s, p.id, p.id)).toBe(true);
  });

  it('is false between every pair in a free-for-all', () => {
    const s = game(FREE_FOR_ALL);
    for (const a of s.players) {
      for (const b of s.players) {
        if (a.id !== b.id) expect(areAllies(s, a.id, b.id)).toBe(false);
      }
    }
  });

  it('is true across a 2v2 partnership and false across the line', () => {
    const s = game(TWO_V_TWO);
    expect(areAllies(s, 0, 2)).toBe(true);
    expect(areAllies(s, 1, 3)).toBe(true);
    expect(areAllies(s, 0, 1)).toBe(false);
    expect(areAllies(s, 2, 3)).toBe(false);
  });

  it('is symmetric', () => {
    const s = game(TWO_V_TWO);
    for (const a of s.players) {
      for (const b of s.players) {
        expect(areAllies(s, a.id, b.id)).toBe(areAllies(s, b.id, a.id));
      }
    }
  });

  it('reports teammates in seat order, including yourself', () => {
    const s = game(TWO_V_TWO);
    expect(teammates(s, 0)).toEqual([0, 2]);
    expect(teammates(s, 3)).toEqual([1, 3]);
  });
});

describe('enemyUnitsAt — the predicate every contested-square rule routes through', () => {
  const pos = { x: 3, y: 3 };

  it('does not see a partner as an enemy', () => {
    let s = game(TWO_V_TWO);
    s = withGnome(s, 2 as PlayerId, pos).state;
    expect(enemyUnitsAt(s, pos, 0)).toHaveLength(0);
  });

  it('still sees an opponent as an enemy', () => {
    let s = game(TWO_V_TWO);
    s = withGnome(s, 1 as PlayerId, pos).state;
    expect(enemyUnitsAt(s, pos, 0)).toHaveLength(1);
  });

  it('sees everyone else as an enemy in a free-for-all', () => {
    let s = game(FREE_FOR_ALL);
    for (const seat of [1, 2, 3] as PlayerId[]) s = withGnome(s, seat, pos).state;
    expect(enemyUnitsAt(s, pos, 0)).toHaveLength(3);
  });

  it('separates a crowded square into partners and opponents', () => {
    let s = game(TWO_V_TWO);
    for (const seat of [0, 1, 2, 3] as PlayerId[]) s = withGnome(s, seat, pos).state;
    // Seat 0 is at war with seats 1 and 3 only.
    expect(enemyUnitsAt(s, pos, 0).map((u) => u.owner).sort()).toEqual([1, 3]);
    expect(enemyUnitsAt(s, pos, 1).map((u) => u.owner).sort()).toEqual([0, 2]);
  });
});

describe('winning', () => {
  /** Knock `seats` out directly, then let the settle loop notice. */
  function eliminate(s: GameState, seats: PlayerId[]): GameState {
    return mutate(s, (d) => {
      for (const seat of seats) d.players[seat].status = 'out';
    });
  }

  it('ends a 2v2 when both opponents are gone, with both partners winning', () => {
    let s = game(TWO_V_TWO);
    // Seat 3 is already gone; seat 1 is the last opponent and is going now.
    s = eliminate(s, [3] as PlayerId[]);
    s = mutate(s, (d) => {
      d.eliminationQueue = [{ player: 1 as PlayerId, reason: 'reinforcements' }];
    });
    // Run the settle path the engine itself uses to detect a decided game.
    s = mutate(s, (d) => processNextElimination(d));

    expect(s.status).toBe('finished');
    expect(s.winningTeam).toBe(0);
    expect(winningSeats(s)).toEqual([0, 2]);
    // Two winners means no single winner: `winner` is the one-seat shorthand.
    expect(s.winner).toBeNull();
    expect(checkInvariants(s)).toEqual([]);
  });

  it('still names a single winner in a free-for-all', () => {
    let s = game(FREE_FOR_ALL);
    s = eliminate(s, [1, 2] as PlayerId[]);
    s = mutate(s, (d) => {
      d.eliminationQueue = [{ player: 3 as PlayerId, reason: 'reinforcements' }];
    });
    s = mutate(s, (d) => processNextElimination(d));

    expect(s.status).toBe('finished');
    expect(s.winner).toBe(0);
    expect(s.winningTeam).toBe(teamOf(s, 0));
    expect(winningSeats(s)).toEqual([0]);
    expect(checkInvariants(s)).toEqual([]);
  });

  it('does not end a 2v2 while one opponent is still playing', () => {
    let s = game(TWO_V_TWO);
    s = eliminate(s, [3] as PlayerId[]);
    s = mutate(s, (d) => {
      d.eliminationQueue = [{ player: 3 as PlayerId, reason: 'reinforcements' }];
    });
    s = mutate(s, (d) => processNextElimination(d));
    expect(s.status).not.toBe('finished');
  });

  it('groups the living into teams', () => {
    let s = game(TWO_V_TWO);
    expect([...livingTeams(s).keys()].sort()).toEqual([0, 1]);
    s = eliminate(s, [1, 3] as PlayerId[]);
    expect([...livingTeams(s).keys()]).toEqual([0]);
    expect(livingTeams(s).get(0)).toEqual([0, 2]);
  });

  it('reports nobody as winning while the game is still running', () => {
    expect(winningSeats(game(TWO_V_TWO))).toEqual([]);
  });
});

describe('partners on the board', () => {
  /**
   * A 2v2 driven to seat 0's Action Phase. The roll-off decides who goes
   * first, so the test drives until seat 0 actually holds the turn rather
   * than assuming it.
   */
  function twoVTwoAtAction(seed = 7): GameState {
    let s = game(TWO_V_TWO, seed);
    for (let i = 0; i < 4000; i++) {
      if (s.status === 'playing' && !s.pendingDecision && s.turn?.phase === 'action' && s.turn.activePlayer === 0) {
        return s;
      }
      s = applyAction(s, chooseAiAction(s));
    }
    throw new Error('never reached seat 0 action phase');
  }

  /** Did moving in start a fight? A one-round fight resolves inside the same
   *  action, so the event log is the evidence, not `state.fight`. */
  const fought = (before: GameState, after: GameState) =>
    after.events.slice(before.events.length).some((e) => e.type === 'fightStarted');

  it('lets partners share a square without starting a fight', () => {
    let s = twoVTwoAtAction();
    const square = { x: 3, y: 3 };
    // Seat 2 (seat 0's partner) is already standing there.
    s = withGnome(s, 2 as PlayerId, square).state;
    const mine = withGnome(s, 0 as PlayerId, { x: 3, y: 4 });

    const after = applyAction(mine.state, { type: 'move', player: 0, unitId: mine.unitId, to: square });

    expect(fought(mine.state, after)).toBe(false);
    expect(after.fight).toBeNull();
    expect(after.fightQueue).toHaveLength(0);
    // Both gnomes are standing on it, and both are still alive.
    const there = Object.values(after.units).filter((u) => u.pos.x === 3 && u.pos.y === 3);
    expect(there.map((u) => u.owner).sort()).toEqual([0, 2]);
    expect(checkInvariants(after)).toEqual([]);
  });

  it('starts a fight when an opponent is on the square', () => {
    // The control for the test above: the machinery still works across the
    // line, so a partner sharing a square is a team rule and not a broken one.
    let s = twoVTwoAtAction();
    const square = { x: 3, y: 3 };
    s = withGnome(s, 1 as PlayerId, square).state;
    const mine = withGnome(s, 0 as PlayerId, { x: 3, y: 4 });

    const after = applyAction(mine.state, { type: 'move', player: 0, unitId: mine.unitId, to: square });

    expect(fought(mine.state, after)).toBe(true);
  });

  it('does not capture a partner\'s home garden', () => {
    let s = twoVTwoAtAction();
    const partnerHome = s.players[2].homePos;
    const from = { x: partnerHome.x, y: partnerHome.y - 1 };
    const mine = withGnome(s, 0 as PlayerId, from);

    const after = applyAction(mine.state, { type: 'move', player: 0, unitId: mine.unitId, to: partnerHome });

    expect(after.players[2].status).toBe('playing');
    expect(after.eliminationQueue).toHaveLength(0);
    // The home is still the partner's.
    expect(after.gardens[`${partnerHome.x},${partnerHome.y}`]?.owner).toBe(2);
    expect(checkInvariants(after)).toEqual([]);
  });

  it('still captures an opponent\'s home garden', () => {
    let s = twoVTwoAtAction();
    const enemyHome = s.players[1].homePos;
    const from = { x: enemyHome.x, y: enemyHome.y + 1 };
    const mine = withGnome(s, 0 as PlayerId, from);

    const after = applyAction(mine.state, { type: 'move', player: 0, unitId: mine.unitId, to: enemyHome });

    const gone =
      after.players[1].status !== 'playing' ||
      after.eliminationQueue.some((e) => e.player === 1) ||
      after.pendingDecision?.kind === 'snailify';
    expect(gone).toBe(true);
  });
});

describe('a 2v2 played out by the AI', () => {
  /**
   * The end-to-end check: real games, real CPU decisions, to a real finish.
   * Unit tests prove each rule; this proves they compose into a game that
   * terminates and never leaves the state inconsistent.
   */
  it('reaches a decided team win and holds every invariant', () => {
    let bothSurvived = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const record = playSelfPlayGame(
        {
          players: TWO_V_TWO.map((p, i) => ({
            name: `P${i}`,
            controller: 'cpu' as const,
            difficulty: 'normal' as const,
            appearance: look(p),
          })),
          gardenPreset: 'few',
        },
        seed,
      );

      expect(record.result.reason, `seed ${seed}`).toBe('lastStanding');
      expect(record.result.winningTeam, `seed ${seed}`).not.toBeNull();
      // Everyone who won is on the winning team, and nobody else is.
      const final = replayMatch(record);
      expect(checkInvariants(final), `seed ${seed}`).toEqual([]);
      for (const w of record.result.winners) {
        expect(teamOf(final, w), `seed ${seed}`).toBe(record.result.winningTeam);
        expect(final.players[w].status).toBe('playing');
      }
      // No survivor outside the winning team.
      for (const p of final.players) {
        if (p.status === 'playing') expect(teamOf(final, p.id)).toBe(record.result.winningTeam);
      }
      if (record.result.winners.length === 2) bothSurvived++;
    }
    // A team can win with one partner already dead, but if that were the ONLY
    // way it ever ended, the shared-victory path would be untested.
    expect(bothSurvived).toBeGreaterThan(0);
  }, 120_000);
});
