/**
 * The game screen: board + panels + overlays, wired to the engine through
 * useGame. All legality flows from the engine — clicks are matched against
 * enumerated legal actions, and card targets are validated by each card's
 * own `validate` (the UI never recomputes rules).
 *
 * The routing rules themselves — what a board click means, what lights up, when
 * a selection dies — are pure functions in `interaction.ts`, tested without
 * React. This component assembles their input, dispatches what they return, and
 * otherwise deals only in layout.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Action, CardId, CardTarget, GameState, PendingDecision, PlayerId, Pos } from '../engine';
import { gardenAt, getLegalActionIntents, getPendingDecisionOptions, posKey, upgradeWishCost } from '../engine';
import { Board } from './Board';
import { DecisionPanel } from './DecisionPanel';
import { FightPanel, FightPlaybackCard, HandPanel, PlayerPanels } from './panels';
import { ChatPanel, QuickChatFeed } from './QuickChat';
import { GARDEN_META, cardName, cardText, curseIcon, playerColor, pname } from './meta';
import { GardenIcon, UiIcon, UnitIcon } from './art';
import { unitNameLive } from './gnomeNames';
import { actionableUnitsAt, unitChipLabels } from './selection';
import type { InteractionContext, Sel } from './interaction';
import {
  NO_SEL,
  bannerText,
  computeHighlights,
  resolveCellClick,
  selectionStillValid,
  plantOptions,
  targetChipKey,
  unitAffordances,
} from './interaction';
import type { ActionMenuItem } from './ActionMenu';
import { ActionMenu } from './ActionMenu';
import type { GameSession } from './useGame';
import { PanZoom } from './PanZoom';
import type { Insets } from './panZoom';
import { boardPixelSize } from './boardGeometry';
import { useMediaQuery, useSize } from './useMeasure';

/**
 * The stage may enlarge the board to fill the play area, up to this much — a
 * 7×7 at 64px cells would otherwise sit small in the middle of a wide monitor.
 * 1.25 lands the default board at roughly the ~580px it was capped at before
 * it moved onto the stage.
 */
const BOARD_MAX_FIT = 1.25;

/** Gap between the columns and the play area, from `.main`'s padding/gap. */
const MAIN_GAP_PX = 12;

/** Below this the layout stacks and nothing floats over the board. */
const DESKTOP_LAYOUT = '(min-width: 1081px)';

// ---------------------------------------------------------------------------
// GameScreen
// ---------------------------------------------------------------------------

export interface GameScreenProps {
  /** The running session — local (useGame) or a room over the network
   *  (useNetGame). The screen renders either without knowing which. */
  game: GameSession;
  /** Absent ⇒ no "play again" button (an online room decides that itself). */
  onPlayAgain?: () => void;
  onQuit: () => void;
}

