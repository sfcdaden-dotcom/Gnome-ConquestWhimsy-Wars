/**
 * Procedural map generation for the "Random (symmetrical)" preset.
 *
 * Everything here is a pure function of `(boardSize, seed)`: the same pair
 * always yields the same map, so a game recorded as `config + seed` replays
 * byte-identically without storing the layout anywhere.
 *
 * Shape of a generated map
 * ------------------------
 * Every placement is an ORBIT: a cell plus its three 90°-rotations about the
 * board center. That makes the whole map 4-fold rotationally symmetric, which
 * is what "fair" means here — each seat sees exactly the same terrain, just
 * rotated. The 4 Home Gardens are one such orbit, so they are automatically
 * equidistant from one another, and the 2-player seating (orbit indices 0 and
 * 2) always lands on an exactly-opposite pair.
 *
 * Placement rules (the design brief, in priority order)
 * -----------------------------------------------------
 * HARD (never violated — a placement that would break one is simply not made):
 *   - Homes sit outside the middle 3×3 and at least `MIN_HOME_SEPARATION`
 *     apart (Chebyshev) from their rotational neighbours.
 *   - Nothing is planted on a home or on the Center Star space.
 *   - Flytrap, Maize and Tunnel gardens keep `HAZARD_HOME_BUFFER` distance
 *     from every home: a turn-1 entry fight can gut a player before they have
 *     drawn a card, maize would tax a player's only exits, and a home-adjacent
 *     tunnel hands every opponent a free teleport onto that doorstep.
 *   - Every home keeps at least `MIN_HOME_FREE_EXITS` garden-free orthogonal
 *     neighbours, so nobody starts walled in.
 * SOFT (relaxed, in this order, only when a placement is otherwise impossible):
 *   1. at most `MAX_SAME_TYPE_ORBITS` orbits of any one type,
 *   2. no two gardens orthogonally adjacent (keeps boards readable).
 *
 * Type selection is zonal: the ring around the homes is pure early-game
 * economy, the middle is the contested spice guarding the Center Star, and the
 * space between them carries the mobility network. See `ZONE_WEIGHTS`.
 */

import type { PlantableGardenType, Pos } from './types';
import { EngineError } from './types';
import { createRng } from './rng';
import type { Rng } from './rng';
import { posKey } from './helpers';

export interface RandomLayout {
  /** Exactly 4 Home Gardens in clockwise rotation order (west/north/east/south for the classic orbit). */
  homes: Pos[];
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Smallest board the generator supports (a 5×5 minus its middle 3×3 is too cramped for random homes). */
export const RANDOM_LAYOUT_MIN_BOARD_SIZE = 7;

/** Homes must be more than this Chebyshev distance from the center (1 ⇒ the middle 3×3 is off-limits). */
const HOME_CENTER_EXCLUSION = 1;
/** Minimum Chebyshev distance between rotationally adjacent homes. */
const MIN_HOME_SEPARATION = 3;
/**
 * Minimum Chebyshev distance from every home to a hazard (flytrap, maize,
 * tunnel): far enough that none of them ever sits on a doorstep.
 *
 * A wider buffer for flytraps specifically was tried and abandoned: because
 * the homes are themselves a rotation orbit, the center is the only cell far
 * from all four of them, and it is reserved for the Center Star. Requiring 3
 * therefore did not make flytraps rarer near homes — it removed flytraps from
 * the game almost entirely (<1% of tiles on a 7×7).
 */
const HAZARD_HOME_BUFFER = 2;
/** Types the buffer above applies to: an entry fight, an exit tax, an enemy teleport pad. */
const HAZARD_TYPES: ReadonlySet<PlantableGardenType> = new Set(['flytrap', 'maize', 'tunnel']);
/** Garden-free orthogonal neighbours every home must retain. */
const MIN_HOME_FREE_EXITS = 2;

/** Orbits (×4 gardens each) rolled per map on a 7×7; larger boards get more (see `rollOrbitCount`). */
const ORBIT_COUNT_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [2, 1],
  [3, 2],
  [4, 1],
];
const MAX_SAME_TYPE_ORBITS = 2;
/** A map with fewer gardens than this is thrown away and re-rolled. */
const MIN_GARDENS = 8;
/** Bound on whole-map re-rolls; the fullest attempt wins if none clears `MIN_GARDENS`. */
const MAX_ATTEMPTS = 12;

/** Keeps map generation off the same RNG stream as dice and shuffles. */
const LAYOUT_SEED_SALT = 0x9d2b7f15;

type Zone = 'nearHome' | 'central' | 'mid';

/**
 * Chebyshev radius around a home / around the center that defines each zone.
 * The near-home ring is deliberately tight: on a 7×7, four homes with radius 2
 * would claim more cells than the board has, and every map would come out as
 * pure economy. Radius 1 is the doorstep — the spaces a player actually opens
 * on — while the hard buffers above keep hazards off the ring beyond it.
 */
const NEAR_HOME_RADIUS = 1;
const CENTRAL_RADIUS = 2;

