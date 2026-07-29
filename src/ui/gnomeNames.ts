/**
 * Gnome names — deterministic flavour identity for individual gnomes.
 *
 * Names are DERIVED, never stored: `(seed, unitId) -> name`, a pure function.
 * That choice matters for three reasons.
 *
 *  1. No randomness is consumed. Drawing names through the engine's RNG would
 *     shift `rngState` and invalidate every seeded test, AI smoke suite and
 *     recorded self-play match. A pure function costs the engine nothing.
 *  2. It works for units that no longer exist. The most valuable place to show
 *     a name is a destruction line — and by then `destroyUnit` has removed the
 *     unit from `state.units`. Deriving from the id in the *event* still works.
 *  3. `seed` is already part of `MatchRecord`, so names reproduce on replay
 *     with no extra stored data and no schemaVersion decision.
 *
 * The identity facts (which unit, whose, what kind) are engine facts and travel
 * on the events themselves — see the `unitKind` fields in `GameEvent`. This
 * module only turns those facts into text. It must never re-derive a historical
 * fact from `state.units`, which describes the board NOW, not when the event
 * happened.
 */

import type { GameState, PlayerId, UnitId, UnitKind } from '../engine';
import { nameSaltOf, normalizeSeed } from '../engine';

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/** 40 first names × 16 epithets = 640 distinct full names per game. */
export const FIRST_NAMES: readonly string[] = [
  'Bramblewick', 'Thistleknot', 'Mossbottom', 'Pipbury', 'Fennelgrub',
  'Tuffet', 'Grumblenook', 'Radishaw', 'Cloverfoot', 'Nettlespry',
  'Barrowdeen', 'Wobblestump', 'Snugglethorn', 'Gribbet', 'Marrowick',
  'Puddlefoot', 'Hazelnub', 'Cricklewood', 'Dimplebark', 'Sprocketmoss',
  'Tanglewhisk', 'Burdockle', 'Quillifer', 'Mudgeon', 'Peatwhistle',
  'Rumblebriar', 'Figwort', 'Toadflax', 'Wimblesnap', 'Crumpetty',
  'Lichenby', 'Sorrelgrit', 'Bindlewick', 'Gorseknuckle', 'Turniphead',
  'Drizzlecap', 'Knobblespur', 'Yarrowgate', 'Spudgeon', 'Wortleby',
];

export const EPITHETS: readonly string[] = [
  'the Bold', 'the Damp', 'the Unwashed', 'the Stout',
  'the Sly', 'the Grim', 'the Lucky', 'the Lost',
  'the Cross', 'the Sturdy', 'the Quick', 'the Quiet',
  'the Restless', 'the Weathered', 'the Untidy', 'the Doomed',
];

/** Distinct full names available before the scheme wraps and repeats. */
export const NAME_SPACE = FIRST_NAMES.length * EPITHETS.length;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Always-positive modulo. JS `%` keeps the sign of the dividend, so a bare `%`
 * here could produce a negative array index and render `undefined`. Every
 * modulo in this file goes through it.
 */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * The unit's ordinal, or null if the id does not follow the documented
 * `UnitId` contract (`u` + a positive decimal integer, allocated sequentially
 * from `nextUnitId` — see types.ts).
 */
function ordinal(unitId: UnitId): number | null {
  const m = /^u([1-9][0-9]*)$/.exec(unitId);
  return m ? Number(m[1]) : null;
}

/**
 * Per-game offsets into the two pools. Reuses the engine's own seed
 * canonicalization, so an arbitrary `state.seed` — negative, zero, fractional
 * or huge — always lands on a valid uint32 before it reaches the pools.
 */
function offsets(seed: number): { first: number; epithet: number } {
  return {
    first: mod(normalizeSeed(seed), FIRST_NAMES.length),
    // A second, independent draw: the same mixer over a decorrelated seed, so
    // first name and epithet don't advance in lockstep across games.
    epithet: mod(normalizeSeed(seed ^ 0x5bf03635), EPITHETS.length),
  };
}

/**
 * The gnome's first name alone — the short label for cramped UI (selection
 * chips). Unique across any `FIRST_NAMES.length` CONSECUTIVE ordinals; since
 * snails consume ordinals too, an arbitrary set of live gnomes can still
 * collide, so callers that need certainty must fall back to `gnomeName`.
 */
export function gnomeFirstName(seed: number, unitId: UnitId): string {
  const n = ordinal(unitId);
  if (n === null) return unitId;
  const off = offsets(seed);
  return FIRST_NAMES[mod(n - 1 + off.first, FIRST_NAMES.length)];
}

/**
 * The gnome's full name, e.g. "Bramblewick the Bold". Distinct for the first
 * `NAME_SPACE` ordinals of a game (a 4-player game issues ~68 unit ids, so the
 * wrap is unreachable in practice).
 *
 * Ids that don't match the `UnitId` contract fall back to the raw id — a
 * documented degradation, not a supported input.
 */
export function gnomeName(seed: number, unitId: UnitId): string {
  const n = ordinal(unitId);
  if (n === null) return unitId;
  const i = n - 1;
  const off = offsets(seed);
  const first = FIRST_NAMES[mod(i + off.first, FIRST_NAMES.length)];
  const epithet = EPITHETS[mod(Math.floor(i / FIRST_NAMES.length) + off.epithet, EPITHETS.length)];
  return `${first} ${epithet}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The identity facts an event carries about a unit. */
export interface UnitEventRef {
  unitId: UnitId;
  player: PlayerId;
  unitKind: UnitKind;
}

function seatName(state: GameState, player: PlayerId): string {
  return state.players[player]?.name ?? `Player ${player + 1}`;
}

/**
 * Name a unit from an EVENT — the historical path, used by the game log.
 *
 * Reads only `state.seed` and the seat's name, both fixed for the whole game.
 * It deliberately never touches `state.units`: the unit may well be gone, and
 * the event already carries every fact needed to label it.
 */
export function unitNameFromEvent(state: GameState, ref: UnitEventRef): string {
  return ref.unitKind === 'snail'
    ? `${seatName(state, ref.player)}'s Immortal Snail`
    : gnomeName(nameSaltOf(state), ref.unitId);
}

/**
 * Name a unit that is on the board RIGHT NOW — tooltips, selection chips, and
 * labels for pending decisions, all of which reference live units by
 * definition.
 *
 * Degrades rather than throwing: an id with no live unit still yields a gnome
 * name, so a race or a stale reference can never render `undefined`. Use
 * `unitNameFromEvent` for anything historical, where the kind is known.
 */
export function unitNameLive(state: GameState, unitId: UnitId): string {
  const u = state.units[unitId];
  if (!u) return gnomeName(nameSaltOf(state), unitId);
  return unitNameFromEvent(state, { unitId, player: u.owner, unitKind: u.kind });
}
