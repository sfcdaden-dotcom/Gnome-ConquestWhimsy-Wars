/**
 * The advanced setup values, and the rules about them — kept apart from the
 * panel that edits them (AdvancedSettings.tsx) so the setup screen and the
 * tests can reason about a configuration without rendering anything.
 *
 * Every value here maps to a field the engine already validates
 * (`setup.resolveConfig`). `settingsProblem` mirrors those checks so a bad
 * combination is refused while the panel is open, rather than as an engine
 * error after "Start the war".
 */

import type { CardId } from '../engine';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS, DEFAULT_CONFIG, DEFAULT_CURSE_COPIES, resolveDeckCounts } from '../engine';

/** Board sizes offered. Odd only, and >= 5 — the engine rejects anything else. */
export const BOARD_SIZES = [5, 7, 9, 11, 13] as const;

/** Ceilings for the numeric settings; the floors live on `SETTING_FIELDS`. */
const MAX_WISHES = 20;
const MAX_GNOMES = 40;
const MAX_REINFORCEMENTS = 99;

export interface AdvancedSettingsValue {
  boardSize: number;
  startingWishes: number;
  wishLimit: number;
  gnomeBoardLimit: number;
  totalReinforcements: number;
  /**
   * Per-card copies, sparse: only cards that differ from the stock deck get an
   * entry, so an untouched deck adds nothing to the game config.
   */
  deckCounts: Record<CardId, number>;
  /**
   * The game seed, as typed. Blank means "roll a fresh one at start", which is
   * why this is text rather than a number — there is no number that means
   * "unset", and the raw text is also what a bad entry is reported against.
   */
  seedText: string;
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettingsValue = {
  boardSize: DEFAULT_CONFIG.boardSize,
  startingWishes: DEFAULT_CONFIG.startingWishes,
  wishLimit: DEFAULT_CONFIG.wishLimit,
  gnomeBoardLimit: DEFAULT_CONFIG.gnomeBoardLimit,
  totalReinforcements: DEFAULT_CONFIG.totalReinforcements,
  deckCounts: {},
  seedText: '',
};

/**
 * The typed seed as a number: null when it is not one. Blank is not an error
 * — it means "roll a fresh seed", which the setup screen does at start rather
 * than here, so the panel never shows a seed the game will not use.
 */
export function parseSeedText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** True when `text` is something other than a seed (blank is fine). */
export function seedTextIsBad(text: string): boolean {
  return text.trim() !== '' && parseSeedText(text) === null;
}

export type NumericSetting = 'startingWishes' | 'wishLimit' | 'gnomeBoardLimit' | 'totalReinforcements';

export const SETTING_FIELDS: ReadonlyArray<{
  key: NumericSetting;
  label: string;
  hint: string;
  min: number;
  max: number;
}> = [
  {
    key: 'startingWishes',
    label: 'Starting wishes',
    hint: 'Wishes each player begins with. Cannot exceed the wish limit.',
    min: 0,
    max: MAX_WISHES,
  },
  {
    key: 'wishLimit',
    label: 'Wish limit',
    hint: 'Most wishes a player may hold. The Center Star raises it by 1.',
    min: 1,
    max: MAX_WISHES,
  },
  {
    key: 'gnomeBoardLimit',
    label: 'Gnome limit',
    hint: 'Most gnomes one player may have on the board at once.',
    min: 1,
    max: MAX_GNOMES,
  },
  {
    key: 'totalReinforcements',
    label: 'Total reinforcements',
    hint: 'Gnomes a player may ever spawn — losing this many is elimination. Cannot be below the gnome limit.',
    min: 1,
    max: MAX_REINFORCEMENTS,
  },
];

/** Copies of `id` in the stock deck (2 per Whimsy card, 1 per Curse). */
export function stockCount(id: CardId): number {
  return CARD_DEFINITIONS.find((c) => c.id === id)?.copies ?? DEFAULT_CURSE_COPIES;
}

/** True when nothing has been changed away from the stock game. */
export function isDefaultSettings(v: AdvancedSettingsValue): boolean {
  return (
    v.boardSize === DEFAULT_ADVANCED_SETTINGS.boardSize &&
    v.startingWishes === DEFAULT_ADVANCED_SETTINGS.startingWishes &&
    v.wishLimit === DEFAULT_ADVANCED_SETTINGS.wishLimit &&
    v.gnomeBoardLimit === DEFAULT_ADVANCED_SETTINGS.gnomeBoardLimit &&
    v.totalReinforcements === DEFAULT_ADVANCED_SETTINGS.totalReinforcements &&
    Object.keys(v.deckCounts).length === 0 &&
    v.seedText.trim() === ''
  );
}

/** Copies of `id` this configuration puts in the deck. */
export function deckCountOf(v: AdvancedSettingsValue, id: CardId): number {
  return v.deckCounts[id] ?? stockCount(id);
}

/** Total cards a fresh deck would hold under this configuration. */
export function deckTotal(v: AdvancedSettingsValue): number {
  return Object.values(resolveDeckCounts(v.deckCounts)).reduce((sum, n) => sum + n, 0);
}

/** Whimsy cards only — a deck of pure curses is not a deck (see `setup.ts`). */
export function whimsyTotal(v: AdvancedSettingsValue): number {
  return CARD_DEFINITIONS.reduce((sum, c) => sum + deckCountOf(v, c.id), 0);
}

/** Curses only, for the deck editor's running summary. */
export function curseTotal(v: AdvancedSettingsValue): number {
  return CURSE_DEFINITIONS.reduce((sum, c) => sum + deckCountOf(v, c.id), 0);
}

/**
 * Why this configuration cannot start a game, or null. Mirrors the engine's
 * own checks, so the panel refuses a combination before the setup screen has
 * to explain an EngineError.
 */
export function settingsProblem(v: AdvancedSettingsValue): string | null {
  if (v.startingWishes > v.wishLimit) return 'Starting wishes cannot exceed the wish limit.';
  if (v.totalReinforcements < v.gnomeBoardLimit) {
    return 'Total reinforcements cannot be below the gnome limit.';
  }
  if (whimsyTotal(v) < 1) return 'The deck needs at least one Whimsy card.';
  if (seedTextIsBad(v.seedText)) return 'Seed must be a number (or leave it blank for a random one).';
  return null;
}

/**
 * The engine options this configuration contributes. The deck is sparse by
 * design: an untouched deck leaves the field off the config entirely, so a
 * stock game's state is identical to one from before the deck editor existed.
 */
export function settingsOptions(v: AdvancedSettingsValue) {
  return {
    startingWishes: v.startingWishes,
    wishLimit: v.wishLimit,
    gnomeBoardLimit: v.gnomeBoardLimit,
    totalReinforcements: v.totalReinforcements,
    ...(Object.keys(v.deckCounts).length > 0 ? { deckCounts: v.deckCounts } : {}),
  };
}
