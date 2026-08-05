/**
 * Configurable deck composition (`GameConfig.deckCounts`).
 *
 * The stock deck is 2 of each Whimsy card + 1 of each Curse; the setup
 * screen's deck editor may change any of those counts, including to 0. What
 * matters is that the override is the ONLY thing that decides the pile —
 * nothing else in the engine may assume the stock 51 cards — and that a
 * nonsense configuration is refused at createGame rather than mid-game.
 */

import { describe, expect, it } from 'vitest';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS, EngineError, isCurseId, resolveDeckCounts } from './index';
import { newGame } from './testkit';

function countOf(deck: readonly string[], id: string): number {
  return deck.filter((c) => c === id).length;
}

describe('deckCounts', () => {
  it('builds the stock deck when unset', () => {
    const s = newGame(7);
    expect(s.deck).toHaveLength(
      CARD_DEFINITIONS.reduce((sum, c) => sum + c.copies, 0) + CURSE_DEFINITIONS.length,
    );
    expect(s.config.deckCounts).toBeUndefined();
  });

  it('honours a per-card override, leaving every other card at stock', () => {
    const s = newGame(7, { deckCounts: { 'snake-eyes': 5 } });
    expect(countOf(s.deck, 'snake-eyes')).toBe(5);
    for (const def of CARD_DEFINITIONS) {
      if (def.id !== 'snake-eyes') expect(countOf(s.deck, def.id)).toBe(def.copies);
    }
  });

  it('removes a card entirely at 0 copies', () => {
    const s = newGame(7, { deckCounts: { 'snake-eyes': 0 } });
    expect(s.deck).not.toContain('snake-eyes');
  });

  it('can build a curse-free deck', () => {
    const zeroed = Object.fromEntries(CURSE_DEFINITIONS.map((c) => [c.id, 0]));
    const s = newGame(7, { deckCounts: zeroed });
    expect(s.deck.filter((id) => isCurseId(id))).toHaveLength(0);
  });

  it('stores the override on the config, so a replay rebuilds the same deck', () => {
    const counts = { 'snake-eyes': 4 };
    const a = newGame(11, { deckCounts: counts });
    const b = newGame(11, { deckCounts: { ...counts } });
    expect(a.config.deckCounts).toEqual(counts);
    expect(b.deck).toEqual(a.deck);
  });

  it('rejects an unknown card, a bad count, and a deck with no whimsy cards', () => {
    expect(() => newGame(7, { deckCounts: { 'not-a-card': 2 } })).toThrow(EngineError);
    expect(() => newGame(7, { deckCounts: { 'snake-eyes': -1 } })).toThrow(EngineError);
    expect(() => newGame(7, { deckCounts: { 'snake-eyes': 2.5 } })).toThrow(EngineError);
    expect(() => newGame(7, { deckCounts: { 'snake-eyes': 999 } })).toThrow(EngineError);
    const allZero = Object.fromEntries(CARD_DEFINITIONS.map((c) => [c.id, 0]));
    expect(() => newGame(7, { deckCounts: allZero })).toThrow(/at least one Whimsy card/);
  });
});

describe('resolveDeckCounts', () => {
  it('defaults to the stock counts and ignores ids it does not know', () => {
    const counts = resolveDeckCounts({ 'not-a-card': 9 });
    expect(counts['not-a-card']).toBeUndefined();
    for (const def of CARD_DEFINITIONS) expect(counts[def.id]).toBe(def.copies);
    for (const def of CURSE_DEFINITIONS) expect(counts[def.id]).toBe(1);
  });
});
