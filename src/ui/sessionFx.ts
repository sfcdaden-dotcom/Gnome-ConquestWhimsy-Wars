/**
 * Presentation effects shared by every kind of game session.
 *
 * `useGame` (local) and `useNetGame` (a room over WebSocket) produce states by
 * different means, but what the player should SEE when a state lands is the
 * same: fights replay step by step, quickchats float over the board, rejected
 * actions become toasts. These hooks hold that behaviour once, so the two
 * session hooks stay thin and cannot drift apart.
 *
 * Each hook returns its screen-facing values plus a `notice*` function the
 * session calls when a new state arrives with the events that state added.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameEvent, GameState, PlayerId, QuickChatId } from '../engine';

// ---------------------------------------------------------------------------
// Event diffing
// ---------------------------------------------------------------------------

/**
 * The events `next` added since `prev`. Diffed via the monotonic `eventCount`,
 * never array lengths — `events` is a trimmed rolling window. `prev` is null
 * for the first state a session sees (nothing is "added"; a mid-game reconnect
 * must not replay the whole backlog of fights and chats).
 */
export function addedEvents(prev: GameState | null, next: GameState): GameEvent[] {
  if (!prev) return [];
  const count = Math.min(next.eventCount - prev.eventCount, next.events.length);
  return count > 0 ? next.events.slice(next.events.length - count) : [];
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

let toastSeq = 1;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((text: string, kind: Toast['kind'] = 'error') => {
    const id = toastSeq++;
    setToasts((ts) => [...ts.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4500);
  }, []);

  return { toasts, pushToast };
}

// ---------------------------------------------------------------------------
// Fight playback
// ---------------------------------------------------------------------------

export interface FightPlayback {
  /** Fight-related events appended by the last action, replayed stepwise. */
  events: GameEvent[];
  /** Number of events currently revealed (0..events.length). */
  shown: number;
}

const FIGHT_EVENT_TYPES = new Set<GameEvent['type']>([
  'fightStarted',
  'fightRoundStarted',
  'fightRolled',
  'rollModified',
  'destructionPrevented',
  'unitDestroyed',
  'flytrapStunned',
  'snailSurvivedLoss',
  'fightEnded',
  'playerEliminated',
]);

export function useFightPlayback(fastForward: boolean) {
  const [playback, setPlayback] = useState<FightPlayback | null>(null);
  const fastRef = useRef(fastForward);
  fastRef.current = fastForward;

  /**
   * Called with each new state's added events. Starts a step-through when they
   * contain dice, unless fast-forwarding or the engine stopped inside the
   * fight anyway (a live Respond window shows its own panel).
   */
  const noticeFightEvents = useCallback((added: GameEvent[], next: GameState) => {
    if (fastRef.current || next.pendingDecision?.kind === 'fightRespond') return;
    const fightEvents = added.filter((e) => FIGHT_EVENT_TYPES.has(e.type));
    if (fightEvents.some((e) => e.type === 'fightRolled')) {
      setPlayback({ events: fightEvents, shown: 1 });
    }
  }, []);

  // Auto-advance; linger briefly on the final step, then dismiss.
  useEffect(() => {
    if (!playback) return;
    if (fastForward || playback.shown >= playback.events.length) {
      const t = window.setTimeout(() => setPlayback(null), fastForward ? 0 : 900);
      return () => window.clearTimeout(t);
    }
    const current = playback.events[playback.shown - 1];
    const delay = current?.type === 'fightRolled' ? 850 : 450;
    const t = window.setTimeout(
      () => setPlayback((p) => (p ? { ...p, shown: p.shown + 1 } : p)),
      delay,
    );
    return () => window.clearTimeout(t);
  }, [playback, fastForward]);

  const skipPlayback = useCallback(() => setPlayback(null), []);

  return { playback, noticeFightEvents, skipPlayback };
}

// ---------------------------------------------------------------------------
// Chat bubbles
// ---------------------------------------------------------------------------

/** One quickchat on screen. Bubbles expire on their own timer. */
export interface ChatBubble {
  id: number;
  player: PlayerId;
  phraseId: QuickChatId;
}

/** How long a quickchat bubble stays on the board, and how many stack up. */
const CHAT_BUBBLE_MS = 6000;
const CHAT_BUBBLE_MAX = 4;

let chatSeq = 1;

export function useChatBubbles() {
  const [chatBubbles, setChatBubbles] = useState<ChatBubble[]>([]);
  const [chatMuted, setChatMuted] = useState(false);
  const mutedRef = useRef(chatMuted);
  mutedRef.current = chatMuted;

  /** Muting is purely cosmetic — the game log keeps every line either way. */
  const noticeChatEvents = useCallback((added: GameEvent[]) => {
    if (mutedRef.current) return;
    for (const e of added) {
      if (e.type !== 'quickChatSaid') continue;
      const id = chatSeq++;
      setChatBubbles((bs) => [...bs.slice(-(CHAT_BUBBLE_MAX - 1)), { id, player: e.player, phraseId: e.phraseId }]);
      window.setTimeout(() => setChatBubbles((bs) => bs.filter((b) => b.id !== id)), CHAT_BUBBLE_MS);
    }
  }, []);

  /** Mute hides the bubbles (and stops new ones); the log is unaffected. */
  const toggleChatMuted = useCallback(() => {
    setChatMuted((m) => {
      if (!m) setChatBubbles([]);
      return !m;
    });
  }, []);

  return { chatBubbles, chatMuted, toggleChatMuted, noticeChatEvents };
}
