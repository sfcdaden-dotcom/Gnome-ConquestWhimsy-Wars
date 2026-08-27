/**
 * Positional scoring: how good is it to stand somewhere, and how good is each
 * Action-Phase action.
 *
 * Everything here is a pure function of `GameState` — no memoization, no
 * per-turn caches, no randomness — so the CPU stays deterministic and a seeded
 * game replays identically. `scoreDestination` is the shared currency: moves,
 * slides, tunnels, snail moves and the free-move cards are all rated on it, so
 * a card play and a board move can be compared directly.
 */

import { areAllies } from '../teams';
import type { Action, GameState, PlantableGardenType, PlayerId, Pos } from '../types';
import {
  centerPos,
  enemyUnitsAt,
  gardenAt,
  gardenIsActive,
  gnomeBoardCap,
  gnomesOnBoard,
  manhattan,
  playerUnitsAt,
  reserveGnomes,
  samePos,
  wishCap,
} from '../helpers';
import { desperation, isHard } from './util';

/**
 * Nearest enemy home garden still standing, else the center.
 *
 * (History: a Hard-only proactive "pincer / spread across homes" bias once lived
 * here. It was removed after measurement — on an open board the shortest face is
 * the same for every attacker and a bias strong enough to force side-face
 * detours only wastes tempo against an undefended home, while the pathfinder
 * ALREADY re-routes the force around a face the enemy actually walls, i.e. it
 * pincers exactly when a pincer helps. See TECH_DEBT.md.)
 */
export function primaryTarget(state: GameState, player: PlayerId, from: Pos): Pos {
  let best: Pos | null = null;
  let bestDist = Infinity;
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const g = gardenAt(state, p.homePos);
    if (!g || g.type !== 'home' || g.owner !== p.id) continue;
    const dist = manhattan(from, p.homePos);
    if (dist < bestDist) {
      bestDist = dist;
      best = p.homePos;
    }
  }
  return best ?? centerPos(state);
}

export function isDangerousFlytrap(state: GameState, pos: Pos): boolean {
  const g = gardenAt(state, pos);
  return !!g && g.type === 'flytrap' && gardenIsActive(state, g) && g.stunnedForPlayerTurn === null;
}

/**
 * BFS distance field from `target`, routing around obstacles: spaces holding
 * enemy critters and active flytraps are impassable (except the target itself,
 * so the final assault square still scores). Unreachable squares fall back to
 * manhattan distance + a large penalty so they still order sensibly.
 */
export function distanceField(state: GameState, player: PlayerId, target: Pos): number[] {
  const n = state.config.boardSize;
  const idx = (p: Pos) => p.y * n + p.x;
  const dist = new Array<number>(n * n).fill(Infinity);
  const queue: Pos[] = [target];
  dist[idx(target)] = 0;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const d of [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]) {
      const next = { x: cur.x + d.x, y: cur.y + d.y };
      if (next.x < 0 || next.y < 0 || next.x >= n || next.y >= n) continue;
      if (dist[idx(next)] !== Infinity) continue;
      if (enemyUnitsAt(state, next, player).length > 0 || isDangerousFlytrap(state, next)) continue;
      dist[idx(next)] = dist[idx(cur)] + 1;
      queue.push(next);
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (dist[y * n + x] === Infinity) dist[y * n + x] = manhattan({ x, y }, target) + 100;
    }
  }
  return dist;
}

