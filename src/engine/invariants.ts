/**
 * Game-state invariant validator.
 *
 * Every invariant here must hold in EVERY reachable state — before and after
 * any action, mid-settle or idle. They are structural ("a unit stands on the
 * board", "a supply count is within its tile budget"), never strategic, and
 * they are cheap: no enumeration, no cloning, one pass over units, gardens and
 * players. That is what makes it safe to call from a smoke test after every
 * action, from a multiplayer host on receipt of a state it did not compute, and
 * from a `catch` when something has already gone wrong and the question is
 * *what*.
 *
 * `checkInvariants(state)` REPORTS rather than throws — a violation list is far
 * more useful than the first failed assertion, because a corrupted state
 * usually breaks several at once and the pattern is the diagnosis.
 * `assertInvariants(state)` is the throwing wrapper for callers who want a hard
 * stop (it raises `EngineError('INTERNAL')`, the code reserved for "engine bug",
 * since a broken invariant is never the caller's fault).
 *
 * This is a DIAGNOSTIC, not a rules check. Passing it does not mean a state is
 * reachable by legal play — only that it is not visibly malformed. The engine
 * itself never calls it on the hot path: `applyAction` stays as cheap as it is
 * today, and callers decide when they want the check.
 */

import type { GameState, PlayerId } from './types';
import { EngineError } from './types';
import { inBounds, parsePos } from './helpers';

/** One broken invariant. `where` is a stable dotted path into the state. */
export interface InvariantViolation {
  /** Short, stable id — safe to group/count on across versions. */
  code: string;
  /** Where the problem is, e.g. `units.u7.pos` or `players.1.gnomesLost`. */
  where: string;
  /** Human-readable description, including the offending values. */
  message: string;
}

/**
 * Check every structural invariant and return the violations found (empty ⇒
 * the state is well-formed). Pure and allocation-light; never throws.
 */
