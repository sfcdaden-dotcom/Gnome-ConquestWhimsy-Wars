/**
 * Teams.
 *
 * A team is a set of seats that share a palette. That is the whole rule: two
 * players who pick red are partners, and the board says so without a legend.
 *
 * The engine does NOT read `appearance.palette` when it applies rules. Palette
 * is cosmetic and could change meaning; a rule that reads it would make every
 * fight depend on a colour name. Instead the palettes are grouped ONCE, at
 * `createGame`, into `PlayerState.team` — a plain seat-order index — and every
 * rule from then on asks about teams. Character select decides teams; the
 * rules never look at a hat.
 *
 * A free-for-all is not a special case: with four distinct palettes every
 * player is a team of one, `areAllies` is false for every pair, and the game
 * behaves exactly as it did before teams existed. That equivalence is what
 * lets the whole existing test suite stand unchanged.
 */

import type { GameState, PlayerId } from './types';

/**
 * Group seats into teams by shared palette, numbered by first appearance in
 * seat order — so seat 0 is always on team 0, and a free-for-all numbers the
 * teams 0,1,2,3 down the seating.
 */
export function assignTeams(palettes: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return palettes.map((p) => {
    const known = seen.get(p);
    if (known !== undefined) return known;
    const next = seen.size;
    seen.set(p, next);
    return next;
  });
}

/** How many distinct teams a seating produces. A game needs at least two. */
export function teamCount(teams: readonly number[]): number {
  return new Set(teams).size;
}

/** The team a seat plays for. */
export function teamOf(state: GameState, player: PlayerId): number {
  return state.players[player]?.team ?? player;
}

/**
 * Are these two seats on the same side?
 *
 * A seat is always its own ally, which is what keeps the free-for-all
 * behaviour identical: `enemyUnitsAt` asks this about every unit on a square,
 * and "not an ally" has to stay false for your own units.
 */
export function areAllies(state: GameState, a: PlayerId, b: PlayerId): boolean {
  return a === b || teamOf(state, a) === teamOf(state, b);
}

/** Everyone on a seat's team, including the seat itself, in seat order. */
export function teammates(state: GameState, player: PlayerId): PlayerId[] {
  return state.players.filter((p) => areAllies(state, p.id, player)).map((p) => p.id);
}

/**
 * Seats still in the game, grouped into the teams they belong to. Only teams
 * with a surviving member appear — this is what win detection counts.
 */
export function livingTeams(state: GameState): Map<number, PlayerId[]> {
  const out = new Map<number, PlayerId[]>();
  for (const p of state.players) {
    if (p.status !== 'playing') continue;
    const team = teamOf(state, p.id);
    const members = out.get(team);
    if (members) members.push(p.id);
    else out.set(team, [p.id]);
  }
  return out;
}

/**
 * Everyone who won, in seat order — empty while the game runs and for a draw.
 *
 * The field to read after a game ends. `state.winner` answers the same
 * question only when the winning team has one member, which is every
 * free-for-all game and no 2v2 game.
 */
export function winningSeats(state: GameState): PlayerId[] {
  if (state.winningTeam === null) return [];
  return state.players
    .filter((p) => p.status === 'playing' && teamOf(state, p.id) === state.winningTeam)
    .map((p) => p.id);
}
