/**
 * Quick chat: fixed phrases, no free text, budgeted per turn.
 *
 * The point of the feature is what it CANNOT do — carry arbitrary text, or be
 * spammed — so most of these tests are about the limits, not the happy path.
 */

import { describe, expect, it } from 'vitest';
import type { Action, CreateGameOptions, GameState } from './index';
import {
  EngineError,
  QUICK_CHAT_GROUPS,
  QUICK_CHAT_PER_TURN,
  QUICK_CHAT_MUSINGS,
  QUICK_CHAT_PHRASES,
  applyAction,
  chooseAiAction,
  createGame,
  getLegalActions,
  getLegalActionIntents,
  getQuickChatPhrase,
  isGameOver,
  quickChatsLeft,
} from './index';
import { activePlayer, drive, newGame, toActionPhase } from './testkit';

const say = (player: number, phraseId: string): Action => ({ type: 'quickChat', player, phraseId });

/** Last quickchat event on the log. */
function lastChat(s: GameState) {
  return [...s.events].reverse().find((e) => e.type === 'quickChatSaid');
}

describe('quick chat catalogue', () => {
  it('has unique ids and non-empty text everywhere', () => {
    const ids = QUICK_CHAT_PHRASES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of QUICK_CHAT_PHRASES) {
      expect(p.text.trim().length).toBeGreaterThan(0);
      expect(p.emoji.trim().length).toBeGreaterThan(0);
      expect(getQuickChatPhrase(p.id)).toEqual(p);
    }
  });

  it('flattens the groups in menu order', () => {
    expect(QUICK_CHAT_PHRASES).toEqual(QUICK_CHAT_GROUPS.flatMap((g) => g.phrases));
    expect(QUICK_CHAT_GROUPS.length).toBeGreaterThan(1);
  });

  it('has no phrase id outside the catalogue', () => {
    expect(getQuickChatPhrase('please-uninstall')).toBeNull();
  });
});

describe('quick chat action', () => {
  it('logs the phrase id and spends one of the sender’s allowance', () => {
    const s = toActionPhase(3);
    const me = activePlayer(s);
    expect(quickChatsLeft(s, me)).toBe(QUICK_CHAT_PER_TURN);

    const after = applyAction(s, say(me, 'good-luck'));
    expect(lastChat(after)).toEqual({ type: 'quickChatSaid', player: me, phraseId: 'good-luck' });
    expect(quickChatsLeft(after, me)).toBe(QUICK_CHAT_PER_TURN - 1);
  });

  it('rejects any phrase id not in the catalogue (no free text can get through)', () => {
    const s = toActionPhase(3);
    const me = activePlayer(s);
    expect(() => applyAction(s, say(me, 'you are bad and you should feel bad'))).toThrow(EngineError);
    expect(() => applyAction(s, say(me, ''))).toThrow(EngineError);
  });

  it('caps a spammer at QUICK_CHAT_PER_TURN and refills next turn', () => {
    let s = toActionPhase(3);
    const me = activePlayer(s);
    for (let i = 0; i < QUICK_CHAT_PER_TURN; i++) s = applyAction(s, say(me, 'wow'));
    expect(quickChatsLeft(s, me)).toBe(0);
    expect(() => applyAction(s, say(me, 'wow'))).toThrow(/limit reached/i);

    // Nothing about the game changed while they spammed.
    const ended = applyAction(s, { type: 'endTurn', player: me });
    expect(quickChatsLeft(ended, me)).toBe(QUICK_CHAT_PER_TURN);
    expect(() => applyAction(ended, say(me, 'wow'))).not.toThrow();
  });

  it('is sendable out of turn, and by a player who is not the one to act', () => {
    const s = toActionPhase(3);
    const me = activePlayer(s);
    const other = (me + 1) % s.players.length;
    const after = applyAction(s, say(other, 'take-your-time'));
    expect(lastChat(after)).toMatchObject({ player: other });
    // The turn is untouched.
    expect(after.turn?.activePlayer).toBe(me);
    expect(after.turn?.number).toBe(s.turn?.number);
    expect(after.pendingDecision).toEqual(s.pendingDecision);
  });

  it('changes nothing but the log and the allowance', () => {
    const s = toActionPhase(3);
    const me = activePlayer(s);
    const after = applyAction(s, say(me, 'hi'));
    const strip = (x: GameState) => ({
      ...x,
      events: [],
      eventCount: 0,
      players: x.players.map((p) => ({ ...p, quickChatsThisTurn: 0 })),
    });
    expect(strip(after)).toEqual(strip(s));
  });

  it('still works after the game is over (“gg”), unlike every other action', () => {
    const s = drive(newGame(9, { gardenPreset: 'many' }), () => false, 4000);
    expect(isGameOver(s)).toBe(true);
    expect(() => applyAction(s, { type: 'endTurn', player: 0 })).toThrow(/game is over/i);

    const after = applyAction(s, say(0, 'gg'));
    expect(lastChat(after)).toMatchObject({ phraseId: 'gg', player: 0 });
    expect(after.status).toBe('finished');
    expect(after.winner).toBe(s.winner);
  });

  it('is never offered as a legal action (chat is not a move)', () => {
    const s = toActionPhase(3);
    expect(getLegalActionIntents(s).some((a) => a.type === 'quickChat')).toBe(false);
    expect(getLegalActions(s).some((a) => a.type === 'quickChat')).toBe(false);
  });

  it('does not disturb a pending decision', () => {
    // Chat during the opening roll-off: the decision must survive untouched.
    const s = newGame(4);
    expect(s.pendingDecision?.kind).toBe('rollOff');
    const after = applyAction(s, say(1, 'good-luck'));
    expect(after.pendingDecision).toEqual(s.pendingDecision);
    expect(after.status).toBe('rolloff');
  });
});

