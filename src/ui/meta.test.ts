/**
 * Card/curse label lookups used by the panels and the log.
 *
 * `cardText` backs the curse tooltips, so the thing worth pinning is that
 * every curse actually has text to show — a curse whose tooltip renders the
 * "Unknown curse" fallback is a bug the UI can't detect on its own.
 */

import { describe, expect, it } from 'vitest';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS } from '../engine/cards';
import type { GameState, PlayerId } from '../engine';
import { getLegalActionIntents } from '../engine';
import { mutate, toActionPhase } from '../engine/testkit';
import { cardName, cardText, playHint } from './meta';

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

describe('playHint', () => {
  /** A game parked in an Action Phase, with `card` in both hands. */
  function handed(card: string) {
    return mutate(toActionPhase(7), (d) => {
      d.players[0].hand = [card];
      d.players[1].hand = [card];
    });
  }

  /** The seat whose Action Phase it is, and the one waiting for their turn. */
  function seats(state: GameState): { active: PlayerId; waiting: PlayerId } {
    const active = state.turn!.activePlayer;
    return { active, waiting: ((active + 1) % state.players.length) as PlayerId };
  }

  it('is silent exactly when the engine would allow the play', () => {
    const state = handed('plot-twist');
    const { active } = seats(state);
    const allowed = getLegalActionIntents(state, active).some(
      (a) => a.type === 'playCard' && a.cardId === 'plot-twist',
    );
    expect(playHint(state, active, 'plot-twist') === null).toBe(allowed);
  });

  it("explains a Ritual held during someone else's turn", () => {
    const state = handed('plot-twist');
    expect(playHint(state, seats(state).waiting, 'plot-twist')).toContain('Ritual Magic');
  });

  it('explains a card that can only be played in response', () => {
    const state = handed('nope-gnome');
    expect(playHint(state, seats(state).active, 'nope-gnome')).toContain('in response');
  });

  it("prefers the screen-level reason over the card's own", () => {
    const state = handed('nope-gnome');
    expect(playHint(state, seats(state).active, 'nope-gnome', 'The game is over.')).toBe(
      'The game is over.',
    );
  });

  it('writes reasons as sentences', () => {
    const state = handed('plot-twist');
    const hint = playHint(state, seats(state).waiting, 'plot-twist');
    expect(hint).toMatch(/^[A-Z].*\.$/s);
  });
});