/** Score arriving on `to` (used for moves, slides and tunnels). */
export function scoreDestination(state: GameState, player: PlayerId, from: Pos, to: Pos): number {
  let score = 0;
  const target = primaryTarget(state, player, from);
  const n = state.config.boardSize;
  const dist = distanceField(state, player, target);
  score += (dist[from.y * n + from.x] - dist[to.y * n + to.x]) * 2; // advance (routes around stacks)

  if (state.config.centerStar && samePos(to, centerPos(state))) score += 4;
  if (isDangerousFlytrap(state, to)) score -= 40;

  const enemies = enemyUnitsAt(state, to, player);
  if (enemies.length === 0 && !samePos(to, from)) {
    // Anti-balling: keep ~1–2 friendly gnomes per square. `friendlies` excludes
    // the mover (still at `from`), so it is the stack height this move would
    // land onto; the resulting stack is one higher. A 3rd gnome onto a square is
    // discouraged and a 4th strongly so — but only on an empty (non-fight)
    // destination, since piling in for an actual fight is governed by the
    // win-probability branch below, not by spreading.
    const friendlies = playerUnitsAt(state, to, player).filter((u) => u.kind === 'gnome').length;
    if (friendlies >= 3) score -= 24;
    else if (friendlies === 2) score -= 8;
    else if (friendlies === 1) score -= 1;
  }
  if (enemies.length > 0) {
    const destGarden = gardenAt(state, to);
    const attackingHome =
      !!destGarden &&
      destGarden.type === 'home' &&
      destGarden.owner !== undefined &&
      !areAllies(state, destGarden.owner, player);
    const difficulty = state.players[player].difficulty;
    if (difficulty === 'easy') {
      // Easy: no late-game push, and barely weighs being outnumbered —
      // walks into bad fights a Normal/Hard opponent would decline.
      score += (attackingHome ? 15 : 4) - 3 * enemies.length;
    } else if (difficulty === 'hard') {
      // Hard: an actual win-probability calculation instead of a flat
      // threshold. Stack fights are repeated fair 1v1 rounds until one side
      // is wiped (RULES.md "Fights") — a classic gambler's-ruin, so with 1
      // attacker vs `enemies.length` defenders, P(attacker wins) = 1 / (1 +
      // enemies.length). `effectiveAttackers` folds in a bounded late-game
      // push (replaces Normal's flat desperation ramp with the same shape,
      // applied inside the probability instead of on top of it).
      const effectiveAttackers = 1 + desperation(state) * 0.15;
      const winProb = effectiveAttackers / (effectiveAttackers + enemies.length);
      const winPayoff = attackingHome ? 20 : 6;
      const losePenalty = 10;
      score += winProb * winPayoff - (1 - winProb) * losePenalty;
    } else {
      // 1v1 fights are coin flips: only worth it when storming a home or when
      // we are not outnumbered on arrival. Late-game desperation ramps up so
      // turtled stalemates still end (fights bleed reinforcements, and
      // reinforcement exhaustion eliminates): the longer the game runs, the
      // less a defended home scares us. Stateless and deterministic.
      const d = desperation(state);
      score += (attackingHome ? 15 + d * 3 : 4) - (8 - d) * enemies.length;
    }
  }
  return score;
}

/**
 * What passing is worth: just above doing something actively bad, just below
 * anything actively useful. Exported because the objective layer needs to know
 * where the "do nothing" line sits so it never argues for crossing it (see
 * `chooseAiActionInner`).
 */
export const END_TURN_SCORE = 0.1;

