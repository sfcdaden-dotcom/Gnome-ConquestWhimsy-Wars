/**
 * Whimsy Card policy: which card to play, at what target, for what score.
 *
 * `planCardPlay(state, player, cardId)` is the single entry point — one
 * deterministic target picker per card, each checked against the card's own
 * `validate` before it is returned (`tryPlayCard`), so the CPU is structurally
 * incapable of emitting a payload the engine would reject. Scores share the
 * Action-Phase scale in `scoring.ts` (moves ~single digits, home-storm ~15+,
 * plant 6–9, endTurn 0.1), which is what lets a card play be compared directly
 * against a board move.
 *
 * Returning `null` means "hold this card" — either because no target is worth
 * it right now, or deliberately: roll-influencing and shield cards (Snake Eyes,
 * 4 Leaf Clover, Gnomebody Dies) are never spent proactively, they are kept for
 * the respond windows in `decisions.ts` where they actually swing an outcome.
 * Six situational cards are Hard-only (`isHard` gate); Plot Twist is held by
 * every difficulty (see the comment at the bottom of `planCardPlay`).
 */

import { areAllies } from '../teams';
import type { Action, CardId, CardTargets, GameState, PlayerId, Pos, Unit } from '../types';
import { getCardDef } from '../cards';
import {
  canSpawnGnome,
  centerPos,
  enemyUnitsAt,
  gardenAt,
  gardenIsActive,
  manhattan,
  orthNeighbors,
  reserveGnomes,
  samePos,
  unitsAt,
  wishCap,
} from '../helpers';
import { ownedEconomyGardens, scoreDestination } from './scoring';
import {
  DIAGONALS,
  ORTHOGONALS,
  STRAIGHT_TWOS,
  enemyGnomes,
  isHard,
  ownGnomes,
  ownHomePos,
} from './util';

/** A concrete, `validate`-checked play and what it is worth. */
export interface CardPlan {
  action: Action;
  score: number;
}

/**
 * Static "keep value" of a card in hand — higher = more worth holding. Used to
 * choose a discard (pitch the lowest) and to pick the best card to recover with
 * Another Gnomes Treasure. Deterministic; no board context.
 */
export function cardKeepValue(cardId: CardId): number {
  switch (cardId) {
    case 'rocket-propelled-gnome':
    case 'seeing-double':
      return 9;
    case 'mushroom-cloud':
    case 'wild-growth':
    case 'nope-gnome':
      return 8;
    case 'four-leaf-clover':
    case 'gnome-birthday-party':
    case 'gnomebody-dies':
    case 'lawnmower-of-doom':
      return 6;
    case 'snake-eyes':
    case 'gust-of-wind':
    case 'slippery-trail':
    case 'gnome-place-like-home':
    case 'ritual-magic':
    case 'another-gnomes-treasure':
    case 'instigation':
      return 5;
    case 'hidden-passage':
    case 'great-wall-of-whimsy':
      return 4;
    default:
      // sundown-sabotage, pocket-shovel, plot-twist, gnomio-and-juliet,
      // lost-in-the-maize — situational, cheap to pitch.
      return 3;
  }
}

/** Build a playCard action if the card's own validate accepts these targets. */
function tryPlayCard(
  state: GameState,
  player: PlayerId,
  cardId: CardId,
  targets: CardTargets | undefined,
): Action | null {
  const def = getCardDef(cardId);
  if (!def) return null;
  if (def.validate && def.validate(state, player, targets) !== null) return null;
  return targets === undefined
    ? { type: 'playCard', player, cardId }
    : { type: 'playCard', player, cardId, targets };
}

/**
 * Decide the best play (with targets) for one card in hand, or null to hold it.
 * Returns a `validate`-checked action and a score on the Action-Phase scale.
 */
