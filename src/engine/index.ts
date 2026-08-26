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
// (PLANTABLE_GARDEN_TYPES now lives in types.ts, covered by the star export above.)
export {
  createGame,
  DEFAULT_CONFIG,
  TILES_PER_TYPE,
  homePositions,
  seatHomes,
  presetGardens,
  sealHiddenState,
} from './setup';
export type { GameSeal } from './setup';

// Garden preset registry (UI reads this to render the preset menu).
export {
  GARDEN_PRESETS,
  MODE_PRESETS,
  CLASSIC_PRESETS,
  DEFAULT_GARDEN_PRESET_ID,
  RANDOM_GARDEN_PRESET_ID,
  findGardenPreset,
} from './gardenPresets';
export type { GardenPresetDef } from './gardenPresets';

// Preset file format (.json): the in-game editor writes it, the setup screen
// imports it, and `engine/presets/*.json` ships it as built-in presets.
export {
  PRESET_FILE_KIND,
  PRESET_FILE_VERSION,
  PRESET_LABEL_MAX_LENGTH,
  PRESET_DESCRIPTION_MAX_LENGTH,
  reservedHomePositions,
  presetDefFromLayout,
  presetDefFromFile,
  parsePresetFile,
  toPresetFile,
  validatePresetLayout,
} from './presetFile';
export type { GardenPresetFile, ValidatedPresetLayout, PresetLayoutValidation } from './presetFile';

// Procedural map generation (the three starting-board modes; setup previews them).
export {
  generateRandomLayout,
  orbitOf,
  rotate90,
  LAYOUT_MODES,
  LAYOUT_MODE_MIN_BOARD_SIZE,
  RANDOM_LAYOUT_MIN_BOARD_SIZE,
} from './randomLayout';
export type { RandomLayout, LayoutMode } from './randomLayout';

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
export { MAX_ENTRY_EFFECT_HOPS } from './gardens';

// Canonical identities for actions and intents (order-independent keys).
export { actionKey, intentKey, targetKey, targetsKey, canonicalTargets, sameAction, byActionKey } from './actionId';

// Structural state validation (diagnostics: hosts, tests, error paths).
export { checkInvariants, invariantsHold, assertInvariants } from './invariants';
export type { InvariantViolation } from './invariants';

// Quick chat: fixed phrases only, never free text (see quickchat.ts).
export {
  QUICK_CHAT_GROUPS,
  QUICK_CHAT_PHRASES,
  QUICK_CHAT_MUSINGS,
  QUICK_CHAT_MUSINGS_GROUP,
  QUICK_CHAT_PER_TURN,
  getQuickChatPhrase,
  quickChatsLeft,
} from './quickchat';
export type { QuickChatGroup, QuickChatGroupId } from './quickchat';

// Per-seat redaction (multiplayer: never broadcast raw GameState — see view.ts).
export { viewFor, isPlayerView, nameSaltOf, HIDDEN_CARD_ID } from './view';
export type { PlayerView } from './view';

// Shot-clock enforcement (multiplayer hosts; the engine holds no wall clock).
export { getTimeoutAction, applyTimeout, isOnTheClock, MAX_TIMEOUT_STEPS } from './timeout';

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
  gnomeBoardCap,
  reserveGnomes,
  gardenIsActive,
  wishCap,
  maizeExitCost,
} from './helpers';

// Card framework (data-driven; the full 23-card + 5-curse list from CARDS.md).
export {
  CARD_DEFINITIONS,
  CURSE_DEFINITIONS,
  DECK_CARD_IDS,
  DEFAULT_CURSE_COPIES,
  MAX_CARD_COPIES,
  defaultDeckCounts,
  resolveDeckCounts,
  getCardDef,
  getCurseDef,
  isCurseId,
  deckHasCards,
  whyCannotPlayNow,
} from './cards';
export type { WhimsyCardDef, CurseCardDef, CardTiming, TargetStep, TargetingContext } from './cards';

// Objective-driven CPU player. `chooseAiAction` takes an optional plan store —
// see `ai/memory.ts` for why the plan lives beside the state rather than in it.
export {
  chooseAiAction,
  describeAiPlan,
  createAiMemory,
  clearAiMemory,
  sharedAiMemory,
  PERSONALITIES,
  personalityFor,
} from './ai';
export type { AiMemory, AiPersonality, AiPlan, Objective, ObjectiveKind, StrategicState } from './ai';

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
