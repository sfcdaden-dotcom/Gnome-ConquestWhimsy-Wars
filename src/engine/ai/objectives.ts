/**
 * The objective layer: what the CPU is *trying to do*, and for how long.
 *
 * This module sits ABOVE the existing action system and knows nothing about
 * how an action is executed. It reads the board and answers two questions:
 *
 *   1. What is my broad posture right now?      → `StrategicState`
 *   2. What concrete thing am I going after?    → `Objective`
 *
 * `objectiveScoring.ts` then turns the answer into a bias over the legal
 * actions the engine already generates. Nothing here generates, validates or
 * executes an action; `legalActions.ts` and `engine.ts` remain the only
 * authority on what is legal and what it does.
 *
 * WHY A STACK
 *
 * The point of the layer is that the CPU keeps a plan across turns instead of
 * re-deciding every action, so a watching player can read its intent ("Blue
 * wants that Mushroom"). But a plan that can't be interrupted is just as
 * unreadable — an opponent marching at an undefended home while its own is
 * being taken looks broken, not determined. So the plan is a small stack:
 *
 *     DEFEND_HOME        ← interrupt, taken because our home is threatened
 *     CAPTURE_GARDEN(3,4) ← suspended; resumes the moment the threat clears
 *
 * Only the top of the stack drives scoring. Interrupts are pushed by
 * `urgentInterrupt` and popped by the same completion check as any other
 * objective, which is what produces the "turned around to defend, then went
 * back to what it was doing" behaviour.
 *
 * LIFETIMES
 *
 * Every objective answers three questions on every call (`objectiveStatus` and
 * `objectiveValue`):
 *
 *   - complete?  the target garden is ours / the threat is gone / we stand on
 *                the enemy home,
 *   - failed?    the garden was destroyed, our home is gone, the target player
 *                was eliminated by somebody else,
 *   - still worth it?  the Mushroom that was worth taking when it was empty is
 *                not worth taking now that six gnomes sit on it. A challenger
 *                objective replaces the current one only if it beats it by
 *                `SWITCH_MARGIN`, which is what stops the CPU dithering
 *                between two similar goals.
 *
 * DETERMINISM. Everything here is a pure function of `GameState` plus the
 * seat's own remembered plan. No wall clock, no RNG, and every scan iterates
 * in a stable order, so a seeded game still replays exactly.
 */

import { areAllies, teamOf } from '../teams';
import type { GameState, GardenType, PlayerId, Pos, Unit } from '../types';
import { enemyUnitsAt, gardenAt, gnomesOnBoard, manhattan, playerUnitsAt, reserveGnomes } from '../helpers';
import type { AiPersonality } from './personality';
import { defenseDecay, enemyGnomes, offensePush, ownGnomes, ownHomePos } from './util';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Broad posture. Influences objective SELECTION, never one specific action —
 * with one deliberate exception: the posture also owns ECONOMIC POLICY, because
 * "is a Wish worth more in the ground or in my hand" is not a question any one
 * objective can answer. Two postures pull in opposite directions, and
 * `objectiveScoring.ts` / `chooseHomeHarvest` implement the contrast:
 *
 *   EXPAND  spends on the board — plants gardens, takes the gnome at the Home
 *           Garden, keeps its Wishes for the ground. A garden pays every turn.
 *   DEFEND  spends on the hand — draws down to its last Wishes, takes the Wish
 *           over the gnome, and leaves the gnomes that are already harvesting
 *           where they are. A dug-in position is not short of bodies, it is
 *           short of answers.
 *
 * Measured over 16 games: EXPAND plants ~3x as often and takes the body ~7x as
 * often; DEFEND draws ~6x as often. (SURVIVE follows DEFEND, and PRESSURE /
 * FINISH follow EXPAND on bodies — both are spending them.)
 */
export type StrategicState = 'EXPAND' | 'DEFEND' | 'PRESSURE' | 'SURVIVE' | 'FINISH';

/** The concrete goal library. Deliberately small — grow it once it pays off. */
export type ObjectiveKind = 'CAPTURE_GARDEN' | 'DEFEND_HOME' | 'ATTACK_ENEMY_HOME';