export function planCardPlay(state: GameState, player: PlayerId, cardId: CardId): CardPlan | null {
  switch (cardId) {
    case 'gnome-birthday-party': {
      const gain = Math.min(2, wishCap(state, player) - state.players[player].wishes);
      if (gain <= 0) return null; // at cap: the 2 Wishes would be lost
      const a = tryPlayCard(state, player, cardId, undefined);
      return a ? { action: a, score: gain >= 2 ? 5 : 2 } : null;
    }

    case 'rocket-propelled-gnome': {
      let best: Unit | null = null;
      let bestVal = -Infinity;
      for (const u of enemyGnomes(state, player)) {
        const v = rocketTargetValue(state, player, u);
        if (v > bestVal) {
          bestVal = v;
          best = u;
        }
      }
      if (!best || bestVal < 9) return null; // don't waste a kill on a nobody
      const a = tryPlayCard(state, player, cardId, { units: [best.id] });
      return a ? { action: a, score: bestVal } : null;
    }

    case 'gnome-place-like-home': {
      const home = ownHomePos(state, player);
      const center = state.config.centerStar ? centerPos(state) : null;
      let best: Unit | null = null;
      let bestVal = 0;
      for (const u of enemyGnomes(state, player)) {
        let v = 0;
        if (home && samePos(u.pos, home)) v = 12; // evict an invader from our home
        else if (center && samePos(u.pos, center)) v = 5; // bump off the Center Star
        if (v > bestVal && tryPlayCard(state, player, cardId, { units: [u.id] })) {
          bestVal = v;
          best = u;
        }
      }
      if (!best) return null;
      const a = tryPlayCard(state, player, cardId, { units: [best.id] });
      return a ? { action: a, score: bestVal } : null;
    }

    case 'hidden-passage':
      return planFreeMove(state, player, cardId, DIAGONALS);
    case 'slippery-trail':
      return planFreeMove(state, player, cardId, STRAIGHT_TWOS);
    case 'gust-of-wind':
      return planFreeMove(state, player, cardId, ORTHOGONALS);

    case 'wild-growth':
      return planWildGrowth(state, player);

    case 'seeing-double': {
      if (!canSpawnGnome(state, player)) return null;
      const gnomes = ownGnomes(state, player);
      if (gnomes.length === 0) return null;
      // Prefer cloning a gnome on our home (adds a defender/reserve), else the
      // lowest-id gnome. The clone spawns on the same space.
      const home = ownHomePos(state, player);
      const pick = (home && gnomes.find((u) => samePos(u.pos, home))) ?? gnomes[0];
      const a = tryPlayCard(state, player, cardId, { units: [pick.id] });
      return a ? { action: a, score: 9 } : null;
    }

    case 'mushroom-cloud':
      return planMushroomCloud(state, player);
    case 'lawnmower-of-doom':
      return planLawnmower(state, player);
    case 'instigation':
      return planInstigation(state, player);
    case 'ritual-magic':
      return planSteal(state, player);
    case 'another-gnomes-treasure':
      return planTreasure(state, player);

    // Situational cards: need a board-state read to be worth playing at all,
    // so only Hard bothers (Easy/Normal hold them — see cardKeepValue).
    case 'great-wall-of-whimsy':
      return isHard(state, player) ? planGreatWall(state, player) : null;
    case 'sundown-sabotage':
      return isHard(state, player) ? planSundownSabotage(state, player) : null;
    case 'pocket-shovel':
      return isHard(state, player) ? planPocketShovel(state, player) : null;
    case 'gnomio-and-juliet':
      return isHard(state, player) ? planGnomioAndJuliet(state, player) : null;
    case 'lost-in-the-maize':
      return isHard(state, player) ? planLostInTheMaize(state, player) : null;

    // Plot Twist is held by every difficulty. A Hard-only planner used to swap
    // one of our gnomes into an enemy home holding a lone defender, on the
    // premise that the swap "relocates the defender away with no Entry trigger"
    // for a free capture. It does not: a garden and the critters standing on it
    // move TOGETHER, and the two spaces' contents cross rather than merge, so
    // the defender arrives at the other space still standing on its own home
    // and our gnome lands on the square the home just vacated. The play spent a
    // card to shuffle the enemy's home one space. Removed 2026-07-28; if Plot
    // Twist is planned again, score it on what a swap can actually do
    // (repositioning a garden and its occupants as a unit), and pin the
    // occupancy invariant in a test first.
    default:
      // Roll/shield cards are held for respond windows regardless of difficulty.
      return null;
  }
}

/** Wall the non-Home garden nearest our home that an enemy is currently approaching. */
function planGreatWall(state: GameState, player: PlayerId): CardPlan | null {
  const home = ownHomePos(state, player);
  if (!home) return null;
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type === 'home') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    const distHome = manhattan(pos, home);
    if (distHome > 4) continue; // only worth guarding our own approach
    const threatened = Object.values(state.units).some(
      (u) => !areAllies(state, u.owner, player) && u.kind === 'gnome' && manhattan(u.pos, pos) <= 2,
    );
    if (!threatened) continue;
    if (distHome < bestDist) {
      bestDist = distHome;
      best = pos;
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'great-wall-of-whimsy', { spaces: [best] });
  return a ? { action: a, score: 7 } : null;
}

/** Deny an enemy-occupied economy garden its next harvest. */
function planSundownSabotage(state: GameState, player: PlayerId): CardPlan | null {
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'dandelion' && g.type !== 'mushroom') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    if (enemyUnitsAt(state, pos, player).length === 0) continue;
    const a = tryPlayCard(state, player, 'sundown-sabotage', { spaces: [pos] });
    if (a) return { action: a, score: 4 };
  }
  return null;
}

