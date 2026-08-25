/**
 * Random-layout generator tests.
 *
 * The generator is a pure function of (boardSize, seed), so the interesting
 * assertions are universal ones swept across many seeds: symmetry, the home
 * geometry, and every hard placement rule from the design brief. A single
 * seed proving a rule holds would prove nothing.
 */

import { describe, expect, it } from 'vitest';
import type { PlantableGardenType, Pos } from './index';
import {
  LAYOUT_MODES,
  LAYOUT_MODE_MIN_BOARD_SIZE,
  RANDOM_LAYOUT_MIN_BOARD_SIZE,
  createGame,
  generateRandomLayout,
  orbitOf,
  posKey,
  rotate90,
} from './index';

const N = 7;
const C = (N - 1) / 2;
const HAZARDS: ReadonlySet<PlantableGardenType> = new Set(['flytrap', 'maize', 'tunnel']);
/** Enough seeds to hit every branch of the placement ladder. */
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

function cheb(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function orth(n: number, p: Pos): Pos[] {
  return [
    { x: p.x, y: p.y - 1 },
    { x: p.x + 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x - 1, y: p.y },
  ].filter((q) => q.x >= 0 && q.y >= 0 && q.x < n && q.y < n);
}

function minHomeDistance(pos: Pos, homes: readonly Pos[]): number {
  return Math.min(...homes.map((h) => cheb(pos, h)));
}

describe('generateRandomLayout', () => {
  it('is deterministic: the same (boardSize, seed) always yields the same map', () => {
    for (const seed of [1, 42, 9999]) {
      // Interleave a different seed to prove the memo cache never leaks a stale map.
      const first = generateRandomLayout(N, seed);
      generateRandomLayout(N, seed + 1);
      expect(generateRandomLayout(N, seed)).toEqual(first);
    }
  });

  it('hands back a fresh copy each call (callers cannot corrupt the cache)', () => {
    const a = generateRandomLayout(N, 5);
    a.homes[0].x = 99;
    a.gardens.length = 0;
    const b = generateRandomLayout(N, 5);
    expect(b.homes[0].x).not.toBe(99);
    expect(b.gardens.length).toBeGreaterThan(0);
  });

  it('rejects boards that are even, too small, or non-integer', () => {
    for (const bad of [5, 6, 8, 7.5]) {
      expect(() => generateRandomLayout(bad, 1)).toThrow();
    }
    expect(() => generateRandomLayout(RANDOM_LAYOUT_MIN_BOARD_SIZE, 1)).not.toThrow();
  });

  it('produces different maps across seeds', () => {
    const shapes = new Set(SEEDS.slice(0, 60).map((s) => JSON.stringify(generateRandomLayout(N, s))));
    expect(shapes.size).toBeGreaterThan(20);
  });

  describe.each(SEEDS)('seed %i', (seed) => {
    const { homes, gardens } = generateRandomLayout(N, seed);
    const gardenAt = new Map(gardens.map((g) => [posKey(g.pos), g.type]));
    const homeKeys = new Set(homes.map(posKey));

    it('places exactly 4 distinct in-bounds homes', () => {
      expect(homes).toHaveLength(4);
      expect(homeKeys.size).toBe(4);
      for (const h of homes) {
        expect(h.x).toBeGreaterThanOrEqual(0);
        expect(h.y).toBeGreaterThanOrEqual(0);
        expect(h.x).toBeLessThan(N);
        expect(h.y).toBeLessThan(N);
      }
    });

    it('keeps the homes a single rotation orbit, so they are equidistant', () => {
      // Clockwise order: each home is the previous one rotated 90°.
      for (let i = 0; i < 4; i++) {
        expect(rotate90(homes[i], C)).toEqual(homes[(i + 1) % 4]);
      }
      // Equidistant: every rotationally-adjacent pair is the same distance
      // apart, and the 2-player pair (0 and 2) is the diagonal.
      const gaps = homes.map((h, i) => cheb(h, homes[(i + 1) % 4]));
      expect(new Set(gaps).size).toBe(1);
      expect(gaps[0]).toBeGreaterThanOrEqual(3);
      expect(cheb(homes[0], homes[2])).toBe(cheb(homes[1], homes[3]));
    });

    it('keeps the homes out of the middle 3×3', () => {
      for (const h of homes) expect(cheb(h, { x: C, y: C })).toBeGreaterThan(1);
    });

    it('is 4-fold rotationally symmetric', () => {
      for (const g of gardens) {
        for (const cell of orbitOf(g.pos, C)) {
          expect(gardenAt.get(posKey(cell))).toBe(g.type);
        }
      }
      expect(gardens.length % 4).toBe(0);
    });

    it('holds 8–16 gardens, none on a home or the Center Star', () => {
      expect(gardens.length).toBeGreaterThanOrEqual(8);
      expect(gardens.length).toBeLessThanOrEqual(16);
      expect(new Set(gardens.map((g) => posKey(g.pos))).size).toBe(gardens.length);
      for (const g of gardens) {
        expect(homeKeys.has(posKey(g.pos))).toBe(false);
        expect(g.pos).not.toEqual({ x: C, y: C });
      }
    });

    it('keeps flytraps, maize and tunnels off every home doorstep', () => {
      for (const g of gardens) {
        if (HAZARDS.has(g.type)) expect(minHomeDistance(g.pos, homes)).toBeGreaterThanOrEqual(2);
      }
    });

    it('leaves every home at least 2 garden-free exits', () => {
      for (const h of homes) {
        const free = orth(N, h).filter((q) => !gardenAt.has(posKey(q)));
        expect(free.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  it('never plants a hazard on a home doorstep, across a wide seed sweep', () => {
    // The per-seed blocks above cover 300 seeds; this sweeps far wider for the
    // one rule an unlucky relaxation would be most likely to break.
    for (let seed = 1; seed <= 3000; seed++) {
      const { homes, gardens } = generateRandomLayout(N, seed);
      for (const g of gardens) {
        if (HAZARDS.has(g.type)) expect(minHomeDistance(g.pos, homes)).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('gives the home doorstep to friendly economy gardens only', () => {
    const doorstep = new Map<PlantableGardenType, number>();
    for (const seed of SEEDS) {
      const { homes, gardens } = generateRandomLayout(N, seed);
      for (const g of gardens) {
        if (minHomeDistance(g.pos, homes) > 1) continue;
        doorstep.set(g.type, (doorstep.get(g.type) ?? 0) + 1);
      }
    }
    for (const hazard of HAZARDS) expect(doorstep.get(hazard)).toBeUndefined();
    // Dandelion is the most likely doorstep roll (45% of that zone's weight).
    expect(doorstep.get('dandelion')).toBeGreaterThan(doorstep.get('slippery') ?? 0);
  });

  it('keeps every type playable rather than statistically absent', () => {
    // A rule that is geometrically impossible to satisfy silently deletes a
    // garden type from the game; each one should hold a real share of tiles.
    const counts = new Map<PlantableGardenType, number>();
    let total = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      for (const g of generateRandomLayout(N, seed).gardens) {
        counts.set(g.type, (counts.get(g.type) ?? 0) + 1);
        total += 1;
      }
    }
    expect(counts.size).toBe(6);
    for (const [, n] of counts) expect(n / total).toBeGreaterThan(0.05);
  });

  it('rolls more than one home orbit across seeds', () => {
    const homeOrbits = new Set(SEEDS.map((s) => posKey(generateRandomLayout(N, s).homes[0])));
    expect(homeOrbits.size).toBeGreaterThan(3);
  });

  it('scales onto larger boards', () => {
    for (const n of [9, 11]) {
      const { homes, gardens } = generateRandomLayout(n, 7);
      const c = (n - 1) / 2;
      expect(homes).toHaveLength(4);
      expect(gardens.length).toBeGreaterThanOrEqual(12);
      const at = new Map(gardens.map((g) => [posKey(g.pos), g.type]));
      for (const g of gardens) {
        for (const cell of orbitOf(g.pos, c)) expect(at.get(posKey(cell))).toBe(g.type);
      }
    }
  });
});

describe('the random preset through createGame', () => {
  const p = { name: 'X', controller: 'cpu' as const };

  it('is the default layout for a new game', () => {
    const s = createGame({ players: [p, p] }, 4);
    expect(s.config.gardenPreset).toBe('random');
    const layout = generateRandomLayout(s.config.boardSize, 4);
    for (const g of layout.gardens) expect(s.gardens[posKey(g.pos)].type).toBe(g.type);
  });

  it('seats 2 players at exactly-opposite homes and 4 at the full orbit', () => {
    for (const seed of [1, 2, 3, 17, 99]) {
      const layout = generateRandomLayout(7, seed);
      const two = createGame({ players: [p, p], gardenPreset: 'random' }, seed);
      expect(two.players.map((x) => x.homePos)).toEqual([layout.homes[0], layout.homes[2]]);

      const four = createGame({ players: [p, p, p, p], gardenPreset: 'random' }, seed);
      expect(four.players.map((x) => x.homePos)).toEqual(layout.homes);
    }
  });

  it('replays identically from config + seed (no layout stored in the record)', () => {
    const a = createGame({ players: [p, p], gardenPreset: 'random' }, 123);
    expect(a.config.customGardens).toBeUndefined();
    expect(a.config.customHomes).toBeUndefined();
    const b = createGame(a.config, a.seed);
    expect(b.gardens).toEqual(a.gardens);
    expect(b.players.map((x) => x.homePos)).toEqual(a.players.map((x) => x.homePos));
  });

  it('lets an explicit customGardens/customHomes layout win over the roll', () => {
    const s = createGame(
      {
        players: [p, p],
        gardenPreset: 'random',
        customHomes: [
          { x: 0, y: 3 },
          { x: 6, y: 3 },
        ],
        customGardens: [{ pos: { x: 3, y: 1 }, type: 'mushroom' }],
      },
      55,
    );
    expect(s.players.map((x) => x.homePos)).toEqual([
      { x: 0, y: 3 },
      { x: 6, y: 3 },
    ]);
    expect(Object.keys(s.gardens).sort()).toEqual(['0,3', '3,1', '6,3']);
  });

  it('rejects a board too small for the procedural layout', () => {
    expect(() => createGame({ players: [p, p], boardSize: 5, gardenPreset: 'random' }, 1)).toThrow();
  });
});

/**
 * The two sparse modes. Their promise is exact — 'fresh' plants nothing,
 * 'essentials' plants exactly one Mushroom and one Dandelion beside every home
 * — so these sweep seeds and board sizes for a promise BROKEN rather than
 * spot-checking one map.
 */
describe('the sparse layout modes', () => {
  const SIZES = [5, 7, 9, 11, 13];
  const MODE_SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

  it('are declared for every board size the setup screen offers', () => {
    for (const mode of LAYOUT_MODES) expect(LAYOUT_MODE_MIN_BOARD_SIZE[mode]).toBeLessThanOrEqual(7);
    expect(LAYOUT_MODE_MIN_BOARD_SIZE.fresh).toBe(5);
    expect(LAYOUT_MODE_MIN_BOARD_SIZE.essentials).toBe(5);
  });

  it('keep the modes apart in the memo cache', () => {
    // Same (boardSize, seed), three different maps — a cache keyed only on the
    // pair would hand the second caller the first one's board.
    const fresh = generateRandomLayout(N, 8, 'fresh');
    const essentials = generateRandomLayout(N, 8, 'essentials');
    const random = generateRandomLayout(N, 8, 'random');
    expect(fresh.gardens).toEqual([]);
    expect(essentials.gardens).toHaveLength(8);
    expect(random.gardens.length).toBeGreaterThan(8);
    expect(generateRandomLayout(N, 8, 'fresh')).toEqual(fresh);
  });

  it('reject a board below the mode minimum', () => {
    expect(() => generateRandomLayout(3, 1, 'fresh')).toThrow();
    expect(() => generateRandomLayout(6, 1, 'essentials')).toThrow();
    expect(() => generateRandomLayout(5, 1, 'random')).toThrow(/"random"/);
  });

  describe.each(SIZES)('%i×%i', (n) => {
    const c = (n - 1) / 2;

    it('fresh: rolls homes and plants nothing at all', () => {
      for (const seed of MODE_SEEDS) {
        const { homes, gardens } = generateRandomLayout(n, seed, 'fresh');
        expect(gardens).toEqual([]);
        expect(new Set(homes.map(posKey)).size).toBe(4);
        for (let i = 0; i < 4; i++) expect(rotate90(homes[i], c)).toEqual(homes[(i + 1) % 4]);
        for (const h of homes) expect(cheb(h, { x: c, y: c })).toBeGreaterThan(1);
      }
    });

    it('essentials: gives every home one Mushroom and one Dandelion neighbour, and nothing else', () => {
      for (const seed of MODE_SEEDS) {
        const { homes, gardens } = generateRandomLayout(n, seed, 'essentials');
        const at = new Map(gardens.map((g) => [posKey(g.pos), g.type]));
        const homeKeys = new Set(homes.map(posKey));

        // Two orbits, one of each economy type, on distinct free spaces.
        expect(gardens).toHaveLength(8);
        expect(at.size).toBe(8);
        const byType = gardens.reduce<Record<string, number>>((acc, g) => {
          acc[g.type] = (acc[g.type] ?? 0) + 1;
          return acc;
        }, {});
        expect(byType).toEqual({ mushroom: 4, dandelion: 4 });
        for (const g of gardens) {
          expect(homeKeys.has(posKey(g.pos))).toBe(false);
          expect(g.pos).not.toEqual({ x: c, y: c });
          // Symmetric: rotating a garden lands on the same type again.
          for (const cell of orbitOf(g.pos, c)) expect(at.get(posKey(cell))).toBe(g.type);
        }

        // The promise itself, checked per home rather than per garden.
        for (const home of homes) {
          const neighbours = gardens.filter((g) => cheb(g.pos, home) === 1).map((g) => g.type);
          expect(neighbours.filter((t) => t === 'mushroom')).toHaveLength(1);
          expect(neighbours.filter((t) => t === 'dandelion')).toHaveLength(1);
          expect(orth(n, home).filter((q) => !at.has(posKey(q))).length).toBeGreaterThanOrEqual(1);
        }
      }
    });
  });

  it('roll a different board from seed to seed', () => {
    for (const mode of ['fresh', 'essentials'] as const) {
      const shapes = new Set(MODE_SEEDS.map((s) => JSON.stringify(generateRandomLayout(N, s, mode))));
      expect(shapes.size).toBeGreaterThan(10);
    }
  });

  it('plant no hazards at all — that is what makes them the gentle modes', () => {
    for (const seed of MODE_SEEDS) {
      for (const g of generateRandomLayout(N, seed, 'essentials').gardens) {
        expect(HAZARDS.has(g.type)).toBe(false);
      }
    }
  });
});

describe('the mode presets through createGame', () => {
  const p = { name: 'X', controller: 'cpu' as const };

  it('play exactly the map their mode rolls', () => {
    for (const [preset, mode] of [
      ['fresh', 'fresh'],
      ['essentials', 'essentials'],
      ['random', 'random'],
    ] as const) {
      const s = createGame({ players: [p, p, p, p], gardenPreset: preset }, 21);
      const layout = generateRandomLayout(s.config.boardSize, 21, mode);
      expect(s.players.map((x) => x.homePos)).toEqual(layout.homes);
      const planted = Object.entries(s.gardens)
        .filter(([, g]) => g.type !== 'home')
        .map(([key]) => key)
        .sort();
      expect(planted).toEqual(layout.gardens.map((g) => posKey(g.pos)).sort());
    }
  });

  it('run the sparse modes on a 5×5, where the full random map does not fit', () => {
    for (const preset of ['fresh', 'essentials'] as const) {
      const s = createGame({ players: [p, p], boardSize: 5, gardenPreset: preset }, 6);
      expect(s.config.boardSize).toBe(5);
      expect(Object.values(s.gardens).filter((g) => g.type === 'home')).toHaveLength(2);
    }
    expect(() => createGame({ players: [p, p], boardSize: 5, gardenPreset: 'random' }, 6)).toThrow();
  });
});
