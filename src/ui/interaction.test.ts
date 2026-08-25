/**
 * Board interaction routing, tested without React.
 *
 * These rules used to live inside `GameScreen`, where the only way to exercise
 * them was to render the whole screen and click. Now they are pure functions
 * over (state, legal actions, decision, selection), so each branch — including
 * the ones that are meant to do NOTHING — gets a direct test.
 *
 * The routing ORDER is the contract: targeting swallows everything, then
 * board-picking decisions, then moving the selected unit, then selection. Each
 * of those precedences is pinned below, because a regression in any of them is
 * a click that silently does the wrong thing rather than an error anyone sees.
 */

import { describe, expect, it } from 'vitest';
import type {
  Action,
  CardTarget,
  GameState,
  PendingDecision,
  PlantableGardenType,
  Pos,
} from '../engine';
import { applyAction, getLegalActionIntents, getPendingDecisionOptions, posKey } from '../engine';
import { mutate, toActionPhase, withGnome, withHand } from '../engine/testkit';
import type { InteractionContext, Sel } from './interaction';
import {
  NO_SEL,
  bannerText,
  boardOptionAt,
  computeHighlights,
  plantOptions,
  resolveCellClick,
  selectionStillValid,
  targetChipKey,
  unitAffordances,
} from './interaction';

const HOME: Pos = { x: 0, y: 3 };
const AWAY: Pos = { x: 1, y: 3 };

function ctxOf(over: Partial<InteractionContext> & { state: GameState }): InteractionContext {
  return {
    legal: [],
    decision: null,
    targetingOptions: [],
    playerToAct: 0,
    interactive: true,
    sel: NO_SEL,
    ...over,
  };
}

/** A bare 2p state with `ids` stacked on `pos` for seat 0. */
function withStack(ids: string[], pos: Pos = HOME): GameState {
  const s = toActionPhase(11);
  return mutate(s, (d) => {
    d.units = Object.fromEntries(
      ids.map((id) => [id, { id, owner: 0, kind: 'gnome' as const, pos: { ...pos }, movedOnTurn: null }]),
    );
  });
}

const move = (unitId: string, to: Pos = AWAY): Action => ({ type: 'move', player: 0, unitId, to });
const plant = (pos: Pos = HOME): Action => ({ type: 'plant', player: 0, pos, gardenType: 'dandelion' });
const upgrade = (pos: Pos = HOME): Action => ({ type: 'upgrade', player: 0, pos });
const plantOf = (gardenType: PlantableGardenType, pos: Pos = HOME): Action => ({
  type: 'plant',
  player: 0,
  pos,
  gardenType,
});

// ---------------------------------------------------------------------------
// selectionStillValid
// ---------------------------------------------------------------------------

