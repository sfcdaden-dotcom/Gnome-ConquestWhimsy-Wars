/**
 * A seat's gnome: which parts it wears, and which palette it wears them in.
 *
 * This lives in the engine rather than the UI for one reason — an appearance
 * is part of the SEATING, and the seating is part of `GameConfig`, which is
 * what `MatchRecord` replays from. Keeping it here means a replayed game shows
 * the gnomes it was played with, and a networked lobby ships appearances over
 * the same `SeatConfig` that already carries names.
 *
 * The engine stores and validates appearances. It never renders one. The parts
 * themselves are not written down here either: `partCatalog.ts` is GENERATED
 * from the art folders (`npm run art`), so adding a hat is adding a file, not
 * editing this module. The five-step colour ramp a palette stands for is a
 * rendering fact and lives in `src/ui/appearance/palettes.ts`.
 *
 * Randomisation is DERIVED, not drawn — the same choice `gnomeNames.ts` makes,
 * for the same reason. Pulling a default look through the engine's RNG would
 * shift `rngState` and invalidate every seeded test and recorded match, so an
 * unconfigured seat's look is a pure function of a salt and the seat index.
 *
 * One field here is not cosmetic: seats that share a PALETTE are on the same
 * team (see teams.ts). That makes "who has which colour" a rules input, and it
 * is why the resolution below never hands out a shared palette by accident —
 * a team is something players opt into, never something a random draw or a
 * collision does to them.
 */

import { CHOOSABLE_LAYERS, NONE_ID, PART_IDS, type ChoosableLayer } from './partCatalog';
import { normalizeSeed } from './rng';

export { CHOOSABLE_LAYERS, NONE_ID, PART_IDS };
export type { ChoosableLayer };

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * Team palettes. The first four are the historical seat colours (red, blue,
 * yellow, purple) so an old `MatchRecord` with no appearances replays looking
 * like it did; the rest exist because a seat's colour now follows the player
 * who chose it — and because sharing one is how players declare a team.
 */
export const PALETTE_IDS = [
  'red', 'blue', 'yellow', 'purple',
  'green', 'teal', 'orange', 'pink',
] as const;

export type PaletteId = (typeof PALETTE_IDS)[number];

/** The parts a gnome wears, one id per choosable layer. */
export type GnomeParts = { [L in ChoosableLayer]: (typeof PART_IDS)[L][number] };

export interface PlayerAppearance extends GnomeParts {
  palette: PaletteId;
}

/** Ids available for a layer, including `'none'` where the layer is optional. */
export function partIds(layer: ChoosableLayer): readonly string[] {
  return PART_IDS[layer];
}

/** Does this layer allow wearing nothing? True when `'none'` leads its list. */
export function isOptionalLayer(layer: ChoosableLayer): boolean {
  return PART_IDS[layer][0] === NONE_ID;
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

/**
 * The look an unconfigured seat wears: random-feeling, but a pure function of
 * the salt and the seat, so it is identical on every client of a networked
 * game and identical on every replay of a recorded one.
 *
 * The palette is NOT drawn here. Two seats drawing independently would collide
 * — and colliding is now how a TEAM is formed, so an unlucky draw would draft
 * people onto teams they never chose. `resolveAppearances` assigns palettes,
 * which is the only place that can see every seat at once.
 */
export function randomLook(salt: number, seat: number): GnomeParts {
  const parts = {} as Record<string, string>;
  CHOOSABLE_LAYERS.forEach((layer, slot) => {
    const ids = PART_IDS[layer] as readonly string[];
    if (isOptionalLayer(layer)) {
      // Weighted so a bare slot is as likely as ALL the parts together rather
      // than one option among many — most gnomes should not be wearing a
      // lantern, however many accessories the folder grows to.
      const worn = ids.filter((id) => id !== NONE_ID);
      parts[layer] =
        draw(salt, seat, slot * 2) % 2 === 0
          ? NONE_ID
          : worn[mod(draw(salt, seat, slot * 2 + 1), worn.length)];
      return;
    }
    parts[layer] = ids[mod(draw(salt, seat, slot * 2), ids.length)];
  });
  return parts as GnomeParts;
}

// ---------------------------------------------------------------------------
// Validation and resolution
// ---------------------------------------------------------------------------

function isMember(pool: readonly string[], v: unknown): v is string {
  return typeof v === 'string' && pool.includes(v);
}

/**
 * Is this a complete, in-catalogue appearance? Structural only — it says
 * nothing about teams. Networked lobbies MUST run untrusted seat configuration
 * through this: everything downstream indexes sprite tables by these ids.
 */
export function isPlayerAppearance(v: unknown): v is PlayerAppearance {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (!isMember(PALETTE_IDS, a.palette)) return false;
  return CHOOSABLE_LAYERS.every((layer) => isMember(PART_IDS[layer], a[layer]));
}

/**
 * Fill in every seat's appearance.
 *
 * Seats that chose a look keep it, EXACTLY — including a palette another seat
 * already has, because sharing a palette is how two players declare
 * themselves teammates and refusing it would refuse the feature.
 *
 * Seats that chose nothing get `randomLook` for their parts and a palette
 * nobody else holds. That asymmetry is the point: a shared colour is always
 * deliberate. A default seating is a free-for-all, and nobody is ever drafted
 * onto a team by an unlucky draw.
 *
 * If the catalogue runs out of free palettes (more seats than colours), a seat
 * falls back to its seat-ordered default, which may collide. That is
 * unreachable at 4 seats and 8 palettes, and `createGame` validates the team
 * split it produces regardless.
 *
 * Deterministic given (salt, requests), so host and client agree without the
 * host having to broadcast the resolution.
 */
export function resolveAppearances(
  requested: readonly (Partial<PlayerAppearance> | undefined)[],
  salt: number,
): PlayerAppearance[] {
  // Only EXPLICIT choices reserve a colour. An auto-assigned seat avoids every
  // explicit pick, so it can never be forced onto somebody else's team.
  const chosen = requested.map((req) =>
    isMember(PALETTE_IDS, req?.palette) ? (req.palette as PaletteId) : null,
  );
  const taken = new Set<PaletteId>(chosen.filter((p): p is PaletteId => p !== null));
  return requested.map((req, seat) => {
    const look = randomLook(salt, seat);
    let palette = chosen[seat];
    if (palette === null) {
      palette = PALETTE_IDS.find((p) => !taken.has(p)) ?? defaultPalette(seat);
      taken.add(palette);
    }
    const parts = {} as Record<string, string>;
    for (const layer of CHOOSABLE_LAYERS) {
      const want = (req as Record<string, unknown> | undefined)?.[layer];
      parts[layer] = isMember(PART_IDS[layer], want) ? want : look[layer];
    }
    return { palette, ...(parts as GnomeParts) };
  });
}
