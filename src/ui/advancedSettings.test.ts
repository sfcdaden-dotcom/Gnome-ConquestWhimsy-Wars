/**
 * The advanced panel's pure parts: the deck bookkeeping and the validation
 * that stands in front of the engine's own `resolveConfig` checks. The panel
 * disables "Done" on `settingsProblem`, so anything the engine would reject
 * has to be caught here too — that agreement is what these tests pin.
 */

import { describe, expect, it } from 'vitest';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS, createGame, EngineError } from '../engine';
import {
  DEFAULT_ADVANCED_SETTINGS,
  deckCountOf,
  deckTotal,
  isDefaultSettings,
  settingsProblem,
} from './advancedSettings';
import type { AdvancedSettingsValue } from './advancedSettings';

const STOCK_TOTAL = CARD_DEFINITIONS.reduce((sum, c) => sum + c.copies, 0) + CURSE_DEFINITIONS.length;

function withDeck(deckCounts: Record<string, number>): AdvancedSettingsValue {
  return { ...DEFAULT_ADVANCED_SETTINGS, deckCounts };
}

/** Start a game the way SetupScreen does, to see whether the engine agrees. */
function start(v: AdvancedSettingsValue) {
  return createGame(
    {
      players: [
        { name: 'A', controller: 'cpu' },
        { name: 'B', controller: 'cpu' },
      ],
      gardenPreset: 'none',
      boardSize: v.boardSize,
      startingWishes: v.startingWishes,
      wishLimit: v.wishLimit,
      gnomeBoardLimit: v.gnomeBoardLimit,
      totalReinforcements: v.totalReinforcements,
      ...(Object.keys(v.deckCounts).length > 0 ? { deckCounts: v.deckCounts } : {}),
    },
    1,
  );
}

describe('deck bookkeeping', () => {
  it('reports the stock deck until a card is changed', () => {
    expect(deckTotal(DEFAULT_ADVANCED_SETTINGS)).toBe(STOCK_TOTAL);
    expect(isDefaultSettings(DEFAULT_ADVANCED_SETTINGS)).toBe(true);
    expect(deckCountOf(DEFAULT_ADVANCED_SETTINGS, CARD_DEFINITIONS[0].id)).toBe(CARD_DEFINITIONS[0].copies);
    expect(deckCountOf(DEFAULT_ADVANCED_SETTINGS, CURSE_DEFINITIONS[0].id)).toBe(1);
  });

  it('counts an override into the total', () => {
    const v = withDeck({ [CARD_DEFINITIONS[0].id]: 0 });
    expect(deckTotal(v)).toBe(STOCK_TOTAL - CARD_DEFINITIONS[0].copies);
    expect(isDefaultSettings(v)).toBe(false);
  });
});

describe('settingsProblem', () => {
  it('passes the defaults, and the engine starts them', () => {
    expect(settingsProblem(DEFAULT_ADVANCED_SETTINGS)).toBeNull();
    expect(() => start(DEFAULT_ADVANCED_SETTINGS)).not.toThrow();
  });

  it('catches every combination the engine would reject', () => {
    const cases: AdvancedSettingsValue[] = [
      { ...DEFAULT_ADVANCED_SETTINGS, startingWishes: 5, wishLimit: 3 },
      { ...DEFAULT_ADVANCED_SETTINGS, gnomeBoardLimit: 20, totalReinforcements: 16 },
      withDeck(Object.fromEntries(CARD_DEFINITIONS.map((c) => [c.id, 0]))),
    ];
    for (const v of cases) {
      expect(settingsProblem(v)).not.toBeNull();
      expect(() => start(v)).toThrow(EngineError);
    }
  });

  it('accepts a raised economy that the engine also accepts', () => {
    const v: AdvancedSettingsValue = {
      boardSize: 9,
      startingWishes: 6,
      wishLimit: 6,
      gnomeBoardLimit: 12,
      totalReinforcements: 30,
      deckCounts: { [CARD_DEFINITIONS[0].id]: 4 },
    };
    expect(settingsProblem(v)).toBeNull();
    const s = start(v);
    expect(s.config.boardSize).toBe(9);
    expect(s.players[0].wishes).toBe(6);
    expect(s.config.gnomeBoardLimit).toBe(12);
    expect(s.deck.filter((id) => id === CARD_DEFINITIONS[0].id)).toHaveLength(4);
  });
});
