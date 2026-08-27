/**
 * A seat's gnome: which parts it wears, and which palette it wears them in.
 *
 * This lives in the engine rather than the UI for one reason — an appearance
 * is part of the SEATING, and the seating is part of `GameConfig`, which is
 * what `MatchRecord` replays from. Keeping it here means a replayed game shows
 * the gnomes it was played with, and a networked lobby ships appearances over
 * the same `SeatConfig` that already carries names.
 *
 * The engine stores and validates appearances. It never renders one and never
 * consults one: no rule, no legal action and no AI decision reads this. The
 * five-step colour ramp each palette id stands for is a rendering fact and
 * lives in `src/ui/appearance/palettes.ts`.
 *
 * Randomisation is DERIVED, not drawn — the same choice `gnomeNames.ts` makes,
 * for the same reason. Pulling a default look through the engine's RNG would
 * shift `rngState` and invalidate every seeded test and recorded match, so an
 * unconfigured seat's look is a pure function of a salt and the seat index.
 */

import { normalizeSeed } from './rng';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** Mushroom caps, by silhouette. */
export const CAP_IDS = ['pointy', 'bulbous', 'wide'] as const;
export const BEARD_IDS = ['pointy', 'wild', 'bushy'] as const;
export const WEAPON_IDS = ['shovel', 'pitchfork', 'staff'] as const;
/** The accessory slot is the one that may be empty. */
export const ACCESSORY_IDS = ['none', 'monocle', 'pipe', 'lantern'] as const;

/**
 * Team palettes. The first four are the historical seat colours (red, blue,
 * yellow, purple) so an old `MatchRecord` with no appearances replays looking
 * like it did; the rest exist because a seat's colour now follows the player
 * who chose it, and four choices for four seats is not a choice.
 */
export const PALETTE_IDS = [
  'red', 'blue', 'yellow', 'purple',
  'green', 'teal', 'orange', 'pink',
] as const;

export type CapId = (typeof CAP_IDS)[number];
export type BeardId = (typeof BEARD_IDS)[number];
export type WeaponId = (typeof WEAPON_IDS)[number];
export type AccessoryId = (typeof ACCESSORY_IDS)[number];
export type PaletteId = (typeof PALETTE_IDS)[number];

export interface PlayerAppearance {
  palette: PaletteId;
  cap: CapId;
  beard: BeardId;
  weapon: WeaponId;
  accessory: AccessoryId;
}

/**
 * The palette a seat gets when nothing else decides. Index into `PALETTE_IDS`,
 * so seat 0 is red, seat 1 blue, and so on — matching the colours the game
 * shipped with.
 */
export function defaultPalette(seat: number): PaletteId {
  return PALETTE_IDS[mod(seat, PALETTE_IDS.length)];
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * A decorrelated 32-bit draw for one (salt, seat, slot). Each slot mixes in its
 * own constant, so two seats one apart don't get looks one apart, and a seat's
 * cap doesn't move in lockstep with its beard.
 */
function draw(salt: number, seat: number, slot: number): number {
  let h = normalizeSeed(salt) ^ Math.imul(seat + 1, 0x9e3779b1) ^ Math.imul(slot + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function pick<T>(pool: readonly T[], salt: number, seat: number, slot: number): T {
  return pool[mod(draw(salt, seat, slot), pool.length)];
}

/**
 * The look an unconfigured seat wears: random-feeling, but a pure function of
 * the salt and the seat, so it is identical on every client of a networked
 * game and identical on every replay of a recorded one.
 *
 * The palette is NOT drawn here. Two seats drawing independently would collide
 * — and a game where both players are teal is a broken game, not an unlucky
 * one. `resolveAppearances` assigns palettes, which is the only place that can
 * see every seat at once.
 */
export function randomLook(salt: number, seat: number): Omit<PlayerAppearance, 'palette'> {
  return {
    cap: pick(CAP_IDS, salt, seat, 0),
    beard: pick(BEARD_IDS, salt, seat, 1),
    weapon: pick(WEAPON_IDS, salt, seat, 2),
    // Weighted so a bare gnome is as likely as any single accessory rather
    // than three times less likely — most gnomes should not be wearing a
    // lantern.
    accessory: draw(salt, seat, 3) % 2 === 0 ? 'none' : pick(ACCESSORY_IDS.slice(1), salt, seat, 4),
  };
}

// ---------------------------------------------------------------------------
// Validation and resolution
// ---------------------------------------------------------------------------

function isMember<T extends string>(pool: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (pool as readonly string[]).includes(v);
}

/**
 * Is this a complete, in-catalogue appearance? Structural only — it says
 * nothing about whether the palette is free. Networked lobbies MUST run
 * untrusted seat configuration through this: everything downstream indexes
 * sprite tables by these ids.
 */
export function isPlayerAppearance(v: unknown): v is PlayerAppearance {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    isMember(PALETTE_IDS, a.palette) &&
    isMember(CAP_IDS, a.cap) &&
    isMember(BEARD_IDS, a.beard) &&
    isMember(WEAPON_IDS, a.weapon) &&
    isMember(ACCESSORY_IDS, a.accessory)
  );
}

/**
 * Fill in every seat's appearance and guarantee the palettes are distinct.
 *
 * Seats that chose a look keep it. Seats that did not get `randomLook`. Then
 * palettes are settled in seat order: an explicit choice wins, an earlier seat
 * beats a later one for the same palette, and a seat left without one takes
 * the first palette nobody else has. Distinctness is the load-bearing part —
 * the whole board reads seat identity off this colour.
 *
 * Deterministic given (salt, requests), so host and client agree without the
 * host having to broadcast the resolution.
 */
export function resolveAppearances(
  requested: readonly (Partial<PlayerAppearance> | undefined)[],
  salt: number,
): PlayerAppearance[] {
  const taken = new Set<PaletteId>();
  const palettes: (PaletteId | null)[] = requested.map((req) => {
    const want = req?.palette;
    if (!isMember(PALETTE_IDS, want) || taken.has(want)) return null;
    taken.add(want);
    return want;
  });
  return requested.map((req, seat) => {
    const look = randomLook(salt, seat);
    let palette = palettes[seat];
    if (palette === null) {
      palette = PALETTE_IDS.find((p) => !taken.has(p)) ?? defaultPalette(seat);
      taken.add(palette);
    }
    return {
      palette,
      cap: isMember(CAP_IDS, req?.cap) ? req.cap : look.cap,
      beard: isMember(BEARD_IDS, req?.beard) ? req.beard : look.beard,
      weapon: isMember(WEAPON_IDS, req?.weapon) ? req.weapon : look.weapon,
      accessory: isMember(ACCESSORY_IDS, req?.accessory) ? req.accessory : look.accessory,
    };
  });
}
