/**
 * Per-seat redaction (view.ts). Three properties matter:
 *
 *  - INFO-SET BOUNDARY: a seat's view never depends on information that seat
 *    may not see. Stated differentially — two states differing ONLY in hidden
 *    content must produce byte-identical foreign views.
 *  - STRUCTURE PRESERVED: everything public survives, including the counts
 *    that hidden zones imply (hand sizes, deck size).
 *  - NOT AN ENGINE INPUT: a view cannot be mistaken for authoritative state.
 */

import { describe, expect, it } from 'vitest';
import type { GameState, PendingDecision, PlayerId } from './index';
import {
  HIDDEN_CARD_ID,
  applyAction,
  isPlayerView,
  nameSaltOf,
  sealHiddenState,
  viewFor,
} from './index';
import { activePlayer, drive, mutate, newGame, toActionPhase, withHand } from './testkit';

/** The two seats of a 2-player game, as (me, opponent). */
function seats(s: GameState): [PlayerId, PlayerId] {
  const me = activePlayer(s);
  return [me, (1 - me) as PlayerId];
}

describe('viewFor — info-set boundary', () => {
  it('hides which cards an opponent holds', () => {
    const base = toActionPhase(5);
    const [me, opp] = seats(base);
    const a = mutate(base, (d) => {
      d.players[opp].hand = ['nope-gnome', 'rocket-gnome'];
    });
    const b = mutate(base, (d) => {
      d.players[opp].hand = ['mushroom-cloud', 'wild-growth'];
    });

    expect(viewFor(a, me)).toEqual(viewFor(b, me));
    // The opponent's own view of course distinguishes them.
    expect(viewFor(a, opp)).not.toEqual(viewFor(b, opp));
  });

  it('hides the deck order — from everyone', () => {
    const base = toActionPhase(6);
    const [me, opp] = seats(base);
    const shuffled = mutate(base, (d) => {
      const last = d.deck.length - 1;
      [d.deck[0], d.deck[last]] = [d.deck[last], d.deck[0]];
    });

    expect(viewFor(shuffled, me)).toEqual(viewFor(base, me));
    expect(viewFor(shuffled, opp)).toEqual(viewFor(base, opp));
  });

  it('hides the RNG state, so future rolls are not computable', () => {
    const base = toActionPhase(7);
    const [me] = seats(base);
    const rolled = mutate(base, (d) => {
      d.rngState = (d.rngState + 12345) >>> 0;
    });

    expect(viewFor(base, me).rngState).toBe(0);
    expect(viewFor(rolled, me)).toEqual(viewFor(base, me));
  });

  it('hides the seed, which would regenerate the whole deck', () => {
    const base = toActionPhase(8);
    const [me] = seats(base);
    const view = viewFor(base, me);

    expect(view.seed).toBe(0);
    expect(view.nameSalt).not.toBe(base.seed);
    // A truncated hash: not an invertible copy of the seed.
    expect(view.nameSalt).toBeLessThanOrEqual(0xffff);
  });

  it('gives every seat the same gnome-name salt', () => {
    const base = toActionPhase(9);
    const [me, opp] = seats(base);
    expect(viewFor(base, me).nameSalt).toBe(viewFor(base, opp).nameSalt);
    expect(viewFor(base, null).nameSalt).toBe(viewFor(base, me).nameSalt);
  });
});

describe('viewFor — what stays visible', () => {
  it('keeps my own hand in full', () => {
    const base = withHand(toActionPhase(10), activePlayer(toActionPhase(10)), 'nope-gnome');
    const [me] = seats(base);
    const view = viewFor(base, me);

    expect(view.players[me].hand).toEqual(base.players[me].hand);
    expect(view.players[me].hand).toContain('nope-gnome');
  });

  it('keeps hand sizes and deck/discard counts', () => {
    const base = mutate(toActionPhase(11), (d) => {
      d.players[0].hand = ['nope-gnome', 'rocket-gnome', 'wild-growth'];
      d.discard = ['snake-eyes'];
    });
    const [me, opp] = seats(base);
    const view = viewFor(base, me);

    expect(view.players[opp].hand).toHaveLength(base.players[opp].hand.length);
    expect(view.players[opp].hand.every((c) => c === HIDDEN_CARD_ID)).toBe(true);
    expect(view.deck).toHaveLength(base.deck.length);
    // The discard pile is face up on the table — public by the rules.
    expect(view.discard).toEqual(base.discard);
  });

  it('keeps the whole board, the card stack and active curses', () => {
    const base = toActionPhase(12);
    const [me] = seats(base);
    const view = viewFor(base, me);

    expect(view.gardens).toEqual(base.gardens);
    expect(view.units).toEqual(base.units);
    expect(view.cardStack).toEqual(base.cardStack);
    expect(view.activeCurses).toEqual(base.activeCurses);
    expect(view.config).toEqual(base.config);
  });

  it('builds a spectator view with no hands at all', () => {
    const base = mutate(toActionPhase(13), (d) => {
      d.players[0].hand = ['nope-gnome'];
      d.players[1].hand = ['rocket-gnome'];
    });
    const view = viewFor(base, null);

    expect(view.viewer).toBeNull();
    for (const p of view.players) {
      expect(p.hand.every((c) => c === HIDDEN_CARD_ID)).toBe(true);
    }
  });
});

