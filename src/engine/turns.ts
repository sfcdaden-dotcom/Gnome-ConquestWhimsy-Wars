/**
 * Turn lifecycle: the opening roll-off, starting and ending turns, and the
 * movement-legality rules those depend on.
 *
 * `moveDestinations` lives here because it is the single source of truth
 * shared by three callers: `doMove` (actions.ts), the legal-action enumerator
 * (legalActions.ts) and the Antsy Pants "must move if able" check below.
 */

import type { GameState, PlayerId, Pos, Unit } from './types';
import {
  CURSE_ANTSY_PANTS,
  CURSE_MAGIC_DRAIN,
  curseActive,
  destroyGarden,
  draftRollD6,
  edibleSnailGarden,
  entryBlockedByWall,
  getPlayer,
  gnomeExitBlocked,
  illegal,
  maizeExitCost,
  orthNeighbors,
  playerUnits,
  pushEvent,
  requireTurn,
} from './helpers';
import { finishGame } from './elimination';
import { refillQuickChat } from './quickchat';

// ---------------------------------------------------------------------------
// Who acts
// ---------------------------------------------------------------------------

/**
 * The player who must act right now: the pendingDecision's player if one is
 * set, otherwise the active player. Null when the game is finished.
 */
export function getPlayerToAct(state: GameState): PlayerId | null {
  if (state.status === 'finished') return null;
  if (state.pendingDecision) return state.pendingDecision.player;
  if (state.turn) return state.turn.activePlayer;
  return null;
}

export function requireActionPhaseActor(draft: GameState, player: PlayerId): void {
  if (draft.status !== 'playing') illegal('The game has not started yet (turn-order roll-off pending)');
  if (draft.pendingDecision) {
    illegal(`A "${draft.pendingDecision.kind}" decision by player ${draft.pendingDecision.player} must be resolved first`);
  }
  const t = requireTurn(draft);
  if (t.activePlayer !== player) illegal(`It is player ${t.activePlayer}'s turn, not player ${player}'s`);
  if (t.phase !== 'action') illegal('Not in the Action Phase (resolve harvests first)');
}

// ---------------------------------------------------------------------------
// Movement legality
// ---------------------------------------------------------------------------

/**
 * Legal destinations for a unit's own 1-space move: orthogonal, on-board,
 * not behind the Great Wall, exit not locked (Lost In The Maize) and the
 * maize exit cost payable.
 */
export function moveDestinations(state: GameState, unit: Unit): Pos[] {
  if (gnomeExitBlocked(state, unit) !== null) return [];
  if (maizeExitCost(state, unit.pos) > getPlayer(state, unit.owner).wishes) return [];
  return orthNeighbors(state, unit.pos).filter((q) => !entryBlockedByWall(state, q));
}

/** Antsy Pants curse: the player's unmoved gnomes that still have a legal move. */
export function antsyPantsViolators(state: GameState, player: PlayerId): Unit[] {
  if (!curseActive(state, CURSE_ANTSY_PANTS)) return [];
  const t = state.turn;
  if (!t || t.phase !== 'action') return [];
  return playerUnits(state, player).filter(
    (u) => u.kind === 'gnome' && u.movedOnTurn !== t.number && moveDestinations(state, u).length > 0,
  );
}

// ---------------------------------------------------------------------------
// Roll-off
// ---------------------------------------------------------------------------

