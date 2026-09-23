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
 * connection" (`CLOSE_SEAT_TAKEN_OVER`): redialing would just steal the seat
 * back and forth forever. That is a dead end unless the player asks to come
 * back as somebody new, which is what `rejoin` is for. A close for flooding
 * (`CLOSE_RATE_LIMITED`) IS re-dialed, but only after a long backoff — see
 * RATE_LIMITED_BACKOFF_ATTEMPT.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Action, PlayerId, PlayerView } from '../engine';
import { getPlayerToAct } from '../engine';
import type { GameSeal, MatchRecord } from '../engine';
import { verifySeal } from '../net/commitment';
import type { ClientMessage, GnomeLookWire, RoomSnapshot, SeatConfig } from '../net/protocol';
import {
  CLOSE_PROTOCOL,
  CLOSE_RATE_LIMITED,
  CLOSE_ROOM_CLOSED,
  CLOSE_SEAT_TAKEN_OVER,
  PROTOCOL_VERSION,
} from '../net/protocol';
import type { RoomClosedReason } from '../net/protocol';
import type { GameSession } from './useGame';
import { addedEvents, useChatBubbles, useFightPlayback, useToasts } from './sessionFx';
import {
  browserSeatStores,
  CLAIM_HEARTBEAT_MS,
  encodeClientMessage,
  parseServerMessage,
  hostKeyStore,
  recentRoom,
  reconnectDelayMs,
  roomSocketUrl,
  tokenStore,
} from './netClient';

/** One set of stores per page: the tab id must not change between renders. */
const seatStores = browserSeatStores();

/** Keepalive interval — keeps idle-connection middleboxes from reaping us. */
const PING_MS = 45_000;
/**
 * How hard to back off after the room hangs up for flooding. The room is
 * telling us we sent more than it will serve, so the one thing a re-dial must
 * not do is arrive immediately — `reconnectDelayMs` at this attempt is 8s.
 * This client has no way to produce a flood by playing, so reaching it means
 * something is wrong here, and the honest response is to go quiet for a while.
 */
const RATE_LIMITED_BACKOFF_ATTEMPT = 3;

export type NetStatus =
  | 'connecting' // no welcome yet (first dial or a re-dial after a drop)
  | 'lobby'
  | 'playing'
  | 'finished'
  | 'taken-over' // another tab holds the seat; we stay down deliberately
  | 'stale' // this build and the room's disagree; we stay down until a reload
  | 'closed'; // the room is gone; we stay down because there is nothing to dial

export interface NetGame {
  status: NetStatus;
  room: RoomSnapshot | null;
  /** Your identity in the room. `seat: null` = spectator. */
  you: { seat: number | null; isHost: boolean } | null;
  /** Non-null once the room has dealt: the session GameScreen renders. */
  game: GameSession | null;
  /** Game-over proof: the revealed seal + record (see commitment.ts). */
  revealed: { seal: GameSeal; record: MatchRecord } | null;
  /** Why the room shut down, once it has. */
  closedReason: RoomClosedReason | null;
  /**
   * Set when this build and the room's speak different protocol versions. The
   * socket is deliberately down and will not come back: reloading the page is
   * the only thing that changes the answer.
   */
  staleReason: string | null;
  /** Host lobby controls (server-rejected for anyone else). */
  configure: (config: Omit<Extract<ClientMessage, { t: 'configure' }>, 't'>) => void;
  start: () => void;
  /** Claim a room whose host has gone. Refused unless it really has none. */
  takeOverRoom: () => void;
  /** Give up this tab's seat and dial back in as a new player. */
  rejoin: () => void;
  /** Lobby-level toasts (the in-game ones ride on `game`). */
  toasts: GameSession['toasts'];
}

/**
 * `spectate` opens the socket as a SCREEN rather than a player: a board view on
 * a TV. The room never seats it, never makes it host, and never sends it a
 * hand — see protocol.ts. It is a property of this client for the life of the
 * socket, so it rides every hello, reconnects included.
 */
