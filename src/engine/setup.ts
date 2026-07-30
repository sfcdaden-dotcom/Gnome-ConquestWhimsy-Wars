/**
 * Game creation: config validation, board layout presets, initial state,
 * and the turn-order roll-off (surfaced as `rollOff` decisions).
 *
 * Home Gardens (equidistant edge midpoints, seats clockwise; N = boardSize,
 * center c = (N-1)/2 — shown for the default 7×7, so c = 3):
 *   2 players: seat 0 west (0,3), seat 1 east (6,3)
 *   4 players: seat 0 west (0,3), seat 1 north (3,0), seat 2 east (6,3),
 *              seat 3 south (3,6)
 * Two things override this formula: `customHomes` (e.g. a preset built in the
 * in-game editor that moved the homes), and a preset's own homes — `homes` on
 * a file-backed preset, or `buildHomes` on a procedural one (the "Random"
 * preset rolls a symmetric home orbit from the seed). All still hand 2-player
 * games an exactly-opposite pair, via `seatHomes`.
 *
 * Additional-garden layouts ("presets") are registered in gardenPresets.ts —
 * see that file for the list and for how to add a new one.
 */

import type {
  CreateGameOptions,
  GameConfig,
  GameState,
  GardenPreset,
  PlantableGardenType,
  PlayerId,
  PlayerState,
  Pos,
} from './types';
import { EngineError, PLANTABLE_GARDEN_TYPES } from './types';
import { normalizeSeed, shuffled } from './rng';
import { posKey } from './helpers';
import { makeGarden } from './gardens';
import { buildInitialDeck } from './cards';
import { DEFAULT_GARDEN_PRESET_ID, findGardenPreset } from './gardenPresets';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  boardSize: 7,
  startingWishes: 3,
  wishLimit: 3,
  gnomeBoardLimit: 8,
  totalReinforcements: 16,
  handLimit: 7,
  centerStar: true,
  tilesPerType: 4,
  gardenPreset: DEFAULT_GARDEN_PRESET_ID as GardenPreset,
} as const;

/** Per-player supply: 4 tiles of each plantable type (see config.tilesPerType). */
export const TILES_PER_TYPE = 4;

export { PLANTABLE_GARDEN_TYPES } from './types';