/**
 * Type weights per zone. A zone simply omits the types it never wants; the
 * hard buffers above independently veto types too close to a home, so the
 * near-home list is the only one that must be safe on its own.
 */
const ZONE_WEIGHTS: Record<Zone, ReadonlyArray<readonly [PlantableGardenType, number]>> = {
  nearHome: [
    ['dandelion', 45],
    ['mushroom', 35],
    ['slippery', 20],
  ],
  central: [
    ['maize', 30],
    ['flytrap', 25],
    ['mushroom', 25],
    ['slippery', 20],
  ],
  mid: [
    ['tunnel', 30],
    ['slippery', 25],
    ['dandelion', 25],
    ['maize', 10],
    ['flytrap', 10],
  ],
};

/** Soft-rule relaxation ladder: the first level that can place an orbit wins. */
const RELAXATION: ReadonlyArray<{ typeCap: boolean; adjacency: boolean }> = [
  { typeCap: true, adjacency: true },
  { typeCap: false, adjacency: true },
  { typeCap: false, adjacency: false },
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let cache: { boardSize: number; seed: number; layout: RandomLayout } | null = null;

/**
 * Build the random symmetric map for `(boardSize, seed)`. Deterministic and
 * memoized on the last call, since `build` and `buildHomes` on the preset
 * definition each ask for the same layout.
 */
export function generateRandomLayout(boardSize: number, seed: number): RandomLayout {
  if (!Number.isInteger(boardSize) || boardSize % 2 === 0 || boardSize < RANDOM_LAYOUT_MIN_BOARD_SIZE) {
    throw new EngineError(
      'BAD_CONFIG',
      `The random layout needs an odd boardSize >= ${RANDOM_LAYOUT_MIN_BOARD_SIZE}, got ${boardSize}`,
    );
  }
  if (cache && cache.boardSize === boardSize && cache.seed === seed) return cloneLayout(cache.layout);

  const rng = createRng(seed ^ LAYOUT_SEED_SALT);
  let best: RandomLayout | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const layout = buildOnce(boardSize, rng);
    if (layout.gardens.length >= MIN_GARDENS) {
      best = layout;
      break;
    }
    if (!best || layout.gardens.length > best.gardens.length) best = layout;
  }

  const layout = best!;
  cache = { boardSize, seed, layout };
  return cloneLayout(layout);
}

function cloneLayout(l: RandomLayout): RandomLayout {
  return {
    homes: l.homes.map((p) => ({ ...p })),
    gardens: l.gardens.map((g) => ({ pos: { ...g.pos }, type: g.type })),
  };
}

// ---------------------------------------------------------------------------
// One generation attempt
// ---------------------------------------------------------------------------

function buildOnce(n: number, rng: Rng): RandomLayout {
  const c = (n - 1) / 2;
  const center = { x: c, y: c };
  const homes = pickOrbit(homeCandidates(n, c), rng, c);

  // `blocked` is everything a garden may not sit on; `gardenCells` is only the
  // planted gardens, which is what the home-exit rule counts against.
  const blocked = new Set<string>([posKey(center), ...homes.map(posKey)]);
  const gardenCells = new Set<string>();
  const typeOrbits = new Map<PlantableGardenType, number>();
  const gardens: RandomLayout['gardens'] = [];

  const orbits = rollOrbitCount(n, rng);
  for (let i = 0; i < orbits; i++) {
    const placement = placeOrbit(n, c, homes, blocked, gardenCells, typeOrbits, rng);
    if (!placement) continue; // no legal spot left even fully relaxed
    for (const pos of placement.cells) {
      blocked.add(posKey(pos));
      gardenCells.add(posKey(pos));
      gardens.push({ pos, type: placement.type });
    }
    typeOrbits.set(placement.type, (typeOrbits.get(placement.type) ?? 0) + 1);
  }

  gardens.sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);
  return { homes, gardens };
}

/** Orbits scale gently with the board so a 9×9 or 11×11 doesn't read as empty. */
function rollOrbitCount(n: number, rng: Rng): number {
  return weightedPick(rng, ORBIT_COUNT_WEIGHTS) + Math.floor((n - RANDOM_LAYOUT_MIN_BOARD_SIZE) / 2);
}

// ---------------------------------------------------------------------------
// Homes
// ---------------------------------------------------------------------------

/**
 * Cells whose orbit is a legal home orbit. The Chebyshev distance between a
 * cell and its own 90°-rotation equals its Manhattan distance from the center,
 * so the "adjacent homes at least 3 apart" rule is a Manhattan test here.
 */
