/**
 * The board view: the screen in the middle of the room.
 *
 * A TV or a projector everyone can see and nobody is holding. It shows the
 * table — the board, who is winning, whose turn it is, what people are saying
 * — and it shows no hand, because it has none: the room redacts per connection
 * and this one sits at no seat (see net/protocol.ts, `spectate`). There is
 * nothing here to hide, which is the point. A shared screen that had the
 * host's cards on it and merely declined to draw them would be one CSS bug
 * away from losing somebody the game.
 *
 * It is also inert on purpose. Every control lives on the phones: no hand, no
 * action menu, no chat composer, no lobby settings, no takeover button. The
 * one thing it does is open the room and then get out of the way — the lobby
 * goes to the first person who sits down (`Room.settleHost`), so setting the
 * TV up before anybody arrives is the natural order rather than the way to
 * strand the start button on an unreachable screen.
 *
 * Everything is drawn a size up from the player screens. The reader is on a
 * sofa, not at a desk.
 */

import { useEffect } from 'react';
import { PlayerPanels } from './panels';
import { Board } from './Board';
import { PanZoom } from './PanZoom';
import { QuickChatFeed } from './QuickChat';
import { GnomeLooksContext } from './gnomeLooks';
import type { SeatLooks } from './gnomeLooks';
import { sanitizeLook } from './gnomeArt';
import { boardPixelSize } from './boardGeometry';
import { useNetGame } from './useNetGame';
import { boardViewHref, roomHref } from './netClient';
import { playerColor } from './meta';
import { lobbyBlocker, blockerText } from './lobbyStatus';
import type { HighlightKind } from './Board';
import type { RoomSnapshot } from '../net/protocol';

/** A board is a backdrop here, not a thing to fit around: fill the wall. */
const BOARD_MAX_FIT = 2.5;

export function BoardView({ code }: { code: string }) {
  // A screen, not a player: the room never seats it and never deals it in.
  const net = useNetGame(code, 'Board view', undefined, true);

  // The projector keeps its own address across a reload. Doing this once here
  // rather than leaning on OnlineScreen's sync, which strips the view back off.
  useEffect(() => {
    window.history.replaceState(null, '', boardViewHref(window.location, code));
  }, [code]);

  const looks: SeatLooks = (net.room?.seats ?? []).map((s) =>
    s.look ? sanitizeLook(s.look) : undefined,
  );

  if (net.status === 'closed') {
    return (
      <BoardStage>
        <h1 className="bv-code">Room closed</h1>
        <p className="bv-line">
          {net.closedReason === 'host-left'
            ? 'The host left and nobody took the room over.'
            : 'Nobody had been in this room for a while.'}
        </p>
      </BoardStage>
    );
  }

  if (net.game) {
    return (
      <GnomeLooksContext value={looks}>
        <BoardGame net={net} code={code} />
      </GnomeLooksContext>
    );
  }

  return (
    <GnomeLooksContext value={looks}>
      <BoardLobby room={net.room} code={code} connecting={net.status === 'connecting'} />
    </GnomeLooksContext>
  );
}

/**
 * Before the deal: the code, big enough to read from the back of the room, and
 * who has arrived so far.
 *
 * The join address is spelled out beside it because the code alone is only
 * half of an instruction — somebody looking at this screen for the first time
 * needs to know where to type it.
 */
function BoardLobby({
  room,
  code,
  connecting,
}: {
  room: RoomSnapshot | null;
  code: string;
  connecting: boolean;
}) {
  const joinAt = roomHref(window.location, null).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const blocker = room ? lobbyBlocker(room) : null;

  return (
    <BoardStage>
      <p className="bv-kicker">Join the game at</p>
      <p className="bv-join">{joinAt}</p>
      <p className="bv-kicker">with the code</p>
      <h1 className="bv-code" data-testid="bv-code">
        {code}
      </h1>

      {connecting && <p className="bv-line">Connecting to the room…</p>}

      {room && (
        <>
          <ul className="bv-seats" data-testid="bv-seats">
            {room.seats.map((s) => (
              <li
                key={s.index}
                className={`bv-seat${s.connected || s.controller === 'cpu' ? ' here' : ''}`}
                style={{ '--pc': playerColor(s.index) } as React.CSSProperties}
              >
                <span className="bv-seat-dot" />
                <span className="bv-seat-name">
                  {s.controller === 'cpu' ? 'CPU' : s.connected ? s.name : 'Empty'}
                </span>
              </li>
            ))}
          </ul>
          <p className="bv-line" data-testid="bv-status">
            {/* The room's own reading of what it is waiting for — the same
                sentence the players are reading on their phones, so the screen
                in the middle of the room never contradicts them. */}
            {room.hostDelegated
              ? 'First player to sit down runs the game.'
              : blocker
                ? blockerText(blocker)
                : ''}
          </p>
        </>
      )}
    </BoardStage>
  );
}

/** In play: the board, the seats, and what people are saying. Nothing to press. */
function BoardGame({ net, code }: { net: ReturnType<typeof useNetGame>; code: string }) {
  const g = net.game!;
  const state = g.state;
  const boardPx = boardPixelSize(state.config.boardSize);
  const winner =
    state.status === 'finished' ? (state.players.find((p) => p.status === 'playing') ?? null) : null;

  return (
    <div className="board-view playing" data-testid="board-view">
      <header className="bv-top">
        <span className="bv-tag">Room {code}</span>
        {state.status === 'finished' ? (
          <span className="bv-turn" data-testid="bv-winner">
            {winner ? `${winner.name} wins` : 'Game over'}
          </span>
        ) : (
          g.playerToAct !== null && (
            <span
              className="bv-turn"
              data-testid="bv-turn"
              style={{ '--pc': playerColor(g.playerToAct) } as React.CSSProperties}
            >
              <span className="bv-seat-dot" />
              {state.players[g.playerToAct]?.name}
            </span>
          )
        )}
      </header>

      <div className="bv-main">
        <PanZoom
          className="bv-stage"
          label="Board"
          contentWidth={boardPx}
          contentHeight={boardPx}
          maxFitScale={BOARD_MAX_FIT}
          controls={false}
        >
          <Board
            state={state}
            highlights={EMPTY_HIGHLIGHTS}
            selectedKey={null}
            poofs={g.poofs}
            sizePx={boardPx}
            /* Nobody is at this screen. A cell that did something when touched
               would be a control on the one surface that must not have any. */
            onCellClick={NOOP}
          />
        </PanZoom>

        <aside className="bv-side">
          <PlayerPanels state={state} takenOverSeats={g.takenOverSeats} />
        </aside>

        <QuickChatFeed state={state} bubbles={g.chatBubbles} />
      </div>
    </div>
  );
}

/** The plain full-screen frame the lobby and the closed notice share. */
function BoardStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="board-view" data-testid="board-view">
      <div className="bv-card">{children}</div>
    </div>
  );
}

/** Nothing is ever highlighted here: highlights answer "what can I do now?" */
const EMPTY_HIGHLIGHTS: ReadonlyMap<string, HighlightKind> = new Map();
function NOOP(): void {}
