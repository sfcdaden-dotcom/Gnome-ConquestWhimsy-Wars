/**
 * The Fly's brain in the loop: game → senses → connectome → urges → moves.
 *
 * Once per fly turn, after its Harvest Phase, the board is turned into firing
 * rates on four sensory channels of the circuit cut from the FlyWire
 * connectome (flyCircuitData.ts), the circuit is simulated (flySim.ts), and
 * the rates of four motor/command channels become the turn's urges:
 *
 *   sense  (neurons)                  fed by                               urge  (neurons)
 *   sugar  (LB3 sugar taste)          the harvest just reaped — Wishes,    feed  (MN9, proboscis)
 *                                     new gnomes, gnomes alive — plus a
 *                                     background hum from the NEXT
 *                                     harvest's expected bounty
 *   bitter (LB1 bitter taste)         gnomes lost since last turn          —     (suppresses feeding)
 *   loom   (LPLC2/LC4 looming)        enemy gnomes close to ours: panic    escape  (Giant Fiber)
 *   object (LC9/LC31 object)          enemy gnomes / Homes within reach    approach (DNp09)
 *                                                                          retreat  (MDN moonwalker)
 *
 * Nothing about how senses combine is written here — sugar feeding MN9, bitter
 * damping it, danger or a target in sight shutting appetite off, looming firing
 * the Giant Fiber: those come from the wiring.
 *
 * The urges then act on moves (fly.ts): feeding pulls toward planting,
 * harvesting and taking gardens; approach toward advancing and attacking;
 * escape pulls threatened gnomes to safety and raises the odds a fight needs;
 * retreat damps advancing. And every move carries the "background hum" — how
 * it changes the next harvest's expected bounty — so abandoning an economy
 * garden, or stepping into Maize or a Flytrap, feels worse.
 *
 * Deterministic: the simulation is seeded from the game seed, turn and seat.
 */

import type { Action, GameState, PlayerId, Pos } from '../types';
import {
  enemyUnitsAt,
  gardenAt,
  gardenIsActive,
  gnomeBoardCap,
  gnomesOnBoard,
  manhattan,
  posKey,
  reserveGnomes,
  wishCap,
} from '../helpers';
import type { InputChannel, OutputChannel } from './flySim';
import { OUTPUT_CHANNELS, loadCircuit, simulate } from './flySim';
import type { Circuit } from './flySim';
import { FLY_CIRCUIT } from './flyCircuitData';
import type { FlyGoalId } from './flyGoals';
import { enemyGnomes, ownGnomes, ownHomePos } from './util';

/** Tuning for the brain loop. Rates are in Hz; pulls in Action-Phase score points. */
export const FLY_BRAIN = {
  /** Off = the fly plays on its hand-written drives alone. */
  enabled: true,
  /** Brain time simulated per fly turn, in ms. */
  duration: 150,
  /** Cap on any sensory channel's firing rate. */
  maxRate: 200,
  /** How hard the urges push, relative to the hand-set incentive pulls. */
  weight: 2,
  /** The harvest treat, per unit of bounty just reaped. */
  treat: { perWish: 30, perNewGnome: 45, perAliveGnome: 6 },
  /** The background hum, per unit of the next harvest's expected bounty. */
  hum: 12,
  /** A gnome is worth this many Wishes of bounty. */
  gnomeValue: 1.5,
  /** Panic: enemy gnomes within `radius` of one of ours; closer counts more. */
  panic: { radius: 2, perEnemy: 60 },
  bitterPerGnomeLost: 70,
  /** Object: a lone enemy gnome next to one of ours, or an enemy Home within 2. */
  objectPerTarget: 50,
  /** Pull on a threatened gnome's move to safety, per unit of escape urge. */
  safetyPull: 3,
  /** Pull per unit change in expected next-harvest bounty (the hum, felt per move). */
  bountyPull: 2,
};

export type FlySenses = Record<InputChannel, number>;
export type FlyUrges = Record<OutputChannel, number>;

/** What the fly reaped in its latest Harvest Phase (tallied from events). */
export interface HarvestTally {
  wishes: number;
  gnomes: number;
}

let circuit: Circuit | null = null;
let reference: FlyUrges | null = null;

function theCircuit(): Circuit {
  circuit ??= loadCircuit(FLY_CIRCUIT);
  return circuit;
}

/**
 * Each urge is its output rate relative to a reference: that channel's
 * response to its own natural input at 100 Hz (sugar for feed, loom for escape,
 * object for approach and retreat), measured on this simulator.
 */
function referenceRates(): FlyUrges {
  if (reference) return reference;
  const c = theCircuit();
  const opts = { duration: 300, seed: 1 };
  const feed = simulate(c, { sugar: 100 }, opts).feed;
  const escape = simulate(c, { loom: 100 }, opts).escape;
  const obj = simulate(c, { object: 200 }, opts);
  reference = { feed, escape, approach: obj.approach / 2, retreat: Math.max(obj.retreat, 10) };
  return reference;
}