function homeCandidates(n: number, c: number): Pos[] {
  const center = { x: c, y: c };
  const out: Pos[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const p = { x, y };
      if (chebyshev(p, center) <= HOME_CENTER_EXCLUSION) continue;
      if (manhattanTo(p, center) < MIN_HOME_SEPARATION) continue;
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gardens
// ---------------------------------------------------------------------------

interface OrbitCandidate {
  cells: Pos[];
  /** Zone weights already filtered down to the types legal on this orbit. */
  entries: ReadonlyArray<readonly [PlantableGardenType, number]>;
}

function placeOrbit(
  n: number,
  c: number,
  homes: readonly Pos[],
  blocked: ReadonlySet<string>,
  gardenCells: ReadonlySet<string>,
  typeOrbits: ReadonlyMap<PlantableGardenType, number>,
  rng: Rng,
): { cells: Pos[]; type: PlantableGardenType } | null {
  for (const level of RELAXATION) {
    const candidates: OrbitCandidate[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const cells = orbitOf({ x, y }, c);
        if (!orbitFits(n, cells, blocked, gardenCells, level.adjacency)) continue;
        if (!homeExitsSurvive(n, homes, cells, gardenCells)) continue;
        const entries = legalTypes(cells[0], homes, c, typeOrbits, level.typeCap);
        if (entries.length === 0) continue;
        candidates.push({ cells, entries });
      }
    }
    if (candidates.length === 0) continue;
    const chosen = candidates[rng.int(candidates.length)];
    return { cells: chosen.cells, type: weightedPick(rng, chosen.entries) };
  }
  return null;
}

/** Is every cell of the orbit free, distinct, and (optionally) un-clumped? */
function orbitFits(
  n: number,
  cells: readonly Pos[],
  blocked: ReadonlySet<string>,
  gardenCells: ReadonlySet<string>,
  enforceAdjacency: boolean,
): boolean {
  const keys = new Set(cells.map(posKey));
  if (keys.size !== cells.length) return false; // degenerate orbit (the center)
  for (const p of cells) {
    if (blocked.has(posKey(p))) return false;
  }
  if (!enforceAdjacency) return true;
  for (const p of cells) {
    for (const q of orthOf(n, p)) {
      const key = posKey(q);
      // Orthogonally adjacent to an existing garden, or to another cell of
      // this same orbit (small orbits can fold back onto themselves).
      if (gardenCells.has(key) || keys.has(key)) return false;
    }
  }
  return true;
}

/** Would planting this orbit leave some home with fewer than 2 open exits? */
function homeExitsSurvive(
  n: number,
  homes: readonly Pos[],
  cells: readonly Pos[],
  gardenCells: ReadonlySet<string>,
): boolean {
  const proposed = new Set(cells.map(posKey));
  for (const home of homes) {
    let free = 0;
    for (const q of orthOf(n, home)) {
      const key = posKey(q);
      if (!gardenCells.has(key) && !proposed.has(key)) free += 1;
    }
    if (free < MIN_HOME_FREE_EXITS) return false;
  }
  return true;
}

/**
 * The zone's type weights, minus types vetoed by a home buffer or (unless
 * relaxed) by the per-type orbit cap. Checking one orbit cell is enough:
 * rotation permutes the homes, so all four cells score identically.
 */
function legalTypes(
  cell: Pos,
  homes: readonly Pos[],
  c: number,
  typeOrbits: ReadonlyMap<PlantableGardenType, number>,
  enforceTypeCap: boolean,
): ReadonlyArray<readonly [PlantableGardenType, number]> {
  const dHome = Math.min(...homes.map((h) => chebyshev(cell, h)));
  const dCenter = chebyshev(cell, { x: c, y: c });
  const zone: Zone = dHome <= NEAR_HOME_RADIUS ? 'nearHome' : dCenter <= CENTRAL_RADIUS ? 'central' : 'mid';
  return ZONE_WEIGHTS[zone].filter(([type]) => {
    if (HAZARD_TYPES.has(type) && dHome < HAZARD_HOME_BUFFER) return false;
    if (enforceTypeCap && (typeOrbits.get(type) ?? 0) >= MAX_SAME_TYPE_ORBITS) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Geometry + RNG helpers
// ---------------------------------------------------------------------------

/** 90° clockwise rotation about the board center (y grows downward). */
export function rotate90(p: Pos, c: number): Pos {
  return { x: c - (p.y - c), y: c + (p.x - c) };
}

/** A cell and its three rotations, clockwise. Four distinct cells unless `p` is the center. */
export function orbitOf(p: Pos, c: number): Pos[] {
  const out = [{ ...p }];
  let cur = p;
  for (let i = 0; i < 3; i++) {
    cur = rotate90(cur, c);
    out.push(cur);
  }
  return out;
}

function pickOrbit(candidates: readonly Pos[], rng: Rng, c: number): Pos[] {
  return orbitOf(candidates[rng.int(candidates.length)], c);
}

function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function manhattanTo(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function orthOf(n: number, p: Pos): Pos[] {
  return [
    { x: p.x, y: p.y - 1 },
    { x: p.x + 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x - 1, y: p.y },
  ].filter((q) => q.x >= 0 && q.y >= 0 && q.x < n && q.y < n);
}

/** Pick from `[value, weight]` pairs with integer weights. */
function weightedPick<T>(rng: Rng, entries: ReadonlyArray<readonly [T, number]>): T {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng.int(total);
  for (const [value, w] of entries) {
    if (r < w) return value;
    r -= w;
  }
  return entries[entries.length - 1][0];
}