/** Plant free Tunnel(s) adjacent to our own gnomes (immediate access, no wish cost). */
function planPocketShovel(state: GameState, player: PlayerId): CardPlan | null {
  const required = Math.min(2, state.players[player].supply.tunnel);
  if (required <= 0) return null;
  const n = state.config.boardSize;
  const isEmpty = (pos: Pos) =>
    pos.x >= 0 && pos.y >= 0 && pos.x < n && pos.y < n && !gardenAt(state, pos) && unitsAt(state, pos).length === 0;
  const seen = new Set<string>();
  const spaces: Pos[] = [];
  outer: for (const u of ownGnomes(state, player)) {
    for (const d of ORTHOGONALS) {
      const pos = { x: u.pos.x + d.x, y: u.pos.y + d.y };
      const key = `${pos.x},${pos.y}`;
      if (seen.has(key) || !isEmpty(pos)) continue;
      seen.add(key);
      spaces.push(pos);
      if (spaces.length === required) break outer;
    }
  }
  if (spaces.length < required) return null;
  const a = tryPlayCard(state, player, 'pocket-shovel', { spaces });
  return a ? { action: a, score: 5 } : null;
}

/** Marry two of the SAME opponent's gnomes — pure upside: no cost to us, and any future kill of one takes both. */
function planGnomioAndJuliet(state: GameState, player: PlayerId): CardPlan | null {
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const gnomes = Object.values(state.units).filter((u) => u.owner === p.id && u.kind === 'gnome');
    if (gnomes.length < 2) continue;
    const a = tryPlayCard(state, player, 'gnomio-and-juliet', { units: [gnomes[0].id, gnomes[1].id] });
    if (a) return { action: a, score: 3 };
  }
  return null;
}

/** Trap an enemy gnome that's currently sitting on a Maize Garden. */
function planLostInTheMaize(state: GameState, player: PlayerId): CardPlan | null {
  const trapped = Object.values(state.units).some(
    (u) => !areAllies(state, u.owner, player) && u.kind === 'gnome' && gardenAt(state, u.pos)?.type === 'maize',
  );
  if (!trapped) return null;
  const a = tryPlayCard(state, player, 'lost-in-the-maize', undefined);
  return a ? { action: a, score: 4 } : null;
}

/** How valuable it is to Rocket-destroy this enemy gnome right now. */
function rocketTargetValue(state: GameState, player: PlayerId, u: Unit): number {
  let v = 3;
  const home = ownHomePos(state, player);
  if (home) {
    const d = manhattan(u.pos, home);
    if (d === 0) v += 22; // standing in our home — capture in progress
    else if (d === 1) v += 9; // one step from our home
    else if (d === 2) v += 3;
  }
  if (state.config.centerStar && samePos(u.pos, centerPos(state))) v += 5;
  // Reinforcement pressure: the closer the owner is to running out, the more a
  // kill contributes to eliminating them.
  const owner = state.players[u.owner];
  v += (owner.gnomesLost / state.config.totalReinforcements) * 6;
  return v;
}

/** Minimum destination score for a free card-move to be worth a card. */
const FINISHER_MIN = 12;

/**
 * Free-move cards (Hidden Passage / Slippery Trail / Gust Of Wind on our own
 * gnome). Only spent as a finisher: the destination must score at least
 * FINISHER_MIN (≈ storming a home or seizing the Center Star), since a normal
 * board move is free. `validate` enforces adjacency / straight-line / exit
 * rules, so we only score candidates it accepts.
 */
function planFreeMove(
  state: GameState,
  player: PlayerId,
  cardId: CardId,
  offsets: Pos[],
): CardPlan | null {
  let best: Action | null = null;
  let bestScore = FINISHER_MIN;
  for (const u of ownGnomes(state, player)) {
    for (const off of offsets) {
      const to = { x: u.pos.x + off.x, y: u.pos.y + off.y };
      const a = tryPlayCard(state, player, cardId, { units: [u.id], spaces: [to] });
      if (!a) continue;
      const score = scoreDestination(state, player, u.pos, to);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
  }
  return best ? { action: best, score: bestScore } : null;
}

/** Wild Growth: plant a free economy garden on an empty space near our home. */
function planWildGrowth(state: GameState, player: PlayerId): CardPlan | null {
  const deepReserves = reserveGnomes(state, player) >= 6;
  const fewEconomy = ownedEconomyGardens(state, player) < 2;
  const wanted: Array<'mushroom' | 'dandelion'> =
    deepReserves && fewEconomy ? ['mushroom', 'dandelion'] : ['dandelion', 'mushroom'];
  const gardenType = wanted.find((g) => state.players[player].supply[g] > 0);
  if (!gardenType) return null;

  const home = ownHomePos(state, player) ?? state.players[player].homePos;
  const n = state.config.boardSize;
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const pos = { x, y };
      if (gardenAt(state, pos) !== null || unitsAt(state, pos).length > 0) continue;
      const dist = manhattan(pos, home);
      if (dist < bestDist) {
        bestDist = dist;
        best = pos;
      }
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'wild-growth', { spaces: [best], gardenType });
  return a ? { action: a, score: 7 } : null;
}

