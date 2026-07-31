/**
 * Local game session hook: holds the single GameState, dispatches actions
 * through the engine (EngineError → toast, never a crash), drives CPU seats on
 * a timer, and gates pass-and-play privacy between human seats.
 *
 * The screen-facing shape is `GameSession`, which `useNetGame` also satisfies
 * — GameScreen renders either without knowing which it has. The fields whose
 * meaning shifts between the two:
 *
 *  - `humanSeats`: the seats THIS DEVICE controls. Locally that is every
 *    human seat (hot-seat); online it is just yours. GameScreen gates
 *    interactivity on it, which is what stops an online client acting during
 *    a remote human's turn.
 *  - `dispatch` returns whether the action was ACCEPTED — immediately truthful
 *    locally; optimistically true online (a server rejection arrives later as
 *    a toast).
 *  - `revealedSeat` / `needsPass` / `confirmPass`: the pass-the-device
 *    interstitial. Online they pin to your seat / false / no-op.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, CreateGameOptions, GameState, PlayerId } from '../engine';
import { applyAction, chooseAiAction, createGame, getPlayerToAct } from '../engine';
import type { ChatBubble, FightPlayback, Toast } from './sessionFx';
import { addedEvents, useChatBubbles, useFightPlayback, useToasts } from './sessionFx';

export type { ChatBubble, FightPlayback, Toast };

// ---------------------------------------------------------------------------
// The session contract GameScreen renders
// ---------------------------------------------------------------------------

export interface GameSession {
  /** Authoritative state locally; the seat's redacted PlayerView online. */
  state: GameState;
  /** Apply/request one action. False = known-rejected (local only). */
  dispatch: (action: Action) => boolean;
  toasts: Toast[];
  pushToast: (text: string, kind?: Toast['kind']) => void;
  /** Skip CPU pacing and fight animations. Meaningless online. */
  fastForward: boolean;
  setFastForward: (on: boolean) => void;
  /** Whether the fast-forward toggle does anything (hidden otherwise). */
  canFastForward: boolean;
  playback: FightPlayback | null;
  skipPlayback: () => void;
  chatBubbles: ChatBubble[];
  chatMuted: boolean;
  toggleChatMuted: () => void;
  playerToAct: PlayerId | null;
  actorIsCpu: boolean;
  /** Seats THIS DEVICE controls — the interactivity gate. */
  humanSeats: PlayerId[];
  /** Whose private info (hand) is on screen. */
  revealedSeat: PlayerId | null;
  /** Pass-the-device interstitial required before the next human acts. */
  needsPass: boolean;
  confirmPass: () => void;
  /**
   * The shot clock, or null when nothing is being timed — which is always the
   * case locally: a hot-seat game has nobody to grief but yourself. Online it
   * carries the seat on the clock and when it runs out, already converted to
   * THIS device's wall clock (see useNetGame), so rendering it is a plain
   * `deadlineAt - Date.now()`.
   */
  shotClock: { seat: PlayerId; deadlineAt: number } | null;
  /**
   * Seats the room took over mid-game because their player stopped playing.
   * They are CPU seats to the ROOM but still read as human in `state` — the
   * engine's config is fixed when the game is created and cannot be edited
   * afterwards without the match record ceasing to replay. So the takeover is
   * carried here, alongside the state, rather than inside it.
   */
  takenOverSeats: PlayerId[];
  /** Short label for the top bar: the seed locally, the room code online. */
  tag: string;
}

const CPU_DELAY_MS = 400;
const CPU_FAST_MS = 25;

/** Shared empty list, so a local session's identity stays stable per render. */
const EMPTY_SEATS: PlayerId[] = [];

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGame(options: CreateGameOptions, seed: number): GameSession {
  const [state, setState] = useState<GameState>(() => createGame(options, seed));
  const [fastForward, setFastForward] = useState(false);
  /** Which human seat's private info (hand) is currently on screen. */
  const [revealedSeat, setRevealedSeat] = useState<PlayerId | null>(null);

  const { toasts, pushToast } = useToasts();
  const { playback, noticeFightEvents, skipPlayback } = useFightPlayback(fastForward);
  const { chatBubbles, chatMuted, toggleChatMuted, noticeChatEvents } = useChatBubbles();

  const stateRef = useRef(state);
  stateRef.current = state;
  const fastRef = useRef(fastForward);
  fastRef.current = fastForward;

  /** Apply one action; illegal actions surface as toasts and change nothing. */
  const dispatch = useCallback(
    (action: Action): boolean => {
      const prev = stateRef.current;
      let next: GameState;
      try {
        next = applyAction(prev, action);
      } catch (err) {
        pushToast(err instanceof Error ? err.message : String(err), 'error');
        return false;
      }
      const added = addedEvents(prev, next);
      noticeFightEvents(added, next);
      noticeChatEvents(added);
      stateRef.current = next;
      setState(next);
      return true;
    },
    [pushToast, noticeFightEvents, noticeChatEvents],
  );

  // --- seat bookkeeping -----------------------------------------------------
  const humanSeats = useMemo(
    () => state.players.filter((p) => p.controller === 'human').map((p) => p.id),
    [state.players],
  );

  const playerToAct = state.status === 'finished' ? null : getPlayerToAct(state);
  const actorIsCpu =
    playerToAct !== null && state.players[playerToAct].controller === 'cpu';

  // With exactly one human, that seat is always "revealed" (no privacy issue).
  useEffect(() => {
    if (humanSeats.length === 1 && revealedSeat !== humanSeats[0]) {
      setRevealedSeat(humanSeats[0]);
    }
  }, [humanSeats, revealedSeat]);

  /**
   * Pass-the-device interstitial: required when a human must act, there are
   * 2+ human seats, and the device was last "revealed" to a different seat.
   * The opening roll-off is exempt (hands are empty; nothing to hide).
   */
  const needsPass =
    playerToAct !== null &&
    !actorIsCpu &&
    humanSeats.length >= 2 &&
    state.status !== 'rolloff' &&
    revealedSeat !== playerToAct;

  const confirmPass = useCallback(() => {
    const actor = getPlayerToAct(stateRef.current);
    if (actor !== null) setRevealedSeat(actor);
  }, []);

  // --- CPU driver -----------------------------------------------------------
  useEffect(() => {
    if (state.status === 'finished') return;
    if (playback) return; // let humans watch the fight
    if (!actorIsCpu) return;
    const t = window.setTimeout(() => {
      const s = stateRef.current;
      const actor = getPlayerToAct(s);
      if (actor === null || s.players[actor].controller !== 'cpu') return;
      try {
        dispatch(chooseAiAction(s));
      } catch (err) {
        pushToast(
          `CPU error: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    }, fastForward ? CPU_FAST_MS : CPU_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [state, playback, actorIsCpu, fastForward, dispatch, pushToast]);

  return {
    state,
    dispatch,
    toasts,
    pushToast,
    fastForward,
    setFastForward,
    canFastForward: true,
    playback,
    skipPlayback,
    chatBubbles,
    chatMuted,
    toggleChatMuted,
    playerToAct,
    actorIsCpu,
    humanSeats,
    revealedSeat,
    needsPass,
    confirmPass,
    shotClock: null,
    takenOverSeats: EMPTY_SEATS,
    tag: `#${seed}`,
  };
}
