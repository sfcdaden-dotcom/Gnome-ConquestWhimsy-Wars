/**
 * The Fly: a CPU seat (`difficulty: 'fly'`) steered by drives and a learned
 * reward memory, standing in for a simulated fruit fly brain.
 *
 * It does not replace the objective CPU — it rides on top of it. Every legal
 * action still gets its tactical + objective score; the fly then adds three
 * things, each in one place:
 *
 *   drives        hunger / aggression / fear / alarm, read off the board
 *        ↓        (`flyDrives` — the function a connectome simulation replaces)
 *   bias          per-tag pull: territory > planting > harvest > cards, scaled
 *        ↓        by the drives, plus whatever the fly has LEARNED about that
 *                 tag in this kind of situation (`flyBias`)
 *   brake         the risk rules, applied after the tactical vetoes: one fight
 *                 a turn is fine, a second needs good odds, a third near-
 *                 certain ones, and every bar rises as reinforcements run out
 *                 (`flyBrake`)
 *
 * LEARNING happens AFTER the match, never during it. While playing, the brain
 * is frozen and the fly only keeps two logs: each choice it made (situation +
 * tags) and each reward that followed (read from the engine's event log). When
 * the game ends, `finishFlyGames` reviews them: every choice is credited with
 * the game's result in full, plus the later rewards discounted by how many
 * turns after the choice they came. The brain keeps a running average of that
 * credit per (situation, tag), and play leans toward the tags whose average
 * beats the other tags available in the same situation.
 *
 * Why after the match: learning live with short-lived traces credited only
 * what paid off immediately (planting, harvests, draws) and taught the fly to
 * stop advancing, because a captured Home pays out many moves later.
 *
 * The learned values live in a `FlyBrain` — plain JSON. Every fly starts from
 * the brain shipped in `trainedFlyBrain.ts` (trained offline by self-play, see
 * fly.train.test.ts) and keeps learning for as long as its host keeps the
 * brain: a browser tab, or an online room. Nothing is stored on the device.
 * Per-game bookkeeping
 * (the two logs, fights this turn) lives in a `FlyEpisode` inside the caller's
 * `AiMemory` and is discarded with the game.
 *
 * NOT DETERMINISTIC ACROSS GAMES by design: the same seed played by a fly with
 * a different brain plays differently. Within one game, given the same brain
 * and memory, it is still a pure function of the state (no Math.random).
 */

import type { Action, GameEvent, GameState, PlayerId, Pos } from '../types';
import { enemyUnitsAt, gardenAt, manhattan, playerUnitsAt, posKey, samePos } from '../helpers';
import { END_TURN_SCORE, ownedEconomyGardens, primaryTarget } from './scoring';
import { desperation, enemyGnomes, ownGnomes, ownHomePos } from './util';
import { TRAINED_FLY_BRAIN } from './trainedFlyBrain';
import { TUNED_FLY_PARAMS } from './tunedFlyParams';
import type { FlyIntent, OpponentProfiles, Sighting } from './flyIntent';
import { FLY_INTENT, heldEconomyGardens, readIntent, recordHabits, snapshot } from './flyIntent';
import { enemyReach, reachersOf } from './flyReach';

// ---------------------------------------------------------------------------
// Tuning — every knob that shapes the fly's personality
// ---------------------------------------------------------------------------

/**
 * Rewards the fly learns from. The priority order is territory > planting >
 * harvest > card interaction; risk (fights, lost gnomes) is a brake on all of
 * them rather than a rival goal.
 */
export const FLY_REWARDS = {
  /** Per garden net-gained (or lost, negated) between the fly's turn starts. */
  territoryPerGarden: 6,
  gardenPlanted: 5,
  gardenUpgraded: 4,
  /** Per gnome from a Dandelion harvest or Mushroom clone. */
  harvestPerGnome: 2,
  maizeHarvest: 2,
  homeHarvest: 1,
  cardDrawn: 0.5,
  cardResolved: 1.5,
  /** Fizzled, cancelled, or discarded unplayed. */
  cardWasted: -1,
  enemyGnomeDestroyed: 2,
  /** Instead of `enemyGnomeDestroyed`, for a kill near a garden we hold. */
  threatKilled: 4,
  /** Multiplied by `scarcity` — a gnome hurts more when few remain. */
  ownGnomeLost: -3,
  /** Per fight started beyond the first in one of the fly's own turns. */
  extraFight: -2,
  opponentEliminated: 4,
} as const;

