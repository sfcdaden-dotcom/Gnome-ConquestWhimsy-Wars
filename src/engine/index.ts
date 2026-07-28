/**
 * Whimsy Wars engine — public API barrel.
 * UI and tests should import from `src/engine` (this file) only.
 * See ENGINE_API.md at the project root for full documentation.
 */

// Types (everything in types.ts is part of the public surface).
export * from './types';

// RNG.
export { createRng, normalizeSeed, rngNext, rngInt, rollDie, shuffled } from './rng';
export type { Rng } from './rng';

// Game creation & layouts.
export {
  createGame,
  DEFAULT_CONFIG,
  TILES_PER_TYPE,
  PLANTABLE_GARDEN_TYPES,
  homePositions,
  seatHomes,
  presetGardens,
} from './setup';

// Garden preset registry (UI reads this to render the preset menu).
export {
  GARDEN_PRESETS,
  DEFAULT_GARDEN_PRESET_ID,
  RANDOM_GARDEN_PRESET_ID,
  findGardenPreset,
} from './gardenPresets';
export type { GardenPresetDef } from './gardenPresets';

// Procedural map generation (the "Random" preset; the setup screen previews it).
export { generateRandomLayout, orbitOf, rotate90, RANDOM_LAYOUT_MIN_BOARD_SIZE } from './randomLayout';
export type { RandomLayout } from './randomLayout';

// Core reducer API.
export {
  applyAction,
  getLegalActionIntents,
  getPendingDecisionOptions,
  getLegalActions,
  enumerateCompleteCardActions,
  getPlayerToAct,
  isGameOver,
  boardGnomes,
} from './engine';
export { MAX_SETTLE_STEPS } from './settle';

// Read-only state queries (safe for UI use).
export {
  posKey,
  parsePos,
  samePos,
  inBounds,
  isOrthAdjacent,
  manhattan,
  orthNeighbors,
  allNeighbors,
  centerPos,
  gardenAt,
  unitsAt,
  playerUnitsAt,
  enemyUnitsAt,
  playerUnits,
  gnomesOnBoard,
  reserveGnomes,
  gardenIsActive,
  wishCap,
  maizeExitCost,
} from './helpers';

// Card framework (data-driven; the full 23-card + 5-curse list from CARDS.md).
export { CARD_DEFINITIONS, CURSE_DEFINITIONS, getCardDef, getCurseDef, isCurseId, deckHasCards } from './cards';
export type { WhimsyCardDef, CurseCardDef, CardTiming, TargetStep, TargetingContext } from './cards';

// Heuristic CPU player.
export { chooseAiAction } from './ai';

// Self-play match recorder (training-data generation).
export {
  MATCH_RECORD_SCHEMA,
  DEFAULT_MAX_ACTIONS,
  playSelfPlayGame,
  simulateSelfPlay,
  replayMatch,
  toNdjson,
  fromNdjson,
} from './selfplay';
export type { MatchRecord, MatchResult, MatchEndReason } from './selfplay';

// Learned-CPU training encoders + sample extractor (pure TS, no ML deps).
export {
  ENCODING_SCHEMA,
  MAX_SEATS,
  ENCODED_CARD_IDS,
  ENCODED_CURSE_IDS,
  OBS_PLANES,
  OBS_SCALARS,
  OPTION_SIZE,
  obsSize,
  encodeObservation,
  encodeOption,
} from './encode';
export { extractSamples, extractDataset } from './samples';
export type { Sample, ExtractOptions } from './samples';
