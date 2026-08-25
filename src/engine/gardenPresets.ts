/**
 * Garden preset registry: named layouts of additional (non-home) gardens.
 *
 * There are two ways in, and they end up in the same list:
 *
 *  1. DRAW ONE. Open the in-game editor (setup → "Preset: Custom", or ✏️ Edit
 *     beside any preset), paint the layout, "Save & export", then drop the
 *     downloaded .json into `presets/`. It is registered on the next build,
 *     under an id taken from the filename — no code to write. This is the
 *     path for fixed layouts, including ones that move the Home Gardens.
 *  2. WRITE ONE. Append an entry to `BUILT_IN_PRESETS` below. Worth it when
 *     the layout must scale with board size N or roll from the seed, which a
 *     file (plain positions, one board size) cannot express.
 *
 * Either way `setup.ts` looks presets up by id (no hardcoded switch) and
 * `SetupScreen.tsx` renders the menu straight from `GARDEN_PRESETS`.
 *
 * The list has two halves, and the menus show them apart:
 *
 *  - The three MODES (`MODE_PRESETS`) — Fresh, Bare Essentials, True Random.
 *    Each is procedural: it builds its gardens AND its homes from the seed
 *    (see randomLayout.ts), which is what `seeded` and `buildHomes` on the
 *    definition below exist for. Being generated, they fit every board size,
 *    which is why they are what setup offers first.
 *  - The CLASSIC layouts (`CLASSIC_PRESETS`, `classic: true`) — fixed maps,
 *    hand-written or file-backed, mostly drawn around a 7×7. They still play
 *    and their ids still resolve (saves, replays, multiplayer); they just sit
 *    behind a "show classic layouts" toggle instead of crowding the menu.
 *    Hand-written ones scale with board size N, center c = (N - 1) / 2 (the
 *    positions below are shown for a 7×7, so c = 3).
 *
 * Preset gardens are wild tiles — they come from no player's supply (see
 * `createGame`), so a layout is free to use any mix of types.
 */

import type { PlantableGardenType, Pos } from './types';
import type { LayoutMode } from './randomLayout';
import { LAYOUT_MODE_MIN_BOARD_SIZE, generateRandomLayout } from './randomLayout';
import { presetDefFromFile } from './presetFile';

export interface GardenPresetDef {
  /** Stable identifier — this is the value stored on `GameConfig.gardenPreset`. */
  id: string;
  /** Short menu label. */
  label: string;
  /** One-line blurb shown under the menu once selected. */
  description: string;
  /** Smallest boardSize this layout fits on (its slots need room around the center). */
  minBoardSize: number;
  /**
   * Compute the garden positions for a given (odd) board size. Fixed layouts
   * ignore `seed` and callers may omit it; a `seeded` preset builds its whole
   * map from it and falls back to seed 0, so pass the game seed for those.
   */
  build: (boardSize: number, seed?: number) => Array<{ pos: Pos; type: PlantableGardenType }>;
  /**
   * Optional override of where the 4 Home Gardens sit (seat order
   * west/north/east/south by convention; 2-player games use indices 0 and
   * 2). Set by every file-backed preset and by player-built ones; leave it
   * undefined to use the standard edge-midpoint formula (`homePositions`)
   * for whatever player count is chosen. Positions are authored for
   * `minBoardSize`, and stay in bounds on any larger board.
   */
  homes?: Pos[];
  /** True when `build`/`buildHomes` vary with the seed (see randomLayout.ts). */
  seeded?: boolean;
  /**
   * Seed-dependent home placement, for procedural presets that move the homes
   * too. Always returns 4 positions in clockwise order, like `homes`.
   */
  buildHomes?: (boardSize: number, seed: number) => Pos[];
  /**
   * A fixed hand-drawn layout rather than one of the starting-board MODES.
   * Every one of these still plays, and every id still resolves — they are
   * simply folded away behind "classic layouts" in the menus, so the first
   * thing a player sees is the three modes and their own presets rather than a
   * list mostly drawn for one board size. See `MODE_PRESETS` / `CLASSIC_PRESETS`.
   */
  classic?: boolean;
}

/**
 * A starting-board mode: the whole map, homes included, rolled from the seed.
 * All three share one generator (randomLayout.ts) and differ only in what it
 * plants, so they are built from one factory rather than written out three
 * times.
 */