/** The board as firing rates on the four sensory channels. */
export function flySenses(
  state: GameState,
  player: PlayerId,
  harvest: HarvestTally,
  lostSinceLastTurn: number,
  attraction: Partial<Record<FlyGoalId, number>> = {},
  bliss = 0,
): FlySenses {
  const B = FLY_BRAIN;
  const cap = (x: number) => Math.max(0, Math.min(B.maxRate, x));
  const mine = ownGnomes(state, player);
  const enemies = enemyGnomes(state, player);

  const treat =
    B.treat.perWish * harvest.wishes + B.treat.perNewGnome * harvest.gnomes + B.treat.perAliveGnome * mine.length;
  const hum = B.hum * Math.max(0, expectedBounty(state, player));

  let panic = 0;
  for (const e of enemies) {
    let closest = Infinity;
    for (const u of mine) closest = Math.min(closest, manhattan(u.pos, e.pos));
    if (closest <= B.panic.radius) panic += (B.panic.radius + 1 - closest) / (B.panic.radius + 1);
  }

  // Targets in reach, each weighted by the learned attraction to its goal.
  let targets = 0;
  const gnomeWeight = 1 + (attraction.killGnome ?? 0);
  const homeWeight = 1 + (attraction.captureHome ?? 0);
  for (const u of mine) {
    for (const e of enemies) {
      if (manhattan(u.pos, e.pos) === 1 && enemyUnitsAt(state, e.pos, player).length === 1) targets += gnomeWeight;
    }
  }
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const g = gardenAt(state, p.homePos);
    if (g?.type === 'home' && g.owner === p.id && mine.some((u) => manhattan(u.pos, p.homePos) <= 2)) targets += homeWeight;
  }

  return {
    sugar: cap(treat + hum),
    bitter: cap(B.bitterPerGnomeLost * lostSinceLastTurn),
    loom: cap(B.panic.perEnemy * panic),
    object: cap(B.objectPerTarget * targets + bliss),
  };
}

/** Run the circuit on the senses; each urge is 0 (silent) to ~2 (twice its reference). */
export function flyUrges(senses: FlySenses, seed: number): FlyUrges {
  const rates = simulate(theCircuit(), senses, { duration: FLY_BRAIN.duration, seed });
  const ref = referenceRates();
  const urges = {} as FlyUrges;
  for (const ch of OUTPUT_CHANNELS) urges[ch] = ref[ch] > 0 ? Math.min(3, rates[ch] / ref[ch]) : 0;
  return urges;
}

/**
 * The next harvest's expected bounty, in Wishes (a gnome counts `gnomeValue`):
 * Dandelions and Mushrooms our gnomes hold and that will be active, the Home's
 * 1, minus the expected cost of gnomes standing on an active Flytrap (it fights
 * them at harvest: half a gnome each) and of Maize tolls owed to walk back out.
 *
 * `after` evaluates it as if one move or plant had been made.
 */
export function expectedBounty(state: GameState, player: PlayerId, after?: Action): number {
  const B = FLY_BRAIN;
  const where = new Map<string, number>(); // own gnomes per square
  for (const u of ownGnomes(state, player)) {
    let pos = u.pos;
    if (after?.type === 'move' && after.unitId === u.id) pos = after.to;
    where.set(posKey(pos), (where.get(posKey(pos)) ?? 0) + 1);
  }
  const planted = after?.type === 'plant' ? { key: posKey(after.pos), type: after.gardenType } : null;

  const p = state.players[player];
  let wishes = ownHomePos(state, player) ? 1 : 0;
  let gnomes = 0;
  let cost = 0;
  const gnomeRoom = Math.max(0, Math.min(gnomeBoardCap(state, player) - gnomesOnBoard(state, player), reserveGnomes(state, player)));
  for (const [key, n] of where) {
    const [x, y] = key.split(',').map(Number);
    const pos: Pos = { x, y };
    if (enemyUnitsAt(state, pos, player).length > 0) continue; // contested: no harvest
    const g = gardenAt(state, pos);
    const type = planted?.key === key ? planted.type : g?.type;
    const active = planted?.key === key || (g ? gardenIsActive(state, g) || g.plantedOnTurn === state.turn?.number : false);
    if (!type || !active) continue;
    if (type === 'dandelion') wishes += Math.min(2, n);
    else if (type === 'mushroom') gnomes += Math.min(2, n);
    else if (type === 'flytrap') cost += 0.5 * n * B.gnomeValue;
    else if (type === 'maize') cost += n * (g?.upgraded ? 2 : 1);
  }
  wishes = Math.min(wishes, Math.max(0, wishCap(state, player) - p.wishes) + 1);
  return wishes + B.gnomeValue * Math.min(gnomes, gnomeRoom) - cost;
}

/** Deterministic per-turn seed for the simulation. */
export function brainSeed(state: GameState, player: PlayerId): number {
  return ((state.seed ^ Math.imul(state.turn?.number ?? 0, 2654435761) ^ Math.imul(player + 1, 40503)) >>> 0) || 1;
}
