/**
 * Board interaction routing — pure, testable, and deliberately outside React.
 *
 * `GameScreen` used to answer three questions inline, inside a component that
 * also owned layout, overlays and twelve pieces of JSX: what does a click on
 * this cell MEAN, which cells should be highlighted, and is the current unit
 * selection still valid. All three are pure functions of (state, legal actions,
 * open decision, selection) — none of them needs a component, and testing them
 * through one meant rendering the whole screen.
 *
 * They live here instead, next to `selection.ts` (which owns the narrower
 * "which units on this space can be picked" rule) and following the same
 * contract: **legality is never recomputed**. Every answer is matched against
 * the caller's enumerated legal actions and the engine's own decision options,
 * so this module encodes UI *routing*, not rules. If a click has no
 * corresponding legal action, the answer is "nothing happens".
 *
 * `resolveCellClick` returns an INTENT rather than performing it — `{kind:
 * 'act'}` to dispatch, `{kind: 'select'}` to change local selection, `{kind:
 * 'none'}` to ignore — so the component stays a thin adapter (dispatch + set
 * state) and the routing order (targeting → decisions → move → select) is
 * pinned by tests instead of by reading the JSX.
 */

import type {
  Action,
  CardTarget,
  GameState,
  PendingDecision,
  PlantableGardenType,
  PlayerId,
  Pos,
  UnitId,
} from '../engine';
import { posKey, samePos } from '../engine';
import type { HighlightKind } from './Board';
import { actionableUnitsAt, nextInCycle } from './selection';

// ---------------------------------------------------------------------------
// Selection
//
// Card targeting is NOT tracked here: it lives entirely in the engine as a
// `cardTargeting` pending decision, and the UI renders the current step's
// options from `getPendingDecisionOptions`. The only local selection is which
// of the acting player's own units is highlighted for moving / planting.
// ---------------------------------------------------------------------------

export type Sel = { kind: 'none' } | { kind: 'unit'; unitId: UnitId };

export const NO_SEL: Sel = { kind: 'none' };

/**
 * Is the selected unit still actionable? It must still exist and still have a
 * legal move or a legal plant/upgrade on its space (the same test the board
 * click uses), so a stale selection can never survive a state update.
 */
export function selectionStillValid(state: GameState, legal: readonly Action[], sel: Sel): boolean {
  if (sel.kind === 'none') return true;
  const u = state.units[sel.unitId];
  if (!u) return false;
  return legal.some(
    (a) =>
      (a.type === 'move' && a.unitId === u.id) ||
      ((a.type === 'plant' || a.type === 'upgrade') && samePos(a.pos, u.pos)),
  );
}

/**
 * The card-agnostic board option at `pos`, if any: a space option matching the
 * cell, or a unit option whose unit stands on it. The engine's options carry
 * the card's rules; the UI just matches by kind, never by card id.
 */