export function checkInvariants(state: GameState): InvariantViolation[] {
  const v: InvariantViolation[] = [];
  const fail = (code: string, where: string, message: string) => v.push({ code, where, message });

  const { config } = state;
  const seats = state.players.length;

  // --- board geometry -------------------------------------------------------

  for (const [key, u] of Object.entries(state.units)) {
    if (!inBounds(state, u.pos)) {
      fail('UNIT_OFF_BOARD', `units.${key}.pos`, `unit ${key} at (${u.pos.x},${u.pos.y}) is off a ${config.boardSize}×${config.boardSize} board`);
    }
    if (u.owner < 0 || u.owner >= seats) {
      fail('UNIT_BAD_OWNER', `units.${key}.owner`, `unit ${key} is owned by seat ${u.owner}, outside 0..${seats - 1}`);
    }
    // The units map is keyed BY unit id; a mismatch means one of the two is
    // stale, and every lookup by id silently returns the wrong critter.
    if (u.id !== key) {
      fail('UNIT_KEY_MISMATCH', `units.${key}.id`, `unit keyed as ${key} carries id ${u.id}`);
    }
  }

  for (const [key, g] of Object.entries(state.gardens)) {
    const pos = parsePos(key);
    if (!inBounds(state, pos)) {
      fail('GARDEN_OFF_BOARD', `gardens.${key}`, `garden at ${key} is off a ${config.boardSize}×${config.boardSize} board`);
    }
    if (g.owner !== undefined && (g.owner < 0 || g.owner >= seats)) {
      fail('GARDEN_BAD_OWNER', `gardens.${key}.owner`, `garden at ${key} is owned by seat ${g.owner}, outside 0..${seats - 1}`);
    }
    if (g.type === 'home' && g.owner === undefined) {
      fail('HOME_WITHOUT_OWNER', `gardens.${key}.owner`, `the Home Garden at ${key} has no owner`);
    }
  }

  // At most one Home Garden per seat (a second would make elimination and the
  // AI's target selection ambiguous).
  const homes = new Map<PlayerId, string[]>();
  for (const [key, g] of Object.entries(state.gardens)) {
    if (g.type !== 'home' || g.owner === undefined) continue;
    homes.set(g.owner, [...(homes.get(g.owner) ?? []), key]);
  }
  for (const [owner, keys] of homes) {
    if (keys.length > 1) {
      fail('DUPLICATE_HOME', `gardens`, `seat ${owner} has ${keys.length} Home Gardens (${keys.join(' ')})`);
    }
  }

  // --- per-player counters --------------------------------------------------

  for (const p of state.players) {
    const at = (field: string) => `players.${p.id}.${field}`;
    if (p.id !== state.players.indexOf(p)) {
      fail('PLAYER_ID_MISMATCH', at('id'), `seat at index ${state.players.indexOf(p)} carries id ${p.id}`);
    }
    if (p.wishes < 0) fail('NEGATIVE_WISHES', at('wishes'), `wishes = ${p.wishes}`);
    if (p.gnomesSpawned < 0 || p.gnomesSpawned > config.totalReinforcements) {
      fail('SPAWNED_OUT_OF_RANGE', at('gnomesSpawned'), `gnomesSpawned = ${p.gnomesSpawned}, budget ${config.totalReinforcements}`);
    }
    if (p.gnomesLost < 0 || p.gnomesLost > p.gnomesSpawned) {
      fail('LOST_EXCEEDS_SPAWNED', at('gnomesLost'), `gnomesLost = ${p.gnomesLost} > gnomesSpawned = ${p.gnomesSpawned}`);
    }
    for (const [type, count] of Object.entries(p.supply)) {
      if (count < 0 || count > config.tilesPerType) {
        fail('SUPPLY_OUT_OF_RANGE', at(`supply.${type}`), `${type} supply = ${count}, budget ${config.tilesPerType}`);
      }
    }
    if (p.quickChatsThisTurn < 0) {
      fail('NEGATIVE_QUICKCHATS', at('quickChatsThisTurn'), `quickChatsThisTurn = ${p.quickChatsThisTurn}`);
    }
    if (!inBounds(state, p.homePos)) {
      fail('HOMEPOS_OFF_BOARD', at('homePos'), `homePos (${p.homePos.x},${p.homePos.y}) is off the board`);
    }
    // Gnomes on board can never exceed what has been spawned and not lost.
    const alive = Object.values(state.units).filter((u) => u.owner === p.id && u.kind === 'gnome').length;
    if (alive > p.gnomesSpawned - p.gnomesLost) {
      fail(
        'MORE_GNOMES_THAN_SPAWNED',
        at('gnomesSpawned'),
        `${alive} gnomes on board but only ${p.gnomesSpawned - p.gnomesLost} accounted for (spawned ${p.gnomesSpawned}, lost ${p.gnomesLost})`,
      );
    }
  }

  if (state.rollModifiers.length !== seats) {
    fail('ROLL_MODIFIERS_ARITY', 'rollModifiers', `${state.rollModifiers.length} entries for ${seats} seats`);
  }
  if (state.preventionShields < 0) {
    fail('NEGATIVE_SHIELDS', 'preventionShields', `preventionShields = ${state.preventionShields}`);
  }

  // --- turn / decision consistency -----------------------------------------

  const t = state.turn;
  if (t && (t.activePlayer < 0 || t.activePlayer >= seats)) {
    fail('ACTIVE_PLAYER_OUT_OF_RANGE', 'turn.activePlayer', `activePlayer = ${t.activePlayer}, outside 0..${seats - 1}`);
  }
  if (t && t.number < 1) fail('TURN_NUMBER', 'turn.number', `turn number = ${t.number}`);
  if (state.status === 'playing' && !t) {
    fail('PLAYING_WITHOUT_TURN', 'turn', 'status is "playing" but there is no turn');
  }
  const d = state.pendingDecision;
  if (d && (d.player < 0 || d.player >= seats)) {
    fail('DECISION_PLAYER_OUT_OF_RANGE', 'pendingDecision.player', `decision owed by seat ${d.player}, outside 0..${seats - 1}`);
  }
  if (d && state.players[d.player]?.status === 'out') {
    fail('DECISION_OWED_BY_ELIMINATED', 'pendingDecision.player', `seat ${d.player} is out but owes a ${d.kind} decision`);
  }

  // The interrupt model: an unresolved card stack must be waiting on somebody
  // (a decision), or the game must be over. Anything else is a stuck stack.
  if (state.cardStack.length > 0 && d === null && state.status !== 'finished') {
    fail('STUCK_CARD_STACK', 'cardStack', `${state.cardStack.length} unresolved card(s) with nobody to act`);
  }
  if (state.responseQueue.some((p) => p < 0 || p >= seats)) {
    fail('RESPONSE_QUEUE_SEAT', 'responseQueue', `queue holds a seat outside 0..${seats - 1}`);
  }

  // --- terminal state -------------------------------------------------------

  if (state.status === 'finished' && state.winner !== null) {
    if (state.winner < 0 || state.winner >= seats) {
      fail('WINNER_OUT_OF_RANGE', 'winner', `winner = ${state.winner}, outside 0..${seats - 1}`);
    } else if (state.players[state.winner].status === 'out') {
      fail('ELIMINATED_WINNER', 'winner', `seat ${state.winner} won while eliminated`);
    }
  }
  if (state.status !== 'finished' && state.winner !== null) {
    fail('WINNER_BEFORE_END', 'winner', `winner ${state.winner} recorded while status is "${state.status}"`);
  }

  // --- bookkeeping ----------------------------------------------------------

  if (state.eventCount < state.events.length) {
    fail('EVENT_COUNT', 'eventCount', `eventCount ${state.eventCount} < ${state.events.length} retained events`);
  }
  for (const [a, b] of state.marriages) {
    if (a === b) fail('SELF_MARRIAGE', 'marriages', `unit ${a} is married to itself`);
  }

  return v;
}

/** True when `checkInvariants` finds nothing. */
export function invariantsHold(state: GameState): boolean {
  return checkInvariants(state).length === 0;
}

/**
 * Throw `EngineError('INTERNAL')` listing every violation, or return the state
 * unchanged. `context` is prefixed to the message ("after applyAction(move)"),
 * which is usually the only thing a stack trace can't tell you.
 */
export function assertInvariants(state: GameState, context?: string): GameState {
  const violations = checkInvariants(state);
  if (violations.length === 0) return state;
  const detail = violations.map((x) => `${x.where}: ${x.message} [${x.code}]`).join('; ');
  throw new EngineError('INTERNAL', `${context ? `${context}: ` : ''}game-state invariants broken — ${detail}`);
}
