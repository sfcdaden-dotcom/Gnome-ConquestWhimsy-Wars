/**
 * Online play: the room menu, the lobby, and the networked game.
 *
 * Three states, in order — choose (host or join) → lobby → game. The lobby and
 * game both live in `RoomView`, which owns the single `useNetGame` socket; the
 * menu deliberately does not open one, so idling on "host or join?" costs the
 * server nothing.
 *
 * Nothing here re-implements game rules or hides information: the lobby edits
 * are requests the room can refuse (a non-host's `configure` comes back as an
 * error toast), and the board is `GameScreen` fed the networked session.
 */

import { useState } from 'react';
import { GARDEN_PRESETS } from '../engine';
import type { AiDifficulty, GardenPreset } from '../engine';
import { GameScreen } from './GameScreen';
import { useNetGame } from './useNetGame';
import { NAME_KEY } from './netClient';
import { ROOM_CODE_LENGTH } from '../net/protocol';
import { playerColor } from './meta';

// ---------------------------------------------------------------------------
// Entry: host or join
// ---------------------------------------------------------------------------

export function OnlineScreen({ onBack }: { onBack: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');

  if (code) {
    return (
      <RoomView
        code={code}
        name={name.trim() || 'Gnome'}
        onLeave={() => setCode(null)}
      />
    );
  }
  return (
    <OnlineMenu
      name={name}
      setName={(n) => {
        setName(n);
        localStorage.setItem(NAME_KEY, n);
      }}
      onEnter={setCode}
      onBack={onBack}
    />
  );
}

function OnlineMenu({
  name,
  setName,
  onEnter,
  onBack,
}: {
  name: string;
  setName: (n: string) => void;
  onEnter: (code: string) => void;
  onBack: () => void;
}) {
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function host() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/rooms', { method: 'POST' });
      if (!res.ok) throw new Error(`The server said ${res.status}`);
      const { code } = (await res.json()) as { code: string };
      onEnter(code);
    } catch (err) {
      // Almost always "this build is served without the Worker" — say so
      // rather than leaving a dead button.
      setError(
        `Could not create a room (${err instanceof Error ? err.message : String(err)}). Online play needs the Whimsy Wars server; a static-only deploy has no rooms.`,
      );
      setBusy(false);
    }
  }

  const codeReady = joinCode.trim().length === ROOM_CODE_LENGTH;

  return (
    <div className="home-screen" data-testid="online-menu">
      <div className="home-card">
        <h1 className="home-title">🌐 Play online</h1>
        <p className="home-tagline">
          Private rooms — no accounts, no lobby list. Whoever has the code is at the table.
        </p>

        <label className="field">
          <span>Your name</span>
          <input
            type="text"
            maxLength={24}
            placeholder="Gnome"
            value={name}
            data-testid="online-name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {error && (
          <p className="form-error" role="alert" data-testid="online-error">
            {error}
          </p>
        )}

        <div className="home-choices">
          <button
            type="button"
            className="btn big accent home-choice"
            data-testid="online-host"
            disabled={busy}
            onClick={host}
          >
            <span className="home-choice-icon">🏡</span>
            <span className="home-choice-label">{busy ? 'Creating…' : 'Host a game'}</span>
            <span className="home-choice-sub">Get a code, set up the table, invite a friend</span>
          </button>

          {joining ? (
            <div className="join-row">
              <label className="field">
                <span>Room code</span>
                <input
                  type="text"
                  autoFocus
                  maxLength={ROOM_CODE_LENGTH}
                  placeholder="ABC234"
                  value={joinCode}
                  data-testid="online-join-code"
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && codeReady) onEnter(joinCode.trim());
                  }}
                />
              </label>
              <button
                type="button"
                className="btn accent"
                data-testid="online-join-go"
                disabled={!codeReady}
                onClick={() => onEnter(joinCode.trim())}
              >
                Join
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn big home-choice"
              data-testid="online-join"
              onClick={() => setJoining(true)}
            >
              <span className="home-choice-icon">🚪</span>
              <span className="home-choice-label">Join a game</span>
              <span className="home-choice-sub">Enter the {ROOM_CODE_LENGTH}-character code you were sent</span>
            </button>
          )}
        </div>

        <button type="button" className="btn ghost" data-testid="online-back" onClick={onBack}>
          ← Back
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In a room
// ---------------------------------------------------------------------------

function RoomView({ code, name, onLeave }: { code: string; name: string; onLeave: () => void }) {
  const net = useNetGame(code, name);

  if (net.status === 'playing' || (net.status === 'finished' && net.game)) {
    // No "play again": a room's next game is the host's call, not a button
    // that would silently re-deal for everyone.
    return <GameScreen game={net.game!} onQuit={onLeave} />;
  }

  return <Lobby net={net} code={code} onLeave={onLeave} />;
}