export function scoreActionPhase(state: GameState, player: PlayerId, action: Action): number {
  const p = state.players[player];
  switch (action.type) {
    case 'move': {
      const unit = state.units[action.unitId];
      if (!unit) return -Infinity;
      let score = scoreDestination(state, player, unit.pos, action.to);
      // Flee gardens that will bite us at our next harvest.
      const here = gardenAt(state, unit.pos);
      if (here && here.type === 'flytrap' && !isDangerousFlytrap(state, action.to)) score += 10;
      // Never strip the last defender off our own home (unless it is our only
      // gnome — a lone gnome camping forever would stall the early game).
      const g = gardenAt(state, unit.pos);
      if (g && g.type === 'home' && g.owner === player) {
        const defenders = playerUnitsAt(state, unit.pos, player).length;
        if (defenders <= 1 && gnomesOnBoard(state, player) >= 2) score -= 12;
        else if (defenders <= 1 && enemyNear(state, player, unit.pos, 3)) score -= 6;
      }
      // Work the economy cluster. Landing a gnome on one of our own, currently
      // unheld economy gardens is worth a little (it will harvest there next
      // turn), which draws passing gnomes onto the cluster instead of past it.
      const dest = gardenAt(state, action.to);
      if (
        (dest?.type === 'dandelion' || dest?.type === 'mushroom') &&
        playerUnitsAt(state, action.to, player).every((u) => u.kind !== 'gnome')
      ) {
        score += 2;
      }
      // Hold the cluster: don't pull the sole gnome off one of our economy
      // gardens. The base pull erodes with the same late-game desperation ramp
      // used elsewhere (so a turtled game still breaks open and terminates),
      // with an extra bump to dig in while an enemy is closing on the garden.
      if (g?.type === 'dandelion' || g?.type === 'mushroom') {
        const holders = playerUnitsAt(state, unit.pos, player).filter((u) => u.kind === 'gnome').length;
        if (holders <= 1) {
          let hold = Math.max(0, 3 - desperation(state));
          if (enemyNear(state, player, unit.pos, 3)) hold += 4;
          score -= hold;
        }
      }
      return score;
    }
    case 'plant': {
      if (p.wishes < 2) return -Infinity; // keep a wish buffer
      const home = p.homePos;
      if (action.gardenType === 'mushroom' || action.gardenType === 'dandelion') {
        // Economy gardens are built as ONE defended cluster near home, capped by
        // how many already sit near home — counted whether or not a gnome is
        // currently standing on them. This stops the old behaviour where the AI
        // planted a fresh garden every time a holder wandered off (occupancy
        // counting made the near-home total look empty again), trailing a line
        // of abandoned Mushroom Gardens across the board, and keeps the economy
        // somewhere the AI's gnomes can actually hold and defend it.
        if (manhattan(action.pos, home) > ECONOMY_CLUSTER_RADIUS) return -1;
        const cluster = economyGardensNearHome(state, player, ECONOMY_CLUSTER_RADIUS);
        if (action.gardenType === 'mushroom') {
          return cluster < 2 && reserveGnomes(state, player) >= 6 ? 9 : -1;
        }
        return cluster < 3 ? 8 : -1; // dandelion
      }
      if (action.gardenType === 'maize' || action.gardenType === 'flytrap') {
        if (isHard(state, player)) {
          // Hard doesn't wall in its own base (that only limits its own
          // flexibility). It drops these on an ENEMY's expected attack lane
          // instead — opportunistically, since we plant where we already stand.
          return scoreForwardDeterrent(state, player, action.pos, action.gardenType);
        }
        // Normal / Easy: guard our own approach near home. Maize taxes any unit
        // exiting it and the flytrap bites arrivals; both symmetric, but placed
        // by our home they slow an enemy assault more than they slow our defense.
        if (
          manhattan(action.pos, home) <= 2 &&
          !samePos(action.pos, home) &&
          !hasOwnGardenTypeNearHome(state, player, action.gardenType)
        ) {
          return action.gardenType === 'maize' ? 7 : 6;
        }
        return -1;
      }
      if (action.gardenType === 'tunnel' && anyTunnelOnBoard(state) && !hasOwnGardenTypeNearHome(state, player, 'tunnel')) {
        // A lone tunnel has nothing to link to; only worth planting once the
        // network already has at least one other node.
        return 5;
      }
      // Slippery: mandatory forced-slide on harvest relocates our own
      // occupant every cycle — a liability for whoever controls it, so the
      // AI never plants one on purpose.
      return -1;
    }
    case 'upgrade': {
      // Upgrades are tile-sticky investments — anyone who takes the garden
      // takes the upgrade — so only buy one on a garden we can actually hold:
      // the defended economy cluster near home. Keep a 1-wish buffer over the
      // 2-wish cost (mirrors the plant buffer).
      if (p.wishes < 3) return -1;
      const g = gardenAt(state, action.pos);
      if (!g) return -Infinity;
      const home = p.homePos;
      if (g.type === 'dandelion' || g.type === 'mushroom') {
        // Golden Dandelion (+1 wish cap while held) / Elder Mushroom (+1 gnome
        // board limit while held). Score just above the corresponding plant:
        // deepening a held garden beats starting an unheld one.
        if (manhattan(action.pos, home) > ECONOMY_CLUSTER_RADIUS) return -1;
        if (g.type === 'mushroom') {
          // The bigger board only pays off when the limit is actually
          // pinching and there are reserves left to spend into the new room.
          const room = gnomeBoardCap(state, player) - gnomesOnBoard(state, player);
          if (room > 1 || reserveGnomes(state, player) === 0) return -1;
        }
        return 9.5;
      }
      if (g.type === 'maize') {
        // Thorn Maize: double the toll on a maize already guarding our approach.
        return manhattan(action.pos, home) <= 2 ? 4 : -1;
      }
      // Flytrap bites its upgrader too; slippery/tunnel upgrades are too
      // situational for the heuristic — skip.
      return -1;
    }
    case 'drawCard': {
      // Draw only when wish-rich with hand room: cheap enough not to starve
      // plants/attacks (scores below them and above endTurn's 0.1), and never
      // so full that the draw forces an immediate discard. "Wish-rich" is
      // relative to the cap so a low wish limit (e.g. 3) stays reachable —
      // otherwise the AI could never afford to draw and would never play cards.
      const drawThreshold = Math.min(4, wishCap(state, player));
      return p.wishes >= drawThreshold && p.hand.length <= state.config.handLimit - 2 ? 0.5 : -1;
    }
    case 'playCard':
      // Card plays are scored via planCardPlay in chooseAiAction (they need a
      // target payload); this path is unreachable for playCard.
      return -1;
    case 'endTurn':
      return END_TURN_SCORE;
    default:
      return -Infinity;
  }
}