export interface Objective {
  readonly kind: ObjectiveKind;
  /** The space the objective is about: the garden, our home, or the enemy home. */
  readonly targetPos: Pos;
  /** CAPTURE_GARDEN: what was standing there when we chose it (a failure check). */
  readonly gardenType?: GardenType;
  /** ATTACK_ENEMY_HOME: whose home. */
  readonly targetPlayer?: PlayerId;
  /** Turn number the objective was adopted — used for age, and for the log. */
  readonly adoptedOnTurn: number;
  /** True for an objective pushed over a suspended plan rather than replacing it. */
  readonly interrupt?: boolean;
}

/** One seat's remembered plan. Persisted between actions AND between turns. */
export interface AiPlan {
  strategy: StrategicState;
  /** Top of the stack is the objective currently driving scoring. */
  stack: Objective[];
  /** Turn number the base objective was last re-considered. */
  plannedOnTurn: number;
  /**
   * What this seat last said out loud, and when (see `chatter.ts`). None of it
   * feeds the decision — it only keeps the CPU from repeating itself.
   */
  announced?: string;
  announcedKind?: string;
  announcedOnTurn?: number;
}

export type ObjectiveStatus = 'active' | 'complete' | 'failed';

/** How close an enemy has to get before our home counts as threatened. */
export const HOME_THREAT_RADIUS = 3;

/** Threat level at which DEFEND_HOME is pushed as an interrupt over any plan. */
export const INTERRUPT_THRESHOLD = 2;

/**
 * How much better a challenger must be before the CPU abandons its current
 * objective. This margin IS the persistence: without it the CPU re-derives a
 * marginally different best goal every turn and never visibly commits to one.
 */
export const SWITCH_MARGIN = 6;

/** Standing value of holding each garden type, before distance and defenders. */
const GARDEN_VALUE: Record<GardenType, number> = {
  mushroom: 14,
  dandelion: 12,
  tunnel: 7,
  maize: 5,
  slippery: 3,
  flytrap: 2,
  home: 0, // homes are ATTACK_ENEMY_HOME's business, not CAPTURE_GARDEN's
};

/**
 * How each posture rates each kind of objective. This matrix replaces what
 * would otherwise be a tree of hard-coded conditions: postures bias, they do
 * not dictate, so a hugely valuable garden can still win out under PRESSURE.
 */
const POSTURE_BIAS: Record<StrategicState, Record<ObjectiveKind, number>> = {
  EXPAND: { CAPTURE_GARDEN: 1.35, DEFEND_HOME: 0.8, ATTACK_ENEMY_HOME: 0.6 },
  DEFEND: { CAPTURE_GARDEN: 0.7, DEFEND_HOME: 1.6, ATTACK_ENEMY_HOME: 0.5 },
  PRESSURE: { CAPTURE_GARDEN: 0.9, DEFEND_HOME: 0.9, ATTACK_ENEMY_HOME: 1.35 },
  SURVIVE: { CAPTURE_GARDEN: 0.55, DEFEND_HOME: 1.8, ATTACK_ENEMY_HOME: 0.35 },
  FINISH: { CAPTURE_GARDEN: 0.5, DEFEND_HOME: 0.7, ATTACK_ENEMY_HOME: 1.8 },
};

// ---------------------------------------------------------------------------
// Board reads
// ---------------------------------------------------------------------------

/**
 * How badly our home is threatened, and by whom.
 *
 * An enemy ON our home tile is the emergency; one three spaces out is a
 * warning. Weighting by closeness (rather than a boolean) lets the threat
 * compete on the same scale as everything else instead of latching a mode.
 */
export function homeThreat(
  state: GameState,
  player: PlayerId,
): { level: number; home: Pos | null; nearest: Unit | null } {
  const home = ownHomePos(state, player);
  if (!home) return { level: 0, home: null, nearest: null };
  let level = 0;
  let nearest: Unit | null = null;
  let nearestDist = Infinity;
  for (const u of enemyGnomes(state, player)) {
    const d = manhattan(u.pos, home);
    if (d > HOME_THREAT_RADIUS) continue;
    level += d === 0 ? 5 : HOME_THREAT_RADIUS + 1 - d;
    if (d < nearestDist) {
      nearestDist = d;
      nearest = u;
    }
  }
  return { level, home, nearest };
}

/** Total force a seat can still bring: gnomes on the board plus reserves. */
export function forceOf(state: GameState, player: PlayerId): number {
  return gnomesOnBoard(state, player) + reserveGnomes(state, player);
}

