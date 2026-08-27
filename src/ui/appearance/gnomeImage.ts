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

import { CHOOSABLE_LAYERS, NONE_ID, PART_IDS, type PlayerAppearance } from '../../engine';
import { PALETTES } from './palettes';
import { LAYER_ORDER, SPRITES, SPRITE_GRID, type RampKey, type SpritePaths } from './spriteData';

/**
 * The sprites to stack, bottom to top, following the generated `LAYER_ORDER`.
 *
 * The body is not a choice, so it is looked up from the catalogue rather than
 * the appearance. A layer set to `none` contributes nothing, and an id outside
 * the catalogue means the sprite table and the engine have drifted — skipped
 * rather than rendered as `undefined`.
 */
function layersOf(a: PlayerAppearance): SpritePaths[] {
  const chosen = a as unknown as Record<string, string>;
  return LAYER_ORDER.map((layer) => {
    const id = layer === 'base' ? PART_IDS.base[0] : chosen[layer];
    return id && id !== NONE_ID ? SPRITES[`${layer}/${id}`] : undefined;
  }).filter((p): p is SpritePaths => p !== undefined);
}

const cache = new Map<string, string>();

/** A stable key for one look — also what `data-look` exposes for tests. */
export function lookKey(a: PlayerAppearance): string {
  const chosen = a as unknown as Record<string, string>;
  return [a.palette, ...CHOOSABLE_LAYERS.map((l) => chosen[l])].join('/');
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