export function enemyNear(state: GameState, player: PlayerId, pos: Pos, radius: number): boolean {
  for (const u of Object.values(state.units)) {
    if (!areAllies(state, u.owner, player) && manhattan(u.pos, pos) <= radius) return true;
  }
  return false;
}

export function ownedEconomyGardens(state: GameState, player: PlayerId): number {
  // Economy gardens currently occupied (≈ controlled) by this player.
  let count = 0;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'dandelion' && g.type !== 'mushroom') continue;
    const [x, y] = key.split(',').map(Number);
    if (playerUnitsAt(state, { x, y }, player).length > 0) count += 1;
  }
  return count;
}

/**
 * Manhattan radius of the AI's economy "home cluster": how far from home an
 * economy garden still counts as part of the defended cluster, both for the
 * plant-placement guard and the count that caps further planting.
 */
export const ECONOMY_CLUSTER_RADIUS = 3;

/**
 * Count economy gardens (Dandelion / Mushroom) within `radius` of `player`'s
 * home, occupied or not. Unlike `ownedEconomyGardens` this does NOT depend on a
 * gnome currently standing on the garden, so the AI's plant cap stops it from
 * replanting the moment a holder wanders off (the cause of the abandoned-garden
 * trail).
 */
export function economyGardensNearHome(state: GameState, player: PlayerId, radius: number): number {
  const home = state.players[player].homePos;
  let count = 0;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'dandelion' && g.type !== 'mushroom') continue;
    const [x, y] = key.split(',').map(Number);
    if (manhattan({ x, y }, home) <= radius) count += 1;
  }
  return count;
}

function hasOwnGardenTypeNearHome(state: GameState, player: PlayerId, gardenType: PlantableGardenType): boolean {
  const home = state.players[player].homePos;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== gardenType) continue;
    const [x, y] = key.split(',').map(Number);
    if (manhattan({ x, y }, home) <= 2) return true;
  }
  return false;
}

function anyTunnelOnBoard(state: GameState): boolean {
  return Object.values(state.gardens).some((g) => g.type === 'tunnel');
}

/** Is there already a garden of `gardenType` within `radius` of `pos`? */
function gardenTypeNear(state: GameState, gardenType: PlantableGardenType, pos: Pos, radius: number): boolean {
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== gardenType) continue;
    const [x, y] = key.split(',').map(Number);
    if (manhattan({ x, y }, pos) <= radius) return true;
  }
  return false;
}

/**
 * Hard-only: score dropping a maize / flytrap on an enemy's expected attack lane
 * — a square on an enemy's porch (within 2, not the home itself) and on the side
 * facing OUR home, i.e. the step they push off to march at us. Keeping these off
 * our own base preserves our own flexibility ("don't wall yourself in"). It is
 * opportunistic: we plant where we already stand, so this only pays out when a
 * forward gnome is already sitting on such a square and isn't better off storming
 * the home outright (a favorable storm scores higher and wins the comparison).
 *
 * Maize is safe to stand on (it only taxes the Wish of whoever LEAVES), so we
 * happily plant it under ourselves. A flytrap is neutral and bites its occupant
 * at the next harvest, so we only drop one when the planting gnome still has its
 * move this turn and can vacate — the +10 "flee a flytrap" bonus in the move case
 * then walks it off the same turn, leaving an active wall on the enemy's doorstep.
 */
function scoreForwardDeterrent(
  state: GameState,
  player: PlayerId,
  pos: Pos,
  gardenType: 'maize' | 'flytrap',
): number {
  const ourHome = state.players[player].homePos;
  for (const p of state.players) {
    if (p.id === player || p.status !== 'playing') continue;
    const g = gardenAt(state, p.homePos);
    if (!g || g.type !== 'home' || g.owner !== p.id) continue;
    const dEnemy = manhattan(pos, p.homePos);
    if (dEnemy === 0 || dEnemy > 2) continue; // on their porch, not their home, not too far
    if (manhattan(pos, ourHome) >= manhattan(p.homePos, ourHome)) continue; // on the side facing us
    if (gardenTypeNear(state, gardenType, pos, 2)) continue; // one deterrent per lane is enough
    if (gardenType === 'flytrap') {
      const canVacate = playerUnitsAt(state, pos, player).some(
        (u) => u.kind === 'gnome' && u.movedOnTurn !== (state.turn?.number ?? -1),
      );
      if (!canVacate) continue; // would activate under our own planter next harvest
      return 6;
    }
    return 7; // maize
  }
  return -1;
}