function modePreset(mode: LayoutMode, label: string, description: string): GardenPresetDef {
  return {
    id: mode,
    label,
    description,
    minBoardSize: LAYOUT_MODE_MIN_BOARD_SIZE[mode],
    seeded: true,
    build: (n, seed = 0) => generateRandomLayout(n, seed, mode).gardens,
    buildHomes: (n, seed) => generateRandomLayout(n, seed, mode).homes,
  };
}

/**
 * The three modes, emptiest first. `random` keeps its old id — it is the
 * default preset and the one every existing save, replay and room references
 * — even though its label is now "True Random".
 */
const MODE_PRESET_LIST: readonly GardenPresetDef[] = [
  modePreset(
    'fresh',
    'Fresh',
    'The board starts with only Home Gardens — placed symmetrically, somewhere new each game. Every other garden is one you plant.',
  ),
  modePreset(
    'essentials',
    'Bare Essentials',
    'A Mushroom and a Dandelion Garden sit next to every Home Garden, and nothing else. Symmetrical, and rolled fresh each game.',
  ),
  modePreset(
    'random',
    'True Random',
    'Creates a random symmetrical starting board: homes land equidistant somewhere new, and the extra gardens follow fairness rules that keep hazards off your doorstep.',
  ),
];

/** The fixed hand-written layouts, kept for the games and replays that use them. */
const CLASSIC_BUILT_INS: readonly GardenPresetDef[] = [
  {
    id: 'none',
    label: 'None',
    description: 'Homes only (+ Center Star, if enabled), on the standard edge midpoints. The purest race.',
    minBoardSize: 5,
    classic: true,
    build: () => [],
  },
  {
    id: 'few',
    label: 'Few (tunnels)',
    description: 'Four Tunnel Gardens in a corner ring — a mobility loop every seat can use.',
    minBoardSize: 7,
    classic: true,
    build: (n) => tunnelCorners(n),
  },
  {
    id: 'orchard',
    label: 'Orchard',
    description: 'Four Dandelion Gardens, one guarding each home approach. Calm, economy-focused.',
    minBoardSize: 7,
    classic: true,
    build: (n) => midEdges(n, 'dandelion'),
  },
  {
    id: 'fortress',
    label: 'Fortress',
    description: 'Maize Gardens tax the approaches; Mushroom Gardens behind them rebuild your army. Slow and defensive.',
    minBoardSize: 7,
    classic: true,
    build: (n) => [...midEdges(n, 'maize'), ...innerCross(n, 'mushroom')],
  },
  {
    id: 'gauntlet',
    label: 'Gauntlet',
    description: 'Slippery corners fling you inward, straight at a ring of Flytraps guarding the center. Chaotic.',
    minBoardSize: 7,
    classic: true,
    build: (n) => [...tunnelCorners(n, 'slippery'), ...innerDiagonals(n, 'flytrap')],
  },
  {
    id: 'many',
    label: 'Many',
    description: 'Tunnels, Dandelions, Mushrooms and Flytraps together (16 gardens) — a bit of everything.',
    minBoardSize: 7,
    classic: true,
    build: (n) => [
      ...tunnelCorners(n),
      ...midEdges(n, 'dandelion'),
      ...innerCross(n, 'mushroom'),
      ...innerDiagonals(n, 'flytrap'),
    ],
  },
];

/** Every hand-written preset, modes first. */
const BUILT_IN_PRESETS: readonly GardenPresetDef[] = [...MODE_PRESET_LIST, ...CLASSIC_BUILT_INS];

/**
 * Every .json under `presets/`, eagerly bundled. The glob is a build-time
 * directory listing, so adding a file is the whole job of adding a preset —
 * there is no index to keep in step.
 */
const PRESET_FILES: Record<string, unknown> = import.meta.glob('./presets/*.json', {
  eager: true,
  import: 'default',
});

/**
 * Preset id from a file path: the basename, minus `.json` and minus the
 * `.whimsy-preset` the editor's download tacks on. So
 * `presets/midfield.whimsy-preset.json` registers as `midfield`.
 *
 * The id is what `GameConfig.gardenPreset` stores and what multiplayer sends
 * over the wire, so RENAMING A FILE RENAMES ITS PRESET: old saves and replays
 * that reference the id stop resolving.
 */
function presetIdFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.json$/i, '').replace(/\.whimsy-preset$/i, '');
}

/**
 * Parse the dropped-in files. Anything malformed throws here, at module load,
 * naming the file — a bad preset is a broken build, not a preset silently
 * missing from the menu at runtime.
 */
function fileBackedPresets(): GardenPresetDef[] {
  const taken = new Set(BUILT_IN_PRESETS.map((p) => p.id));
  return Object.keys(PRESET_FILES)
    .sort()
    .map((path) => {
      const id = presetIdFromPath(path);
      if (taken.has(id)) throw new Error(`Garden preset "${path}": the id "${id}" is already taken.`);
      taken.add(id);
      try {
        // A file is a fixed layout for one board size, so it lists with the
        // other classic maps rather than with the modes.
        return { ...presetDefFromFile(PRESET_FILES[path], id), classic: true };
      } catch (e) {
        throw new Error(`Garden preset "${path}": ${e instanceof Error ? e.message : String(e)}`);
      }
    });
}

/** The menu: hand-written presets first, then the file-backed ones in filename order. */
export const GARDEN_PRESETS: readonly GardenPresetDef[] = [...BUILT_IN_PRESETS, ...fileBackedPresets()];

export const DEFAULT_GARDEN_PRESET_ID = 'random';

/** Id of the fullest procedural mode (the one whose whole map is rolled from the seed). */
export const RANDOM_GARDEN_PRESET_ID = 'random';

/** The starting-board modes, in menu order — what setup offers first. */
export const MODE_PRESETS: readonly GardenPresetDef[] = GARDEN_PRESETS.filter((p) => !p.classic);

/** The fixed layouts, hand-written and file-backed alike, folded behind a toggle in the menus. */
export const CLASSIC_PRESETS: readonly GardenPresetDef[] = GARDEN_PRESETS.filter((p) => p.classic);

/** Look up a preset by id, or `undefined` if the id isn't registered. */
export function findGardenPreset(id: string): GardenPresetDef | undefined {
  return GARDEN_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Shared slot geometry (4-fold rotationally symmetric around the center, so
// every preset is fair for both the 2-player west/east and 4-player seatings)
// ---------------------------------------------------------------------------

/** Outer corner ring: (1,1) (n-2,1) (1,n-2) (n-2,n-2). Default type 'tunnel'. */
function tunnelCorners(n: number, type: PlantableGardenType = 'tunnel'): Array<{ pos: Pos; type: PlantableGardenType }> {
  return [
    { pos: { x: 1, y: 1 }, type },
    { pos: { x: n - 2, y: 1 }, type },
    { pos: { x: 1, y: n - 2 }, type },
    { pos: { x: n - 2, y: n - 2 }, type },
  ];
}

/** One slot near each home approach: (1,c) (c,1) (n-2,c) (c,n-2). */
function midEdges(n: number, type: PlantableGardenType): Array<{ pos: Pos; type: PlantableGardenType }> {
  const c = (n - 1) / 2;
  return [
    { pos: { x: 1, y: c }, type },
    { pos: { x: c, y: 1 }, type },
    { pos: { x: n - 2, y: c }, type },
    { pos: { x: c, y: n - 2 }, type },
  ];
}

/** Orthogonal ring hugging the center: (c-1,c) (c,c-1) (c+1,c) (c,c+1). */
function innerCross(n: number, type: PlantableGardenType): Array<{ pos: Pos; type: PlantableGardenType }> {
  const c = (n - 1) / 2;
  return [
    { pos: { x: c - 1, y: c }, type },
    { pos: { x: c, y: c - 1 }, type },
    { pos: { x: c + 1, y: c }, type },
    { pos: { x: c, y: c + 1 }, type },
  ];
}

/** Diagonal ring hugging the center: (c±1, c±1). */
function innerDiagonals(n: number, type: PlantableGardenType): Array<{ pos: Pos; type: PlantableGardenType }> {
  const c = (n - 1) / 2;
  return [
    { pos: { x: c - 1, y: c - 1 }, type },
    { pos: { x: c + 1, y: c - 1 }, type },
    { pos: { x: c - 1, y: c + 1 }, type },
    { pos: { x: c + 1, y: c + 1 }, type },
  ];
}
