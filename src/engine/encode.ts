/**
 * Observation & option encoders — Milestone 13 Phase 1 (learned CPU).
 *
 * Pure TS, no ML dependencies. Two encoders, both deterministic functions of
 * `(state, seat)` alone:
 *
 *   encodeObservation(state, seat) — the game as SEEN BY `seat`: what a
 *     legal player at that seat may know (their information set). Board
 *     planes + a flat scalar block. Hidden information NEVER leaks in: the
 *     encoder reads other players' hands only as sizes and the deck/discard
 *     only as counts, so two states differing only in hidden content encode
 *     identically (pinned by tests).
 *
 *   encodeOption(state, seat, action) — one legal action intent (an entry of
 *     `getLegalActionIntents`) as a fixed-length feature vector. The learned
 *     policy scores each legal option's vector against the observation, so
 *     the engine's legality IS the action mask and no global action space is
 *     ever enumerated.
 *
 * Seat-relative convention: every per-player feature is indexed by RELATIVE
 * seat `(other - seat + n) % n` — slot 0 is always "me", slot 1 the next seat
 * clockwise, etc. — so one net generalizes across seats. Board coordinates
 * stay absolute (no rotation) for v0.
 *
 * Layout stability: vector layouts derive from the frozen lists below plus
 * the card definition order in cards.ts. Any change to them changes the
 * meaning of trained weights — bump ENCODING_SCHEMA when that happens.
 */

import type {
  Action,
  CardTarget,
  GameState,
  GardenType,
  PendingDecision,
  PlayerId,
  PlantableGardenType,
  Pos,
} from './types';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS } from './cards';
import { centerPos, gardenIsActive, parsePos, samePos, wishCap } from './helpers';

/** Bump whenever any encoder layout changes; trained weights gate on this. */
// v2: garden upgrades (upgraded plane + dest flag, 'upgrade' action type) and
// per-player tile supplies (per-relative-seat supply scalars).
export const ENCODING_SCHEMA = 2;

/** Per-player feature slots. Absent seats (2-player games) encode as zeros. */
export const MAX_SEATS = 4;

// ---------------------------------------------------------------------------
// Frozen index lists (order defines vector layout)
// ---------------------------------------------------------------------------

/** Whimsy card ids in cards.ts definition order — the card one-hot layout. */
export const ENCODED_CARD_IDS: readonly string[] = CARD_DEFINITIONS.map((c) => c.id);
/** Curse ids in cards.ts definition order — the active-curse one-hot layout. */
export const ENCODED_CURSE_IDS: readonly string[] = CURSE_DEFINITIONS.map((c) => c.id);

const GARDEN_TYPES: readonly GardenType[] = ['home', 'dandelion', 'mushroom', 'flytrap', 'maize', 'slippery', 'tunnel'];
const PLANTABLE_TYPES: readonly PlantableGardenType[] = ['dandelion', 'mushroom', 'flytrap', 'maize', 'slippery', 'tunnel'];

const ACTION_TYPES: readonly Action['type'][] = [
  'rollOff', 'chooseHarvest', 'homeHarvest', 'mushroomClones', 'slide', 'tunnel',
  'declineEffect', 'respondPass', 'respondPlayCard', 'discardCard', 'snailify',
  'sacrificeGnome', 'snailMove', 'selectTarget', 'cancelTargeting',
  'move', 'plant', 'upgrade', 'drawCard', 'playCard', 'endTurn',
];

const DECISION_KINDS: readonly PendingDecision['kind'][] = [
  'rollOff', 'chooseHarvest', 'homeHarvest', 'mushroomClones', 'slide', 'tunnel',
  'fightRespond', 'cardResponse', 'discard', 'snailify', 'sacrificeGnome',
  'snailMove', 'cardTargeting',
];

const TARGET_KINDS: readonly CardTarget['kind'][] = ['unit', 'space', 'player', 'card', 'gardenType'];

const cardIndex = new Map(ENCODED_CARD_IDS.map((id, i) => [id, i]));
const curseIndex = new Map(ENCODED_CURSE_IDS.map((id, i) => [id, i]));
const gardenIndex = new Map(GARDEN_TYPES.map((t, i) => [t, i]));
const plantableIndex = new Map(PLANTABLE_TYPES.map((t, i) => [t, i]));
const actionTypeIndex = new Map(ACTION_TYPES.map((t, i) => [t, i]));
const decisionKindIndex = new Map(DECISION_KINDS.map((k, i) => [k, i]));
const targetKindIndex = new Map(TARGET_KINDS.map((k, i) => [k, i]));

