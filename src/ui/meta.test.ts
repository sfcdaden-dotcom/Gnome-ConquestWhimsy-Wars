/**
 * Card/curse label lookups used by the panels and the log.
 *
 * `cardText` backs the curse tooltips, so the thing worth pinning is that
 * every curse actually has text to show — a curse whose tooltip renders the
 * "Unknown curse" fallback is a bug the UI can't detect on its own.
 */

import { describe, expect, it } from 'vitest';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS } from '../engine/cards';
import { cardName, cardText } from './meta';

describe('cardText', () => {
  it('returns the rules text of every curse', () => {
    for (const curse of CURSE_DEFINITIONS) {
      expect(cardText(curse.id)).toBe(curse.text);
      expect(cardText(curse.id)).not.toBe('');
      expect(cardName(curse.id)).toBe(curse.name);
    }
  });

  it('returns the rules text of every whimsy card', () => {
    for (const card of CARD_DEFINITIONS) {
      expect(cardText(card.id)).toBe(card.text);
    }
  });

  it('is empty for an unknown id, so callers can fall back', () => {
    expect(cardText('not-a-card')).toBe('');
  });
});