function Lobby({
  net,
  code,
  onLeave,
}: {
  net: ReturnType<typeof useNetGame>;
  code: string;
  onLeave: () => void;
}) {
  const { room, you, status } = net;
  const isHost = you?.isHost ?? false;
  const [copied, setCopied] = useState(false);

  const emptyHumanSeats =
    room?.seats.filter((s) => s.controller === 'human' && !s.connected).map((s) => s.index + 1) ?? [];

  return (
    <div className="home-screen" data-testid="room-lobby">
      <div className="home-card lobby-card">
        <h1 className="home-title">Room {code}</h1>

        {status === 'taken-over' ? (
          <p className="form-error" role="alert" data-testid="lobby-taken-over">
            Another tab took this seat. Close the other tab and rejoin from here if you want it back.
          </p>
        ) : status === 'connecting' ? (
          <p className="muted" data-testid="lobby-connecting">
            Connecting to the room…
          </p>
        ) : null}

        <div className="lobby-share">
          <span className="muted small">Share this code — anyone who has it can sit down:</span>
          <div className="join-row">
            <code className="room-code" data-testid="lobby-code">
              {code}
            </code>
            <button
              type="button"
              className="btn small"
              data-testid="lobby-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(code);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied ✔' : 'Copy'}
            </button>
          </div>
        </div>

        {room && (
          <>
            <div className="lobby-seats" data-testid="lobby-seats">
              {room.seats.map((seat) => (
                <div className="lobby-seat" key={seat.index} data-testid={`lobby-seat-${seat.index}`}>
                  <span className="seat-dot" style={{ background: playerColor(seat.index) }} />
                  <span className="seat-name">
                    {seat.name}
                    {you?.seat === seat.index && <span className="muted small"> (you)</span>}
                  </span>

                  <span className="muted small seat-status">
                    {seat.controller === 'cpu'
                      ? `CPU (${seat.difficulty})`
                      : seat.connected
                        ? 'ready'
                        : 'open — waiting for a player'}
                  </span>

                  {isHost && status === 'lobby' && (
                    <>
                      <div className="btn-row">
                        <button
                          type="button"
                          className={`btn chip ${seat.controller === 'human' ? 'on' : ''}`}
                          data-testid={`lobby-seat-${seat.index}-human`}
                          onClick={() => net.configure({ seats: [{ index: seat.index, controller: 'human' }] })}
                        >
                          Human
                        </button>
                        <button
                          type="button"
                          className={`btn chip ${seat.controller === 'cpu' ? 'on' : ''}`}
                          data-testid={`lobby-seat-${seat.index}-cpu`}
                          onClick={() => net.configure({ seats: [{ index: seat.index, controller: 'cpu' }] })}
                        >
                          CPU
                        </button>
                      </div>
                      {seat.controller === 'cpu' && (
                        <select
                          value={seat.difficulty}
                          aria-label={`Seat ${seat.index + 1} CPU difficulty`}
                          onChange={(e) =>
                            net.configure({
                              seats: [{ index: seat.index, difficulty: e.target.value as AiDifficulty }],
                            })
                          }
                        >
                          <option value="easy">Easy</option>
                          <option value="normal">Normal</option>
                          <option value="hard">Hard</option>
                        </select>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>

            {you?.seat === null && (
              <p className="muted small" data-testid="lobby-spectator">
                {status === 'lobby'
                  ? isHost
                    ? "You have no seat — turn one of the CPU seats human to sit down."
                    : "Every seat is taken or set to CPU, so you're watching for now. The host can " +
                      'switch a seat to Human and you will be sat down in it automatically.'
                  : "You're watching this game. You'll see the board, but no hands."}
              </p>
            )}

            {isHost && status === 'lobby' && (
              <div className="lobby-config">
                <div className="btn-row">
                  <button
                    type="button"
                    className={`btn chip ${room.seats.length === 2 ? 'on' : ''}`}
                    data-testid="lobby-count-2"
                    onClick={() => net.configure({ playerCount: 2 })}
                  >
                    2 players
                  </button>
                  <button
                    type="button"
                    className={`btn chip ${room.seats.length === 4 ? 'on' : ''}`}
                    data-testid="lobby-count-4"
                    onClick={() => net.configure({ playerCount: 4 })}
                  >
                    4 players
                  </button>
                </div>
                <label className="field">
                  <span>Extra-garden preset</span>
                  <select
                    value={room.gardenPreset}
                    onChange={(e) => net.configure({ gardenPreset: e.target.value as GardenPreset })}
                  >
                    {GARDEN_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted small">
                  The room picks the map and shuffles the deck itself — no seed to choose, and nobody
                  (host included) can see the cards. The deck is verified when the game ends.
                </p>
              </div>
            )}

            {isHost && status === 'lobby' ? (
              <>
                <button
                  type="button"
                  className="btn accent big"
                  data-testid="lobby-start"
                  disabled={emptyHumanSeats.length > 0}
                  onClick={net.start}
                >
                  {emptyHumanSeats.length > 0
                    ? `Waiting for seat ${emptyHumanSeats.join(', ')}…`
                    : '🎲 Start the game'}
                </button>
                {emptyHumanSeats.length > 0 && (
                  <p className="muted small" data-testid="lobby-empty-hint">
                    Every seat starts open for a person. Share the code and they'll be seated as they
                    arrive — or switch seat {emptyHumanSeats.join(', ')} to CPU to play without them.
                  </p>
                )}
              </>
            ) : (
              status === 'lobby' && (
                <p className="muted" data-testid="lobby-waiting">
                  Waiting for the host to start…
                </p>
              )
            )}
          </>
        )}

        <button type="button" className="btn ghost" data-testid="lobby-leave" onClick={onLeave}>
          ← Leave room
        </button>
      </div>

      <div className="toasts">
        {net.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
