/**
 * Per-seat redaction: turning the authoritative `GameState` into the
 * `PlayerView` one seat is allowed to see.
 *
 * `GameState` is a FULL-INFORMATION object. It carries every hand, the deck
 * order, and `rngState` — from which every future die roll and every future
 * draw is computable. On a single device that is harmless (one person sees
 * everything anyway); over a network it is the whole game. A server that
 * broadcasts raw state has no hidden information left, and no amount of UI
 * discipline puts it back.
 *
 *   viewFor(state, seat) → PlayerView    // what `seat` may see (null = spectator)
 *
 * The boundary is the same one `encode.ts` already pins for the learned CPU:
 * **your own hand in full; every other hidden zone as counts only.** Here the
 * counts are preserved structurally — a hidden card is present in the array as
 * `HIDDEN_CARD_ID`, so `deck.length`, `hand.length` and "how many cards does
 * Red hold" all keep working, while the identities are gone.
 *
 * A `PlayerView` is structurally a `GameState`, so rendering code takes it
 * unchanged. It is NOT a legal engine input: `rngState` and `seed` are zeroed
 * and the hidden zones are placeholders, so applying actions to a view would
 * silently produce a different game. `applyAction` rejects one outright
 * (see `isPlayerView`).
 */

import type { CardId, GameEvent, GameState, PendingDecision, PlayerId } from './types';
import { normalizeSeed } from './rng';

/**
 * Stand-in for a card the viewer may not identify. Not a real card id, so it
 * never matches a `CARD_DEFINITIONS` lookup — `getCardDef` returns undefined
 * and UI code renders it as a face-down card.
 */
export const HIDDEN_CARD_ID: CardId = '__hidden__';

export interface PlayerView extends GameState {
  /** Seat this view was built for. `null` = spectator (sees no hand at all). */
  viewer: PlayerId | null;
  /**
   * Stable per-game salt for cosmetic derivations that used to read `seed`
   * (gnome names). Every client of one game gets the same salt, so gnomes are
   * named consistently — but it is a TRUNCATED hash of the seed, not the seed,
   * which with `config` would regenerate the entire deck order.
   *
   * Truncation matters: `normalizeSeed` is a bijection on uint32 (a murmur3
   * finalizer), so shipping its full output would ship an invertible copy of
   * the seed. 16 bits leaves ~65k preimages and is far more entropy than two
   * name-pool offsets need.
   *
   * Consequence: the same seed names gnomes differently in local and
   * networked play. Cosmetic, and the alternative is handing out the deck.
   */
  nameSalt: number;
  /** Views are not engine inputs. Present so `isPlayerView` can say so. */
  readonly redacted: true;
}

/** True if `state` is a redacted view rather than authoritative state. */
export function isPlayerView(state: GameState): state is PlayerView {
  return (state as Partial<PlayerView>).redacted === true;
}

/**
 * Cosmetic salt for a state or view. Local (hot-seat) play passes a real
 * `GameState` and keeps using the seed; networked play passes a `PlayerView`
 * and uses the salt. Same value across all clients of one game either way.
 */
export function nameSaltOf(state: GameState): number {
  return isPlayerView(state) ? state.nameSalt : state.seed;
}

/** An array of `n` unidentifiable cards. */
function hiddenCards(n: number): CardId[] {
  return new Array<CardId>(n).fill(HIDDEN_CARD_ID);
}

/**
 * Redact one event. The log is broadcast alongside the state, so it leaks the
 * same way the state would: `cardDrawn` names the card that just went into a
 * hand, and `cardStolen` names a card taken out of one.
 *
 * Everything else is public by the rules — the discard pile is face up
 * (`cardDiscarded`), and playing, resolving, cancelling, fizzling or revealing
 * a card announces it to the table.
 */
function redactEvent(ev: GameEvent, viewer: PlayerId | null): GameEvent {
  switch (ev.type) {
    case 'cardDrawn':
      // You see your own draws; everyone else sees that a card was drawn.
      return ev.player === viewer ? ev : { ...ev, cardId: HIDDEN_CARD_ID };
    case 'cardStolen':
      // Both parties to the theft know what changed hands; the table doesn't.
      return viewer !== null && (ev.from === viewer || ev.to === viewer)
        ? ev
        : { ...ev, cardId: HIDDEN_CARD_ID };
    case 'deckReshuffled':
      // Currently always null (all 5 curses start in the deck), but a curse
      // added mid-game must not be named — the table only learns one lurks.
      return ev.curseAdded === null ? ev : { ...ev, curseAdded: HIDDEN_CARD_ID };
    default:
      return ev;
  }
}

/**
 * Redact the pending decision. Two of the twelve kinds carry private data:
 * the response windows list the cards that seat could play (a hand subset),
 * and `cardTargeting` names a card that is still IN hand — it is committed
 * only when the last target is picked, and `cancelTargeting` puts it back, so
 * naming it would leak a card the owner never played.
 *
 * The rest are board-public: positions, harvest sources, unit ids, counts.
 */
function redactDecision(
  decision: PendingDecision | null,
  viewer: PlayerId | null,
): PendingDecision | null {
  if (decision === null) return null;
  const mine = decision.player === viewer;
  switch (decision.kind) {
    case 'fightRespond':
    case 'cardResponse':
      // Not even the count: "Red holds 2 playable responses" is information.
      return mine ? decision : { ...decision, playableCards: [] };
    case 'cardTargeting': {
      if (mine) return decision;
      return {
        ...decision,
        cardId: HIDDEN_CARD_ID,
        // The prompt names the card ("Choose a gnome to Rocket").
        prompt: 'is choosing targets…',
        // The window this play interrupted is redacted on its own terms.
        ...(decision.restore
          ? { restore: redactDecision(decision.restore, viewer) as typeof decision.restore }
          : {}),
      };
    }
    default:
      return decision;
  }
}

/**
 * Build the view of `state` that `seat` is allowed to see. Pure; the input is
 * never mutated. `seat === null` builds the spectator view (no hands at all).
 *
 * Redacted: `rngState` and `seed` (future rolls and the whole deck),
 * the draw pile and curse pool, every other seat's hand, the private parts of
 * the pending decision, and the card identities in draw/steal events.
 *
 * Public, deliberately: hand SIZES, deck and discard COUNTS, the discard pile
 * itself, the card stack (a played card is announced), active curses, and the
 * entire board.
 */
export function viewFor(state: GameState, seat: PlayerId | null): PlayerView {
  if (isPlayerView(state)) {
    throw new Error('viewFor: already a redacted view — redact the authoritative state');
  }
  const view = structuredClone(state) as GameState as PlayerView;

  // Randomness: the single largest leak. rngState alone predicts every roll.
  view.rngState = 0;
  view.seed = 0;
  view.nameSalt = normalizeSeed(state.seed) & 0xffff;

  // Hidden zones become the right number of unidentifiable cards.
  view.deck = hiddenCards(state.deck.length);
  view.cursePool = hiddenCards(state.cursePool.length);
  for (const p of view.players) {
    if (p.id !== seat) p.hand = hiddenCards(p.hand.length);
  }

  view.pendingDecision = redactDecision(view.pendingDecision, seat);
  view.events = view.events.map((ev) => redactEvent(ev, seat));

  view.viewer = seat;
  (view as { redacted: true }).redacted = true;
  return view;
}