/**
 * Standing pull toward each tag before drives and learning, in Action-Phase
 * score points. Kept small on purpose: these tip close calls between sound
 * actions. At twice these values the fly neglected its attack and lost 3:1 to
 * Normal. `advance` (a step toward the enemy Home) needs a pull of its own, or
 * every side errand outbids actually marching.
 */
export const FLY_PRIORITY: Record<FlyTag, number> = {
  territory: 1.5,
  plant: 1.25,
  harvest: 1,
  card: 0.6,
  draw: 0.3,
  fight: 0.75,
  advance: 1.5,
  defend: 3,
  pass: 0,
};

/**
 * Threat to our economy: enemy gnomes near a Dandelion / Mushroom / Maize we
 * hold. `alarmAt` enemies within `radius` of one garden rings the alarm (local
 * alarm 1.0); fewer is a proportional unease, more is louder. Alarm pulls the
 * fly toward killing those gnomes or reinforcing the garden (`defend`), and
 * lets it accept worse odds for that fight than for an attack elsewhere.
 */
export const FLY_THREAT = {
  radius: 2,
  alarmAt: 2,
  /** Win-probability bar reduction per unit of local alarm (alarm capped at 2). */
  oddsRelief: 0.1,
};

/** Minimum win probability to take the Nth fight of a turn (index 0 = first). */
export const FLY_FIGHT_ODDS: number[] = [0.4, 0.62, 0.85];

/**
 * The values above (and FLY_INTENT) are hand-set defaults. `npm run tune:fly`
 * searches for better ones by win rate and writes them to tunedFlyParams.ts,
 * which overrides the defaults here at load.
 */
function applyTunedParams(): void {
  const t = TUNED_FLY_PARAMS;
  if (!t) return;
  Object.assign(FLY_PRIORITY, t.priority);
  if (t.fightOdds) FLY_FIGHT_ODDS.splice(0, FLY_FIGHT_ODDS.length, ...t.fightOdds);
  Object.assign(FLY_THREAT, t.threat);
  Object.assign(FLY_INTENT, t.intent);
}
applyTunedParams();