/** Total whimsy cards in a fresh deck (normalizes deck/discard sizes). */
const DECK_TOTAL = CARD_DEFINITIONS.reduce((sum, c) => sum + c.copies, 0);

// ---------------------------------------------------------------------------
// Observation layout
// ---------------------------------------------------------------------------

/**
 * Spatial planes, one boardSize×boardSize grid each (row-major, y*N + x):
 *   0..3   gnome count / 4 per relative seat
 *   4..7   snail present per relative seat
 *   8..14  garden type one-hot (GARDEN_TYPES order)
 *   15..18 home-garden owner as relative-seat one-hot
 *   19     garden is Active
 *   20     flytrap stunned
 *   21     maize exit-cost doubled
 *   22     garden skips its next harvest
 *   23     Center Star space
 *   24     Great Wall Of Whimsy (entry blocked)
 *   25     current fight position
 *   26     garden is upgraded
 */
export const OBS_PLANES = 27;

const PLANE_GNOME = 0;
const PLANE_SNAIL = 4;
const PLANE_GARDEN = 8;
const PLANE_HOME_OWNER = 15;
const PLANE_ACTIVE = 19;
const PLANE_STUNNED = 20;
const PLANE_DOUBLED = 21;
const PLANE_SKIP_HARVEST = 22;
const PLANE_CENTER = 23;
const PLANE_WALL = 24;
const PLANE_FIGHT = 25;
const PLANE_UPGRADED = 26;

/** Scalar block size (see writeScalars for the exact field order). */
export const OBS_SCALARS =
  MAX_SEATS * 12 + // per relative seat: exists, status one-hot(3), isActive, wishes, cap, hand, reserve, lost, onBoard, rollMod
  ENCODED_CARD_IDS.length + // my hand as card-type counts (the info-set boundary)
  3 + // deck, discard, curse pool sizes
  ENCODED_CURSE_IDS.length + // active curses one-hot
  3 + // game status one-hot (rolloff / playing / finished)
  2 + // phase flags (harvest, action)
  1 + // turn number
  DECISION_KINDS.length + // pending-decision kind one-hot
  ENCODED_CARD_IDS.length + // decision context card (targeting / responded-to)
  1 + // targeting progress
  MAX_SEATS + // cardResponse: responded-to player, relative one-hot
  1 + // decision is mine
  6 + // fight block: present, I defend, I attack, vs flytrap, round, pinned
  5 + // shields, turnMustEnd, card stack depth, response queue, marriages
  MAX_SEATS * PLANTABLE_TYPES.length + // per-relative-seat tile supply remaining per type
  2; // board size, player count

/** Flat observation length for a given board size. */
export function obsSize(boardSize: number): number {
  return OBS_PLANES * boardSize * boardSize + OBS_SCALARS;
}

// ---------------------------------------------------------------------------
// Observation encoder
// ---------------------------------------------------------------------------

/** Relative seat of `other` from `seat`'s perspective (0 = me). */
function relSeat(state: GameState, seat: PlayerId, other: PlayerId): number {
  const n = state.players.length;
  return (other - seat + n) % n;
}

/**
 * Encode the game from `seat`'s point of view. Uses only information a player
 * at that seat may legally see.
 */
