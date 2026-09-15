/**
 * Quick chat: fixed phrases, no free text, budgeted per turn.
 *
 * The point of the feature is what it CANNOT do — carry arbitrary text, or be
 * spammed — so most of these tests are about the limits, not the happy path.
 */

import { describe, expect, it } from 'vitest';
import type { Action, CreateGameOptions, GameState, QuickChatTarget } from './index';
import {
  EngineError,
  QUICK_CHAT_GROUPS,
  QUICK_CHAT_PER_TURN,
  QUICK_CHAT_MUSINGS,
  QUICK_CHAT_PHRASES,
  QUICK_CHAT_SCHEMES,
  applyAction,
  chooseAiAction,
  createAiMemory,
  createGame,
  getLegalActions,
  getLegalActionIntents,
  getQuickChatPhrase,
  isGameOver,
  quickChatsLeft,
} from './index';
import { CPU_SCHEME_LINES } from './ai/chatter';
import { activePlayer, drive, newGame, toActionPhase } from './testkit';

const say = (player: number, phraseId: string, target?: QuickChatTarget): Action => ({
  type: 'quickChat',
  player,
  phraseId,
  ...(target ? { target } : {}),
});

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
    const after = applyAction(s, say(other, 'no-worries'));
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

  it('still works after the game is over (a parting “Good Game!”), unlike every other action', () => {
    const s = drive(newGame(9, { gardenPreset: 'many' }), () => false, 4000);
    expect(isGameOver(s)).toBe(true);
    expect(() => applyAction(s, { type: 'endTurn', player: 0 })).toThrow(/game is over/i);

    const after = applyAction(s, say(0, 'good-game'));
    expect(lastChat(after)).toMatchObject({ phraseId: 'good-game', player: 0 });
    expect(after.status).toBe('finished');
    expect(after.winner).toBe(s.winner);
  });

  /**
   * The two lines that name something.
   *
   * A target is an id or a coordinate, never text — which is what keeps the set
   * of things a player can say closed even though two of the lines vary. The
   * rules run both ways on purpose: a line that needs a target cannot go
   * without one, and a line that shows no target cannot carry one. The second
   * is the one worth enforcing, because a target rides in the match record and
   * out to every seat, so an unshown one would be a free side-channel for
   * pointing at a square.
   */
  describe('lines that name something', () => {
    it('carries a player target on the line that names a rival', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      const other = (me + 1) % s.players.length;
      const after = applyAction(s, say(me, 'coming-for-you', { kind: 'player', player: other }));
      expect(lastChat(after)).toMatchObject({
        phraseId: 'coming-for-you',
        target: { kind: 'player', player: other },
      });
    });

    it('carries a space target on the line that names a square', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      const after = applyAction(s, say(me, 'one-day-that-garden', { kind: 'space', pos: { x: 1, y: 2 } }));
      expect(lastChat(after)).toMatchObject({ target: { kind: 'space', pos: { x: 1, y: 2 } } });
    });

    it('refuses a line that names something when nothing is named', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      expect(() => applyAction(s, say(me, 'coming-for-you'))).toThrow(EngineError);
      expect(() => applyAction(s, say(me, 'one-day-that-garden'))).toThrow(EngineError);
    });

    it('refuses a target on a line that would never show it', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      expect(() => applyAction(s, say(me, 'hi', { kind: 'space', pos: { x: 0, y: 0 } }))).toThrow(
        EngineError,
      );
    });

    it('refuses the wrong kind of target', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      expect(() => applyAction(s, say(me, 'coming-for-you', { kind: 'space', pos: { x: 0, y: 0 } }))).toThrow(
        EngineError,
      );
    });

    it('refuses a square that is not on the board', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      const off = s.config.boardSize;
      expect(() => applyAction(s, say(me, 'one-day-that-garden', { kind: 'space', pos: { x: off, y: 0 } }))).toThrow(
        EngineError,
      );
    });

    it('refuses a seat that does not exist, and refuses aiming at yourself', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      expect(() => applyAction(s, say(me, 'coming-for-you', { kind: 'player', player: 99 }))).toThrow(
        EngineError,
      );
      // A mis-click, not a taunt.
      expect(() => applyAction(s, say(me, 'coming-for-you', { kind: 'player', player: me }))).toThrow(
        /yourself/i,
      );
    });

    it('spends an allowance like any other line', () => {
      const s = toActionPhase(3);
      const me = activePlayer(s);
      const other = (me + 1) % s.players.length;
      const after = applyAction(s, say(me, 'coming-for-you', { kind: 'player', player: other }));
      expect(quickChatsLeft(after, me)).toBe(QUICK_CHAT_PER_TURN - 1);
    });
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