/** How the post-game review turns the logs into learning. */
export const FLY_REVIEW = {
  /** The result, credited in full to every choice: + for a win, − for a loss. */
  outcomeWeight: 10,
  /** Per-turn discount on a reward's credit to the choices made before it. */
  discount: 0.9,
  /** Step size of each tag's running average of credit. */
  learningRate: 0.02,
  /** Score points per point of credit a tag beats its situation's average by. */
  influence: 0.3,
  /** Cap on the learned pull either way, so the hand-set priorities stay in charge. */
  maxPull: 2,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of thing an action is, as far as the fly's incentives care. */
export type FlyTag =
  | 'territory'
  | 'plant'
  | 'harvest'
  | 'card'
  | 'draw'
  | 'fight'
  | 'advance'
  | 'defend'
  | 'pass';

const TAGS: readonly FlyTag[] = [
  'territory',
  'plant',
  'harvest',
  'card',
  'draw',
  'fight',
  'advance',
  'defend',
  'pass',
];

/** The persistent, learned half of the fly. Plain JSON; keep it across games. */
export interface FlyBrain {
  /** 2: values are post-game credit averages (1 was live-trace learning). */
  version: 2;
  gamesPlayed: number;
  /** Average credit per `${situation}:${tag}`; absent = never reviewed. */
  values: Record<string, number>;
}

/** Drives read off the board: 1 is neutral. */
export interface FlyDrives {
  /** 1–2: economy is thin (few Wishes, no held economy garden). */
  hunger: number;
  /** 0.5–2: our board force against the strongest enemy's. */
  aggression: number;
  /** 1–4: how scarce our remaining reinforcements are. */
  fear: number;
  /** 0+: the loudest local alarm over our held economy gardens (1 = alarm). */
  alarm: number;
}

export interface FlyRewardEntry {
  turn: number;
  reason: string;
  amount: number;
}

/** Per-game, per-seat bookkeeping. Discarded with the game. */
interface FlyEpisode {
  seed: number;
  lastEventCount: number;
  /** Turn number of the fly's current (or last) own turn. */
  turn: number;
  fightsThisTurn: number;
  /** Gardens held at the start of the fly's last turn (null before the first). */
  territory: number | null;
  /** Enemy gnome positions at the start of each of the fly's turns. */
  sightings: Sighting[];
  /** Orders choices and rewards, so a reward credits only earlier choices. */
  seq: number;
  choices: Array<{ seq: number; turn: number; keys: string[] }>;
  rewards: Array<FlyRewardEntry & { seq: number }>;
  finished: boolean;
}

/** The fly's slice of `AiMemory`. */
export interface FlyMemory {
  brain: FlyBrain;
  episodes: Map<PlayerId, FlyEpisode>;
  /** What the fly has read of each opponent's habits; keep across games. */
  opponents: OpponentProfiles;
  /**
   * Whether the post-game review may change the brain. Off by default: so far
   * no learned brain has beaten one that never learns (see trainedFlyBrain.ts).
   * The trainer turns it on. Opponent profiles are recorded either way.
   */
  learn: boolean;
}

/** Everything one decision needs, gathered once by `flyObserve`. */
export interface FlyContext {
  brain: FlyBrain;
  episode: FlyEpisode;
  drives: FlyDrives;
  situation: string;
  intent: FlyIntent;
}

// ---------------------------------------------------------------------------
// Brain lifecycle
// ---------------------------------------------------------------------------

/** A blank brain: no experience at all. */
export function createFlyBrain(): FlyBrain {
  return { version: 2, gamesPlayed: 0, values: {} };
}

/** A private copy of the shipped, pre-trained brain (see fly.train.test.ts). */
export function trainedFlyBrain(): FlyBrain {
  return structuredClone(TRAINED_FLY_BRAIN);
}

export function createFlyMemory(
  brain: FlyBrain = createFlyBrain(),
  options: { opponents?: OpponentProfiles; learn?: boolean } = {},
): FlyMemory {
  return { brain, episodes: new Map(), opponents: options.opponents ?? new Map(), learn: options.learn ?? false };
}

/** Read a brain back from JSON, or null if it is not one we understand. */
export function parseFlyBrain(json: string): FlyBrain | null {
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Partial<FlyBrain>;
    if (r.version !== 2 || typeof r.gamesPlayed !== 'number' || typeof r.values !== 'object' || r.values === null) {
      return null;
    }
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.values)) {
      if (typeof v === 'number' && Number.isFinite(v)) values[k] = v;
    }
    return { version: 2, gamesPlayed: r.gamesPlayed, values };
  } catch {
    return null;
  }
}

export function isFly(state: GameState, player: PlayerId): boolean {
  return state.players[player]?.difficulty === 'fly';
}

// ---------------------------------------------------------------------------
// Drives and situation
// ---------------------------------------------------------------------------

/** 1 with a full budget, rising to 4 as the last gnomes run out. */
export function scarcity(state: GameState, player: PlayerId): number {
  const total = state.config.totalReinforcements;
  const remaining = Math.max(0, total - state.players[player].gnomesLost);
  const spent = total > 0 ? 1 - remaining / total : 1;
  return 1 + 3 * spent * spent;
}

/**
 * What the fly wants right now. This is the seam for the connectome: a
 * simulated brain replaces this function, reading the same board facts as
 * sensory input and returning the same three drives from its motor output.
 */
export function flyDrives(state: GameState, player: PlayerId): FlyDrives {
  const p = state.players[player];
  let hunger = 1;
  if (p.wishes <= 1) hunger += 0.5;
  if (ownedEconomyGardens(state, player) === 0) hunger += 0.5;

  const ours = ownGnomes(state, player).length;
  const counts = new Map<PlayerId, number>();
  for (const u of enemyGnomes(state, player)) counts.set(u.owner, (counts.get(u.owner) ?? 0) + 1);
  const strongest = Math.max(1, ...counts.values());
  const aggression = clamp(ours / strongest, 0.5, 2);

  let alarm = 0;
  for (const g of threatenedGardens(state, player)) alarm = Math.max(alarm, g.alarm);

  return { hunger, aggression, fear: scarcity(state, player), alarm };
}