export function boardOptionAt(
  options: readonly CardTarget[],
  state: GameState,
  pos: Pos,
): CardTarget | null {
  for (const o of options) {
    if (o.kind === 'space' && samePos(o.pos, pos)) return o;
    if (o.kind === 'unit') {
      const u = state.units[o.unitId];
      if (u && samePos(u.pos, pos)) return o;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Click routing
// ---------------------------------------------------------------------------

/** Everything the routing rules read. Assembled by the component per render. */
export interface InteractionContext {
  state: GameState;
  /** Legal action INTENTS for the player to act (card plays untargeted). */
  legal: readonly Action[];
  /** The open decision, if any (`state.pendingDecision`). */
  decision: PendingDecision | null;
  /** Options for the current `cardTargeting` step; empty otherwise. */
  targetingOptions: readonly CardTarget[];
  /** Whose input the screen is accepting, or null if nobody's. */
  playerToAct: PlayerId | null;
  /** False ⇒ the board is read-only (CPU turn, remote turn, playback, pass screen). */
  interactive: boolean;
  /** Local unit selection. */
  sel: Sel;
}

/**
 * What a board click should cause. `act` carries an engine action to dispatch;
 * `select` carries the new local selection (`null` ⇒ clear it); `none` means
 * the click is not meaningful here and must be swallowed silently.
 */
export type ClickResult =
  | { kind: 'act'; action: Action }
  | { kind: 'select'; unitId: UnitId | null }
  | { kind: 'none' };

const NOTHING: ClickResult = { kind: 'none' };

/**
 * Route a click on `pos`. Order matters and is part of the contract:
 *
 *  1. **Card targeting** — while a `cardTargeting` decision is open, a click is
 *     only ever an answer to the current step. Nothing else on the board is
 *     live, so a mis-click can't quietly move a gnome mid-play.
 *  2. **Board-picking decisions** — slide / tunnel / snailMove destinations,
 *     harvest sources, sacrifice picks. A decision that doesn't use the board
 *     swallows the click rather than falling through to selection.
 *  3. **Move the selected unit** — if the click matches a legal move for it.
 *  4. **Select / cycle** own actionable units on the space (`selection.ts`).
 */
export function resolveCellClick(ctx: InteractionContext, pos: Pos): ClickResult {
  const { state, legal, decision, targetingOptions, playerToAct, sel } = ctx;
  if (!ctx.interactive || playerToAct === null) return NOTHING;

  // 1) Card targeting: the engine offers this step's options; the UI matches
  // the clicked cell against them by kind (unit on the cell, or the space
  // itself). It never inspects the card's rules.
  if (decision?.kind === 'cardTargeting') {
    if (decision.player !== playerToAct) return NOTHING;
    const opt = boardOptionAt(targetingOptions, state, pos);
    return opt
      ? { kind: 'act', action: { type: 'selectTarget', player: decision.player, target: opt } }
      : NOTHING;
  }

  // 2) Board-picking decisions.
  if (decision) {
    if (decision.player !== playerToAct) return NOTHING;
    if (decision.kind === 'slide' || decision.kind === 'tunnel' || decision.kind === 'snailMove') {
      return decision.options.some((o) => samePos(o, pos))
        ? { kind: 'act', action: { type: decision.kind, player: decision.player, to: pos } }
        : NOTHING;
    }
    if (decision.kind === 'chooseHarvest') {
      const opt = decision.options.find((o) => samePos(o.pos, pos));
      return opt
        ? { kind: 'act', action: { type: 'chooseHarvest', player: decision.player, sourceKey: opt.key } }
        : NOTHING;
    }
    if (decision.kind === 'sacrificeGnome') {
      const unit = decision.options.map((id) => state.units[id]).find((u) => u && samePos(u.pos, pos));
      return unit
        ? { kind: 'act', action: { type: 'sacrificeGnome', player: decision.player, unitId: unit.id } }
        : NOTHING;
    }
    return NOTHING; // other decisions don't use the board
  }

  // 3) Action Phase: move a selected unit.
  if (sel.kind === 'unit') {
    const mv = legal.find((a) => a.type === 'move' && a.unitId === sel.unitId && samePos(a.to, pos));
    if (mv) return { kind: 'act', action: mv };
  }

  // 4) Select (or cycle through) own actionable units on the clicked space.
  // The same ordered list backs the name chips in the action bar, so clicking
  // and picking a chip can never disagree about what is selectable.
  const actionable = actionableUnitsAt(state, playerToAct, pos, legal);
  const next = nextInCycle(actionable, sel.kind === 'unit' ? sel.unitId : null);
  return { kind: 'select', unitId: next ? next.id : null };
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

/**
 * Which cells to highlight, and how. Mirrors `resolveCellClick`'s priority
 * exactly — whatever is clickable is what lights up — so the two can never
 * drift into highlighting one thing and acting on another.
 */
export function computeHighlights(ctx: InteractionContext): Map<string, HighlightKind> {
  const { state, legal, decision, targetingOptions, sel } = ctx;
  const map = new Map<string, HighlightKind>();
  if (!ctx.interactive) return map;

  if (decision?.kind === 'cardTargeting') {
    // Highlight this step's legal options (from the engine) and the picks
    // already made in earlier steps.
    for (const o of targetingOptions) {
      if (o.kind === 'space') map.set(posKey(o.pos), 'target');
      else if (o.kind === 'unit') {
        const u = state.units[o.unitId];
        if (u) map.set(posKey(u.pos), 'target');
      }
    }
    for (const q of decision.selected.spaces ?? []) map.set(posKey(q), 'picked');
    for (const uid of decision.selected.units ?? []) {
      const u = state.units[uid];
      if (u) map.set(posKey(u.pos), 'picked');
    }
    return map;
  }

  if (decision) {
    if (decision.kind === 'slide' || decision.kind === 'tunnel' || decision.kind === 'snailMove') {
      for (const o of decision.options) map.set(posKey(o), 'decision');
    } else if (decision.kind === 'chooseHarvest') {
      for (const o of decision.options) map.set(posKey(o.pos), 'decision');
    } else if (decision.kind === 'sacrificeGnome') {
      for (const id of decision.options) {
        const u = state.units[id];
        if (u) map.set(posKey(u.pos), 'decision');
      }
    }
    return map;
  }

  if (sel.kind === 'unit') {
    for (const a of legal) {
      if (a.type === 'move' && a.unitId === sel.unitId) map.set(posKey(a.to), 'move');
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Action-bar affordances
// ---------------------------------------------------------------------------

/** The buttons the action bar offers for the currently selected unit. */
export interface UnitAffordances {
  plants: Array<Extract<Action, { type: 'plant' }>>;
  upgrade: Extract<Action, { type: 'upgrade' }> | null;
}

/**
 * Plant / upgrade actions available on the selected unit's space, straight out
 * of the enumerated legal actions (no legality of its own). Empty when nothing
 * is selected — a gnome that has already moved still qualifies, which is the
 * bug the P1 "couldn't plant after moving" entry was about.
 */
export function unitAffordances(
  legal: readonly Action[],
  pos: Pos | null,
): UnitAffordances {
  if (!pos) return { plants: [], upgrade: null };
  const plants = legal.filter(
    (a): a is Extract<Action, { type: 'plant' }> => a.type === 'plant' && samePos(a.pos, pos),
  );
  const upgrade =
    legal.find(
      (a): a is Extract<Action, { type: 'upgrade' }> => a.type === 'upgrade' && samePos(a.pos, pos),
    ) ?? null;
  return { plants, upgrade };
}

/** One row of the "Plant Garden" submenu: a garden type, its supply, its action. */
export interface PlantOption {
  gardenType: PlantableGardenType;
  /** Tiles of this type left in the acting player's supply. */
  remaining: number;
  /** The legal plant action, or null when it cannot be planted right now. */
  action: Extract<Action, { type: 'plant' }> | null;
}

/**
 * Every garden the acting player could ever plant, in supply order, each with
 * its remaining tile count and the matching legal action (null ⇒ not
 * plantable here and now, so the row renders disabled).
 *
 * Both halves come from the engine: the count is read straight off the
 * player's supply record, and enablement is *only* ever the presence of an
 * enumerated `plant` action — this never re-derives when planting is allowed.
 */
export function plantOptions(
  state: GameState,
  player: PlayerId | null,
  plants: readonly Extract<Action, { type: 'plant' }>[],
): PlantOption[] {
  if (player === null) return [];
  const supply = state.players[player]?.supply;
  if (!supply) return [];
  return (Object.keys(supply) as PlantableGardenType[]).map((gardenType) => ({
    gardenType,
    remaining: supply[gardenType],
    action: plants.find((a) => a.gardenType === gardenType) ?? null,
  }));
}

/** Stable key for a non-board target chip (player / discard card / garden type). */
export function targetChipKey(t: CardTarget): string {
  switch (t.kind) {
    case 'unit':
      return `u:${t.unitId}`;
    case 'space':
      return `s:${t.pos.x},${t.pos.y}`;
    case 'player':
      return `p:${t.playerId}`;
    case 'card':
      return `c:${t.cardId}`;
    case 'gardenType':
      return `g:${t.gardenType}`;
  }
}

/**
 * Banner text for the top bar. Pure string formatting over state, extracted so
 * a test can assert the wording without rendering the screen.
 */
export function bannerText(
  state: GameState,
  playerToAct: PlayerId | null,
  pname: (state: GameState, p: PlayerId) => string,
  decisionLabel: (kind: PendingDecision['kind']) => string,
): string {
  if (state.status === 'finished') {
    return state.winner !== null ? `🏆 ${pname(state, state.winner)} wins!` : 'Game over — no winner.';
  }
  if (state.status === 'rolloff') {
    return `🎲 Rolling for turn order — ${playerToAct !== null ? pname(state, playerToAct) : '…'} to roll`;
  }
  const t = state.turn;
  if (!t) return '…';
  let s = `Turn ${t.number} · ${pname(state, t.activePlayer)} · ${t.phase === 'harvest' ? '🌾 Harvest' : '⚡ Action'} Phase`;
  const d = state.pendingDecision;
  if (playerToAct !== null && (playerToAct !== t.activePlayer || d)) {
    s += ` — ${pname(state, playerToAct)} must act${d ? ` (${decisionLabel(d.kind)})` : ''}`;
  }
  return s;
}
