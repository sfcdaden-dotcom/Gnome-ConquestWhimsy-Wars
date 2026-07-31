/**
 * Networked game session: one WebSocket into a room Durable Object.
 *
 * Returns lobby-level facts (room snapshot, your seat, host controls) plus a
 * `game: GameSession | null` that becomes non-null once the room has dealt —
 * the SAME shape `useGame` returns, so `GameScreen` renders a networked game
 * without knowing it is one. The differences all live in the session fields'
 * meanings (see the GameSession doc in useGame.ts): `humanSeats` is just your
 * seat, so the screen is interactive only on your turn; `dispatch` is
 * optimistic (a server rejection arrives as an error frame → toast); the
 * pass-and-play machinery pins to "always you".
 *
 * The state received is a per-seat `PlayerView` — redacted in the room before
 * transmission. This hook adds no hiding of its own, and could not: the
 * information is simply not on the wire.
 *
 * Reconnect: the room's token (held per tab, per room code — see netClient.ts)
 * is presented on every hello, including automatic re-dials after a drop, so a
 * refresh, a dead tunnel or a hibernated room all return you to your seat.
 * The one close we do not re-dial is the server's "seat taken over by a newer
 * connection" (code 4000): redialing would just steal the seat back and forth
 * forever. That is a dead end unless the player asks to come back as somebody
 * new, which is what `rejoin` is for.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, PlayerId, PlayerView } from '../engine';
import { getPlayerToAct } from '../engine';
import type { GameSeal, MatchRecord } from '../engine';
import { verifySeal } from '../net/commitment';
import type { ClientMessage, RoomSnapshot, SeatConfig } from '../net/protocol';
import { PROTOCOL_VERSION } from '../net/protocol';
import type { GameSession } from './useGame';
import { addedEvents, useChatBubbles, useFightPlayback, useToasts } from './sessionFx';
import {
  browserSeatStores,
  CLAIM_HEARTBEAT_MS,
  encodeClientMessage,
  parseServerMessage,
  reconnectDelayMs,
  roomSocketUrl,
  tokenStore,
} from './netClient';

/** One set of stores per page: the tab id must not change between renders. */
const seatStores = browserSeatStores();

/** Keepalive interval — keeps idle-connection middleboxes from reaping us. */
const PING_MS = 45_000;
/** The server's "another connection took this seat" close code. */
const TAKEN_OVER_CODE = 4000;

export type NetStatus =
  | 'connecting' // no welcome yet (first dial or a re-dial after a drop)
  | 'lobby'
  | 'playing'
  | 'finished'
  | 'taken-over'; // another tab holds the seat; we stay down deliberately

export interface NetGame {
  status: NetStatus;
  room: RoomSnapshot | null;
  /** Your identity in the room. `seat: null` = spectator. */
  you: { seat: number | null; isHost: boolean } | null;
  /** Non-null once the room has dealt: the session GameScreen renders. */
  game: GameSession | null;
  /** Game-over proof: the revealed seal + record (see commitment.ts). */
  revealed: { seal: GameSeal; record: MatchRecord } | null;
  /** Host lobby controls (server-rejected for anyone else). */
  configure: (config: Omit<Extract<ClientMessage, { t: 'configure' }>, 't'>) => void;
  start: () => void;
  /** Give up this tab's seat and dial back in as a new player. */
  rejoin: () => void;
  /** Lobby-level toasts (the in-game ones ride on `game`). */
  toasts: GameSession['toasts'];
}