// ---------------------------------------------------------------------------
// CPU idle chatter
// ---------------------------------------------------------------------------

describe('CPU idle chatter', () => {
  /** A wish-rich economy so the AI actually holds playable cards to sit on. */
  const CARD_RICH: CreateGameOptions = {
    players: [
      { name: 'North', controller: 'cpu', difficulty: 'hard' },
      { name: 'South', controller: 'cpu', difficulty: 'hard' },
    ],
    startingWishes: 6,
    wishLimit: 6,
  };

  /** Play a full AI game, keeping the state each chat action was chosen in. */
  function playAndWatch(seed: number) {
    let state = createGame(CARD_RICH, seed);
    const chats: Array<{ state: GameState; action: Action }> = [];
    for (let i = 0; i < 4000 && !isGameOver(state); i++) {
      const action = chooseAiAction(state);
      if (action.type === 'quickChat') chats.push({ state, action });
      state = applyAction(state, action);
    }
    return { state, chats };
  }

  const games = [1, 2, 3, 4, 5, 6].map(playAndWatch);
  const allChats = games.flatMap((g) => g.chats);

  it('happens at all (the CPU does mutter over a held card)', () => {
    expect(allChats.length).toBeGreaterThan(0);
  });

  it('only ever says rhetorical musings — never a line about the board', () => {
    const musings = new Set(QUICK_CHAT_MUSINGS.map((p) => p.id));
    for (const c of allChats) {
      expect(c.action.type).toBe('quickChat');
      if (c.action.type !== 'quickChat') continue;
      expect(musings.has(c.action.phraseId)).toBe(true);
    }
  });

  it('only mutters when it really could have played a card instead', () => {
    for (const { state, action } of allChats) {
      const actor = action.player;
      expect(state.turn?.activePlayer).toBe(actor);
      expect(state.turn?.phase).toBe('action');
      expect(state.pendingDecision).toBeNull();
      // The whole trigger: a Whimsy Card it can play right now, and doesn't.
      expect(getLegalActionIntents(state, actor).some((a) => a.type === 'playCard')).toBe(true);
    }
  });

  it('mutters at most once per turn per seat', () => {
    for (const { state, action } of allChats) {
      expect(state.players[action.player].quickChatsThisTurn).toBe(0);
    }
    // And a chatty seat still plays the game: chat is a small share of actions.
    for (const g of games) {
      expect(g.chats.length).toBeLessThan((g.state.eventCount ?? 0) / 4);
    }
  });

  it('keeps the AI deterministic (same seed ⇒ same chatter)', () => {
    const a = playAndWatch(3);
    const b = playAndWatch(3);
    expect(a.chats.map((c) => c.action)).toEqual(b.chats.map((c) => c.action));
    expect(a.state.events).toEqual(b.state.events);
  });

  it('does not chat its way past the end of a game', () => {
    for (const g of games) expect(isGameOver(g.state)).toBe(true);
  });
});