export function GameScreen({ game: g, onPlayAgain, onQuit }: GameScreenProps) {
  const { state, dispatch, playerToAct, needsPass, playback } = g;
  const [sel, setSel] = useState<Sel>(NO_SEL);
  // Which action-bar submenu is expanded ("plant"), or null for the top list.
  const [submenu, setSubmenu] = useState<string | null>(null);
  // After the game ends, "Review match" dismisses the end overlay so the board
  // and full game log stay on screen; "Results" brings the overlay back.
  const [reviewing, setReviewing] = useState(false);
  // "New game" abandons a game in progress, so it asks first: armed here,
  // confirmed by the second click.
  const [quitArmed, setQuitArmed] = useState(false);

  // What the board has to fit between. The columns and the action-bar slot are
  // measured rather than assumed: the right column is a `clamp` of the viewport
  // width, and the left one grows with the number of seats and curses.
  const leftCol = useRef<HTMLElement>(null);
  const rightCol = useRef<HTMLElement>(null);
  const boardFooter = useRef<HTMLDivElement>(null);
  const floating = useMediaQuery(DESKTOP_LAYOUT);
  const leftWidth = useSize(leftCol).width;
  const rightWidth = useSize(rightCol).width;
  const footerHeight = useSize(boardFooter).height;
  const boardPx = boardPixelSize(state.config.boardSize);
  const boardInsets: Insets = floating
    ? {
        left: leftWidth + MAIN_GAP_PX,
        right: rightWidth + MAIN_GAP_PX,
        top: 0,
        bottom: footerHeight + MAIN_GAP_PX,
      }
    : { left: 0, right: 0, top: 0, bottom: 0 };

  // Card plays are enumerated WITHOUT targets — dispatching a targeted play
  // opens a `cardTargeting` decision, and the engine then hands back one step's
  // options at a time, so no combinatorial expansion is ever paid in the UI.
  const legal = useMemo(() => getLegalActionIntents(state), [state]);

  /**
   * Keep a unit selection across state updates when it is still valid, drop it
   * when it is not. Blanket-clearing on every state change used to interrupt
   * tunnel chains whenever an unrelated update landed (a CPU seat acting, a
   * fight step, a toast-triggering re-render).
   */
  useEffect(() => {
    setSel((cur) => (selectionStillValid(state, legal, cur) ? cur : NO_SEL));
  }, [state, legal]);

  /**
   * Options for the current step of an in-progress card targeting (empty
   * otherwise). Recomputed from live state by the engine — the UI holds no
   * targeting state of its own.
   */
  const targetingOptions = useMemo(
    () => (state.pendingDecision?.kind === 'cardTargeting' ? getPendingDecisionOptions(state) : []),
    [state],
  );

  /**
   * True when the on-screen human may interact with board/panels. Gated on
   * `humanSeats` — the seats THIS DEVICE controls — not on "the actor is not a
   * CPU": online, a remote human's turn is exactly as untouchable as a CPU's.
   */
  const interactive =
    state.status !== 'finished' &&
    playerToAct !== null &&
    g.humanSeats.includes(playerToAct) &&
    !needsPass &&
    !playback;

  /** Whose hand is on screen: the revealed human seat. */
  const handSeat =
    g.revealedSeat !== null && state.players[g.revealedSeat]?.controller === 'human'
      ? g.revealedSeat
      : null;

  const handPlayable = useMemo(() => {
    const set = new Set<CardId>();
    if (handSeat === null || needsPass || playback) return set;
    for (const a of getLegalActionIntents(state, handSeat)) {
      if (a.type === 'playCard') set.add(a.cardId);
    }
    return set;
  }, [state, handSeat, needsPass, playback]);

  const decision = state.pendingDecision;

  /**
   * Why the whole hand is inert, or null when it is live. The hand panel shows
   * this on each card, so it says what is in the way rather than leaving five
   * greyed-out buttons to be interpreted.
   */
  const handBlocked =
    state.status === 'finished'
      ? 'The game is over.'
      : needsPass
        ? 'Pass the device first — the hand is hidden until then.'
        : playback
          ? 'Wait for the fight to finish.'
          : null;

  /** Everything the pure routing rules in `interaction.ts` read. */
  const ctx: InteractionContext = {
    state,
    legal,
    decision,
    targetingOptions,
    playerToAct,
    interactive,
    sel,
  };

  // --- dispatch helpers ------------------------------------------------------

  function act(action: Action) {
    const ok = dispatch(action);
    // A rejected action drops the unit selection outright. Otherwise it is left
    // to the validity check above — so a gnome you just moved stays selected
    // and can still plant on its new space.
    if (!ok) setSel(NO_SEL);
  }

  /**
   * Begin playing a card. Dispatching WITHOUT targets lets the engine decide:
   * an untargeted card resolves at once; a targeted one opens a `cardTargeting`
   * decision (or reports "no legal targets" via a toast). The UI never builds
   * target payloads itself — it answers the engine's steps one at a time.
   */
  function startCardPlay(cardId: CardId, respond: boolean, player: PlayerId) {
    // Clear any unit selection so a card play does not visually collide with it.
    setSel(NO_SEL);
    act(
      respond
        ? { type: 'respondPlayCard', player, cardId }
        : { type: 'playCard', player, cardId },
    );
  }

  /**
   * Escape backs out one level, most recent first: a fight replay still
   * stepping, an armed "New game", an in-progress card targeting (the card
   * never left the hand, so cancelling is always safe), an open plant submenu,
   * then a selected gnome. Every one of those was previously escapable only by
   * finding its own button.
   *
   * It listens on the document rather than a container because clicking the
   * board leaves focus on <body>, and Escape is precisely the key people press
   * without looking at where focus went. Anything nested that owns Escape —
   * the action menu while focused, the quick-chat picker while open — consumes
   * the event before it reaches here.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (playback) {
        g.skipPlayback();
      } else if (quitArmed) {
        setQuitArmed(false);
      } else if (interactive && decision?.kind === 'cardTargeting' && decision.player === playerToAct) {
        if (!dispatch({ type: 'cancelTargeting', player: decision.player })) setSel(NO_SEL);
      } else if (submenu !== null) {
        setSubmenu(null);
      } else if (sel.kind === 'unit') {
        setSel(NO_SEL);
      } else {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [playback, g, quitArmed, interactive, decision, playerToAct, submenu, sel.kind, dispatch]);

  // --- board click routing -----------------------------------------------------

  /** Thin adapter: the rules decide, this dispatches or moves the selection. */
  function onCellClick(pos: Pos) {
    const result = resolveCellClick(ctx, pos);
    if (result.kind === 'act') act(result.action);
    else if (result.kind === 'select') {
      setSel(result.unitId ? { kind: 'unit', unitId: result.unitId } : NO_SEL);
    }
  }

  // --- highlights ---------------------------------------------------------------

  const highlights = useMemo(
    () => computeHighlights({ state, legal, decision, targetingOptions, playerToAct, interactive, sel }),
    [state, sel, decision, legal, interactive, targetingOptions, playerToAct],
  );

  const selectedUnit = sel.kind === 'unit' ? (state.units[sel.unitId] ?? null) : null;
  const selectedKey = selectedUnit ? posKey(selectedUnit.pos) : null;

  /**
   * Everything the acting player could select on the selected unit's space.
   * More than one ⇒ the action bar offers a chip per gnome, so a stack can be
   * picked apart by name instead of by blind repeated clicking.
   */
  const stackChoices = useMemo(
    () =>
      selectedUnit && playerToAct !== null
        ? actionableUnitsAt(state, playerToAct, selectedUnit.pos, legal)
        : [],
    [state, selectedUnit, playerToAct, legal],
  );
  const stackChips = useMemo(
    () => (stackChoices.length > 1 ? unitChipLabels(state, stackChoices) : []),
    [state, stackChoices],
  );

  // --- action bar (active human, action phase) ------------------------------------

  const showActionBar =
    interactive && !decision && state.turn?.phase === 'action' && state.turn.activePlayer === playerToAct;
  const canDraw = legal.some((a) => a.type === 'drawCard');
  const { plants: plantActions, upgrade: upgradeAction } = unitAffordances(
    legal,
    selectedUnit?.pos ?? null,
  );
  const upgradeGardenType = upgradeAction ? gardenAt(state, upgradeAction.pos)?.type : undefined;

  /**
   * The action list, with planting folded into one submenu. Every garden the
   * seat owns tiles for is listed with its remaining count; a row is clickable
   * only when the engine enumerated a `plant` action for it, so supply, wish
   * cost and space legality all stay the engine's call.
   */
  const plantChoices = plantOptions(state, playerToAct, plantActions);
  const menuItems: ActionMenuItem[] = [];
  menuItems.push({
    key: 'draw',
    label: (
      <>
        <UiIcon kind="card" /> Draw card (1 <UiIcon kind="wish" label="Wish" />)
      </>
    ),
    testId: 'draw-card',
    disabled: !canDraw,
    onSelect: () => act({ type: 'drawCard', player: playerToAct! }),
  });
  if (plantActions.length > 0) {
    menuItems.push({
      key: 'plant',
      label: (
        <>
          <UiIcon kind="plant" /> Plant Garden
        </>
      ),
      testId: 'open-plant-menu',
      heading: 'Plant a Garden',
      items: plantChoices.map((o) => ({
        key: o.gardenType,
        label: (
          <>
            <GardenIcon type={o.gardenType} className="btn-icon" /> {GARDEN_META[o.gardenType].label}
          </>
        ),
        badge: `×${o.remaining}`,
        testId: `plant-${o.gardenType}`,
        title: GARDEN_META[o.gardenType].blurb,
        disabled: !o.action,
        onSelect: () => {
          if (o.action) act(o.action);
          setSubmenu(null);
        },
      })),
    });
  }
  if (upgradeAction && upgradeGardenType && upgradeGardenType !== 'home') {
    menuItems.push({
      key: 'upgrade',
      // The price is per-space: a Center Star set to 'freeUpgrade' makes the
      // garden on the center space free, so the label reads the real cost.
      label: (
        <>
          ⭐ Upgrade to {GARDEN_META[upgradeGardenType].upgradeLabel} ({upgradeWishCost(state, upgradeAction.pos)}{' '}
          <UiIcon kind="wish" label="Wishes" />)
        </>
      ),
      testId: 'upgrade-garden',
      title: GARDEN_META[upgradeGardenType].upgradeBlurb,
      onSelect: () => act(upgradeAction),
    });
  }
  if (sel.kind === 'unit') {
    menuItems.push({
      key: 'deselect',
      label: 'Deselect',
      testId: 'deselect',
      className: 'small',
      onSelect: () => setSel(NO_SEL),
    });
  }
  menuItems.push({
    key: 'end-turn',
    label: 'End turn ⏹',
    testId: 'end-turn',
    onSelect: () => act({ type: 'endTurn', player: playerToAct! }),
  });

  // A submenu whose trigger is gone (the gnome moved off, the tiles ran out,
  // the turn ended) collapses back to the action list rather than lingering.
  const openSubmenu = menuItems.some((i) => i.key === submenu) ? submenu : null;

  return (
    /* The data-* attributes mirror already-visible game state (status, phase,
       whose decision is open). They exist so browser tests can wait on a
       condition without scraping prose from the banner. */
    <div
      className="game-screen"
      data-testid="game-screen"
      data-status={state.status}
      data-phase={state.turn?.phase ?? ''}
      data-turn={state.turn?.number ?? ''}
      data-active-player={state.turn?.activePlayer ?? ''}
      data-player-to-act={playerToAct ?? ''}
      data-decision={decision?.kind ?? ''}
      data-interactive={interactive ? 'true' : 'false'}
      data-selected-unit={selectedUnit?.id ?? ''}
    >
      <header className="topbar">
        <span className="brand">
          <UnitIcon className="brand-art" /> Whimsy Wars
        </span>
        <span className="banner" data-testid="banner">
          {bannerText(state, playerToAct, pname)}
        </span>
        {/* Utilities, grouped on the right: nothing here is game state. */}
        {g.shotClock && (
          <ShotClockPill
            clock={g.shotClock}
            who={pname(state, g.shotClock.seat)}
            yours={g.humanSeats.includes(g.shotClock.seat)}
          />
        )}
        {g.canFastForward && (
          <label className="ff-toggle" title="Skip CPU pacing and fight animations">
            <input
              type="checkbox"
              checked={g.fastForward}
              onChange={(e) => g.setFastForward(e.target.checked)}
            />
            ⏩ Fast CPU
          </label>
        )}
        {g.tag !== null && (
          <span className="seed-tag" title="Room code">
            {g.tag}
          </span>
        )}
        {state.status === 'finished' && reviewing && (
          <button
            type="button"
            className="btn small primary"
            data-testid="show-results"
            onClick={() => setReviewing(false)}
          >
            🏁 Results
          </button>
        )}
        {/* One click used to throw a game in progress away. Now it arms, and
            the second click confirms — a finished game still goes in one. */}
        {quitArmed ? (
          <span className="quit-confirm">
            <button
              type="button"
              className="btn small danger"
              data-testid="quit-confirm"
              onClick={onQuit}
            >
              Abandon game
            </button>
            <button
              type="button"
              className="btn small ghost"
              data-testid="quit-cancel"
              onClick={() => setQuitArmed(false)}
            >
              Keep playing
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn small"
            data-testid="new-game"
            onClick={() => (state.status === 'finished' ? onQuit() : setQuitArmed(true))}
          >
            New game
          </button>
        )}
      </header>

      <div className="main">
        {/* The board is the backdrop on a desktop layout: it pans and zooms on
            its own stage across the whole play area, while the columns float
            over it. The stage fits it into the space they leave, so nothing is
            hidden until you choose to drag it under a panel. Stacked (≤1080px)
            the stage is an ordinary row and the insets go to zero — there is
            nothing over the board to avoid down there. */}
        <PanZoom
          className="board-stage"
          label="Board viewport"
          contentWidth={boardPx}
          contentHeight={boardPx}
          insets={boardInsets}
          maxFitScale={BOARD_MAX_FIT}
        >
          <Board
            state={state}
            highlights={highlights}
            selectedKey={selectedKey}
            poofs={g.poofs}
            sizePx={boardPx}
            onCellClick={onCellClick}
          />
        </PanZoom>

        {/* Stacked, chat bubbles hang in the board's top corner: the rows
            under the board are all controls, and bubbles over them hid the
            action bar. */}
        {!floating && <QuickChatFeed state={state} bubbles={g.chatBubbles} />}

        <aside className="left-col" ref={leftCol}>
          <h2 className="rail-heading">Players</h2>
          <PlayerPanels state={state} takenOverSeats={g.takenOverSeats} />
          {state.activeCurses.length > 0 && <CursePanel state={state} />}
        </aside>

        <section className="board-wrap">
          {/* The dice replay, beside the board rather than over it. Hidden once
              the game ends, where the end overlay is the thing to read. */}
          {playback && state.status !== 'finished' && (
            <FightPlaybackCard
              state={state}
              playback={playback}
              poofs={g.poofs}
              onSkip={g.skipPlayback}
            />
          )}
          {/* Stable-height slot: the bar appearing/disappearing must not
              reflow the board. Targeting replaces the action bar. */}
          <div className="board-footer" ref={boardFooter}>
            {interactive && decision?.kind === 'cardTargeting' && decision.player === playerToAct ? (
              <TargetingBanner
                state={state}
                decision={decision}
                options={targetingOptions}
                onSelect={(target) => act({ type: 'selectTarget', player: decision.player, target })}
                onCancel={() => act({ type: 'cancelTargeting', player: decision.player })}
              />
            ) : showActionBar ? (
              <div className="action-bar" data-testid="action-bar">
                {selectedUnit && !openSubmenu && (
                  <span className="selected-unit" data-testid="selected-unit-name">
                    <UnitIcon kind={selectedUnit.kind} owner={selectedUnit.owner} className="inline-art" />{' '}
                    {unitNameLive(state, selectedUnit.id)}
                  </span>
                )}
                {stackChips.length > 0 && !openSubmenu && (
                  <span className="stack-chips" data-testid="stack-chips">
                    {stackChips.map((c) => (
                      <button
                        key={c.unitId}
                        type="button"
                        className={`btn small chip${c.unitId === selectedUnit?.id ? ' on' : ''}`}
                        aria-pressed={c.unitId === selectedUnit?.id}
                        title={c.full}
                        data-testid={`select-unit-${c.unitId}`}
                        onClick={() => setSel({ kind: 'unit', unitId: c.unitId })}
                      >
                        {c.short}
                      </button>
                    ))}
                  </span>
                )}
                <ActionMenu items={menuItems} openKey={openSubmenu} onOpenKeyChange={setSubmenu} />
              </div>
            ) : null}
          </div>
        </section>

        <aside className="right-col" ref={rightCol}>
          {/* fightRespond → FightPanel; cardTargeting → the board-footer
              TargetingBanner. Everything else gets the DecisionPanel. */}
          {/* Another seat picking card targets has no banner here, so it gets
              the plain "…is deciding" panel rather than nothing at all. */}
          {decision &&
            decision.kind === 'cardTargeting' &&
            !(interactive && decision.player === playerToAct) && (
              <DecisionPanel
                state={state}
                decision={decision}
                legal={legal}
                interactive={false}
                act={act}
                onRespondCard={(cardId, player) => startCardPlay(cardId, true, player)}
              />
            )}
          {decision && decision.kind !== 'fightRespond' && decision.kind !== 'cardTargeting' && (
            <DecisionPanel
              state={state}
              decision={decision}
              legal={legal}
              interactive={interactive && decision.player === playerToAct}
              act={act}
              onRespondCard={(cardId, player) => startCardPlay(cardId, true, player)}
            />
          )}
          {state.fight && (
            <FightPanel
              state={state}
              interactive={interactive && decision?.kind === 'fightRespond'}
              poofs={g.poofs}
              onPass={() =>
                decision?.kind === 'fightRespond' && act({ type: 'respondPass', player: decision.player })
              }
              onPlayCard={(cardId) =>
                decision?.kind === 'fightRespond' && startCardPlay(cardId, true, decision.player)
              }
            />
          )}
          <HandPanel
            state={state}
            seat={handSeat}
            playable={handPlayable}
            onPlay={(cardId) => handSeat !== null && startCardPlay(cardId, false, handSeat)}
            blocked={handBlocked}
          />
          {/* Chat + game log share one window (tabs), and it is last in the
              column so the phrase picker opens upward over the transcript.
              Chat outlives the game itself: "gg" is the one action a finished
              game still accepts. */}
          {/* On a desktop layout the bubbles pop up right above the chat
              window, in the column's own flow, so they never land on the
              board, the replay card or a panel. */}
          {floating && <QuickChatFeed state={state} bubbles={g.chatBubbles} />}
          <ChatPanel
            state={state}
            seat={handSeat}
            disabled={needsPass}
            muted={g.chatMuted}
            onToggleMute={g.toggleChatMuted}
            onSay={(player, phraseId, target) => act({ type: 'quickChat', player, phraseId, ...(target ? { target } : {}) })}
          />
        </aside>
      </div>

      {/* Overlays (priority: end > pass interstitial). The fight replay is no
          longer among them — it sits beside the board and covers nothing — but
          it still holds the pass interstitial back, so a hand-off cannot hide
          the fight that just decided the turn. */}
      {state.status === 'finished' && !reviewing ? (
        <EndOverlay
          state={state}
          seed={g.seed}
          onPlayAgain={onPlayAgain}
          onQuit={onQuit}
          onReview={() => setReviewing(true)}
        />
      ) : needsPass && !playback && playerToAct !== null ? (
        <PassOverlay state={state} seat={playerToAct} onConfirm={g.confirmPass} />
      ) : null}

      {/* Click one away rather than waiting out its timer — a rejected action
          leaves a red bar over the board, and "I have read it" is a click. */}
      <div className="toasts">
        {g.toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`toast ${t.kind}`}
            title="Dismiss"
            data-testid={`toast-${t.id}`}
            onClick={() => g.dismissToast(t.id)}
          >
            {t.text}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** How often the countdown redraws. Fast enough that it never looks stuck. */
const CLOCK_TICK_MS = 250;
/** Below this the pill goes loud — the point at which it is worth panicking. */
const CLOCK_URGENT_MS = 15_000;

/**
 * The shot clock, counting down for whoever is on it (online games only —
 * locally `shotClock` is null and this never renders).
 *
 * The deadline arrived already corrected for clock skew, so this only has to
 * subtract. It ticks on its own interval rather than on state updates because
 * between two actions there are no state updates, which is precisely when the
 * clock matters most.
 */
function ShotClockPill({
  clock,
  who,
  yours,
}: {
  clock: NonNullable<GameSession['shotClock']>;
  who: string;
  yours: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(t);
  }, [clock.deadlineAt]);

  const left = Math.max(0, clock.deadlineAt - now);
  const seconds = Math.ceil(left / 1000);
  return (
    <span
      className="shot-clock"
      data-testid="shot-clock"
      data-urgent={left <= CLOCK_URGENT_MS ? 'true' : 'false'}
      data-yours={yours ? 'true' : 'false'}
      title={yours ? 'Your time to act' : `${who} is on the clock`}
    >
      ⏱ {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      <span className="shot-clock-who">{yours ? 'you' : who}</span>
    </span>
  );
}

/**
 * Active curses as a strip of symbols, each with a hover/focus/tap tooltip
 * carrying its name and rules text — a full panel of names took far more room
 * than a rule everyone already knows needs.
 * The text comes straight from the curse definition, so the panel never
 * restates rules the engine owns.
 *
 * The tooltip is position: fixed and placed from the row's rect because the
 * left column scrolls (`overflow-y: auto`), which would clip an absolutely
 * positioned bubble hanging off the last panel.
 *
 * Exported for the dev-only UI laboratory (`ui/preview/`), which shows it —
 * and its tooltip — off a fixture rather than a live game. Nothing else
 * outside this file uses it.
 */
export function CursePanel({ state }: { state: GameState }) {
  const [openId, setOpenId] = useState<CardId | null>(null);
  const [pos, setPos] = useState<TipPos | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Flip above the row when there isn't room for the bubble underneath.
    const above = r.bottom + CURSE_TIP_MAX_HEIGHT > window.innerHeight;
    setPos({ x: r.left, y: above ? r.top - 6 : r.bottom + 6, above });
  }, []);

  const show = (id: CardId, el: HTMLElement) => {
    anchor.current = el;
    setOpenId(id);
    place();
  };
  const hide = (id: CardId) => setOpenId((cur) => (cur === id ? null : cur));
  // Tapping toggles, so touch devices (no hover) can read a curse too.
  const toggle = (id: CardId, el: HTMLElement) => (openId === id ? setOpenId(null) : show(id, el));

  // Fixed coordinates go stale as soon as anything moves under the bubble —
  // including the left column auto-scrolling a just-focused row into view.
  useEffect(() => {
    if (openId === null) return;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [openId, place]);

  // The bubble starts at its symbol's left edge, which for a symbol near the
  // right of a phone screen runs it off the edge. Once it has a size, slide it
  // back inside the viewport. Written straight to the element: it is a nudge
  // to the position just rendered, not new state to render again.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !pos) return;
    const w = el.getBoundingClientRect().width;
    const maxLeft = window.innerWidth - w - TIP_EDGE_GAP;
    el.style.left = `${Math.max(TIP_EDGE_GAP, Math.min(pos.x, maxLeft))}px`;
  }, [openId, pos]);

  return (
    <div className="curse-panel" role="group" aria-label="Active curses" data-testid="curse-panel">
      <span className="curse-label" aria-hidden="true" title="Active curses">
        ☠️
      </span>
      {state.activeCurses.map((id) => (
        <span
          key={id}
          className="curse-item"
          tabIndex={0}
          role="img"
          aria-label={cardName(id)}
          data-testid={`curse-${id}`}
          aria-describedby={openId === id ? `curse-tip-${id}` : undefined}
          // Pointer events, not mouse ones: a tap also emits compatibility
          // mouseenter/mouseleave, and the trailing mouseleave would close the
          // bubble the tap just opened.
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') show(id, e.currentTarget);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') hide(id);
          }}
          onFocus={(e) => show(id, e.currentTarget)}
          onBlur={() => hide(id)}
          onPointerDown={(e) => {
            if (e.pointerType !== 'mouse') toggle(id, e.currentTarget);
          }}
        >
          {curseIcon(id)}
        </span>
      ))}
      {openId !== null && pos && (
        <div
          ref={tip}
          className="curse-tip"
          role="tooltip"
          id={`curse-tip-${openId}`}
          style={{
            left: pos.x,
            ...(pos.above ? { bottom: window.innerHeight - pos.y } : { top: pos.y }),
          }}
        >
          <b>
            {curseIcon(openId)} {cardName(openId)}
          </b>
          <span>{cardText(openId) || 'Unknown curse.'}</span>
        </div>
      )}
    </div>
  );
}

