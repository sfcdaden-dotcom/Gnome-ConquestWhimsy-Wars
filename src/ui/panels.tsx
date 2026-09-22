/**
 * Side panels: player status cards, game log, hand, and the fight views
 * (live respond panel + finished-fight step-through overlay).
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { CardId, FightSide, GameEvent, GameState, PlayerId, Pos } from '../engine';
import {
  getCardDef,
  getPlayerToAct,
  posKey,
  gnomeBoardCap,
  gnomesOnBoard,
  reserveGnomes,
  wishCap,
} from '../engine';
import type { FightPlayback, UnitPoof } from './useGame';
import {
  cardName,
  describeEvent,
  playHint,
  playerColor,
  pname,
  posStr,
  sideName,
} from './meta';
import { GardenIcon, Poof, UiIcon, UnitIcon } from './art';
import type { LogTurn } from './gameLog';
import { groupByTurn, isPinnedToBottom, logLines } from './gameLog';

// ---------------------------------------------------------------------------
// Player panels
// ---------------------------------------------------------------------------

/**
 * `takenOverSeats` are seats the room is playing because their player stopped
 * playing. They still read as human in `state` — the engine's config is fixed
 * at creation — so the panel takes the room's word for who is at the controls.
 */
export function PlayerPanels({ state, takenOverSeats = [] }: { state: GameState; takenOverSeats?: PlayerId[] }) {
  const actor = state.status === 'finished' ? null : getPlayerToAct(state);
  const active = state.turn?.activePlayer ?? null;
  return (
    <div className="player-panels">
      {state.players.map((p) => {
        const cap = wishCap(state, p.id);
        const classes = ['player-panel', `status-${p.status}`];
        if (p.id === active) classes.push('active-turn');
        if (p.id === actor) classes.push('to-act');
        return (
          <div
            key={p.id}
            className={classes.join(' ')}
            style={{ '--pc': playerColor(p.id) } as CSSProperties}
          >
            <div className="pp-head">
              <span className="pp-dot" />
              <span className="pp-name">{p.name}</span>
              <span
                className="pp-ctl"
                title={takenOverSeats.includes(p.id) ? 'Stopped playing — a CPU took the seat' : undefined}
              >
                {p.controller === 'cpu' || takenOverSeats.includes(p.id) ? '🤖' : '🧑'}
              </span>
              {p.id === actor && <span className="pp-act">acting</span>}
            </div>
            {p.status === 'playing' ? (
              <div className="pp-stats">
                <span title={`Wishes (cap ${cap})`} data-testid="pp-wishes">
                  <UiIcon kind="wish" label="Wishes" /> {p.wishes}/{cap}
                </span>
                <span title="Gnomes on board / limit">
                  <UnitIcon owner={p.id} className="inline-art" /> {gnomesOnBoard(state, p.id)}/{gnomeBoardCap(state, p.id)}
                </span>
                <span title="Reserve gnomes remaining">
                  <UiIcon kind="reinforcement" label="Reserve gnomes" /> {reserveGnomes(state, p.id)}
                </span>
                <span title="Cards in hand">
                  <UiIcon kind="card" label="Cards in hand" /> {p.hand.length}
                </span>
              </div>
            ) : (
              <div className="pp-stats">
                <span>
                  {p.status === 'snail' ? (
                    <>
                      <UnitIcon kind="snail" className="inline-art" /> Immortal Snail
                    </>
                  ) : (
                    '💀 Out of the game'
                  )}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game log
// ---------------------------------------------------------------------------

/**
 * The scrolling event list. It has no chrome of its own: the chat window owns
 * the panel, the tabs and the collapse, and renders this as its "Game log" tab.
 */
export function GameLogView({ state }: { state: GameState }) {
  const ref = useRef<HTMLDivElement>(null);
  // Whether the reader is watching the tail. Kept in a ref, not state: it is
  // read by the scroll effect and never rendered, and a scroll handler that
  // re-rendered the log on every wheel tick would be its own papercut.
  const pinned = useRef(true);
  /**
   * Turns the reader has explicitly opened or shut, by turn key. Everything
   * absent from this map follows the default — the current turn open, the rest
   * collapsed — which is what makes the log follow play on its own: when a new
   * turn starts it becomes the open one and the finished turn folds away,
   * without touching anything the reader chose for themselves.
   */
  const [overrides, setOverrides] = useState<ReadonlyMap<number, boolean>>(new Map());

  const turns = groupByTurn(logLines(state));
  const currentKey = turns.length > 0 ? turns[turns.length - 1].key : null;
  const isOpen = (t: LogTurn) => overrides.get(t.key) ?? t.key === currentKey;

  useEffect(() => {
    const el = ref.current;
    // Follow the tail only for someone already reading it — scroll back to
    // check what a fight did and the next event no longer snatches the view.
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state.eventCount]);

  return (
    <div
      className="game-log"
      ref={ref}
      aria-label="Game log"
      data-testid="game-log"
      onScroll={(e) => {
        pinned.current = isPinnedToBottom(e.currentTarget);
      }}
    >
      {turns.map((t) => {
        const open = isOpen(t);
        return (
          <div key={t.key} className="log-turn" data-open={open ? 'true' : 'false'}>
            <button
              type="button"
              className="log-turn-head"
              aria-expanded={open}
              data-testid={`log-turn-${t.turnNumber ?? 'earlier'}`}
              onClick={() =>
                setOverrides((m) => {
                  const next = new Map(m);
                  next.set(t.key, !open);
                  return next;
                })
              }
            >
              <span className="log-caret" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
              <span className="log-turn-title">{turnTitle(state, t)}</span>
              {!open && <span className="log-turn-count">{t.lines.length}</span>}
            </button>
            {open &&
              t.lines.map(({ key, ev }) => (
                <div key={key} className={`log-line log-${ev.type}`}>
                  {describeEvent(state, ev)}
                </div>
              ))}
          </div>
        );
      })}
      {turns.length === 0 && <div className="log-line muted">The garden awaits…</div>}
    </div>
  );
}

/** "Turn 3: Red", or a label for the lines that precede the window's first turn. */
function turnTitle(state: GameState, t: LogTurn): string {
  if (t.turnNumber === null) return t.matchStart ? 'Roll-off' : 'Earlier';
  return `Turn ${t.turnNumber}: ${t.player === null ? '' : pname(state, t.player)}`;
}

// ---------------------------------------------------------------------------
// Hand
// ---------------------------------------------------------------------------

export interface HandPanelProps {
  state: GameState;
  /** Whose hand is shown (a human seat), or null to hide all hands. */
  seat: PlayerId | null;
  /** Card ids playable right now via a normal playCard action. */
  playable: ReadonlySet<CardId>;
  onPlay: (cardId: CardId) => void;
  /**
   * Why the whole hand is inert (hand-off pending, a fight replaying, the game
   * over), or null when it is live. A sentence rather than a boolean: it is
   * shown on every card, and "no legal targets" would be a misleading thing to
   * say about a card whose owner is not even looking at the screen yet.
   */
  blocked: string | null;
}

export function HandPanel({ state, seat, playable, onPlay, blocked }: HandPanelProps) {
  if (seat === null) {
    return (
      <div className="hand-panel">
        <div className="panel-title">Hand</div>
        <div className="muted small">Hands are hidden (CPU seats).</div>
      </div>
    );
  }
  const p = state.players[seat];
  return (
    <div className="hand-panel">
      <div className="panel-title">
        {p.name}'s hand ({p.hand.length}/{state.config.handLimit})
        <span className="deck-info">
          deck {state.deck.length} · discard {state.discard.length}
        </span>
      </div>
      {p.hand.length === 0 ? (
        <div className="muted small">
          No cards. Draw one for 1 <UiIcon kind="wish" label="Wish" /> during your Action Phase.
        </div>
      ) : (
        <div className="hand-cards" data-testid="hand-cards">
          {p.hand.map((cardId, i) => {
            const def = getCardDef(cardId);
            // `playable` (the engine's own enumeration) decides the button;
            // the hint only explains it, and is asked for only when there is
            // something to explain, since the reason costs a target search.
            const live = blocked === null && playable.has(cardId);
            const hint = live ? null : playHint(state, seat, cardId, blocked);
            return (
              <div key={`${cardId}-${i}`} className={`card ${def?.timing ?? 'unknown'}`}>
                <div className="card-head">
                  <span className="card-name">{cardName(cardId)}</span>
                  <span className="card-timing">{def ? (def.timing === 'sudden' ? '⚡ Sudden' : '🕯️ Ritual') : '?'}</span>
                </div>
                <div className="card-text">{def?.text ?? 'Unknown card (engine card list in progress).'}</div>
                <button
                  type="button"
                  className="btn small"
                  disabled={!live}
                  data-testid={`play-card-${cardId}`}
                  onClick={() => onPlay(cardId)}
                >
                  Play
                </button>
                {hint && (
                  <span className="card-why" data-testid={`card-why-${cardId}`}>
                    {hint}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fight: the clash
//
// What a roll LOOKS like. The dice themselves were never the interesting part
// — two gnomes squaring up and throwing themselves at each other is, so the
// combatants stand on either side and lunge at the middle once per roll, with
// the number each of them rolled underneath. A reroll (a tie) is another
// lunge, which is exactly what a tie feels like.
//
// Restarting the lunge is the caller's job: pass a `seq` that changes on every
// roll, because CSS animations restart when the ELEMENT is replaced, not when
// its props change, and `key` is the only thing that replaces an element.
// ---------------------------------------------------------------------------

interface FightClashProps {
  state: GameState;
  /** [defender, attacker], as everywhere else. */
  sides: [FightSide, FightSide];
  /** Where the fight is. A poof counts as this fight's only if it happened here. */
  pos: Pos;
  /** The roll being shown, or null before the first one lands. */
  roll: { rolls: [number, number]; tie: boolean } | null;
  /** Changes per roll; restarts the lunge. */
  seq: number;
  /** Label each side defender/attacker — worth the room in the live panel. */
  showRoles?: boolean;
  /** Deaths currently on screen — a side whose player is in here puffs out. */
  poofs: readonly UnitPoof[];
}

export function FightClash({
  state,
  sides,
  pos,
  roll,
  seq,
  poofs,
  showRoles = false,
}: FightClashProps) {
  const here = posKey(pos);
  return (
    <div className="fight-clash" data-testid="fight-clash" key={seq}>
      {([0, 1] as const).map((idx) => {
        const side = sides[idx];
        const mine = side.kind === 'player' ? side.player : null;
        // Space AND seat: a gnome dying to a card across the board is that
        // player's death too, and it is not this fight's.
        const dying =
          mine !== null ? poofs.find((p) => p.player === mine && p.key === here) ?? null : null;
        const roll0 = roll?.rolls[idx] ?? null;
        const other = roll?.rolls[idx === 0 ? 1 : 0] ?? null;
        const won = roll !== null && !roll.tie && roll0 !== null && other !== null && roll0 > other;
        return (
          <span
            key={idx}
            className={`clash-side${idx === 0 ? ' left' : ' right'}${dying ? ' dying' : ''}`}
            style={
              { '--pc': side.kind === 'player' ? playerColor(side.player) : '#3c7a3c' } as CSSProperties
            }
            data-side={idx}
            data-won={won ? 'true' : 'false'}
          >
            <span className="clash-art">
              {side.kind === 'flytrap' ? (
                <GardenIcon type="flytrap" className="clash-face" />
              ) : (
                <UnitIcon owner={side.player} className="clash-face" />
              )}
              {dying && <Poof variant={dying.variant} color={playerColor(dying.player)} className="clash-poof" />}
            </span>
            <span className="clash-name">{sideName(state, side)}</span>
            {showRoles && <span className="side-role">{idx === 0 ? 'defender' : 'attacker'}</span>}
            {roll0 !== null && (
              <span className="clash-roll" data-testid={`clash-roll-${idx}`}>
                {roll0}
              </span>
            )}
          </span>
        );
      })}
      <span className="clash-vs">{roll?.tie ? 'tie!' : 'vs'}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fight: live respond panel
// ---------------------------------------------------------------------------

export interface FightPanelProps {
  state: GameState;
  /** True when the respond controls should be shown (human actor, revealed). */
  interactive: boolean;
  /** Deaths currently on screen, so a losing side can puff out mid-fight. */
  poofs: readonly UnitPoof[];
  onPass: () => void;
  onPlayCard: (cardId: CardId) => void;
}

export function FightPanel({ state, interactive, poofs, onPass, onPlayCard }: FightPanelProps) {
  const f = state.fight;
  if (!f) return null;
  const rolls = state.events.filter(
    (e): e is Extract<GameEvent, { type: 'fightRolled' }> =>
      e.type === 'fightRolled' && e.fightId === f.id,
  );
  const last = rolls[rolls.length - 1] ?? null;
  const d = state.pendingDecision;
  const respond = d?.kind === 'fightRespond' ? d : null;
  return (
    <div className="fight-panel" data-testid="fight-panel">
      <div className="panel-title">⚔️ Fight at {posStr(f.pos)} — round {f.round}</div>
      <FightClash
        state={state}
        sides={f.sides}
        pos={f.pos}
        roll={last}
        seq={rolls.length}
        poofs={poofs}
        showRoles
      />
      {rolls.length > 1 && (
        <div className="fight-rolls">
          {rolls.slice(-4).map((r, i) => (
            <span key={i} className="roll-pair">
              {r.rolls[0]} : {r.rolls[1]}
              {r.tie ? ' (tie)' : ''}
            </span>
          ))}
        </div>
      )}
      {respond && (
        <div className="fight-respond">
          <div className="small">
            <b>{pname(state, respond.player)}</b> may respond with Sudden Magic.
          </div>
          {interactive ? (
            <div className="btn-row">
              <button type="button" className="btn" data-testid="fight-respond-pass" onClick={onPass}>
                Pass
              </button>
              {respond.playableCards.map((cardId) => (
                <button
                  key={cardId}
                  type="button"
                  className="btn"
                  data-testid={`fight-respond-card-${cardId}`}
                  onClick={() => onPlayCard(cardId)}
                >
                  Play {cardName(cardId)}
                </button>
              ))}
            </div>
          ) : (
            <div className="muted small">Waiting…</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fight: finished-fight step-through
//
// It used to be a modal overlay — dimmed backdrop, blur, centred over
// everything — for what is a replay of dice that have already been rolled.
// Nothing about it needs an answer, so it no longer takes the screen: it is a
// card beside the board, and the board stays visible and readable underneath.
// ---------------------------------------------------------------------------

export interface FightPlaybackProps {
  state: GameState;
  playback: FightPlayback;
  /** Deaths currently on screen; a side that just lost puffs out here too. */
  poofs: readonly UnitPoof[];
  onSkip: () => void;
}

export function FightPlaybackCard({ state, playback, poofs, onSkip }: FightPlaybackProps) {
  const shownEvents = playback.events.slice(0, playback.shown);
  // Header describes the most recent fight in the shown window; the sides and
  // roll count come from the same pass, so the clash always shows the fight
  // being replayed rather than whatever the engine is doing now.
  let header = '⚔️ Fight!';
  let lastRoll: Extract<GameEvent, { type: 'fightRolled' }> | null = null;
  let sides: [FightSide, FightSide] | null = state.fight?.sides ?? null;
  let pos: Pos | null = state.fight?.pos ?? null;
  let rollCount = 0;
  for (const ev of shownEvents) {
    if (ev.type === 'fightStarted') {
      header = `⚔️ ${sideName(state, ev.sides[1])} attacks ${sideName(state, ev.sides[0])} at ${posStr(ev.pos)}`;
      sides = ev.sides;
      pos = ev.pos;
      lastRoll = null;
      rollCount = 0;
    }
    if (ev.type === 'fightRolled') {
      lastRoll = ev;
      rollCount += 1;
    }
  }
  return (
    /* Not a dialog: it interrupts nothing, so it announces itself politely and
       leaves focus where the player left it. */
    <div className="fight-playback" role="status" aria-label="Fight" data-testid="fight-playback">
      <div className="fight-header">{header}</div>
      {sides && pos && (
        <FightClash
          state={state}
          sides={sides}
          pos={pos}
          roll={lastRoll}
          seq={rollCount}
          poofs={poofs}
        />
      )}
      <div className="fight-steps">
        {shownEvents.map((ev, i) => (
          <div key={i} className={`log-line${i === shownEvents.length - 1 ? ' latest' : ''}`}>
            {describeEvent(state, ev)}
          </div>
        ))}
      </div>
      <button type="button" className="btn small" data-testid="skip-playback" onClick={onSkip}>
        Skip ⏭
      </button>
    </div>
  );
}