/**
 * Our TEAM's force minus the strongest surviving enemy team's. Positive =
 * ahead. Counting partners on our side of the ledger is what stops an AI
 * reading a 2v2 it is winning as a game it is losing.
 */
export function materialEdge(state: GameState, player: PlayerId): number {
  const byTeam = new Map<number, number>();
  for (const p of state.players) {
    if (p.status !== 'playing') continue;
    const team = teamOf(state, p.id);
    byTeam.set(team, (byTeam.get(team) ?? 0) + forceOf(state, p.id));
  }
  const ours = byTeam.get(teamOf(state, player)) ?? 0;
  let best = 0;
  for (const [team, force] of byTeam) {
    if (team === teamOf(state, player)) continue;
    best = Math.max(best, force);
  }
  return ours - best;
}

/** Enemy homes still standing, in seat order (stable). Never a partner's. */
function livingEnemyHomes(state: GameState, player: PlayerId): Array<{ player: PlayerId; pos: Pos }> {
  const out: Array<{ player: PlayerId; pos: Pos }> = [];
  for (const p of state.players) {
    if (areAllies(state, p.id, player) || p.status !== 'playing') continue;
    const g = gardenAt(state, p.homePos);
    if (g && g.type === 'home' && g.owner === p.id) out.push({ player: p.id, pos: p.homePos });
  }
  return out;
}

/** Distance from our nearest gnome to `pos`, or Infinity if we have none. */
function ownDistanceTo(state: GameState, player: PlayerId, pos: Pos): number {
  let best = Infinity;
  for (const u of ownGnomes(state, player)) best = Math.min(best, manhattan(u.pos, pos));
  return best;
}

/**
 * How ripe an opponent is for a finishing push: a weak, poorly garrisoned home
 * we already have gnomes near. Zero when we are nowhere close.
 */
function homeVulnerability(state: GameState, player: PlayerId, target: { player: PlayerId; pos: Pos }): number {
  const dist = ownDistanceTo(state, player, target.pos);
  if (!Number.isFinite(dist)) return 0;
  const garrison = playerUnitsAt(state, target.pos, target.player).length;
  const force = forceOf(state, target.player);
  return Math.max(0, 10 - dist) + Math.max(0, 6 - force) * 1.5 - garrison * 2.5;
}

// ---------------------------------------------------------------------------
// Level 1 — strategic state
// ---------------------------------------------------------------------------

/**
 * Score every posture and take the best, with hysteresis: the incumbent keeps a
 * small bonus so the CPU does not flicker between DEFEND and PRESSURE on a
 * one-point swing. Postures are scored, not branched into, so tuning one number
 * shifts behaviour without rewriting a condition tree.
 */
