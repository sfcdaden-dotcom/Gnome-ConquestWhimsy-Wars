/**
 * The pixel-art toolkit the layer sprites are generated with.
 *
 * Sprites are authored as ASCII: one character per logical pixel on a 32x32
 * grid, scaled up 8x to the 256x256 PNGs the game loads. Authoring in text is
 * what makes a beard reviewable in a diff — and what lets a shape be nudged a
 * pixel without opening an image editor.
 *
 * The five ramp characters are the five EXACT greys the compiler recognises.
 * That is the whole contract with `build.mjs`: it snaps greys onto a team's
 * ramp and passes every other colour through untouched, so skin, eyes and
 * outlines are written as real colours here and survive recolouring.
 *
 * This module is only used by the STARTER art (`sprites.mjs` and
 * `export-starter.mjs`). Parts added later are PNGs in `src/assets/art/parts/`
 * and never come through here — see the Art section in README.md.
 */

/** Logical pixels per side. Every sprite is authored on this grid. */
export const GRID = 32;
/** Upscale factor: 32 * 8 = 256px PNGs, the top of the README's size range. */
export const SCALE = 8;

/**
 * The five greys a recolourable pixel may be. Written into the PNG verbatim
 * and matched verbatim at runtime — do not "tidy" these values.
 */
export const RAMP = {
  '0': '#1b1a19', // outline / darkest
  '1': '#4a4a4a', // shadow
  '2': '#7d7d7d', // mid
  '3': '#ababab', // light
  '4': '#d9d9d9', // highlight
};

/** Fixed colours: never remapped, identical on every team. */
export const FIXED = {
  '.': null,      // transparent
  'K': '#241d16', // hard outline (skin, eyes)
  'S': '#c99e63', // skin shadow
  's': '#e8c48f', // skin mid
  'h': '#f7dcb4', // skin highlight
  'e': '#2a2118', // eye
  'w': '#ffffff', // eye white / cap speckle
};

const COLORS = { ...FIXED, ...RAMP };

/**
 * Pad a sprite to the full grid. Trailing blank rows are implied — a cap that
 * stops at row 13 is written as 14 rows, not 14 rows and 18 lines of dots, so
 * the shape stays the only thing in the file worth reading.
 */
export function sprite(rows, name = 'sprite') {
  if (rows.length > GRID) throw new Error(`${name}: ${rows.length} rows, max ${GRID}`);
  return [...rows, ...Array.from({ length: GRID - rows.length }, () => '.'.repeat(GRID))];
}

export function parse(rows, name) {
  if (rows.length !== GRID) throw new Error(`${name}: ${rows.length} rows, want ${GRID}`);
  return rows.map((row, y) => {
    if (row.length !== GRID) throw new Error(`${name}: row ${y} is ${row.length} chars, want ${GRID}`);
    return [...row].map((ch) => {
      if (!(ch in COLORS)) throw new Error(`${name}: row ${y} has unknown char ${JSON.stringify(ch)}`);
      return COLORS[ch];
    });
  });
}
