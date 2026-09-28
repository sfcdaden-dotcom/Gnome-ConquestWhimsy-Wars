/**
 * Reading the opponent: what is each enemy gnome heading for?
 *
 * The fly snapshots every enemy gnome's position at the start of each of its
 * own turns. From how a gnome has moved since a few snapshots ago, and where it
 * stands now, it guesses the gnome's destination among a few candidates:
 *
 *   flyHome     the fly's Home Garden          (an assault on us)
 *   flyGarden   an economy garden the fly holds (a raid)
 *   ownHome     the gnome's own Home            (going back to defend)
 *   center      the Center Star                 (neutral ground)
 *
 * Each candidate scores "closing in on it" plus "already near it", tilted by
 * the opponent's habits (`OpponentProfile` — how often this opponent's gnomes
 * have been read as going for each kind before), and the scores become
 * probabilities. Summed over gnomes this gives:
 *
 *  - predicted threat per fly asset, for reinforcing it BEFORE raiders arrive,
 *  - how hostile each enemy gnome is, for intercepting the ones coming for us,
 *  - how exposed each enemy Home is, for counterattacking a committed opponent.
 *
 * Pure reads of the state plus the fly's own snapshots. Deterministic.
 */

import type { GameState, PlayerId, Pos, UnitId } from '../types';
import { centerPos, gardenAt, manhattan, playerUnitsAt, posKey } from '../helpers';
import { enemyGnomes, ownHomePos } from './util';

/** Tuning for the intent reader. */
export const FLY_INTENT = {
  /** How many of the fly's turns back a heading is measured over. */
  lookback: 2,
  /** Score per space closed on a candidate, per fly turn. */
  progressWeight: 1.5,
  /** Score lost per space still to go. */
  distanceWeight: 0.35,
  /** Softmax temperature: lower = more decisive guesses. */
  temperature: 1.5,
  /** A predicted target further than this is not a threat yet. */
  reach: 6,
  /** Predicted threat on one of our assets at which the fly reinforces it early. */
  anticipateAt: 0.6,
  /** A gnome at least this likely to be after our assets is worth intercepting. */
  interceptAt: 0.5,
  /** Extra pull on advancing toward an enemy Home, per unit of its exposure. */
  counterattack: 1.5,
  /** How strongly an opponent's habits tilt the guesses (0 = ignore them). */
  profileWeight: 1,
  /** A guess this confident is remembered as the opponent's habit. */
  habitAt: 0.6,
};

export type TargetKind = 'flyHome' | 'flyGarden' | 'ownHome' | 'center';
const KINDS: readonly TargetKind[] = ['flyHome', 'flyGarden', 'ownHome', 'center'];

/** How often an opponent's gnomes have been read as heading for each kind. */
export interface OpponentProfile {
  counts: Record<TargetKind, number>;
}

/** Profiles by opponent (see `opponentKey`), kept across games by the host. */
export type OpponentProfiles = Map<string, OpponentProfile>;

/** Where every enemy gnome stood at the start of one of the fly's turns. */
export interface Sighting {
  positions: Record<UnitId, Pos>;
}

export interface FlyIntent {
  /** Predicted threat per fly asset (its Home, its held economy gardens), by posKey. */
  threat: Map<string, number>;
  /** Probability each enemy gnome is after one of the fly's assets. */
  hostile: Map<UnitId, number>;
  /** 0–1 per enemy seat: how undefended its Home is. */
  exposure: Map<PlayerId, number>;
  /** Confident reads this call — the raw material of a profile. */
  habits: Array<{ owner: PlayerId; kind: TargetKind }>;
  /**
   * Enemy gnomes that could land on the fly's Home next turn by any legal
   * route — slides, tunnels, entry chains (filled from flyReach.ts).
   */
  homeReachers: Set<UnitId>;
}

/** The identity a profile is filed under: the opponent's seat name and kind. */
export function opponentKey(state: GameState, owner: PlayerId): string {
  const p = state.players[owner];
  return `${p.controller}:${p.name}`;
}

/** Economy gardens with one of `player`'s gnomes on them. */
export function heldEconomyGardens(state: GameState, player: PlayerId): Pos[] {
  const out: Pos[] = [];
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'dandelion' && g.type !== 'mushroom' && g.type !== 'maize') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    if (playerUnitsAt(state, pos, player).some((u) => u.kind === 'gnome')) out.push(pos);
  }
  return out;
}