describe('selectionStillValid', () => {
  const state = withStack(['u1', 'u2']);
  const sel: Sel = { kind: 'unit', unitId: 'u1' };

  it('keeps a selection with a legal move', () => {
    expect(selectionStillValid(state, [move('u1')], sel)).toBe(true);
  });

  it('keeps a selection that can only still plant (the moved-gnome case)', () => {
    // The P1 regression: a gnome that already moved has no legal move but can
    // still plant on its space, and must stay selected so the button is
    // reachable for the rest of the turn.
    expect(selectionStillValid(state, [plant(HOME)], sel)).toBe(true);
  });

  it('drops a selection with nothing left to do', () => {
    expect(selectionStillValid(state, [move('u2')], sel)).toBe(false);
  });

  it('drops a selection whose unit no longer exists', () => {
    expect(selectionStillValid(state, [move('u9')], { kind: 'unit', unitId: 'u9' })).toBe(false);
  });

  it('an empty selection is always valid', () => {
    expect(selectionStillValid(state, [], NO_SEL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// boardOptionAt
// ---------------------------------------------------------------------------

describe('boardOptionAt', () => {
  const state = withStack(['u1']);

  it('matches a space option by position', () => {
    const opts: CardTarget[] = [{ kind: 'space', pos: AWAY }];
    expect(boardOptionAt(opts, state, AWAY)).toEqual(opts[0]);
    expect(boardOptionAt(opts, state, HOME)).toBeNull();
  });

  it('matches a unit option by where its unit stands', () => {
    const opts: CardTarget[] = [{ kind: 'unit', unitId: 'u1' }];
    expect(boardOptionAt(opts, state, HOME)).toEqual(opts[0]);
    expect(boardOptionAt(opts, state, AWAY)).toBeNull();
  });

  it('ignores non-board options (they are chips, not cells)', () => {
    const opts: CardTarget[] = [
      { kind: 'player', playerId: 1 },
      { kind: 'gardenType', gardenType: 'maize' },
    ];
    expect(boardOptionAt(opts, state, HOME)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveCellClick
// ---------------------------------------------------------------------------

describe('resolveCellClick: gating', () => {
  const state = withStack(['u1']);

  it('does nothing when the screen is not interactive', () => {
    const ctx = ctxOf({ state, legal: [move('u1')], interactive: false });
    expect(resolveCellClick(ctx, HOME)).toEqual({ kind: 'none' });
  });

  it('does nothing when nobody is to act', () => {
    const ctx = ctxOf({ state, legal: [move('u1')], playerToAct: null });
    expect(resolveCellClick(ctx, HOME)).toEqual({ kind: 'none' });
  });

  it('does nothing when the open decision belongs to another seat', () => {
    const decision: PendingDecision = {
      kind: 'snailMove',
      player: 1,
      unitId: 'u1',
      from: HOME,
      options: [AWAY],
    };
    const ctx = ctxOf({ state, decision, legal: [move('u1')] });
    expect(resolveCellClick(ctx, AWAY)).toEqual({ kind: 'none' });
  });
});

describe('resolveCellClick: card targeting takes precedence', () => {
  const state = withStack(['u1']);
  const decision = {
    kind: 'cardTargeting',
    player: 0,
    cardId: 'rocket-propelled-gnome',
    selected: {},
    stepIndex: 0,
    stepCount: 1,
    targetKind: 'unit',
    prompt: 'Choose a gnome',
  } as Extract<PendingDecision, { kind: 'cardTargeting' }>;

  it('answers the current step when the cell carries an option', () => {
    const targetingOptions: CardTarget[] = [{ kind: 'unit', unitId: 'u1' }];
    const ctx = ctxOf({ state, decision, targetingOptions, legal: [move('u1')] });
    expect(resolveCellClick(ctx, HOME)).toEqual({
      kind: 'act',
      action: { type: 'selectTarget', player: 0, target: { kind: 'unit', unitId: 'u1' } },
    });
  });

  it('swallows a click on a cell with no option — never falls through to a move', () => {
    // `legal` still contains a move to AWAY; while targeting is open it must
    // not be reachable, or a mis-click would move a gnome mid-play.
    const ctx = ctxOf({ state, decision, targetingOptions: [], legal: [move('u1')] });
    expect(resolveCellClick(ctx, AWAY)).toEqual({ kind: 'none' });
  });
});

describe('resolveCellClick: board-picking decisions', () => {
  const state = withStack(['u1']);

  for (const kind of ['slide', 'tunnel', 'snailMove'] as const) {
    it(`${kind}: clicking an offered destination answers it`, () => {
      const decision = { kind, player: 0, unitId: 'u1', from: HOME, options: [AWAY], optional: true } as PendingDecision;
      const ctx = ctxOf({ state, decision });
      expect(resolveCellClick(ctx, AWAY)).toEqual({
        kind: 'act',
        action: { type: kind, player: 0, to: AWAY },
      });
      expect(resolveCellClick(ctx, { x: 6, y: 6 })).toEqual({ kind: 'none' });
    });
  }

  it('chooseHarvest: clicking a source answers with its key', () => {
    const decision: PendingDecision = {
      kind: 'chooseHarvest',
      player: 0,
      options: [{ key: '1,3', kind: 'garden', pos: AWAY, gardenType: 'dandelion' }],
    };
    const ctx = ctxOf({ state, decision });
    expect(resolveCellClick(ctx, AWAY)).toEqual({
      kind: 'act',
      action: { type: 'chooseHarvest', player: 0, sourceKey: '1,3' },
    });
  });

  it('sacrificeGnome: clicking the cell a candidate stands on picks that unit', () => {
    const decision: PendingDecision = { kind: 'sacrificeGnome', player: 0, options: ['u1'] };
    const ctx = ctxOf({ state, decision });
    expect(resolveCellClick(ctx, HOME)).toEqual({
      kind: 'act',
      action: { type: 'sacrificeGnome', player: 0, unitId: 'u1' },
    });
  });

  it('a non-board decision swallows the click instead of selecting', () => {
    const decision: PendingDecision = { kind: 'homeHarvest', player: 0, options: ['wish', 'gnome'] };
    const ctx = ctxOf({ state, decision, legal: [move('u1')] });
    expect(resolveCellClick(ctx, HOME)).toEqual({ kind: 'none' });
  });
});

describe('resolveCellClick: action phase', () => {
  const state = withStack(['u1', 'u2']);

  it('moves the selected unit when the cell is a legal destination', () => {
    const sel: Sel = { kind: 'unit', unitId: 'u1' };
    const ctx = ctxOf({ state, sel, legal: [move('u1')] });
    expect(resolveCellClick(ctx, AWAY)).toEqual({ kind: 'act', action: move('u1') });
  });

  it("does not move on another unit's legal destination", () => {
    const sel: Sel = { kind: 'unit', unitId: 'u1' };
    const ctx = ctxOf({ state, sel, legal: [move('u2')] });
    // Falls through to selection on that cell (nothing selectable there ⇒ clear).
    expect(resolveCellClick(ctx, AWAY)).toEqual({ kind: 'select', unitId: null });
  });

  it('selects the first actionable unit on an unselected space', () => {
    const ctx = ctxOf({ state, legal: [move('u1'), move('u2')] });
    expect(resolveCellClick(ctx, HOME)).toEqual({ kind: 'select', unitId: 'u1' });
  });

  it('cycles through a stack on repeated clicks, wrapping', () => {
    const legal = [move('u1'), move('u2')];
    const first = resolveCellClick(ctxOf({ state, legal }), HOME);
    expect(first).toEqual({ kind: 'select', unitId: 'u1' });
    const second = resolveCellClick(ctxOf({ state, legal, sel: { kind: 'unit', unitId: 'u1' } }), HOME);
    expect(second).toEqual({ kind: 'select', unitId: 'u2' });
    const third = resolveCellClick(ctxOf({ state, legal, sel: { kind: 'unit', unitId: 'u2' } }), HOME);
    expect(third).toEqual({ kind: 'select', unitId: 'u1' });
  });

  it('clears the selection when the clicked space has nothing actionable', () => {
    const ctx = ctxOf({ state, legal: [move('u1')], sel: { kind: 'unit', unitId: 'u1' } });
    expect(resolveCellClick(ctx, { x: 6, y: 6 })).toEqual({ kind: 'select', unitId: null });
  });

  it('a gnome that already moved is still selectable when it can plant', () => {
    // Only a plant is legal on HOME — no moves at all. Both gnomes qualify.
    const ctx = ctxOf({ state, legal: [plant(HOME)] });
    expect(resolveCellClick(ctx, HOME)).toEqual({ kind: 'select', unitId: 'u1' });
  });
});

// ---------------------------------------------------------------------------
// computeHighlights
// ---------------------------------------------------------------------------

describe('computeHighlights', () => {
  const state = withStack(['u1']);

  it('is empty when the screen is not interactive', () => {
    const ctx = ctxOf({ state, legal: [move('u1')], sel: { kind: 'unit', unitId: 'u1' }, interactive: false });
    expect(computeHighlights(ctx).size).toBe(0);
  });

  it('marks the selected unit’s legal destinations', () => {
    const ctx = ctxOf({ state, legal: [move('u1'), move('u1', { x: 2, y: 3 })], sel: { kind: 'unit', unitId: 'u1' } });
    expect(Object.fromEntries(computeHighlights(ctx))).toEqual({ '1,3': 'move', '2,3': 'move' });
  });

  it('marks decision options', () => {
    const decision = { kind: 'slide', player: 0, unitId: 'u1', from: HOME, options: [AWAY], optional: false } as PendingDecision;
    expect(Object.fromEntries(computeHighlights(ctxOf({ state, decision })))).toEqual({ '1,3': 'decision' });
  });

  it('marks targeting options and already-picked cells distinctly', () => {
    const decision = {
      kind: 'cardTargeting',
      player: 0,
      cardId: 'plot-twist',
      selected: { spaces: [HOME] },
      stepIndex: 1,
      stepCount: 2,
      targetKind: 'space',
      prompt: 'second space',
    } as Extract<PendingDecision, { kind: 'cardTargeting' }>;
    const targetingOptions: CardTarget[] = [{ kind: 'space', pos: AWAY }];
    expect(Object.fromEntries(computeHighlights(ctxOf({ state, decision, targetingOptions })))).toEqual({
      '1,3': 'target',
      '0,3': 'picked',
    });
  });

  it('marks what a card being responded to is aimed at', () => {
    // Blue rocketed one of Red's gnomes; Red is in the response window and
    // needs to see which gnome before deciding whether to Nope it.
    const base = withStack(['u1', 'u2'], HOME);
    const state = mutate(base, (d) => {
      d.units.u2.pos = { ...AWAY };
      d.cardStack = [
        { player: 1, cardId: 'rocket-propelled-gnome', targets: { units: ['u2'] }, cancelled: false },
      ];
    });
    const decision = {
      kind: 'cardResponse',
      player: 0,
      respondingToCard: 'rocket-propelled-gnome',
      respondingToPlayer: 1,
      stackIndex: 0,
      playableCards: ['nope-gnome'],
    } as Extract<PendingDecision, { kind: 'cardResponse' }>;
    // 'picked' — the caster's choices, shown but not clickable.
    expect(Object.fromEntries(computeHighlights(ctxOf({ state, decision })))).toEqual({
      '1,3': 'picked',
    });
  });

  it('marks nothing for a responded card that takes no targets', () => {
    const state = mutate(withStack(['u1']), (d) => {
      d.cardStack = [{ player: 1, cardId: 'gnome-birthday-party', cancelled: false }];
    });
    const decision = {
      kind: 'cardResponse',
      player: 0,
      respondingToCard: 'gnome-birthday-party',
      respondingToPlayer: 1,
      stackIndex: 0,
      playableCards: [],
    } as Extract<PendingDecision, { kind: 'cardResponse' }>;
    expect(computeHighlights(ctxOf({ state, decision })).size).toBe(0);
  });

  /**
   * The two must not drift: anything highlighted has to be clickable, and
   * anything clickable has to be highlighted. (One documented exception, not
   * exercised here: a `cardResponse` marks the responded card's targets purely
   * to be read — the decision is answered from the panel, not the board.) A click that lights up but does
   * nothing (or vice versa) is exactly the class of bug this extraction exists
   * to make testable.
   */
  it('agrees with resolveCellClick on every cell of a real state', () => {
    let s = toActionPhase(17);
    const me = s.turn!.activePlayer;
    s = withGnome(s, me, { x: 3, y: 3 }).state;
    const legal = getLegalActionIntents(s, me);
    const unit = Object.values(s.units).find((u) => u.owner === me)!;
    const ctx = ctxOf({ state: s, legal, playerToAct: me, sel: { kind: 'unit', unitId: unit.id } });
    const highlights = computeHighlights(ctx);

    const n = s.config.boardSize;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const pos = { x, y };
        const highlighted = highlights.get(posKey(pos)) === 'move';
        const acts = resolveCellClick(ctx, pos).kind === 'act';
        expect(acts, `move highlight vs click disagree at ${posKey(pos)}`).toBe(highlighted);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Affordances, chips, banner
// ---------------------------------------------------------------------------

describe('unitAffordances', () => {
  it('returns the plant/upgrade actions on the unit’s own space only', () => {
    const legal = [plant(HOME), plant(AWAY), upgrade(HOME), move('u1')];
    const a = unitAffordances(legal, HOME);
    expect(a.plants).toEqual([plant(HOME)]);
    expect(a.upgrade).toEqual(upgrade(HOME));
  });

  it('is empty with nothing selected', () => {
    expect(unitAffordances([plant(HOME)], null)).toEqual({ plants: [], upgrade: null });
  });
});

describe('plantOptions', () => {
  it('lists every garden in supply with its count, enabled only where legal', () => {
    const s = mutate(toActionPhase(11), (d) => {
      d.players[0].supply = { dandelion: 2, mushroom: 0, flytrap: 1, maize: 3, slippery: 1, tunnel: 0 };
    });
    const plants = unitAffordances([plant(HOME), plantOf('maize'), move('u1')], HOME).plants;
    const opts = plantOptions(s, 0, plants);

    // Every type in supply appears, exactly once, with the supply's own count.
    expect(opts.map((o) => o.gardenType)).toEqual(Object.keys(s.players[0].supply));
    expect(Object.fromEntries(opts.map((o) => [o.gardenType, o.remaining]))).toEqual(
      s.players[0].supply,
    );
    // Enablement is the enumerated action, never a recomputed rule.
    expect(opts.filter((o) => o.action).map((o) => o.gardenType)).toEqual(['dandelion', 'maize']);
  });

  it('is empty with nobody to act', () => {
    expect(plantOptions(toActionPhase(11), null, [])).toEqual([]);
  });
});

describe('targetChipKey', () => {
  it('is distinct per target kind and value', () => {
    const targets: CardTarget[] = [
      { kind: 'unit', unitId: 'u1' },
      { kind: 'space', pos: HOME },
      { kind: 'player', playerId: 1 },
      { kind: 'card', cardId: 'snake-eyes' },
      { kind: 'gardenType', gardenType: 'maize' },
    ];
    const keys = targets.map(targetChipKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('bannerText', () => {
  const pname = (s: GameState, p: number) => s.players[p].name;
  const label = (k: PendingDecision['kind']) => k;

  it('announces the winner when the game is finished', () => {
    const s = mutate(withStack(['u1']), (d) => {
      d.status = 'finished';
      d.winner = 1;
    });
    expect(bannerText(s, null, pname, label)).toBe('🏆 P1 wins!');
  });

  it('names the turn, seat and phase in play', () => {
    const s = withStack(['u1']);
    expect(bannerText(s, s.turn!.activePlayer, pname, label)).toContain('⚡ Action Phase');
  });

  it('calls out an interrupt by the seat that owes it', () => {
    const s = mutate(withStack(['u1']), (d) => {
      d.pendingDecision = { kind: 'discard', player: 1, mustDiscard: 1 };
    });
    expect(bannerText(s, 1, pname, label)).toContain('P1 must act (discard)');
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the engine
// ---------------------------------------------------------------------------

describe('routing drives a real card play to completion', () => {
  it('walks Plot Twist’s two targeting steps by clicking highlighted cells', () => {
    let s = toActionPhase(31);
    const me = s.turn!.activePlayer;
    s = withGnome(s, me, { x: 3, y: 3 }).state;
    s = withHand(s, me, 'plot-twist');
    s = applyAction(s, { type: 'playCard', player: me, cardId: 'plot-twist' });
    expect(s.pendingDecision?.kind).toBe('cardTargeting');

    // Click through each step by picking the first highlighted 'target' cell,
    // exactly as a player would, using only the routing functions.
    for (let step = 0; step < 2; step++) {
      const ctx = ctxOf({
        state: s,
        decision: s.pendingDecision,
        targetingOptions: getPendingDecisionOptions(s),
        playerToAct: me,
      });
      const cell = [...computeHighlights(ctx)].find(([, kind]) => kind === 'target')?.[0];
      expect(cell, `step ${step} should highlight at least one option`).toBeDefined();
      const [x, y] = cell!.split(',').map(Number);
      const result = resolveCellClick(ctx, { x, y });
      expect(result.kind).toBe('act');
      if (result.kind !== 'act') return;
      s = applyAction(s, result.action);
    }

    // Both steps answered ⇒ the card resolved and left the hand.
    expect(s.pendingDecision?.kind).not.toBe('cardTargeting');
    expect(s.players[me].hand).not.toContain('plot-twist');
  });
});