/** Mushroom Cloud: nuke the non-Home garden whose stack costs enemies the most. */
function planMushroomCloud(state: GameState, player: PlayerId): CardPlan | null {
  let best: Pos | null = null;
  let bestVal = 6; // threshold: worth it mainly when it kills a gnome
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type === 'home') continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    const occupants = unitsAt(state, pos);
    if (occupants.some((u) => u.owner === player)) continue; // never nuke our own
    let v = occupants.filter((u) => !areAllies(state, u.owner, player) && u.kind === 'gnome').length * 8;
    if (g.type === 'dandelion' || g.type === 'mushroom') v += 3;
    else if (g.type === 'flytrap' && gardenIsActive(state, g)) v += 2;
    if (v > bestVal) {
      bestVal = v;
      best = pos;
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'mushroom-cloud', { spaces: [best] });
  return a ? { action: a, score: bestVal } : null;
}

/** Lawnmower Of Doom: raze a threatening garden orthogonally next to our gnome. */
function planLawnmower(state: GameState, player: PlayerId): CardPlan | null {
  let best: Pos | null = null;
  let bestVal = 5; // threshold
  for (const u of ownGnomes(state, player)) {
    for (const adj of orthNeighbors(state, u.pos)) {
      const g = gardenAt(state, adj);
      if (!g || g.type === 'home') continue;
      let v = 0;
      if (g.type === 'flytrap' && gardenIsActive(state, g) && g.stunnedForPlayerTurn === null) {
        v = 5; // an active flytrap that could bite us
      } else if (
        (g.type === 'dandelion' || g.type === 'mushroom') &&
        enemyUnitsAt(state, adj, player).some((x) => x.kind === 'gnome')
      ) {
        v = 6; // an enemy economy garden they are actively harvesting
      }
      if (v > bestVal && tryPlayCard(state, player, 'lawnmower-of-doom', { spaces: [adj] })) {
        bestVal = v;
        best = adj;
      }
    }
  }
  if (!best) return null;
  const a = tryPlayCard(state, player, 'lawnmower-of-doom', { spaces: [best] });
  return a ? { action: a, score: bestVal } : null;
}

/**
 * Instigation: only used to make two OTHER players' gnomes fight (a free gnome
 * loss for someone else). In a 2-player game there is no enemy-vs-enemy pair,
 * so this holds — pitting our own gnome into a coin-flip is not worth a card.
 */
function planInstigation(state: GameState, player: PlayerId): CardPlan | null {
  const foes = enemyGnomes(state, player);
  for (let i = 0; i < foes.length; i++) {
    for (let j = i + 1; j < foes.length; j++) {
      if (foes[i].owner === foes[j].owner) continue;
      const a = tryPlayCard(state, player, 'instigation', { units: [foes[i].id, foes[j].id] });
      if (a) return { action: a, score: 4 };
    }
  }
  return null;
}

/** Ritual Magic (card): steal from the opponent holding the most cards. */
function planSteal(state: GameState, player: PlayerId): CardPlan | null {
  if (state.players[player].hand.length >= state.config.handLimit) return null;
  let best: PlayerId | null = null;
  let bestCount = 0;
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    if (p.hand.length > bestCount) {
      bestCount = p.hand.length;
      best = p.id;
    }
  }
  if (best === null) return null;
  const a = tryPlayCard(state, player, 'ritual-magic', { players: [best] });
  return a ? { action: a, score: 3 } : null;
}

/** Another Gnomes Treasure: recover the highest-keep-value card from the discard. */
function planTreasure(state: GameState, player: PlayerId): CardPlan | null {
  if (state.discard.length === 0) return null;
  if (state.players[player].hand.length >= state.config.handLimit) return null; // would force a discard
  let best: CardId | null = null;
  let bestVal = -Infinity;
  for (const id of state.discard) {
    const v = cardKeepValue(id);
    if (v > bestVal) {
      bestVal = v;
      best = id;
    }
  }
  if (best === null) return null;
  const a = tryPlayCard(state, player, 'another-gnomes-treasure', { cards: [best] });
  return a ? { action: a, score: 3 } : null;
}