/** Economy gardens we hold (our gnome on it), with their local alarm. */
export function threatenedGardens(state: GameState, player: PlayerId): Array<{ pos: Pos; alarm: number }> {
  const enemies = enemyGnomes(state, player);
  const out: Array<{ pos: Pos; alarm: number }> = [];
  for (const pos of heldEconomyGardens(state, player)) {
    const near = enemies.filter((u) => manhattan(u.pos, pos) <= FLY_THREAT.radius).length;
    if (near > 0) out.push({ pos, alarm: near / FLY_THREAT.alarmAt });
  }
  return out;
}

/**
 * How alarming it is to act on `pos`: the loudest alarm among threatened held
 * gardens within the threat radius of it. 0 when `pos` is nowhere near one —
 * which is what makes a nearby raider worth more than a distant one.
 */
function localAlarm(state: GameState, player: PlayerId, pos: Pos): number {
  let alarm = 0;
  for (const g of threatenedGardens(state, player)) {
    if (manhattan(g.pos, pos) <= FLY_THREAT.radius) alarm = Math.max(alarm, g.alarm);
  }
  return alarm;
}

/** A coarse situation key, so learning is conditional: "hungry+scarce" etc. */
function situationOf(drives: FlyDrives): string {
  const bits: string[] = [];
  if (drives.hunger > 1) bits.push('hungry');
  if (drives.aggression < 1) bits.push('outnumbered');
  if (drives.fear >= 2) bits.push('scarce');
  if (drives.alarm >= 1) bits.push('alarmed');
  return bits.length > 0 ? bits.join('+') : 'calm';
}

// ---------------------------------------------------------------------------
// Tagging and fight odds
// ---------------------------------------------------------------------------

/** The incentive tags an action touches. A move can be several at once. */
export function flyTags(
  state: GameState,
  player: PlayerId,
  action: Action,
  intent: FlyIntent | null = null,
): FlyTag[] {
  switch (action.type) {
    case 'move': {
      const tags: FlyTag[] = [];
      const fight = enemyUnitsAt(state, action.to, player).length > 0;
      if (fight) tags.push('fight');
      const g = gardenAt(state, action.to);
      const held = playerUnitsAt(state, action.to, player).some((u) => u.kind === 'gnome');
      // Kill a raider near our gardens, or reinforce a garden under threat —
      // present (alarm) or predicted (intent).
      if (defendDrive(state, player, action.to, intent) > 0 && (fight || held || isOwnAsset(state, player, action.to))) {
        tags.push('defend');
      }
      if (g && !held && g.type !== 'flytrap' && !(g.type === 'home' && g.owner === player)) {
        tags.push('territory');
        if (g.type === 'dandelion' || g.type === 'mushroom' || g.type === 'maize') tags.push('harvest');
      }
      if (tags.length === 0) {
        const unit = state.units[action.unitId];
        const target = unit ? primaryTarget(state, player, unit.pos) : null;
        if (unit && target && manhattan(action.to, target) < manhattan(unit.pos, target)) tags.push('advance');
      }
      return tags;
    }
    case 'plant':
    case 'upgrade':
      return ['plant'];
    case 'drawCard':
      return ['draw'];
    case 'playCard':
      return ['card'];
    case 'endTurn':
      return ['pass'];
    default:
      return [];
  }
}

/**
 * How much acting on `pos` defends us: the present alarm there, a predicted
 * threat on the asset at `pos` (reinforcing it early), or an enemy there that
 * is likely heading for our assets (intercepting it).
 */
