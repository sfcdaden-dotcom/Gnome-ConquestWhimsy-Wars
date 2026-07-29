/**
 * Shot-clock enforcement.
 *
 * These are the anti-troll tests: whatever a stalling client leaves the engine
 * waiting on, one `applyTimeout` must release the seat and let the game go on.
 */

import { describe, expect, it } from 'vitest';
import type { GameState } from './index';
import {
  MAX_ENTRY_EFFECT_HOPS,
  applyAction,
  applyTimeout,
  chooseAiAction,
  getPlayerToAct,
  getTimeoutAction,
  isGameOver,
  isOnTheClock,
} from './index';
import { CURSE_ANTSY_PANTS } from './helpers';
import { activePlayer, drive, mutate, newGame, toActionPhase, withGarden, withGnome } from './testkit';

describe('shot clock', () => {
  it('ends an idle turn and hands the seat to the next player', () => {
    const s = toActionPhase(3);
    const me = activePlayer(s);
    expect(isOnTheClock(s, me)).toBe(true);

    const after = applyTimeout(s);
    expect(after.turn?.activePlayer).not.toBe(me);
    expect(getPlayerToAct(after)).not.toBe(me);
  });

  it('does not spend the timed-out player’s cards', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      d.players[me].wishes = 5;
      d.players[me].hand.push('pocket-shovel', 'four-leaf-clover');
    });
    const handBefore = [...s.players[me].hand];
    const after = applyTimeout(s);
    expect(after.players[me].hand).toEqual(handBefore);
    expect(after.players[me].wishes).toBe(5);
  });

  it('declines a pending entry effect rather than committing the gnome', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    s = withGarden(s, { x: 3, y: 1 }, 'tunnel');
    s = withGarden(s, { x: 5, y: 5 }, 'tunnel');
    const g = withGnome(s, me, { x: 2, y: 1 });
    const moved = applyAction(g.state, { type: 'move', player: me, unitId: g.unitId, to: { x: 3, y: 1 } });
    expect(moved.pendingDecision?.kind).toBe('tunnel');

    expect(getTimeoutAction(moved)).toEqual({ type: 'declineEffect', player: me });
    const after = applyTimeout(moved);
    expect(after.units[g.unitId].pos).toEqual({ x: 3, y: 1 }); // stayed put
    expect(after.turn?.activePlayer).not.toBe(me);
  });

  it('breaks the open-targeting / cancel spin (the state-neutral stall)', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      d.players[me].hand.push('pocket-shovel');
    });
    // The spin: play a targeted card, cancel, repeat — legal forever, changes
    // nothing. A timeout cancels once and then ends the turn.
    const targeting = applyAction(s, { type: 'playCard', player: me, cardId: 'pocket-shovel' });
    expect(targeting.pendingDecision?.kind).toBe('cardTargeting');
    expect(getTimeoutAction(targeting)).toEqual({ type: 'cancelTargeting', player: me });

    const after = applyTimeout(targeting);
    expect(after.pendingDecision?.kind).not.toBe('cardTargeting');
    expect(after.turn?.activePlayer).not.toBe(me);
    expect(after.players[me].hand).toContain('pocket-shovel');
  });

  it('makes the forced moves Antsy Pants demands before ending the turn', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    s = mutate(s, (d) => {
      d.activeCurses.push(CURSE_ANTSY_PANTS);
    });
    const after = applyTimeout(s);
    expect(after.turn?.activePlayer).not.toBe(me);
  });

  it('releases the seat from a capped hop chain too', () => {
    let s = toActionPhase(5);
    const me = activePlayer(s);
    for (const p of [
      { x: 3, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 5 },
    ]) {
      s = withGarden(s, p, 'tunnel');
    }
    const g = withGnome(s, me, { x: 2, y: 1 });
    let hopped: GameState = applyAction(g.state, {
      type: 'move',
      player: me,
      unitId: g.unitId,
      to: { x: 3, y: 1 },
    });
    // Hop as far as the rules allow, then stall.
    for (let i = 0; i < MAX_ENTRY_EFFECT_HOPS; i++) {
      const d = hopped.pendingDecision;
      if (d?.kind !== 'tunnel') break;
      hopped = applyAction(hopped, { type: 'tunnel', player: me, to: d.options[0] });
    }
    const after = applyTimeout(hopped);
    expect(after.turn?.activePlayer).not.toBe(me);
  });

  it('is a no-op for a player who is not on the clock', () => {
    const s = toActionPhase(3);
    const me = activePlayer(s);
    const other = (me + 1) % s.players.length;
    expect(isOnTheClock(s, other)).toBe(false);
  });

  it('a seat that never acts gets played around and loses (every wait state has a default)', () => {
    // Seat 1 stalls on everything — including Respond windows during seat 0's
    // turn. The match must still finish, decided by the player who does act.
    const griefer = 1;
    let s: GameState = newGame(9, { gardenPreset: 'many' });
    for (let i = 0; i < 3000 && !isGameOver(s); i++) {
      const actor = getPlayerToAct(s);
      if (actor === null) break;
      const next = actor === griefer ? applyTimeout(s) : applyAction(s, chooseAiAction(s));
      expect(next).not.toBe(s); // every wait state had an answer
      s = next;
    }
    expect(isGameOver(s)).toBe(true);
    expect(s.winner).not.toBe(griefer);
  });

  it('leaves a normal game untouched when nobody times out', () => {
    const s = drive(newGame(11, { gardenPreset: 'few' }), () => false, 200);
    if (!isGameOver(s)) expect(getPlayerToAct(s)).not.toBeNull();
  });
});