/** A fresh per-player tile supply. */
export function makeSupply(tilesPerType: number): Record<PlantableGardenType, number> {
  return {
    dandelion: tilesPerType,
    mushroom: tilesPerType,
    flytrap: tilesPerType,
    maize: tilesPerType,
    slippery: tilesPerType,
    tunnel: tilesPerType,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Home garden positions for a seating (clockwise). */
export function homePositions(boardSize: number, playerCount: number): Pos[] {
  const c = (boardSize - 1) / 2;
  const west = { x: 0, y: c };
  const north = { x: c, y: 0 };
  const east = { x: boardSize - 1, y: c };
  const south = { x: c, y: boardSize - 1 };
  return playerCount === 2 ? [west, east] : [west, north, east, south];
}

/**
 * Take the seats' share of a 4-home layout: 2-player games use the opposite
 * pair (indices 0 and 2), mirroring `homePositions` itself.
 */
export function seatHomes(fourHomes: readonly Pos[], playerCount: number): Pos[] {
  return playerCount === 2 ? [fourHomes[0], fourHomes[2]] : fourHomes.slice(0, 4);
}

/**
 * Additional-garden preset positions (registry: gardenPresets.ts). `seed` only
 * matters for procedural presets — fixed layouts ignore it.
 */
export function presetGardens(
  boardSize: number,
  preset: GardenPreset,
  seed = 0,
): Array<{ pos: Pos; type: PlantableGardenType }> {
  const def = findGardenPreset(preset);
  if (!def) badConfig(`Unknown gardenPreset "${preset}"`);
  return def.build(boardSize, seed);
}

// ---------------------------------------------------------------------------
// createGame
// ---------------------------------------------------------------------------

function badConfig(message: string): never {
  throw new EngineError('BAD_CONFIG', message);
}

function resolveConfig(options: CreateGameOptions): GameConfig {
  const playerCount = options.players.length;
  if (playerCount !== 2 && playerCount !== 4) badConfig('Whimsy Wars supports exactly 2 or 4 players');
  const boardSize = options.boardSize ?? DEFAULT_CONFIG.boardSize;
  if (!Number.isInteger(boardSize) || boardSize < 5 || boardSize % 2 === 0) {
    badConfig('boardSize must be an odd integer >= 5');
  }
  const customHomes = options.customHomes;
  if (customHomes) {
    if (customHomes.length !== playerCount) {
      badConfig(`customHomes must have exactly ${playerCount} position(s), got ${customHomes.length}`);
    }
    const seen = new Set<string>();
    for (const pos of customHomes) {
      if (!Number.isInteger(pos.x) || !Number.isInteger(pos.y) || pos.x < 0 || pos.y < 0 || pos.x >= boardSize || pos.y >= boardSize) {
        badConfig(`customHomes position (${pos.x},${pos.y}) is out of bounds for boardSize ${boardSize}`);
      }
      const key = posKey(pos);
      if (seen.has(key)) badConfig(`customHomes has more than one home at ${key}`);
      seen.add(key);
    }
  }
  const gardenPreset = options.gardenPreset ?? DEFAULT_CONFIG.gardenPreset;
  const customGardens = options.customGardens;
  if (customGardens) {
    const plantable = new Set<string>(PLANTABLE_GARDEN_TYPES);
    const seen = new Set<string>();
    for (const g of customGardens) {
      if (!Number.isInteger(g.pos.x) || !Number.isInteger(g.pos.y) || g.pos.x < 0 || g.pos.y < 0 || g.pos.x >= boardSize || g.pos.y >= boardSize) {
        badConfig(`customGardens position (${g.pos.x},${g.pos.y}) is out of bounds for boardSize ${boardSize}`);
      }
      if (!plantable.has(g.type)) badConfig(`customGardens has an invalid garden type "${g.type}"`);
      const key = posKey(g.pos);
      if (seen.has(key)) badConfig(`customGardens has more than one garden at ${key}`);
      seen.add(key);
    }
  } else {
    const presetDef = findGardenPreset(gardenPreset);
    if (!presetDef) badConfig(`Unknown gardenPreset "${gardenPreset}"`);
    if (boardSize < presetDef.minBoardSize) {
      badConfig(`gardenPreset "${gardenPreset}" requires boardSize >= ${presetDef.minBoardSize}`);
    }
  }
  const cfg: GameConfig = {
    boardSize,
    startingWishes: options.startingWishes ?? DEFAULT_CONFIG.startingWishes,
    wishLimit: options.wishLimit ?? DEFAULT_CONFIG.wishLimit,
    gnomeBoardLimit: options.gnomeBoardLimit ?? DEFAULT_CONFIG.gnomeBoardLimit,
    totalReinforcements: options.totalReinforcements ?? DEFAULT_CONFIG.totalReinforcements,
    handLimit: options.handLimit ?? DEFAULT_CONFIG.handLimit,
    centerStar: options.centerStar ?? DEFAULT_CONFIG.centerStar,
    tilesPerType: options.tilesPerType ?? DEFAULT_CONFIG.tilesPerType,
    gardenPreset,
    ...(customGardens ? { customGardens } : {}),
    ...(customHomes ? { customHomes } : {}),
    players: options.players.map((p, i) => ({
      name: p.name ?? `Player ${i + 1}`,
      controller: p.controller,
      difficulty: p.difficulty ?? 'normal',
    })),
  };
  if (cfg.startingWishes < 0 || cfg.wishLimit < 1 || cfg.gnomeBoardLimit < 1) badConfig('Limits must be positive');
  if (cfg.startingWishes > cfg.wishLimit) badConfig('startingWishes cannot exceed wishLimit');
  if (cfg.totalReinforcements < cfg.gnomeBoardLimit) {
    badConfig('totalReinforcements must be >= gnomeBoardLimit');
  }
  if (cfg.handLimit < 1) badConfig('handLimit must be >= 1');
  if (!Number.isInteger(cfg.tilesPerType) || cfg.tilesPerType < 1) {
    badConfig('tilesPerType must be a positive integer');
  }
  return cfg;
}

/**
 * Create a new game. The returned state is in the turn-order roll-off:
 * `state.pendingDecision` asks each seat in order to submit a `rollOff`
 * action; highest roll goes first (ties reroll among the tied), then play
 * proceeds clockwise. Players start with 0 gnomes on the board.
 */
export function createGame(options: CreateGameOptions, seed: number): GameState {
  const config = resolveConfig(options);
  const playerCount = config.players.length;
  // Home placement, most specific first: `customHomes` (the in-game editor, or
  // a layout the setup screen already previewed) beats the preset's own homes
  // — rolled from the seed by a procedural preset, or fixed on a file-backed
  // one — which in turn beats the default edge-midpoint formula.
  const presetDef = findGardenPreset(config.gardenPreset);
  const presetHomes = presetDef?.buildHomes?.(config.boardSize, seed) ?? presetDef?.homes;
  const homes =
    config.customHomes ??
    (presetHomes ? seatHomes(presetHomes, playerCount) : homePositions(config.boardSize, playerCount));

  const players: PlayerState[] = config.players.map((p, i) => ({
    id: i as PlayerId,
    name: p.name,
    controller: p.controller,
    difficulty: p.difficulty,
    status: 'playing',
    wishes: config.startingWishes,
    hand: [],
    gnomesSpawned: 0,
    gnomesLost: 0,
    homePos: homes[i],
    supply: makeSupply(config.tilesPerType),
    quickChatsThisTurn: 0,
  }));

  const state: GameState = {
    schemaVersion: 1,
    config,
    seed,
    rngState: normalizeSeed(seed),
    status: 'rolloff',
    rolloff: {
      participants: players.map((p) => p.id),
      pending: players.map((p) => p.id),
      rolls: players.map(() => null),
    },
    players,
    gardens: {},
    units: {},
    deck: [],
    discard: [],
    cursePool: [],
    activeCurses: [],
    turn: null,
    harvest: null,
    fight: null,
    fightQueue: [],
    cardStack: [],
    responseQueue: [],
    rollModifiers: players.map(() => 0),
    preventionShields: 0,
    marriages: [],
    timedEffects: [],
    eliminationQueue: [],
    turnMustEnd: false,
    pendingDecision: { kind: 'rollOff', player: players[0].id },
    winner: null,
    nextUnitId: 1,
    nextFightId: 1,
    events: [],
    eventCount: 0,
  };

  // Home gardens.
  for (const p of players) {
    state.gardens[posKey(p.homePos)] = makeGarden('home', 0, p.id);
  }

  // Preset (or custom) gardens — WILD tiles: they come from no player's
  // supply, and when destroyed they leave the game instead of returning.
  const layout = config.customGardens ?? presetGardens(config.boardSize, config.gardenPreset, seed);
  for (const g of layout) {
    const key = posKey(g.pos);
    if (state.gardens[key]) badConfig(`Preset layout collision at ${key}`);
    state.gardens[key] = makeGarden(g.type, 0);
  }

  // Whimsy deck: 2 copies of each of the 23 cards, shuffled (see cards.ts).
  buildInitialDeck(state);

  return state;
}

// ---------------------------------------------------------------------------
// Sealing the deck (networked play)
// ---------------------------------------------------------------------------

/**
 * Break the link between the seed and the hidden zones, for a game whose
 * secrets have to survive a hostile client.
 *
 * `createGame` derives EVERYTHING from one seed — the garden layout, the deck
 * order, and the whole dice stream. The layout is then drawn on the board for
 * all to see, which makes the seed searchable: generate layouts for candidate
 * seeds until one matches the board, and the deck falls out with it. Measured
 * at ~0.4 ms per layout, a full 2^32 sweep is ~480 core-hours — one cheap,
 * *reusable* precomputation, not a per-game cost. Keeping the seed secret does
 * not fix this; the board is the leak.
 *
 * So a host calls this once, immediately after `createGame`, with a
 * cryptographically random `secret` it never sends anyone:
 *
 * ```ts
 * const secret = crypto.getRandomValues(new Uint32Array(1))[0];
 * let state = sealHiddenState(createGame(options, mapSeed), secret);
 * ```
 *
 * After it, the two split cleanly:
 *  - `state.seed` is now only the MAP seed. It still reproduces the layout —
 *    and nothing else. Safe for the host to publish (a room can name its map)
 *    once the deck no longer follows from it.
 *  - `secret` alone drives the deck order and every future die roll, and lives
 *    only on the host.
 *
 * The `secret` must come from a CSPRNG (`crypto.getRandomValues`), never from
 * a counter, a timestamp, or the room code — all of which are guessable, which
 * is the entire problem this function exists to solve.
 *
 * Pure, like `applyAction`: the input is never mutated. Determinism is intact
 * — the same (seed, secret) pair always yields the same game — so a sealed
 * game still replays exactly, provided the record carries the secret too
 * (`MatchRecord` currently carries only the seed; see selfplay.ts).
 *
 * Only legal on a freshly created game: reshuffling a deck that has been drawn
 * from would contradict cards players have already seen.
 */
export function sealHiddenState(state: GameState, secret: number): GameState {
  if (state.status !== 'rolloff' || state.eventCount !== 0 || state.turn !== null) {
    throw new EngineError(
      'BAD_ARGUMENT',
      'sealHiddenState: only a freshly created game can be sealed (nothing drawn yet)',
    );
  }
  const draft = structuredClone(state) as GameState;
  // The secret replaces the seed-derived stream: dice, and every shuffle from
  // here on (including mid-game discard reshuffles) now follow from it alone.
  draft.rngState = normalizeSeed(secret);
  const reshuffled = shuffled(draft.rngState, draft.deck);
  draft.deck = reshuffled.value;
  draft.rngState = reshuffled.state;
  return draft;
}

/**
 * The commit–reveal envelope for a sealed game. Plain data, so it rides along
 * in a MatchRecord and over the wire like everything else; the crypto that
 * produces and checks it lives in `src/net/commitment.ts`.
 *
 * The problem it solves: once the deck follows from a secret only the host
 * knows, players have to take the host's word that it was random and never
 * touched. Publishing `commitment` when the game STARTS and `secret` when it
 * ENDS removes the need for that trust — anyone can then replay the whole game
 * and check that the deck they saw is the deck the commitment bound the host
 * to, while learning nothing while it still matters.
 *
 * `nonce` is not decoration. A bare 32-bit secret is exhaustible: an opponent
 * who receives `sha256(secret)` at game start can hash all 2^32 candidates in
 * minutes and read the deck. The nonce pads the pre-image out of reach.
 */
export interface GameSeal {
  /** The `secret` handed to `sealHiddenState`. Published at game END. */
  secret: number;
  /** Random padding, published with the secret. See above — this is load-bearing. */
  nonce: string;
  /** SHA-256 of (secret, nonce), hex. Published when the game STARTS. */
  commitment: string;
}