function defendDrive(state: GameState, player: PlayerId, pos: Pos, intent: FlyIntent | null): number {
  let drive = localAlarm(state, player, pos);
  if (!intent) return drive;
  const predicted = intent.threat.get(posKey(pos)) ?? 0;
  if (predicted >= FLY_INTENT.anticipateAt) drive = Math.max(drive, predicted);
  for (const u of enemyUnitsAt(state, pos, player)) {
    const hostile = intent.hostile.get(u.id) ?? 0;
    if (hostile >= FLY_INTENT.interceptAt) drive = Math.max(drive, hostile);
    // One that can reach our Home next turn is the most urgent target there is.
    if (intent.homeReachers.has(u.id)) drive = Math.max(drive, FLY_HOME_WATCH.interceptDrive);
  }
  const home = ownHomePos(state, player);
  if (home && samePos(pos, home)) drive = Math.max(drive, homeShortfall(state, player, intent));
  return drive;
}

/**
 * The Home watch (flyReach.ts): what the fly does about enemy gnomes that could
 * land on its Home next turn — by walking, or by slides, tunnels and chains.
 */
export const FLY_HOME_WATCH = {
  /** Defend drive for attacking a gnome that can reach our Home next turn. */
  interceptDrive: 1.5,
};

/** How many more gnomes could land on our Home next turn than defend it now. */
export function homeShortfall(state: GameState, player: PlayerId, intent: FlyIntent, leaving = 0): number {
  const home = ownHomePos(state, player);
  if (!home) return 0;
  const defenders = playerUnitsAt(state, home, player).filter((u) => u.kind === 'gnome').length - leaving;
  return Math.max(0, intent.homeReachers.size - defenders);
}

/**
 * Maize awareness: the Wishes it takes to walk back out of the Maize at `pos`
 * (at its base cost — by next turn a freshly planted one is active), or 0.
 */
function maizeToll(state: GameState, pos: Pos): number {
  const g = gardenAt(state, pos);
  return g && g.type === 'maize' ? (g.upgraded ? 2 : 1) : 0;
}

/** Our Home, or an economy garden we hold. */
function isOwnAsset(state: GameState, player: PlayerId, pos: Pos): boolean {
  const g = gardenAt(state, pos);
  if (g?.type === 'home') return g.owner === player;
  return heldEconomyGardens(state, player).some((p) => p.x === pos.x && p.y === pos.y);
}

function stormsEnemyHome(state: GameState, player: PlayerId, pos: Pos): boolean {
  const g = gardenAt(state, pos);
  return !!g && g.type === 'home' && g.owner !== undefined && g.owner !== player;
}

/** Win probability of a move that starts a fight (gambler's ruin, 1 vs N). */
function fightOdds(state: GameState, player: PlayerId, action: Action): number | null {
  if (action.type !== 'move') return null;
  const defenders = enemyUnitsAt(state, action.to, player).length;
  if (defenders === 0) return null;
  const attackers = 1 + desperation(state) * 0.15;
  return attackers / (attackers + defenders);
}

// ---------------------------------------------------------------------------
// The three hooks index.ts calls
// ---------------------------------------------------------------------------

/**
 * Start of every decision for a fly seat: pick up this game's episode, log the
 * rewards in everything that happened since the last call, and read the drives.
 * Nothing is learned here — the brain is frozen until the post-game review.
 */
export function flyObserve(state: GameState, player: PlayerId, memory: FlyMemory): FlyContext {
  const episode = episodeFor(memory, state, player);
  logEvents(state, player, episode);

  // New own turn: territory reward for what the last turn gained or lost, and
  // a fresh fight budget.
  const turn = state.turn;
  if (turn && turn.activePlayer === player && turn.number !== episode.turn) {
    episode.turn = turn.number;
    episode.fightsThisTurn = 0;
    const held = territoryHeld(state, player);
    if (episode.territory !== null && held !== episode.territory) {
      const delta = held - episode.territory;
      logReward(episode, turn.number, delta * FLY_REWARDS.territoryPerGarden,
        `${delta > 0 ? 'gained' : 'lost'} ${Math.abs(delta)} garden${Math.abs(delta) === 1 ? '' : 's'}`);
    }
    episode.territory = held;
    // Snapshot the enemy for the intent reader, and file this turn's reads of
    // each opponent under their profile.
    episode.sightings.push(snapshot(state, player));
    if (episode.sightings.length > FLY_INTENT.lookback + 1) episode.sightings.shift();
    recordHabits(state, readIntent(state, player, episode.sightings, memory.opponents), memory.opponents);
  }

  const intent = readIntent(state, player, episode.sightings, memory.opponents);
  const home = ownHomePos(state, player);
  if (home) intent.homeReachers = new Set(reachersOf(enemyReach(state, player), home));
  const drives = flyDrives(state, player);
  return { brain: memory.brain, episode, drives, situation: situationOf(drives), intent };
}