export function chooseStrategy(
  state: GameState,
  player: PlayerId,
  personality: AiPersonality,
  current: StrategicState | null,
): StrategicState {
  const threat = homeThreat(state, player);
  const edge = materialEdge(state, player);
  const force = forceOf(state, player);
  const homeless = ownHomePos(state, player) === null;

  let bestVulnerability = 0;
  for (const h of livingEnemyHomes(state, player)) {
    bestVulnerability = Math.max(bestVulnerability, homeVulnerability(state, player, h));
  }

  // The longer the game runs, the less a posture of waiting at home can win it.
  const guard = defenseDecay(state);
  const push = offensePush(state);

  const scores: Record<StrategicState, number> = {
    // Growth is the floor: always a live option, strongest while we are small —
    // but a game nobody is winning is not won by planting another Dandelion, so
    // it fades on the same ramp as DEFEND.
    EXPAND: (18 + Math.max(0, 8 - force) * 2) * personality.expansion * guard,
    DEFEND: threat.level * 7 * personality.defense * guard,
    PRESSURE: (6 + Math.max(0, edge) * 5) * personality.aggression * push,
    // Real danger: few gnomes left, nothing in reserve, or no home at all.
    SURVIVE:
      (Math.max(0, 5 - force) * 9 + (homeless ? 22 : 0) + Math.max(0, -edge) * 3) * personality.defense * guard,
    FINISH: bestVulnerability * 3.2 * personality.homeAttackPreference * push,
  };

  let best: StrategicState = 'EXPAND';
  let bestScore = -Infinity;
  for (const key of Object.keys(scores) as StrategicState[]) {
    const score = scores[key] + (key === current ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Level 2 — objective proposal
// ---------------------------------------------------------------------------

/** A candidate objective and what it is worth right now. */
export interface ScoredObjective {
  objective: Objective;
  score: number;
}

/**
 * Every objective worth considering this turn, best first.
 *
 * Each candidate is scored on one shared scale (roughly 0–60) so different
 * concerns compete directly — a threatened home is simply worth more points
 * than a distant Mushroom, rather than short-circuiting the decision.
 */
export function proposeObjectives(
  state: GameState,
  player: PlayerId,
  strategy: StrategicState,
  personality: AiPersonality,
): ScoredObjective[] {
  const turn = state.turn?.number ?? 0;
  const out: ScoredObjective[] = [];
  const add = (objective: Objective) => {
    const score = scoreObjective(state, player, objective, strategy, personality);
    if (score > 0) out.push({ objective, score });
  };

  const threat = homeThreat(state, player);
  if (threat.home) add({ kind: 'DEFEND_HOME', targetPos: threat.home, adoptedOnTurn: turn });

  for (const h of livingEnemyHomes(state, player)) {
    add({ kind: 'ATTACK_ENEMY_HOME', targetPos: h.pos, targetPlayer: h.player, adoptedOnTurn: turn });
  }

  for (const c of captureCandidates(state, player)) {
    add({ kind: 'CAPTURE_GARDEN', targetPos: c.pos, gardenType: c.type, adoptedOnTurn: turn });
  }

  // Stable ordering: score, then position, so equal candidates never flap.
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.objective.targetPos.y - b.objective.targetPos.y ||
      a.objective.targetPos.x - b.objective.targetPos.x,
  );
  return out;
}

/**
 * What one objective — proposed or already held — is worth right now.
 *
 * Every score in the layer comes through here, and that is the point. The first
 * version scored proposals in `proposeObjectives` and then valued the CURRENT
 * objective by looking it up among them; `captureCandidates` returns only the
 * plausible few, so an objective that slipped out of that shortlist valued at
 * zero and was abandoned on the spot — which quietly defeated the persistence
 * the whole layer exists for (measured: a seat alternating garden / attack /
 * garden on consecutive turns). One scorer, callable for any objective, is what
 * makes "is my plan still worth it?" and "is that plan better?" the same
 * question asked twice.
 */
export function scoreObjective(
  state: GameState,
  player: PlayerId,
  objective: Objective,
  strategy: StrategicState,
  personality: AiPersonality,
): number {
  const bias = POSTURE_BIAS[strategy][objective.kind];
  switch (objective.kind) {
    case 'DEFEND_HOME': {
      const threat = homeThreat(state, player);
      if (!threat.home) return 0;
      return threat.level * 8 * personality.defense * bias * defenseDecay(state);
    }
    case 'ATTACK_ENEMY_HOME': {
      const dist = ownDistanceTo(state, player, objective.targetPos);
      if (!Number.isFinite(dist)) return 0;
      const owner = objective.targetPlayer;
      const garrison =
        owner === undefined ? 0 : playerUnitsAt(state, objective.targetPos, owner).length;
      return (
        (16 + Math.max(0, 14 - dist) * 1.4 - (garrison * 4) / personality.riskTolerance) *
        personality.aggression *
        personality.homeAttackPreference *
        bias *
        offensePush(state)
      );
    }
    case 'CAPTURE_GARDEN': {
      const raw = captureValue(state, player, objective.targetPos, personality);
      if (raw === null) return 0;
      return raw * personality.expansion * personality.gardenPreference * bias * defenseDecay(state);
    }
  }
}

/**
 * What walking onto the garden at `pos` is worth, before posture and taste:
 * the garden's standing value, less the walk, less whoever is standing on it.
 * `null` when there is no garden there, we already hold it, or we cannot reach
 * it at all.
 */
function captureValue(
  state: GameState,
  player: PlayerId,
  pos: Pos,
  personality: AiPersonality,
): number | null {
  const g = gardenAt(state, pos);
  if (!g || g.type === 'home') return null;
  if (playerUnitsAt(state, pos, player).some((u) => u.kind === 'gnome')) return null; // already ours
  const dist = ownDistanceTo(state, player, pos);
  if (!Number.isFinite(dist)) return null;
  const defenders = enemyUnitsAt(state, pos, player).length;
  // Gardens near our own home are cheaper to hold once taken.
  const holdBonus = Math.max(0, 4 - manhattan(pos, state.players[player].homePos) / 2);
  // A well-defended garden is worth less to WANT, not just harder to reach:
  // this is the "six gnomes moved onto my Mushroom" abandonment signal.
  return GARDEN_VALUE[g.type] + holdBonus - dist * 1.2 - (defenders * 5) / personality.riskTolerance;
}

/**
 * Gardens worth PROPOSING. Only the plausible few are ever adopted, so this
 * shortlist keeps objective selection cheap — but it is a shortlist for
 * proposals only. Valuing an objective we already hold goes through
 * `captureValue` directly, which has no such cutoff.
 */
function captureCandidates(state: GameState, player: PlayerId): Array<{ pos: Pos; type: GardenType }> {
  const scored: Array<{ pos: Pos; type: GardenType; raw: number }> = [];
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type === 'home') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    const raw = captureValue(state, player, pos, PROPOSAL_TASTE);
    if (raw === null) continue;
    scored.push({ pos, type: g.type, raw });
  }
  scored.sort((a, b) => b.raw - a.raw || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
  return scored.slice(0, CAPTURE_SHORTLIST).map(({ pos, type }) => ({ pos, type }));
}

/** How many gardens are even considered as a new objective each turn. */
const CAPTURE_SHORTLIST = 6;

/**
 * Neutral weights for building the shortlist. Personality decides how much a
 * garden is WANTED (`scoreObjective`); which gardens are worth looking at is a
 * board question, and using the seat's own risk tolerance here would let a
 * timid seat shortlist nothing at all.
 */
const PROPOSAL_TASTE: AiPersonality = {
  name: 'shortlist',
  aggression: 1,
  defense: 1,
  expansion: 1,
  whimsyPreference: 1,
  riskTolerance: 1,
  gardenPreference: 1,
  homeAttackPreference: 1,
  objectiveFocus: 1,
  explorationBand: 0,
};

// ---------------------------------------------------------------------------
// Level 2b — lifetimes
// ---------------------------------------------------------------------------

/** Is this objective done, dead, or still live? */
export function objectiveStatus(state: GameState, player: PlayerId, objective: Objective): ObjectiveStatus {
  switch (objective.kind) {
    case 'DEFEND_HOME': {
      const home = ownHomePos(state, player);
      if (!home) return 'failed'; // nothing left to defend
      return homeThreat(state, player).level > 0 ? 'active' : 'complete';
    }
    case 'CAPTURE_GARDEN': {
      const g = gardenAt(state, objective.targetPos);
      if (!g || (objective.gardenType && g.type !== objective.gardenType)) return 'failed';
      const held = playerUnitsAt(state, objective.targetPos, player).some((u) => u.kind === 'gnome');
      return held ? 'complete' : 'active';
    }
    case 'ATTACK_ENEMY_HOME': {
      const held = playerUnitsAt(state, objective.targetPos, player).some((u) => u.kind === 'gnome');
      if (held) return 'complete';
      const g = gardenAt(state, objective.targetPos);
      // Somebody else took it, or the owner is out: the plan is spent either way.
      if (!g || g.type !== 'home' || g.owner !== objective.targetPlayer) return 'failed';
      const owner = objective.targetPlayer !== undefined ? state.players[objective.targetPlayer] : undefined;
      if (!owner || owner.status !== 'playing') return 'failed';
      return 'active';
    }
  }
}

/**
 * What the objective is worth NOW, on the same scale `proposeObjectives` uses.
 * This is the abandonment check: the Mushroom that six gnomes moved onto scores
 * far below what it did when it was empty, and a challenger can take over.
 */
export function objectiveValue(
  state: GameState,
  player: PlayerId,
  objective: Objective,
  strategy: StrategicState,
  personality: AiPersonality,
): number {
  return scoreObjective(state, player, objective, strategy, personality);
}

/** Two objectives are the same plan if they aim the same kind at the same place. */
export function sameObjective(a: Objective, b: Objective): boolean {
  return a.kind === b.kind && a.targetPos.x === b.targetPos.x && a.targetPos.y === b.targetPos.y;
}

// ---------------------------------------------------------------------------
// Level 3 — interrupts and plan maintenance
// ---------------------------------------------------------------------------

/**
 * The one interrupt the first milestone ships: our home is under real threat
 * and we are not already dealing with it. Returned as an objective to PUSH,
 * leaving whatever we were doing underneath it, intact.
 */
export function urgentInterrupt(
  state: GameState,
  player: PlayerId,
  stack: readonly Objective[],
): Objective | null {
  const threat = homeThreat(state, player);
  // The bar for dropping everything rises as the game drags on, for the same
  // reason `defenseDecay` exists: a permanent loiterer must stop being an
  // emergency, or the plan never gets back off the stack.
  if (!threat.home || threat.level < INTERRUPT_THRESHOLD / defenseDecay(state)) return null;
  if (stack.some((o) => o.kind === 'DEFEND_HOME')) return null; // already on it
  return {
    kind: 'DEFEND_HOME',
    targetPos: threat.home,
    adoptedOnTurn: state.turn?.number ?? 0,
    interrupt: true,
  };
}

/**
 * Advance the seat's plan to fit the current board and return the objective
 * that should drive scoring — the top of the stack.
 *
 * The order matters and is the whole behaviour of the layer:
 *
 *   1. retire finished/dead objectives from the top down (an interrupt that is
 *      done uncovers the plan it suspended — this is the "returns to what it
 *      was doing" step),
 *   2. re-read the posture,
 *   3. push an interrupt if something urgent is happening,
 *   4. adopt a base objective only if we have none, or a challenger clears
 *      `SWITCH_MARGIN` and we are on a NEW TURN. Step 4's turn gate is what
 *      stops the plan being rebuilt between two actions of the same turn.
 *
 * Mutates `plan` in place; it is the caller's own remembered state.
 */
export function updatePlan(
  state: GameState,
  player: PlayerId,
  plan: AiPlan,
  personality: AiPersonality,
): Objective | null {
  const turn = state.turn?.number ?? 0;

  // 1. Retire anything finished or dead, top down.
  while (plan.stack.length > 0) {
    const top = plan.stack[plan.stack.length - 1];
    if (objectiveStatus(state, player, top) === 'active') break;
    plan.stack.pop();
  }

  // 2. Posture.
  plan.strategy = chooseStrategy(state, player, personality, plan.strategy);

  // 3. Interrupt.
  const interrupt = urgentInterrupt(state, player, plan.stack);
  if (interrupt) {
    plan.stack.push(interrupt);
    return interrupt;
  }

  // 4. Base objective. Only reconsidered on a fresh turn (or when we have none),
  //    which is what makes an objective persist across a turn's worth of actions.
  const base = plan.stack.length > 0 ? plan.stack[plan.stack.length - 1] : null;
  const newTurn = turn !== plan.plannedOnTurn;
  if (base && !newTurn) return base;

  if (!base || newTurn) {
    const candidates = proposeObjectives(state, player, plan.strategy, personality);
    const challenger = candidates[0];
    if (challenger) {
      if (!base) {
        plan.stack.push(challenger.objective);
        plan.plannedOnTurn = turn;
        return challenger.objective;
      }
      const currentValue = objectiveValue(state, player, base, plan.strategy, personality);
      if (!sameObjective(challenger.objective, base) && challenger.score > currentValue + SWITCH_MARGIN) {
        // Abandon: the plan stopped being the best use of our turn.
        plan.stack[plan.stack.length - 1] = challenger.objective;
        plan.plannedOnTurn = turn;
        return challenger.objective;
      }
    }
    plan.plannedOnTurn = turn;
  }
  return plan.stack.length > 0 ? plan.stack[plan.stack.length - 1] : null;
}

/** One line of plain English for a plan — for tests, the log, and debugging. */
export function describeObjective(objective: Objective | null): string {
  if (!objective) return 'no plan';
  switch (objective.kind) {
    case 'CAPTURE_GARDEN':
      return `take the ${objective.gardenType ?? 'garden'} at (${objective.targetPos.x},${objective.targetPos.y})`;
    case 'DEFEND_HOME':
      return 'defend home';
    case 'ATTACK_ENEMY_HOME':
      return `attack player ${objective.targetPlayer}'s home`;
  }
}