export function doRollOff(draft: GameState, player: PlayerId): void {
  const d = draft.pendingDecision;
  if (draft.status !== 'rolloff' || !d || d.kind !== 'rollOff' || !draft.rolloff) {
    illegal('No turn-order roll-off is pending');
  }
  if (d.player !== player) illegal(`It is player ${d.player}'s roll, not player ${player}'s`);
  const r = draft.rolloff;
  const roll = draftRollD6(draft);
  r.rolls[player] = roll;
  pushEvent(draft, { type: 'rollOffRolled', player, roll });
  r.pending = r.pending.filter((p) => p !== player);
  draft.pendingDecision = null;

  if (r.pending.length > 0) {
    draft.pendingDecision = { kind: 'rollOff', player: r.pending[0] };
    return;
  }

  const rolls = r.participants.map((pid) => ({ pid, roll: r.rolls[pid] ?? 0 }));
  const best = Math.max(...rolls.map((x) => x.roll));
  const winners = rolls.filter((x) => x.roll === best).map((x) => x.pid);
  if (winners.length > 1) {
    pushEvent(draft, { type: 'rollOffTie', players: winners });
    r.participants = winners;
    r.pending = [...winners];
    for (const w of winners) r.rolls[w] = null;
    draft.pendingDecision = { kind: 'rollOff', player: r.pending[0] };
    return;
  }

  const first = winners[0];
  pushEvent(draft, { type: 'turnOrderDetermined', first });
  draft.status = 'playing';
  draft.rolloff = null;
  startTurn(draft, first, 1);
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export function startTurn(draft: GameState, player: PlayerId, turnNumber: number): void {
  const p = getPlayer(draft, player);
  draft.turn = {
    number: turnNumber,
    activePlayer: player,
    phase: p.status === 'playing' ? 'harvest' : 'action',
    snailLostFight: false,
    snailEatOffered: false,
  };
  draft.turnMustEnd = false;
  refillQuickChat(draft); // everyone's quickchat allowance refills each turn
  pushEvent(draft, { type: 'turnStarted', player, turnNumber });

  // "Until your next turn" effects cast by this player expire now.
  const expired = draft.timedEffects.filter((e) => e.caster === player);
  if (expired.length > 0) {
    draft.timedEffects = draft.timedEffects.filter((e) => e.caster !== player);
    for (const e of expired) {
      pushEvent(draft, { type: 'timedEffectExpired', kind: e.kind, player });
    }
  }

  if (draft.turn.phase === 'action') {
    // Snail turns have no Harvest Phase.
    pushEvent(draft, { type: 'actionPhaseStarted', player });
    return;
  }

  // Magic Drain curse: starting your turn at 0 Wishes costs a gnome (if you
  // have one). The Harvest Phase itself is built lazily by the settle loop
  // (continueHarvest), so this sacrifice resolves before any harvest.
  if (curseActive(draft, CURSE_MAGIC_DRAIN) && p.wishes === 0) {
    const gnomes = playerUnits(draft, player)
      .filter((u) => u.kind === 'gnome')
      .map((u) => u.id);
    if (gnomes.length > 0) {
      draft.pendingDecision = { kind: 'sacrificeGnome', player, options: gnomes };
    }
  }
}

export function doEndTurn(draft: GameState, player: PlayerId): void {
  requireActionPhaseActor(draft, player);
  const antsy = antsyPantsViolators(draft, player);
  if (antsy.length > 0) {
    illegal(
      `Antsy Pants: ${antsy.length} of your gnome(s) can still move this turn and must do so before it ends`,
    );
  }
  endTurnInternal(draft);
}

/**
 * Answer to a snail-meal offer: the end-of-turn `snailEat` decision, or the
 * "eat instead of slithering" option inside a Snailmaggedon `snailMove`.
 */
export function resolveSnailEat(draft: GameState, player: PlayerId, accept: boolean): void {
  const d = draft.pendingDecision;
  if (!d || (d.kind !== 'snailEat' && d.kind !== 'snailMove')) {
    illegal('No snail-meal decision is pending');
  }
  if (d.player !== player) illegal(`It is player ${d.player}'s decision, not player ${player}'s`);

  if (d.kind === 'snailMove') {
    // Snailmaggedon only: the curse's bonus action may be spent on a meal
    // instead of a slither. A post-fight rout is a rout — no snacking.
    if (d.context !== 'snailmaggedon') illegal('A snail that lost a fight must retreat, not eat');
    if (!accept) illegal('Use declineEffect to pass on the snail move');
    const snail = edibleSnailGarden(draft, player);
    if (!snail) illegal('Your snail is not sitting on a garden it can eat');
    draft.pendingDecision = null;
    const h = draft.harvest;
    if (h && h.snailMoves[0] === player) h.snailMoves.shift();
    destroyGarden(draft, snail.pos, 'snail');
    return;
  }

  draft.pendingDecision = null;
  if (accept) {
    // Re-checked rather than trusted: nothing resolves between opening the
    // decision and answering it, but the meal is cheap to verify.
    const snail = edibleSnailGarden(draft, player);
    if (snail) destroyGarden(draft, snail.pos, 'snail');
  } else {
    pushEvent(draft, { type: 'snailMealDeclined', player, pos: d.pos });
  }
  endTurnInternal(draft);
}

export function endTurnInternal(draft: GameState): void {
  const t = requireTurn(draft);
  const p = getPlayer(draft, t.activePlayer);

  // Snail: offer the garden it occupies as a meal — eating is the Snail's
  // choice, not a reflex. Skipped when its turn ended by losing a fight (then
  // nothing is eaten), when enemy units still share the space (the snail
  // survives losses without clearing it, so a garden its defenders are still
  // standing on is safe), and once the offer has already been answered.
  if (p.status === 'snail' && !t.snailLostFight && !t.snailEatOffered) {
    const snail = edibleSnailGarden(draft, p.id);
    if (snail) {
      t.snailEatOffered = true;
      draft.pendingDecision = {
        kind: 'snailEat',
        player: p.id,
        unitId: snail.id,
        pos: { ...snail.pos },
      };
      return; // resolveSnailEat resumes this turn end once the Snail answers
    }
  }

  pushEvent(draft, { type: 'turnEnded', player: p.id });

  // Per-turn markers keyed to this player's turn expire now.
  for (const g of Object.values(draft.gardens)) {
    if (g.stunnedForPlayerTurn === p.id) g.stunnedForPlayerTurn = null;
    if (g.doubledForPlayerTurn === p.id) g.doubledForPlayerTurn = null;
  }

  draft.harvest = null;
  draft.turnMustEnd = false;
  draft.pendingDecision = null;

  // Next seat (clockwise) still in the game.
  const n = draft.players.length;
  let next: PlayerId | null = null;
  for (let i = 1; i <= n; i++) {
    const cand = (t.activePlayer + i) % n;
    const cp = draft.players[cand];
    if (cp.status === 'playing' || cp.status === 'snail') {
      next = cand;
      break;
    }
  }
  if (next === null) {
    finishGame(draft, null);
    return;
  }
  startTurn(draft, next, t.number + 1);
}