/**
 * Pull toward an action, added to its score BEFORE the tactical vetoes are
 * enforced — so it can make a sound action more attractive but never approve
 * one the tactics rejected.
 */
export function flyBias(ctx: FlyContext, state: GameState, player: PlayerId, action: Action): number {
  const { drives } = ctx;
  let bias = 0;
  for (const tag of flyTags(state, player, action, ctx.intent)) {
    let drive = 1;
    if (tag === 'territory') drive = 0.5 + 0.5 * drives.aggression;
    else if (tag === 'plant' || tag === 'harvest') drive = drives.hunger;
    else if (tag === 'fight') drive = drives.aggression / drives.fear;
    else if (tag === 'defend' && action.type === 'move') drive = defendDrive(state, player, action.to, ctx.intent);
    else if (tag === 'advance') drive = 1 + FLY_INTENT.counterattack * exposureAhead(state, player, action, ctx.intent);
    bias += FLY_PRIORITY[tag] * drive + learned(ctx, tag);
  }
  return bias;
}

/** Exposure of the enemy Home this move advances on (0 when it advances on none). */
function exposureAhead(state: GameState, player: PlayerId, action: Action, intent: FlyIntent): number {
  if (action.type !== 'move') return 0;
  const unit = state.units[action.unitId];
  if (!unit) return 0;
  const target = primaryTarget(state, player, unit.pos);
  const g = gardenAt(state, target);
  if (!g || g.type !== 'home' || g.owner === undefined || g.owner === player) return 0;
  return intent.exposure.get(g.owner) ?? 0;
}

/**
 * The risk rules, applied AFTER the tactical vetoes — a hard brake, so a fight
 * that fails its bar drops below passing no matter how the bias pulled it.
 */
export function flyBrake(ctx: FlyContext, state: GameState, player: PlayerId, action: Action, score: number): number {
  if (action.type === 'move') {
    const unit = state.units[action.unitId];
    const home = ownHomePos(state, player);
    const defending = defendDrive(state, player, action.to, ctx.intent) >= 1;
    // Never strip the Home below what could land on it next turn.
    if (
      unit &&
      home &&
      samePos(unit.pos, home) &&
      !samePos(action.to, home) &&
      homeShortfall(state, player, ctx.intent, 1) > 0 &&
      !stormsEnemyHome(state, player, action.to)
    ) {
      return Math.min(score, END_TURN_SCORE - 0.05);
    }
    // Don't walk into Maize we could not pay to leave (unless it defends).
    const toll = unit && !samePos(unit.pos, action.to) ? maizeToll(state, action.to) : 0;
    if (toll > 0) {
      if (state.players[player].wishes < toll && !defending) return Math.min(score, END_TURN_SCORE - 0.05);
      score -= toll; // the Wish it will cost to get out again
    }
  }
  const odds = fightOdds(state, player, action);
  if (odds === null) return score;
  const nth = Math.min(ctx.episode.fightsThisTurn, FLY_FIGHT_ODDS.length - 1);
  const g = action.type === 'move' ? gardenAt(state, action.to) : null;
  const storming = !!g && g.type === 'home' && g.owner !== player;
  const bar =
    FLY_FIGHT_ODDS[nth] +
    0.15 * (ctx.drives.fear - 1) - // scarce reinforcements raise every bar
    0.1 * (ctx.drives.aggression - 1) - // a stronger force lowers it a little
    (storming ? 0.1 : 0) -
    FLY_THREAT.oddsRelief * Math.min(2, action.type === 'move' ? defendDrive(state, player, action.to, ctx.intent) : 0);
  if (odds < bar) return Math.min(score, END_TURN_SCORE - 0.05);
  // Accepted — but still priced: the expected loss, heavier when gnomes are scarce.
  return score - (1 - odds) * 2 * ctx.drives.fear;
}