export function snapshot(state: GameState, player: PlayerId): Sighting {
  const positions: Record<UnitId, Pos> = {};
  for (const u of enemyGnomes(state, player)) positions[u.id] = { ...u.pos };
  return { positions };
}

export function readIntent(
  state: GameState,
  player: PlayerId,
  sightings: readonly Sighting[],
  profiles: OpponentProfiles,
): FlyIntent {
  const P = FLY_INTENT;
  const intent: FlyIntent = {
    threat: new Map(),
    hostile: new Map(),
    exposure: new Map(),
    habits: [],
    homeReachers: new Set(),
  };

  const assets: Array<{ kind: TargetKind; pos: Pos }> = [];
  const home = ownHomePos(state, player);
  if (home) assets.push({ kind: 'flyHome', pos: home });
  for (const pos of heldEconomyGardens(state, player)) assets.push({ kind: 'flyGarden', pos });

  const back = Math.min(P.lookback, sightings.length - 1);
  const past = back > 0 ? sightings[sightings.length - 1 - back] : null;
  const center = centerPos(state);

  for (const u of enemyGnomes(state, player)) {
    const theirHome = state.players[u.owner].homePos;
    const g = gardenAt(state, theirHome);
    const candidates = [...assets];
    if (g && g.type === 'home' && g.owner === u.owner) candidates.push({ kind: 'ownHome', pos: theirHome });
    candidates.push({ kind: 'center', pos: center });

    const before = past?.positions[u.id];
    const prior = habitPrior(profiles.get(opponentKey(state, u.owner)));
    const scores = candidates.map((c) => {
      const now = manhattan(u.pos, c.pos);
      const progress = before ? (manhattan(before, c.pos) - now) / back : 0;
      return (P.progressWeight * progress - P.distanceWeight * now + P.profileWeight * prior[c.kind]) / P.temperature;
    });
    const top = Math.max(...scores);
    const weights = scores.map((s) => Math.exp(s - top));
    const total = weights.reduce((a, b) => a + b, 0);

    let hostile = 0;
    let best = 0;
    candidates.forEach((c, i) => {
      const p = weights[i] / total;
      if (p > weights[best] / total) best = i;
      if (c.kind === 'flyHome' || c.kind === 'flyGarden') {
        hostile += p;
        const closeness = Math.max(0, 1 - manhattan(u.pos, c.pos) / P.reach);
        const key = posKey(c.pos);
        intent.threat.set(key, (intent.threat.get(key) ?? 0) + p * closeness);
      }
    });
    intent.hostile.set(u.id, hostile);
    // Only a gnome that actually closed on its likeliest target reveals a habit;
    // one standing guard says nothing about where this opponent attacks.
    const closed = before ? manhattan(before, candidates[best].pos) - manhattan(u.pos, candidates[best].pos) : 0;
    if (closed > 0 && weights[best] / total >= P.habitAt) {
      intent.habits.push({ owner: u.owner, kind: candidates[best].kind });
    }
  }

  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const g = gardenAt(state, p.homePos);
    if (!g || g.type !== 'home' || g.owner !== p.id) continue;
    const defenders = enemyGnomes(state, player).filter(
      (u) => u.owner === p.id && manhattan(u.pos, p.homePos) <= 1,
    ).length;
    intent.exposure.set(p.id, defenders === 0 ? 1 : defenders === 1 ? 0.3 : 0);
  }
  return intent;
}

/** File this turn's confident reads under each opponent's profile. */
export function recordHabits(state: GameState, intent: FlyIntent, profiles: OpponentProfiles): void {
  for (const h of intent.habits) {
    const key = opponentKey(state, h.owner);
    let profile = profiles.get(key);
    if (!profile) {
      profile = { counts: { flyHome: 0, flyGarden: 0, ownHome: 0, center: 0 } };
      profiles.set(key, profile);
    }
    profile.counts[h.kind] += 1;
  }
}

/** Log-odds tilt per kind from a profile; all zero for an unknown opponent. */
function habitPrior(profile: OpponentProfile | undefined): Record<TargetKind, number> {
  const prior = { flyHome: 0, flyGarden: 0, ownHome: 0, center: 0 };
  if (!profile) return prior;
  const total = KINDS.reduce((a, k) => a + profile.counts[k], 0);
  for (const k of KINDS) prior[k] = Math.log(((profile.counts[k] + 1) / (total + KINDS.length)) * KINDS.length);
  return prior;
}