export function useNetGame(
  code: string,
  name: string,
  look?: GnomeLookWire,
  spectate = false,
): NetGame {
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [you, setYou] = useState<{ seat: number | null; isHost: boolean } | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [revealed, setRevealed] = useState<{ seal: GameSeal; record: MatchRecord } | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [closedReason, setClosedReason] = useState<RoomClosedReason | null>(null);
  const [shotClock, setShotClock] = useState<{ seat: PlayerId; deadlineAt: number } | null>(null);
  // Bumped to force a fresh dial (see `rejoin`); the socket effect keys on it.
  const [dial, setDial] = useState(0);

  const { toasts, pushToast, dismissToast } = useToasts();
  const { playback, poofs, noticeFightEvents, skipPlayback } = useFightPlayback(false);
  const { chatBubbles, chatMuted, toggleChatMuted, noticeChatEvents } = useChatBubbles();

  const wsRef = useRef<WebSocket | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  viewRef.current = view;
  // The socket effect is built once, so anything its handlers need to read
  // "as of now" — rather than as of the first dial — comes through a ref.
  const roomRef = useRef<RoomSnapshot | null>(null);
  roomRef.current = room;
  // The socket effect is built once, so the gnome reaches `hello` through a
  // ref rather than a dependency — re-dialling on a hat change would drop the
  // player out of the room to put a hat on them.
  const lookRef = useRef<GnomeLookWire | undefined>(look);
  lookRef.current = look;

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
        send({
          t: 'hello',
          protocol: PROTOCOL_VERSION,
          token: tokenStore.load(seatStores, code),
          // Only ever set for a room this browser opened. The room binds it
          // once and ignores it afterwards, so re-sending it on every dial
          // costs nothing and covers a first dial that failed. A board view
          // sends it too, and the room reads it as an offer rather than a
          // claim: the lobby goes to the first player to sit down.
          hostKey: hostKeyStore.load(localStorage, code),
          // A screen has no name and no gnome — it is not sitting anywhere for
          // one to belong to.
          ...(spectate
            ? { spectate: true }
            : {
                name,
                // Sent on every dial for the same reason the name is: a
                // reconnect has to put the player's gnome back, not just their
                // seat.
                look: lookRef.current,
              }),
        });
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
          case 'roomTakenOver': {
            const who = msg.name ?? (msg.seat === null ? 'A spectator' : seatName(msg.seat));
            pushToast(`👑 ${who} took over the room and can start the game now.`, 'info');
            return;
          }
          case 'roomClosed':
            // Nothing to come back to: drop the seat token and the host key so
            // a later visit to this code arrives as a stranger rather than
            // presenting credentials for a room that no longer exists.
            setClosedReason(msg.reason);
            tokenStore.forget(seatStores, code);
            hostKeyStore.forget(localStorage, code);
            recentRoom.forget(localStorage, code);
            return;
          case 'error':
            // A version mismatch gets a screen of its own rather than a toast:
            // it is not something that went wrong with one message, it is the
            // whole connection being impossible until the page is reloaded.
            if (msg.code === 'STALE_CLIENT') {
              setStale(msg.message);
              return;
            }
            pushToast(msg.message, 'error');
            return;
          case 'pong':
            return;
        }
      };

      ws.onclose = (e) => {
        window.clearInterval(ping);
        if (disposed) return;
        if (e.code === CLOSE_SEAT_TAKEN_OVER) {
          setTakenOver(true);
          return; // deliberate: re-dialing would fight the newer tab forever
        }
        if (e.code === CLOSE_PROTOCOL) {
          // Redialing cannot help: this build speaks what it speaks, so the
          // loop would be infinite — a connection and an error per pass, for
          // as long as the tab is open. Stay down and let the screen ask for
          // the one thing that does fix it.
          setStale((was) => was ?? 'This page is running a different version of the game than the room. Reload it to carry on.');
          return;
        }
        if (e.code === CLOSE_ROOM_CLOSED) {
          // Never redial: addressing a room is what CREATES it, so a redial
          // would build a fresh empty lobby at this code and hand it to us.
          setClosedReason((was) => was ?? 'abandoned');
          return;
        }
        if (e.code === CLOSE_RATE_LIMITED) {
          pushToast('⚠ The room closed the connection for sending too fast. Reconnecting shortly…', 'error');
          attempt = Math.max(attempt, RATE_LIMITED_BACKOFF_ATTEMPT);
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
    // `spectate` is fixed for the life of a screen, so it never re-dials here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, dial, spectate]);

  // --- the seat claim ------------------------------------------------------
  // Says "this tab is still using this seat" to the other tabs of this
  // browser, so they get seats of their own rather than evicting us. It runs
  // whenever we are in the room, including while re-dialling: a seat is not
  // released just because the socket blipped.
  useEffect(() => {
    const beat = () => {
      tokenStore.heartbeat(seatStores, code);
      // Same tick keeps the breadcrumb fresh, so the menu can offer a way back
      // into this room if the tab is closed and the app reopened elsewhere.
      recentRoom.save(localStorage, code, Date.now());
    };
    beat();
    const id = window.setInterval(beat, CLAIM_HEARTBEAT_MS);
    return () => window.clearInterval(id);
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
      dismissToast,
      fastForward: false,
      setFastForward: () => {},
      canFastForward: false,
      playback,
      skipPlayback,
      poofs,
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
      seed: null,
    };
  }, [
    view,
    dispatch,
    toasts,
    pushToast,
    dismissToast,
    playback,
    skipPlayback,
    poofs,
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
  const takeOverRoom = useCallback(() => send({ t: 'takeOverRoom' }), [send]);

  const status: NetStatus = stale
    ? 'stale'
    : closedReason
    ? 'closed'
    : takenOver
      ? 'taken-over'
      : !you
        ? 'connecting'
        : room?.phase === 'playing' && game
          ? 'playing'
          : room?.phase === 'finished'
            ? 'finished'
            : 'lobby';

  return {
    status,
    room,
    you,
    game,
    revealed,
    closedReason,
    staleReason: stale,
    configure,
    start,
    takeOverRoom,
    rejoin,
    toasts,
  };
}

// Re-exported so screens can type seat edits without reaching into protocol.
export type { RoomSnapshot, SeatConfig };