interface TipPos {
  x: number;
  y: number;
  /** True when the bubble hangs above its row instead of below it. */
  above: boolean;
}

/** The least gap kept between a curse tooltip and the edge of the screen. */
const TIP_EDGE_GAP = 8;

/** Room to reserve below a curse row before the tooltip flips above it. */
const CURSE_TIP_MAX_HEIGHT = 110;

/**
 * Card-agnostic targeting banner. It renders whatever the engine's current
 * `cardTargeting` step asks for: unit / space steps are clicked on the board
 * (options are highlighted there), while player / card / gardenType steps show
 * chips. The prompt and the options both come from the engine — this component
 * has no per-card knowledge.
 */
function TargetingBanner({
  state,
  decision,
  options,
  onSelect,
  onCancel,
}: {
  state: GameState;
  decision: Extract<PendingDecision, { kind: 'cardTargeting' }>;
  options: readonly CardTarget[];
  onSelect: (target: CardTarget) => void;
  onCancel: () => void;
}) {
  const boardStep = decision.targetKind === 'unit' || decision.targetKind === 'space';
  return (
    <div className="targeting-banner" data-testid="targeting-banner">
      <span>
        🎯 <b>{cardName(decision.cardId)}</b>
        {decision.stepCount > 1 && <> ({decision.stepIndex + 1}/{decision.stepCount})</>}: {decision.prompt}
        {boardStep && <> — click a highlighted space</>}
      </span>
      {options.map((o) => (
        <TargetChip key={targetChipKey(o)} state={state} target={o} onSelect={onSelect} />
      ))}
      <button type="button" className="btn small ghost" data-testid="targeting-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** A clickable chip for a non-board target (player / discard card / garden type). */
function TargetChip({
  state,
  target,
  onSelect,
}: {
  state: GameState;
  target: CardTarget;
  onSelect: (target: CardTarget) => void;
}) {
  // Unit / space options are picked on the board, not as chips.
  if (target.kind === 'unit' || target.kind === 'space') return null;
  if (target.kind === 'player') {
    return (
      <button
        type="button"
        className="btn small"
        style={{ borderColor: playerColor(target.playerId) }}
        onClick={() => onSelect(target)}
      >
        {pname(state, target.playerId)}
      </button>
    );
  }
  if (target.kind === 'card') {
    return (
      <button type="button" className="btn small" onClick={() => onSelect(target)}>
        {cardName(target.cardId)}
      </button>
    );
  }
  return (
    <button type="button" className="btn small" onClick={() => onSelect(target)}>
      <GardenIcon type={target.gardenType} className="btn-icon" /> {GARDEN_META[target.gardenType].label}
    </button>
  );
}

function PassOverlay({
  state,
  seat,
  onConfirm,
}: {
  state: GameState;
  seat: PlayerId;
  onConfirm: () => void;
}) {
  return (
    <div className="overlay opaque" role="dialog" aria-label="Pass the device" data-testid="pass-overlay">
      <div className="overlay-card pass-card">
        <div className="pass-emoji">🤝</div>
        <h2>
          Pass the device to <span style={{ color: playerColor(seat) }}>{pname(state, seat)}</span>
        </h2>
        <p className="muted">Hands stay hidden until they take over.</p>
        <button type="button" className="btn primary big" data-testid="pass-confirm" onClick={onConfirm}>
          I'm {pname(state, seat)} — continue
        </button>
      </div>
    </div>
  );
}

function EndOverlay({
  state,
  seed,
  onPlayAgain,
  onQuit,
  onReview,
}: {
  state: GameState;
  seed: number | null;
  onPlayAgain?: () => void;
  onQuit: () => void;
  onReview: () => void;
}) {
  const w = state.winner;
  return (
    <div className="overlay" role="dialog" aria-label="Game over" data-testid="end-overlay">
      <div className="overlay-card end-card">
        <div className="pass-emoji">{w !== null ? '🏆' : '🍂'}</div>
        <h2>
          {w !== null ? (
            <>
              <span style={{ color: playerColor(w) }}>{pname(state, w)}</span> wins Whimsy Wars!
            </>
          ) : (
            'Nobody wins — the garden falls silent.'
          )}
        </h2>
        <div className="btn-row center">
          {onPlayAgain && (
            <button type="button" className="btn primary big" onClick={onPlayAgain}>
              🔁 Play again (new seed)
            </button>
          )}
          <button type="button" className="btn big" onClick={onQuit}>
            {onPlayAgain ? 'Change setup' : 'Leave room'}
          </button>
        </div>
        <button type="button" className="btn ghost" data-testid="review-match" onClick={onReview}>
          🔍 Review the match — board &amp; full log
        </button>
        {/* The one place the seed shows: enough to deal this board again
            from Advanced settings, without a number sitting in the header. */}
        {seed !== null && (
          <p className="end-seed" data-testid="end-seed">
            Game #{seed}
          </p>
        )}
      </div>
    </div>
  );
}