describe('viewFor — pending decisions', () => {
  const respondWindow = (player: PlayerId): Extract<PendingDecision, { kind: 'fightRespond' }> => ({
    kind: 'fightRespond',
    player,
    fightId: 1,
    playableCards: ['nope-gnome', 'snake-eyes'],
  });

  it("empties another seat's playable-response list — even the count", () => {
    const base = toActionPhase(14);
    const [me, opp] = seats(base);
    const s = mutate(base, (d) => {
      d.pendingDecision = respondWindow(opp);
    });
    const decision = viewFor(s, me).pendingDecision;

    expect(decision?.kind).toBe('fightRespond');
    expect(decision).toMatchObject({ playableCards: [] });
  });

  it('keeps my own playable-response list', () => {
    const base = toActionPhase(15);
    const [me] = seats(base);
    const s = mutate(base, (d) => {
      d.pendingDecision = respondWindow(me);
    });

    expect(viewFor(s, me).pendingDecision).toMatchObject({
      playableCards: ['nope-gnome', 'snake-eyes'],
    });
  });

  it('hides a card another seat is still aiming (it is not yet committed)', () => {
    const base = toActionPhase(16);
    const [me, opp] = seats(base);
    const s = mutate(base, (d) => {
      d.pendingDecision = {
        kind: 'cardTargeting',
        player: opp,
        cardId: 'rocket-gnome',
        selected: {},
        stepIndex: 0,
        stepCount: 1,
        targetKind: 'unit',
        prompt: 'Choose a gnome to Rocket',
        restore: respondWindow(opp),
      };
    });

    const mine = viewFor(s, me).pendingDecision;
    expect(mine).toMatchObject({ kind: 'cardTargeting', cardId: HIDDEN_CARD_ID });
    // The prompt names the card too.
    expect(JSON.stringify(mine)).not.toContain('rocket-gnome');
    expect(JSON.stringify(mine)).not.toContain('Rocket');
    // ...including the window the play interrupted.
    expect(JSON.stringify(mine)).not.toContain('nope-gnome');

    // The player aiming it sees everything.
    expect(viewFor(s, opp).pendingDecision).toEqual(s.pendingDecision);
  });
});

describe('viewFor — events', () => {
  it('hides what an opponent drew, but not what I drew', () => {
    const base = mutate(toActionPhase(17), (d) => {
      d.events = [
        { type: 'cardDrawn', player: 0, cardId: 'nope-gnome' },
        { type: 'cardDrawn', player: 1, cardId: 'rocket-gnome' },
      ];
    });

    expect(viewFor(base, 0).events).toEqual([
      { type: 'cardDrawn', player: 0, cardId: 'nope-gnome' },
      { type: 'cardDrawn', player: 1, cardId: HIDDEN_CARD_ID },
    ]);
    expect(viewFor(base, 1).events).toEqual([
      { type: 'cardDrawn', player: 0, cardId: HIDDEN_CARD_ID },
      { type: 'cardDrawn', player: 1, cardId: 'rocket-gnome' },
    ]);
  });

  it('shows a theft to both parties and to nobody else', () => {
    const base = mutate(newGame(18, {}, 4), (d) => {
      d.events = [{ type: 'cardStolen', from: 1, to: 2, cardId: 'wild-growth' }];
    });

    for (const seat of [1, 2] as PlayerId[]) {
      expect(viewFor(base, seat).events[0]).toMatchObject({ cardId: 'wild-growth' });
    }
    for (const seat of [0, 3] as PlayerId[]) {
      expect(viewFor(base, seat).events[0]).toMatchObject({ cardId: HIDDEN_CARD_ID });
    }
    expect(viewFor(base, null).events[0]).toMatchObject({ cardId: HIDDEN_CARD_ID });
  });

  it('leaves public card events alone', () => {
    const base = mutate(toActionPhase(19), (d) => {
      d.events = [
        { type: 'cardPlayed', player: 1, cardId: 'rocket-gnome' },
        { type: 'cardDiscarded', player: 1, cardId: 'wild-growth' },
        { type: 'curseRevealed', player: 1, cardId: 'mulch-fever' },
      ];
    });

    expect(viewFor(base, 0).events).toEqual(base.events);
  });

  it('never names a curse shuffled into the deck mid-game', () => {
    const base = mutate(toActionPhase(20), (d) => {
      d.events = [{ type: 'deckReshuffled', curseAdded: 'mulch-fever' }];
    });

    expect(viewFor(base, 0).events[0]).toMatchObject({ curseAdded: HIDDEN_CARD_ID });
  });
});