export function useNetGame(code: string, name: string): NetGame {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [you, setYou] = useState<{ seat: number | null; isHost: boolean } | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [revealed, setRevealed] = useState<{ seal: GameSeal; record: MatchRecord } | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [shotClock, setShotClock] = useState<{ seat: PlayerId; deadlineAt: number } | null>(null);
  // Bumped to force a fresh dial (see `rejoin`); the socket effect keys on it.
  const [dial, setDial] = useState(0);

  const { toasts, pushToast } = useToasts();
  const { playback, noticeFightEvents, skipPlayback } = useFightPlayback(false);
  const { chatBubbles, chatMuted, toggleChatMuted, noticeChatEvents } = useChatBubbles();

  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  viewRef.current = view;
  // The socket effect is built once, so anything its handlers need to read
  // "as of now" — rather than as of the first dial — comes through a ref.
  const roomRef = useRef<RoomSnapshot | null>(null);
  roomRef.current = room;

  const send = useCallback((message: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeClientMessage(message));
  }, []);

  // --- the socket, with re-dial --------------------------------------------
  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let ws: WebSocket | null = null;
    let redial: number | undefined;
    let ping: number | undefined;

    const seatName = (seat: number) => roomRef.current?.seats[seat]?.name ?? `Seat ${seat + 1}`;

    function dial() {
      if (disposed) return;
      ws = new WebSocket(roomSocketUrl(code, window.location));
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        send({ t: 'hello', protocol: PROTOCOL_VERSION, token: tokenStore.load(seatStores, code), name });
        ping = window.setInterval(() => send({ t: 'ping' }), PING_MS);
      };

      ws.onmessage = (e) => {
        const msg = parseServerMessage(e.data);
        if (!msg) return;
        switch (msg.t) {
          case 'welcome':
            // Not only the first frame: the room re-sends `welcome` whenever
            // it changes who we are — seated out of the spectator list, moved
            // out of a seat it turned into a CPU, handed the lobby. Always
            // take the new identity.
            tokenStore.save(seatStores, code, msg.you.token);
            setYou({ seat: msg.you.seat, isHost: msg.you.isHost });
            setRoom(msg.room);
            return;
          case 'room':
            setRoom(msg.room);
            return;
          case 'state': {
            // FX diff against the previous view; null across a reconnect gap
            // would replay nothing, which is exactly right.
            const prev = viewRef.current;
            noticeFightEvents(addedEvents(prev, msg.view), msg.view);
            noticeChatEvents(addedEvents(prev, msg.view));
            viewRef.current = msg.view;
            setView(msg.view);
            // The server stamps every clock with its OWN wall clock, so the
            // remaining time is a difference of two server timestamps and a
            // device whose clock is minutes off still counts down correctly.
            setShotClock(
              msg.clock ? { seat: msg.clock.seat, deadlineAt: Date.now() + (msg.clock.deadline - msg.clock.now) } : null,
            );
            return;
          }
          case 'timedOut': {
            pushToast(`⏱ ${seatName(msg.seat)} ran out of time — the room played the turn out.`, 'info');
            return;
          }
          case 'seatTakenOver': {
            pushToast(`🤖 ${seatName(msg.seat)} stopped playing — a CPU has taken the seat.`, 'info');
            return;
          }
          case 'revealed':
            setRevealed({ seal: msg.seal, record: msg.record });
            return;
          case 'error':
            pushToast(msg.message, 'error');
            return;
          case 'pong':
            return;
        }
      };

      ws.onclose = (e) => {
        window.clearInterval(ping);
        if (disposed) return;
        if (e.code === TAKEN_OVER_CODE) {
          setTakenOver(true);
          return; // deliberate: re-dialing would fight the newer tab forever
        }
        redial = window.setTimeout(dial, reconnectDelayMs(attempt++));
      };
    }

    dial();
    return () => {
      disposed = true;
      window.clearTimeout(redial);
      window.clearInterval(ping);
      wsRef.current = null;
      ws?.close(1000, 'leaving');
    };
    // Reconnecting on a name change alone would drop the seat mid-game; the
    // name is only a first-hello nicety, so the socket is keyed by room only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, dial]);

  // --- the seat claim ------------------------------------------------------
  // Says "this tab is still using this seat" to the other tabs of this
  // browser, so they get seats of their own rather than evicting us. It runs
  // whenever we are in the room, including while re-dialling: a seat is not
  // released just because the socket blipped.
  useEffect(() => {
    tokenStore.heartbeat(seatStores, code);
    const beat = window.setInterval(() => tokenStore.heartbeat(seatStores, code), CLAIM_HEARTBEAT_MS);
    return () => window.clearInterval(beat);
  }, [code]);

  /** Come back as a new player, abandoning the seat this tab was holding. */
  const rejoin = useCallback(() => {
    tokenStore.forget(seatStores, code);
    setTakenOver(false);
    setYou(null);
    setRoom(null);
    setView(null);
    viewRef.current = null;
    setRevealed(null);
    // The old identity's countdown is not ours to keep showing.
    setShotClock(null);
    setDial((n) => n + 1);
  }, [code]);

  // --- game-over verification ----------------------------------------------
  // The seal the room reveals must hash to the commitment it published when
  // the game STARTED. Players should not have to run this by hand.
  useEffect(() => {
    if (!revealed || !room?.commitment) return;
    let stale = false;
    void verifySeal(revealed.seal, room.commitment).then((ok: boolean) => {
      if (stale) return;
      if (ok) pushToast('Deck verified: the room played the deck it committed to. ✔', 'info');
      else pushToast('⚠ Deck verification FAILED — the revealed secret does not match the commitment.', 'error');
    });
    return () => {
      stale = true;
    };
  }, [revealed, room?.commitment, pushToast]);

  // --- the session GameScreen renders --------------------------------------
  const dispatch = useCallback(
    (action: Action): boolean => {
      // Optimistic: the room is authoritative, so the truth arrives as either
      // a new state or an error toast. Nothing is applied locally.
      send({ t: 'action', action });
      return true;
    },
    [send],
  );

  const mySeat = you?.seat ?? null;

  // The room's word, not the state's: `state.players[].controller` is fixed
  // when the game is created (see GameSession.takenOverSeats).
  const takenOverSeats = useMemo(
    () => (room?.seats ?? []).filter((s) => s.takenOver).map((s) => s.index),
    [room?.seats],
  );

  const game = useMemo<GameSession | null>(() => {
    if (!view) return null;
    const playerToAct = view.status === 'finished' ? null : getPlayerToAct(view);
    return {
      state: view,
      dispatch,
      toasts,
      pushToast,
      fastForward: false,
      setFastForward: () => {},
      canFastForward: false,
      playback,
      skipPlayback,
      chatBubbles,
      chatMuted,
      toggleChatMuted,
      playerToAct,
      actorIsCpu: playerToAct !== null && view.players[playerToAct]?.controller === 'cpu',
      // Only your own seat: the interactivity gate. A remote human's turn is
      // exactly as untouchable as a CPU's.
      humanSeats: mySeat !== null ? [mySeat] : [],
      revealedSeat: mySeat,
      needsPass: false,
      confirmPass: () => {},
      shotClock,
      takenOverSeats,
      tag: `room ${code}`,
    };
  }, [
    view,
    dispatch,
    toasts,
    pushToast,
    playback,
    skipPlayback,
    chatBubbles,
    chatMuted,
    toggleChatMuted,
    mySeat,
    shotClock,
    takenOverSeats,
    code,
  ]);

  const configure = useCallback(
    (config: Omit<Extract<ClientMessage, { t: 'configure' }>, 't'>) => send({ t: 'configure', ...config } as ClientMessage),
    [send],
  );
  const start = useCallback(() => send({ t: 'start' }), [send]);

  const status: NetStatus = takenOver
    ? 'taken-over'
    : !you
      ? 'connecting'
      : room?.phase === 'playing' && game
        ? 'playing'
        : room?.phase === 'finished'
          ? 'finished'
          : 'lobby';

  return { status, room, you, game, revealed, configure, start, rejoin, toasts };
}

// Re-exported so screens can type seat edits without reaching into protocol.
export type { RoomSnapshot, SeatConfig };