/** Log a choice the fly actually made, for the post-game review. */
export function flyRecordChoice(ctx: FlyContext, state: GameState, player: PlayerId, action: Action): void {
  const keys = flyTags(state, player, action, ctx.intent).map((tag) => `${ctx.situation}:${tag}`);
  if (keys.length === 0) return;
  const ep = ctx.episode;
  ep.choices.push({ seq: ep.seq++, turn: state.turn?.number ?? 0, keys });
}

/**
 * The post-game review, for every fly seat in a finished game: log the final
 * events, then learn from the whole game at once. Idempotent per game. Hosts
 * call it once the game ends.
 */
export function finishFlyGames(state: GameState, memory: FlyMemory): void {
  if (state.status !== 'finished') return;
  for (const p of state.players) {
    if (p.difficulty !== 'fly') continue;
    const episode = memory.episodes.get(p.id);
    if (!episode || episode.finished || episode.seed !== state.seed) continue;
    logEvents(state, p.id, episode);
    const outcome = state.winner === p.id ? 1 : state.winner === null ? 0 : -1;
    if (memory.learn) review(memory.brain, episode, outcome);
    episode.finished = true;
    memory.brain.gamesPlayed += 1;
  }
}

/** Everything the fly was rewarded or punished for this game, oldest first. */
export function flyRewardLog(memory: FlyMemory, player: PlayerId): readonly FlyRewardEntry[] {
  return memory.episodes.get(player)?.rewards ?? [];
}

// ---------------------------------------------------------------------------
// Learning internals
// ---------------------------------------------------------------------------

function episodeFor(memory: FlyMemory, state: GameState, player: PlayerId): FlyEpisode {
  const existing = memory.episodes.get(player);
  if (existing && existing.seed === state.seed && state.eventCount >= existing.lastEventCount) return existing;
  const fresh: FlyEpisode = {
    seed: state.seed,
    lastEventCount: state.eventCount,
    turn: -1,
    fightsThisTurn: 0,
    territory: null,
    sightings: [],
    seq: 0,
    choices: [],
    rewards: [],
    finished: false,
  };
  memory.episodes.set(player, fresh);
  return fresh;
}

/**
 * What the fly has learned about `tag` here, RELATIVE to the other tags in the
 * same situation. Most rewards are positive, so raw values all drift upward
 * together; centering keeps only the part that says "this paid off better than
 * my other options", which is the part that should change behaviour.
 */
function learned(ctx: FlyContext, tag: FlyTag): number {
  const mine = ctx.brain.values[`${ctx.situation}:${tag}`];
  if (mine === undefined) return 0; // never tried here: no opinion
  let sum = 0;
  let n = 0;
  for (const t of TAGS) {
    const v = ctx.brain.values[`${ctx.situation}:${t}`];
    if (v !== undefined) {
      sum += v;
      n += 1;
    }
  }
  const pull = (mine - sum / n) * FLY_REVIEW.influence;
  return clamp(pull, -FLY_REVIEW.maxPull, FLY_REVIEW.maxPull);
}

/** Non-home gardens where we have a gnome and the enemy has nothing. */
function territoryHeld(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type === 'home' && g.owner === player) continue;
    const [x, y] = key.split(',').map(Number);
    const pos = { x, y };
    if (
      playerUnitsAt(state, pos, player).some((u) => u.kind === 'gnome') &&
      enemyUnitsAt(state, pos, player).length === 0
    ) {
      n += 1;
    }
  }
  return n;
}

/** Events emitted since the episode last looked, oldest first. */
function newEvents(state: GameState, episode: FlyEpisode): readonly GameEvent[] {
  const fresh = state.eventCount - episode.lastEventCount;
  episode.lastEventCount = state.eventCount;
  if (fresh <= 0) return [];
  return state.events.slice(Math.max(0, state.events.length - fresh));
}