describe('viewFor — contract', () => {
  it('never mutates the state it redacts', () => {
    const base = toActionPhase(21);
    const before = structuredClone(base);
    viewFor(base, 0);
    expect(base).toEqual(before);
  });

  it('marks its output as a view, and refuses to redact one twice', () => {
    const base = toActionPhase(22);
    const view = viewFor(base, 0);

    expect(isPlayerView(view)).toBe(true);
    expect(isPlayerView(base)).toBe(false);
    expect(() => viewFor(view, 0)).toThrow(/already a redacted view/);
  });

  it('is rejected by applyAction — a view is not a game', () => {
    const base = toActionPhase(23);
    const me = activePlayer(base);
    const view = viewFor(base, me);

    expect(() => applyAction(view, { type: 'endTurn', player: me })).toThrow(/redacted PlayerView/);
  });

  it('nameSaltOf reads the seed for authoritative state, the salt for a view', () => {
    const base = toActionPhase(24);
    expect(nameSaltOf(base)).toBe(base.seed);
    expect(nameSaltOf(viewFor(base, 0))).toBe(viewFor(base, 0).nameSalt);
  });
});

describe('sealHiddenState — the visible board must not imply the deck', () => {
  it('keeps the map the seed drew, but re-orders the deck', () => {
    const base = newGame(31, { gardenPreset: 'random' });
    const sealed = sealHiddenState(base, 0xdecafbad);

    // The board is what the seed is allowed to determine, and it is unchanged.
    expect(sealed.gardens).toEqual(base.gardens);
    expect(sealed.seed).toBe(base.seed);
    // The deck is not: same cards, different order.
    expect([...sealed.deck].sort()).toEqual([...base.deck].sort());
    expect(sealed.deck).not.toEqual(base.deck);
  });

  it('makes two games with the same map play out differently', () => {
    const base = newGame(32, { gardenPreset: 'random' });
    const a = sealHiddenState(base, 1111);
    const b = sealHiddenState(base, 2222);

    expect(a.gardens).toEqual(b.gardens);
    expect(a.deck).not.toEqual(b.deck);
    expect(a.rngState).not.toBe(b.rngState);

    // ...all the way through a played game: same board, different dice.
    const playedA = drive(a, () => false, 400);
    const playedB = drive(b, () => false, 400);
    expect(playedA.events).not.toEqual(playedB.events);
  });

  it('stays deterministic: the same secret always seals the same game', () => {
    const base = newGame(33, { gardenPreset: 'random' });
    expect(sealHiddenState(base, 4242)).toEqual(sealHiddenState(base, 4242));
    expect(drive(sealHiddenState(base, 4242), () => false, 300).events).toEqual(
      drive(sealHiddenState(base, 4242), () => false, 300).events,
    );
  });

  it('never mutates the game it seals', () => {
    const base = newGame(34);
    const before = structuredClone(base);
    sealHiddenState(base, 999);
    expect(base).toEqual(before);
  });

  it('refuses a game already under way — those cards have been seen', () => {
    const started = toActionPhase(35);
    expect(() => sealHiddenState(started, 999)).toThrow(/freshly created/);
  });

  it('leaves nothing seed-derived in the view a player receives', () => {
    const sealed = sealHiddenState(newGame(36, { gardenPreset: 'random' }), 0x5eed);
    const view = viewFor(sealed, 0);

    expect(view.seed).toBe(0);
    expect(view.rngState).toBe(0);
    expect(view.deck.every((c) => c === HIDDEN_CARD_ID)).toBe(true);
  });
});
