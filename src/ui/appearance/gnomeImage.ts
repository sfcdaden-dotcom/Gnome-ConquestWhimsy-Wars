/**
 * Builds a seat's gnome as an image.
 *
 * The five layers are composited into ONE SVG document and handed to an
 * `<img>` as a data URI, rather than mounted as live SVG elements. That is a
 * deliberate trade: a 4-player board can show a couple of dozen tokens, and
 * each live gnome would be ~20 `<path>` nodes for the browser to lay out and
 * re-style on every render. As a data URI the browser rasterises each DISTINCT
 * look once and reuses it everywhere, and the result drops straight into the
 * `.art` / `.token-face` styling the PNG units already use.
 *
 * The document is memoised by look, so the cost is paid once per (parts,
 * palette) combination and never again — bounded by the catalogue at
 * 3 x 3 x 3 x 4 x 8 = 864 possibilities, and in practice by the four in play.
 */

import type { PlayerAppearance } from '../../engine';
import { PALETTES } from './palettes';
import { SPRITES, SPRITE_GRID, type RampKey, type SpritePaths } from './spriteData';

/**
 * Bottom to top. The weapon goes UNDER the body on purpose: the beard then
 * overlaps the shaft, which reads as the gnome holding it rather than standing
 * next to it.
 */
function layersOf(a: PlayerAppearance): SpritePaths[] {
  const parts = [
    SPRITES[`WEAPON_${a.weapon.toUpperCase()}`],
    SPRITES.BASE,
    SPRITES[`BEARD_${a.beard.toUpperCase()}`],
    SPRITES[`CAP_${a.cap.toUpperCase()}`],
    a.accessory === 'none' ? undefined : SPRITES[`ACC_${a.accessory.toUpperCase()}`],
  ];
  // An id outside the catalogue means the sprite table and engine/appearance.ts
  // have drifted. Skip it rather than render `undefined` into the document.
  return parts.filter((p): p is SpritePaths => p !== undefined);
}

const cache = new Map<string, string>();

export function lookKey(a: PlayerAppearance): string {
  return `${a.palette}/${a.cap}/${a.beard}/${a.weapon}/${a.accessory}`;
}

/** The gnome as an SVG data URI, built once per distinct look. */
export function gnomeImageUrl(appearance: PlayerAppearance): string {
  const key = lookKey(appearance);
  const hit = cache.get(key);
  if (hit) return hit;

  const ramp = PALETTES[appearance.palette].ramp;
  const body = layersOf(appearance)
    .flatMap((layer) =>
      Object.entries(layer).map(
        ([fill, d]) => `<path d="${d}" fill="${fill.startsWith('#') ? fill : ramp[fill as RampKey]}"/>`,
      ),
    )
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPRITE_GRID} ${SPRITE_GRID}" shape-rendering="crispEdges">${body}</svg>`;
  // encodeURIComponent rather than base64: the document is small, and a
  // readable URI is a readable devtools panel.
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(key, url);
  return url;
}