function logEvents(state: GameState, player: PlayerId, episode: FlyEpisode): void {
  const turn = state.turn?.number ?? 0;
  for (const ev of newEvents(state, episode)) {
    const r = rewardFor(state, player, episode, ev);
    if (r) logReward(episode, turn, r.amount, r.reason);
  }
}

function logReward(episode: FlyEpisode, turn: number, amount: number, reason: string): void {
  if (amount === 0) return;
  episode.rewards.push({ seq: episode.seq++, turn, reason, amount: Math.round(amount * 100) / 100 });
}

/**
 * Learn from one finished game. Each choice's credit is the result in full
 * plus every later reward, discounted per turn of delay; each (situation, tag)
 * the choice touched moves its running average toward that credit.
 */
function review(brain: FlyBrain, episode: FlyEpisode, outcome: number): void {
  const { discount, learningRate, outcomeWeight } = FLY_REVIEW;
  for (const choice of episode.choices) {
    let credit = outcome * outcomeWeight;
    for (const r of episode.rewards) {
      if (r.seq > choice.seq) credit += r.amount * discount ** Math.max(0, r.turn - choice.turn);
    }
    for (const key of choice.keys) {
      const v = brain.values[key] ?? 0;
      brain.values[key] = v + learningRate * (credit - v);
    }
  }
}

function rewardFor(
  state: GameState,
  player: PlayerId,
  episode: FlyEpisode,
  ev: GameEvent,
): { amount: number; reason: string } | null {
  const R = FLY_REWARDS;
  switch (ev.type) {
    case 'gardenPlanted':
      return ev.player === player ? { amount: R.gardenPlanted, reason: `planted ${ev.gardenType}` } : null;
    case 'gardenUpgraded':
      return ev.player === player ? { amount: R.gardenUpgraded, reason: `upgraded ${ev.gardenType}` } : null;
    case 'dandelionHarvested':
      return ev.player === player && ev.gnomes > 0
        ? { amount: R.harvestPerGnome * ev.gnomes, reason: `dandelion +${ev.gnomes}` }
        : null;
    case 'mushroomHarvested':
      return ev.player === player && ev.cloned > 0
        ? { amount: R.harvestPerGnome * ev.cloned, reason: `mushroom cloned ${ev.cloned}` }
        : null;
    case 'maizeHarvested':
      return ev.player === player ? { amount: R.maizeHarvest * (ev.doubled ? 2 : 1), reason: 'maize harvest' } : null;
    case 'homeHarvested':
      return ev.player === player && ev.took !== 'nothing'
        ? { amount: R.homeHarvest, reason: `home harvest (${ev.took})` }
        : null;
    case 'cardDrawn':
      return ev.player === player ? { amount: R.cardDrawn, reason: 'drew a card' } : null;
    case 'cardResolved':
      return ev.player === player ? { amount: R.cardResolved, reason: `played ${ev.cardId}` } : null;
    case 'cardFizzled':
    case 'cardCancelled':
    case 'cardDiscarded':
      return ev.player === player ? { amount: R.cardWasted, reason: `wasted ${ev.cardId}` } : null;
    case 'unitDestroyed':
      if (ev.unitKind !== 'gnome') return null;
      return ev.player === player
        ? { amount: R.ownGnomeLost * scarcity(state, player), reason: 'lost a gnome' }
        : heldEconomyGardens(state, player).some((g) => manhattan(g, ev.pos) <= FLY_THREAT.radius)
          ? { amount: R.threatKilled, reason: 'killed a raider near our garden' }
          : { amount: R.enemyGnomeDestroyed, reason: 'enemy gnome destroyed' };
    case 'fightStarted': {
      const attacker = ev.sides[1];
      if (attacker.kind !== 'player' || attacker.player !== player) return null;
      episode.fightsThisTurn += 1;
      return episode.fightsThisTurn > 1
        ? { amount: R.extraFight * (episode.fightsThisTurn - 1), reason: `fight #${episode.fightsThisTurn} this turn` }
        : null;
    }
    case 'playerEliminated':
      // Our own fall is the game's result, which the review credits separately.
      return ev.player === player ? null : { amount: R.opponentEliminated, reason: 'an opponent fell' };
    default:
      return null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
