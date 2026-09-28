/**
 * Where can each enemy gnome get to on its owner's NEXT turn?
 *
 * The intent reader (flyIntent.ts) guesses where a gnome is walking. That
 * misses jumps: a gnome five spaces away is no walker's threat, but standing on
 * a Glacier it harvests a 2-space slide, then takes its 1-space move, then may
 * chain entry slides and tunnel hops — and lands on the fly's Home. This
 * module answers "what is POSSIBLE", following RULES.md:
 *
 *  1. Harvest Phase — a gnome on a garden its owner controls relocates first:
 *       Slippery   to any of the 8 neighbours
 *       Glacier    exactly 2 in a straight orthogonal line, or 1 diagonal
 *       Tunnel     to any other tunnel, or any garden the owner occupies
 *     That arrival is an Entry, opening a chain that already counts 1.
 *  2. Action Phase — one orthogonal step, opening a fresh chain.
 *  3. Entry chains — an arrival on a garden with no enemy of the mover may
 *     relocate again (Slippery: 4 orthogonal; Glacier: 8 neighbours; Tunnel:
 *     any other tunnel; Grand Burrow: also any garden the owner occupies), at
 *     most 3 relocations per chain.
 *
 * Deliberately generous: it assumes every optional effect is taken and every
 * Wish toll paid, except that a gnome whose owner cannot pay the Maize toll it
 * stands in cannot leave. A space with the fly's units on it is reachable (the
 * arrival is an attack) but the chain stops there. Cards are not modelled.
 */

import type { GameState, PlayerId, Pos, Unit, UnitId } from '../types';
import { gardenAt, inBounds, playerUnitsAt, posKey, unitsAt } from '../helpers';
import { enemyGnomes } from './util';

const ORTH: Pos[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];
const DIAG: Pos[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
  { x: 1, y: 1 },
];
const CHAIN_CAP = 3;

/** For every enemy gnome, the posKeys it can reach next turn (including where it stands). */
export type FlyReach = Map<UnitId, Set<string>>;

export function enemyReach(state: GameState, player: PlayerId): FlyReach {
  const reach: FlyReach = new Map();
  for (const u of enemyGnomes(state, player)) reach.set(u.id, reachOf(state, player, u));
  return reach;
}

/** How many enemy gnomes could land on `pos` next turn. */
export function reachersOf(reach: FlyReach, pos: Pos): UnitId[] {
  const key = posKey(pos);
  const out: UnitId[] = [];
  for (const [id, set] of reach) if (set.has(key)) out.push(id);
  return out;
}

function reachOf(state: GameState, fly: PlayerId, u: Unit): Set<string> {
  const seen = new Set<string>([posKey(u.pos)]);
  if (stuckInMaize(state, u)) return seen;

  // Where the gnome can stand when its Action Phase begins.
  const starts: Pos[] = [u.pos];
  for (const to of harvestHops(state, fly, u)) {
    for (const p of chain(state, fly, u.owner, to, 1)) {
      if (!seen.has(posKey(p))) starts.push(p);
      seen.add(posKey(p));
    }
  }
  // One orthogonal step from any of those, then its entry chain.
  for (const s of starts) {
    if (hasFlyUnits(state, fly, s) && posKey(s) !== posKey(u.pos)) continue; // arrived into a fight
    for (const d of ORTH) {
      const to = { x: s.x + d.x, y: s.y + d.y };
      if (!inBounds(state, to)) continue;
      for (const p of chain(state, fly, u.owner, to, 0)) seen.add(posKey(p));
    }
  }
  return seen;
}

/** Everywhere an arrival at `at` can end up, taking entry effects up to the chain cap. */
function chain(state: GameState, fly: PlayerId, owner: PlayerId, at: Pos, used: number): Pos[] {
  const out: Pos[] = [at];
  if (used >= CHAIN_CAP || hasFlyUnits(state, fly, at)) return out;
  for (const next of entryHops(state, owner, at)) out.push(...chain(state, fly, owner, next, used + 1));
  return out;
}

function entryHops(state: GameState, owner: PlayerId, at: Pos): Pos[] {
  const g = gardenAt(state, at);
  if (!g) return [];
  if (g.type === 'slippery') return neighbours(state, at, g.upgraded ? [...ORTH, ...DIAG] : ORTH);
  if (g.type === 'tunnel') return g.upgraded ? [...otherTunnels(state, at), ...ownerGardens(state, owner, at)] : otherTunnels(state, at);
  return [];
}

function harvestHops(state: GameState, fly: PlayerId, u: Unit): Pos[] {
  const g = gardenAt(state, u.pos);
  if (!g || hasFlyUnits(state, fly, u.pos)) return [];
  if (g.type === 'slippery') {
    if (!g.upgraded) return neighbours(state, u.pos, [...ORTH, ...DIAG]);
    const straight = ORTH.map((d) => ({ x: u.pos.x + 2 * d.x, y: u.pos.y + 2 * d.y })).filter((p) => inBounds(state, p));
    return [...straight, ...neighbours(state, u.pos, DIAG)];
  }
  if (g.type === 'tunnel') return [...otherTunnels(state, u.pos), ...ownerGardens(state, u.owner, u.pos)];
  return [];
}

function stuckInMaize(state: GameState, u: Unit): boolean {
  const g = gardenAt(state, u.pos);
  if (!g || g.type !== 'maize') return false;
  return state.players[u.owner].wishes < (g.upgraded ? 2 : 1);
}

function neighbours(state: GameState, at: Pos, dirs: Pos[]): Pos[] {
  return dirs.map((d) => ({ x: at.x + d.x, y: at.y + d.y })).filter((p) => inBounds(state, p));
}

function otherTunnels(state: GameState, at: Pos): Pos[] {
  return gardenPositions(state, (g) => g.type === 'tunnel').filter((p) => posKey(p) !== posKey(at));
}

function ownerGardens(state: GameState, owner: PlayerId, at: Pos): Pos[] {
  return gardenPositions(state, () => true).filter(
    (p) => posKey(p) !== posKey(at) && playerUnitsAt(state, p, owner).some((x) => x.kind === 'gnome'),
  );
}

function gardenPositions(state: GameState, keep: (g: NonNullable<ReturnType<typeof gardenAt>>) => boolean): Pos[] {
  const out: Pos[] = [];
  for (const [key, g] of Object.entries(state.gardens)) {
    if (!keep(g)) continue;
    const [x, y] = key.split(',').map(Number);
    out.push({ x, y });
  }
  return out;
}

function hasFlyUnits(state: GameState, fly: PlayerId, at: Pos): boolean {
  return unitsAt(state, at).some((x) => x.owner === fly);
}