describe('CPU chatter', () => {
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
    const memory = createAiMemory();
    const chats: Array<{ state: GameState; action: Action }> = [];
    for (let i = 0; i < 4000 && !isGameOver(state); i++) {
      const action = chooseAiAction(state, memory);
      if (action.type === 'quickChat') chats.push({ state, action });
      state = applyAction(state, action);
    }
    return { state, chats };
  }

  const games = [1, 2, 3, 4, 5, 6].map(playAndWatch);
  const allChats = games.flatMap((g) => g.chats);

  it('happens at all', () => {
    expect(allChats.length).toBeGreaterThan(0);
  });

  /**
   * The CPU's whole vocabulary, asserted against the tables rather than against
   * a list of groups.
   *
   * It used to be exactly two groups, Schemes and Musings. It no longer is: the
   * line for marching on somebody's Home names whose, and a phrase that names a
   * person sits with the other targeted lines in Tactics. Deriving the set from
   * `CPU_SCHEME_LINES` keeps this honest when the tables move again.
   */
  it('says only lines the objective tables and the musings list allow', () => {
    const speakable = new Set([...QUICK_CHAT_MUSINGS.map((p) => p.id), ...CPU_SCHEME_LINES]);
    for (const c of allChats) {
      expect(c.action.type).toBe('quickChat');
      if (c.action.type !== 'quickChat') continue;
      expect(speakable.has(c.action.phraseId)).toBe(true);
    }
  });

  /**
   * A templated line arrives complete or not at all.
   *
   * The CPU fills `{{player.color}}` and `{{space}}` from the objective that
   * prompted the line (`targetFor` in ai/chatter.ts). `doQuickChat` refuses a
   * phrase that needs a target and has none, so a gap here would not be a
   * cosmetic bug — it would throw mid-turn and take the CPU's turn with it.
   */
  it('fills in every line that names something', () => {
    for (const { action } of allChats) {
      if (action.type !== 'quickChat') continue;
      const phrase = getQuickChatPhrase(action.phraseId);
      expect(phrase).not.toBeNull();
      if (phrase?.needs) expect(action.target?.kind).toBe(phrase.needs);
      else expect(action.target).toBeUndefined();
    }
  });

  it('announces its plans — the schemes are the point of the feature', () => {
    const schemes = new Set(QUICK_CHAT_SCHEMES.map((p) => p.id));
    const said = allChats
      .map((c) => (c.action.type === 'quickChat' ? c.action.phraseId : ''))
      .filter((id) => schemes.has(id));
    expect(said.length).toBeGreaterThan(0);
    // Across six games it should reach for more than one kind of plan.
    expect(new Set(said).size).toBeGreaterThan(1);
  });

  it('every line the CPU can say for a plan is really in the catalogue', () => {
    // The objective→phrase tables in ai/chatter.ts are hand-written; a typo
    // there would silently mute the CPU rather than fail anything at runtime.
    for (const id of CPU_SCHEME_LINES) expect(getQuickChatPhrase(id)).not.toBeNull();
  });

  it('only ever speaks on its own Action Phase, with no decision open', () => {
    for (const { state, action } of allChats) {
      const actor = action.player;
      expect(state.turn?.activePlayer).toBe(actor);
      expect(state.turn?.phase).toBe('action');
      expect(state.pendingDecision).toBeNull();
    }
  });

  it('only MUSES when it really could have played a card instead', () => {
    // Schemes are announced whatever else is going on; the rhetorical filler
    // keeps its original trigger — a playable Whimsy Card it chose not to play.
    const musings = new Set(QUICK_CHAT_MUSINGS.map((p) => p.id));
    for (const { state, action } of allChats) {
      if (action.type !== 'quickChat' || !musings.has(action.phraseId)) continue;
      expect(getLegalActionIntents(state, action.player).some((a) => a.type === 'playCard')).toBe(
        true,
      );
    }
  });

  it('speaks at most once per turn per seat', () => {
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