export function encodeObservation(state: GameState, seat: PlayerId): Float32Array {
  if (seat < 0 || seat >= state.players.length) {
    throw new Error(`encodeObservation: seat ${seat} out of range (${state.players.length} players)`);
  }
  const N = state.config.boardSize;
  const cells = N * N;
  const out = new Float32Array(obsSize(N));
  const at = (plane: number, p: Pos) => plane * cells + p.y * N + p.x;

  // --- planes ---------------------------------------------------------------
  for (const u of Object.values(state.units)) {
    const rel = relSeat(state, seat, u.owner);
    if (u.kind === 'gnome') out[at(PLANE_GNOME + rel, u.pos)] += 0.25;
    else out[at(PLANE_SNAIL + rel, u.pos)] = 1;
  }

  for (const [key, g] of Object.entries(state.gardens)) {
    const pos = parsePos(key);
    out[at(PLANE_GARDEN + (gardenIndex.get(g.type) ?? 0), pos)] = 1;
    if (g.type === 'home' && g.owner !== undefined) {
      out[at(PLANE_HOME_OWNER + relSeat(state, seat, g.owner), pos)] = 1;
    }
    if (gardenIsActive(state, g)) out[at(PLANE_ACTIVE, pos)] = 1;
    if (g.stunnedForPlayerTurn !== null) out[at(PLANE_STUNNED, pos)] = 1;
    if (g.doubledForPlayerTurn !== null) out[at(PLANE_DOUBLED, pos)] = 1;
    if (g.skipNextHarvest) out[at(PLANE_SKIP_HARVEST, pos)] = 1;
    if (g.upgraded) out[at(PLANE_UPGRADED, pos)] = 1;
  }

  if (state.config.centerStar) out[at(PLANE_CENTER, centerPos(state))] = 1;
  for (const e of state.timedEffects) {
    if (e.kind === 'greatWall' && e.pos) out[at(PLANE_WALL, e.pos)] = 1;
  }
  if (state.fight) out[at(PLANE_FIGHT, state.fight.pos)] = 1;

  // --- scalars ----------------------------------------------------------------
  let i = OBS_PLANES * cells;
  const put = (v: number) => {
    out[i++] = v;
  };

  const cfg = state.config;
  const me = state.players[seat];

  // Per relative seat (12 each). Absent seats stay zero.
  for (let rel = 0; rel < MAX_SEATS; rel++) {
    const id = (seat + rel) % state.players.length;
    if (rel > 0 && (state.players.length <= rel || id === seat)) {
      i += 12;
      continue;
    }
    const p = state.players[id];
    put(1); // seat exists
    put(p.status === 'playing' ? 1 : 0);
    put(p.status === 'snail' ? 1 : 0);
    put(p.status === 'out' ? 1 : 0);
    put(state.turn?.activePlayer === id ? 1 : 0);
    put(p.wishes / 10);
    put(wishCap(state, id) / 10);
    put(p.hand.length / cfg.handLimit);
    put((cfg.totalReinforcements - p.gnomesSpawned) / cfg.totalReinforcements);
    put(p.gnomesLost / cfg.totalReinforcements);
    put(Object.values(state.units).filter((u) => u.owner === id && u.kind === 'gnome').length / cfg.gnomeBoardLimit);
    put(Math.max(-4, Math.min(4, state.rollModifiers[id] ?? 0)) / 4);
  }

  // My hand as card-type counts (only MY hand — the info-set boundary).
  const handStart = i;
  i += ENCODED_CARD_IDS.length;
  for (const cardId of me.hand) {
    const idx = cardIndex.get(cardId);
    if (idx !== undefined) out[handStart + idx] += 0.5; // /2 = copies per card
  }

  // Hidden zones as counts only.
  put(state.deck.length / DECK_TOTAL);
  put(state.discard.length / DECK_TOTAL);
  put(state.cursePool.length / ENCODED_CURSE_IDS.length);

  // Active curses (public).
  const curseStart = i;
  i += ENCODED_CURSE_IDS.length;
  for (const curseId of state.activeCurses) {
    const idx = curseIndex.get(curseId);
    if (idx !== undefined) out[curseStart + idx] = 1;
  }

  // Status / phase / clock.
  put(state.status === 'rolloff' ? 1 : 0);
  put(state.status === 'playing' ? 1 : 0);
  put(state.status === 'finished' ? 1 : 0);
  put(state.turn?.phase === 'harvest' ? 1 : 0);
  put(state.turn?.phase === 'action' ? 1 : 0);
  put(Math.min(state.turn?.number ?? 0, 100) / 100);

  // Pending decision.
  const d = state.pendingDecision;
  const kindStart = i;
  i += DECISION_KINDS.length;
  if (d) {
    const idx = decisionKindIndex.get(d.kind);
    if (idx !== undefined) out[kindStart + idx] = 1;
  }
  const ctxCardStart = i;
  i += ENCODED_CARD_IDS.length;
  const ctxCard = d?.kind === 'cardTargeting' ? d.cardId : d?.kind === 'cardResponse' ? d.respondingToCard : null;
  if (ctxCard !== null) {
    const idx = cardIndex.get(ctxCard);
    if (idx !== undefined) out[ctxCardStart + idx] = 1;
  }
  put(d?.kind === 'cardTargeting' ? (d.stepIndex + 1) / d.stepCount : 0);
  const respStart = i;
  i += MAX_SEATS;
  if (d?.kind === 'cardResponse') out[respStart + relSeat(state, seat, d.respondingToPlayer)] = 1;
  put(d !== null && d.player === seat ? 1 : 0);

  // Fight block.
  const f = state.fight;
  put(f ? 1 : 0);
  put(f && f.sides[0].kind === 'player' && f.sides[0].player === seat ? 1 : 0);
  put(f && f.sides[1].kind === 'player' && f.sides[1].player === seat ? 1 : 0);
  put(f && (f.sides[0].kind === 'flytrap' || f.sides[1].kind === 'flytrap') ? 1 : 0);
  put(f ? Math.min(f.round, 5) / 5 : 0);
  put(f?.pinned ? 1 : 0);

  // Global counters.
  put(Math.min(state.preventionShields, 4) / 4);
  put(state.turnMustEnd ? 1 : 0);
  put(Math.min(state.cardStack.length, 4) / 4);
  put(Math.min(state.responseQueue.length, 3) / 3);
  put(Math.min(state.marriages.length, 4) / 4);

  // Per-relative-seat tile supplies (public). Absent seats stay zero.
  for (let rel = 0; rel < MAX_SEATS; rel++) {
    const id = (seat + rel) % state.players.length;
    if (rel > 0 && (state.players.length <= rel || id === seat)) {
      i += PLANTABLE_TYPES.length;
      continue;
    }
    for (const t of PLANTABLE_TYPES) put(state.players[id].supply[t] / cfg.tilesPerType);
  }

  put(N / 9);
  put(state.players.length / MAX_SEATS);

  if (i !== out.length) {
    throw new Error(`encodeObservation: wrote ${i - OBS_PLANES * cells} scalars, layout says ${OBS_SCALARS}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Option encoder
// ---------------------------------------------------------------------------

/**
 * Option vector layout:
 *   action type one-hot (ACTION_TYPES)          20
 *   card one-hot (ENCODED_CARD_IDS)             23
 *   plantable garden type one-hot                6
 *   target kind one-hot (selectTarget)           5
 *   relative seat one-hot (player/unit target)   4
 *   destination space block                     15
 *     present, x, y, garden one-hot(7), active, my units, enemy units, center,
 *     upgraded
 *   origin space block                           3   (present, x, y)
 *   unit flags                                   2   (is snail, is mine)
 *   choice scalars                               4   (clone count, take wish, take gnome, accept)
 */
export const OPTION_SIZE = ACTION_TYPES.length + ENCODED_CARD_IDS.length + PLANTABLE_TYPES.length + TARGET_KINDS.length + MAX_SEATS + 15 + 3 + 2 + 4;

const OPT_TYPE = 0;
const OPT_CARD = OPT_TYPE + ACTION_TYPES.length;
const OPT_PLANTABLE = OPT_CARD + ENCODED_CARD_IDS.length;
const OPT_TARGET_KIND = OPT_PLANTABLE + PLANTABLE_TYPES.length;
const OPT_REL_SEAT = OPT_TARGET_KIND + TARGET_KINDS.length;
const OPT_DEST = OPT_REL_SEAT + MAX_SEATS;
const OPT_FROM = OPT_DEST + 15;
const OPT_UNIT = OPT_FROM + 3;
const OPT_CHOICE = OPT_UNIT + 2;

/**
 * Encode one legal action intent for `seat` in `state` — the state the intent
 * was enumerated in, which supplies the action's context (the pending
 * decision for chooseHarvest/slide/tunnel, unit positions for moves, board
 * contents under target spaces).
 */
export function encodeOption(state: GameState, seat: PlayerId, action: Action): Float32Array {
  const out = new Float32Array(OPTION_SIZE);
  const typeIdx = actionTypeIndex.get(action.type);
  if (typeIdx === undefined) throw new Error(`encodeOption: unknown action type ${action.type}`);
  out[OPT_TYPE + typeIdx] = 1;

  const setCard = (cardId: string) => {
    const idx = cardIndex.get(cardId);
    if (idx !== undefined) out[OPT_CARD + idx] = 1;
  };
  const setDest = (pos: Pos) => {
    const N = state.config.boardSize;
    out[OPT_DEST] = 1;
    out[OPT_DEST + 1] = pos.x / (N - 1);
    out[OPT_DEST + 2] = pos.y / (N - 1);
    const g = state.gardens[`${pos.x},${pos.y}`];
    if (g) {
      out[OPT_DEST + 3 + (gardenIndex.get(g.type) ?? 0)] = 1;
      out[OPT_DEST + 10] = gardenIsActive(state, g) ? 1 : 0;
      out[OPT_DEST + 14] = g.upgraded ? 1 : 0;
    }
    let mine = 0;
    let enemy = 0;
    for (const u of Object.values(state.units)) {
      if (!samePos(u.pos, pos)) continue;
      if (u.owner === seat) mine++;
      else enemy++;
    }
    out[OPT_DEST + 11] = Math.min(mine, 4) / 4;
    out[OPT_DEST + 12] = Math.min(enemy, 4) / 4;
    out[OPT_DEST + 13] = samePos(pos, centerPos(state)) ? 1 : 0;
  };
  const setFrom = (pos: Pos) => {
    const N = state.config.boardSize;
    out[OPT_FROM] = 1;
    out[OPT_FROM + 1] = pos.x / (N - 1);
    out[OPT_FROM + 2] = pos.y / (N - 1);
  };
  const setUnit = (unitId: string) => {
    const u = state.units[unitId];
    if (!u) return;
    out[OPT_UNIT] = u.kind === 'snail' ? 1 : 0;
    out[OPT_UNIT + 1] = u.owner === seat ? 1 : 0;
    out[OPT_REL_SEAT + relSeat(state, seat, u.owner)] = 1;
    setDest(u.pos);
  };
  const decision = state.pendingDecision;

  switch (action.type) {
    case 'playCard':
    case 'respondPlayCard':
    case 'discardCard':
      setCard(action.cardId);
      break;
    case 'move': {
      setDest(action.to);
      const u = state.units[action.unitId];
      if (u) {
        setFrom(u.pos);
        out[OPT_UNIT] = u.kind === 'snail' ? 1 : 0;
        out[OPT_UNIT + 1] = 1;
      }
      break;
    }
    case 'plant':
      setDest(action.pos);
      out[OPT_PLANTABLE + (plantableIndex.get(action.gardenType) ?? 0)] = 1;
      break;
    case 'upgrade':
      setDest(action.pos);
      break;
    case 'slide':
    case 'tunnel':
    case 'snailMove': {
      setDest(action.to);
      if (decision && (decision.kind === 'slide' || decision.kind === 'tunnel' || decision.kind === 'snailMove')) {
        setFrom(decision.from);
      }
      break;
    }
    case 'chooseHarvest': {
      if (decision?.kind === 'chooseHarvest') {
        const src = decision.options.find((s) => s.key === action.sourceKey);
        if (src) setDest(src.pos);
      }
      break;
    }
    case 'homeHarvest':
      out[OPT_CHOICE + 1] = action.take === 'wish' ? 1 : 0;
      out[OPT_CHOICE + 2] = action.take === 'gnome' ? 1 : 0;
      break;
    case 'mushroomClones':
      out[OPT_CHOICE] = Math.min(action.count, 6) / 6;
      break;
    case 'snailify':
      out[OPT_CHOICE + 3] = action.accept ? 1 : 0;
      break;
    case 'sacrificeGnome':
      setUnit(action.unitId);
      break;
    case 'selectTarget': {
      const t = action.target;
      out[OPT_TARGET_KIND + (targetKindIndex.get(t.kind) ?? 0)] = 1;
      if (t.kind === 'unit') setUnit(t.unitId);
      else if (t.kind === 'space') setDest(t.pos);
      else if (t.kind === 'player') out[OPT_REL_SEAT + relSeat(state, seat, t.playerId)] = 1;
      else if (t.kind === 'card') setCard(t.cardId);
      else out[OPT_PLANTABLE + (plantableIndex.get(t.gardenType) ?? 0)] = 1;
      break;
    }
    default:
      // rollOff, declineEffect, respondPass, cancelTargeting, drawCard,
      // endTurn: the type one-hot is the whole feature.
      break;
  }
  return out;
}
