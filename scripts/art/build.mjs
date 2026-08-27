/**
 * Compiles the part folders into the two generated files the app uses:
 *
 *   src/engine/partCatalog.ts   the ids  (rules + wire + replay)
 *   src/ui/appearance/spriteData.ts   the pixels and labels (rendering)
 *
 * Run `npm run art` after adding, removing or redrawing anything under
 * `src/assets/art/parts/`. Both outputs are generated and checked in, so a
 * normal build stays a plain `tsc && vite build`.
 *
 * ---------------------------------------------------------------------------
 * Why art becomes paths instead of staying a PNG
 * ---------------------------------------------------------------------------
 * A gnome is recoloured to its team's palette at runtime, and an `<img>`
 * cannot be palette-swapped — CSS filters do hue rotation, not a per-step
 * colour map. So each part is converted here, once, into one SVG path per
 * colour, and `gnomeImage.ts` fills those paths with a team's ramp.
 *
 * ---------------------------------------------------------------------------
 * What to draw
 * ---------------------------------------------------------------------------
 * Square, transparent where empty, ideally 256x256. Any square size works: the
 * image is sampled onto the shared 32x32 grid every part is drawn on, so all
 * the layers line up by construction. A size that is a clean multiple of 32
 * keeps pixel edges exact.
 *
 * Colour decides what recolours:
 *
 *   GREY  (r == g == b, within a tolerance) -> snapped to the nearest of the
 *         five ramp steps and painted in the TEAM's colour. Dark greys become
 *         the team's dark shades, light greys its light ones.
 *   ANY OTHER COLOUR -> kept exactly as drawn, on every team. This is how skin
 *         and eyes survive recolouring.
 *
 * Two conventions are load-bearing rather than stylistic, and a part that
 * ignores them will look wrong at the ~20px a board token gets:
 *   - beards use the DARK half of the ramp, caps the LIGHT half, so a gnome's
 *     two big masses stay distinguishable;
 *   - every part is drawn in the same frame — head at x 8-23 / y 8-25, caps
 *     above it, beards below, weapons down the right margin.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRID, RAMP } from './pixel.mjs';
import { CHOOSABLE, LAYERS, NONE_ID, PARTS_DIR } from './layers.mjs';
import { readPng } from './png.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Below this alpha a pixel is nothing at all. */
const ALPHA_FLOOR = 128;
/** How far apart r/g/b may be and still count as "grey", i.e. recolourable. */
const GREY_TOLERANCE = 10;

const RAMP_STEPS = Object.entries(RAMP).map(([key, hex]) => ({
  key,
  level: parseInt(hex.slice(1, 3), 16),
}));

/**
 * A pixel's fill key: a ramp step ('0'-'4') for greys, or a literal '#rrggbb'
 * for anything else. Null means transparent.
 */
function fillKey(r, g, b, a) {
  if (a < ALPHA_FLOOR) return null;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread > GREY_TOLERANCE) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  const level = (r + g + b) / 3;
  let best = RAMP_STEPS[0];
  for (const step of RAMP_STEPS) {
    if (Math.abs(step.level - level) < Math.abs(best.level - level)) best = step;
  }
  return best.key;
}

/** Sample an image onto the 32x32 grid, at the centre of each logical cell. */
function toGrid(img, file) {
  if (img.width !== img.height) {
    throw new Error(`${file}: must be square (got ${img.width}x${img.height})`);
  }
  if (img.width < GRID) {
    throw new Error(`${file}: must be at least ${GRID}x${GRID} (got ${img.width})`);
  }
  const cell = img.width / GRID;
  const rows = [];
  for (let y = 0; y < GRID; y++) {
    const row = [];
    for (let x = 0; x < GRID; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * cell));
      const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * cell));
      row.push(fillKey(...img.at(sx, sy)));
    }
    rows.push(row);
  }
  return rows;
}

/** One path per fill, built by merging each row's runs of identical pixels. */
function toPaths(grid) {
  const runs = new Map();
  for (let y = 0; y < GRID; y++) {
    let x = 0;
    while (x < GRID) {
      const key = grid[y][x];
      if (key === null) { x++; continue; }
      let w = 1;
      while (x + w < GRID && grid[y][x + w] === key) w++;
      if (!runs.has(key)) runs.set(key, []);
      runs.get(key).push(`M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  }
  return Object.fromEntries([...runs].map(([k, v]) => [k, v.join('')]));
}

/**
 * `03-wide-brim.png` -> id `wide-brim`, label "Wide Brim", sort key 3.
 *
 * The numeric prefix orders the picker and is NOT part of the id — ids are
 * stored in match records and sent over the wire, so renumbering the menu must
 * never invalidate a saved game.
 */
function describe(filename) {
  const stem = filename.replace(/\.png$/i, '');
  const m = /^(\d+)[-_](.+)$/.exec(stem);
  const sort = m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  const id = (m ? m[2] : stem).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`"${filename}": id "${id}" must be lowercase letters, digits and dashes`);
  }
  const label = id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return { id, label, sort };
}

const sprites = {};
const catalog = {};
const labels = {};

for (const layer of LAYERS) {
  const dir = path.join(ROOT, PARTS_DIR, layer.dir);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)) : [];
  if (files.length === 0) throw new Error(`${PARTS_DIR}/${layer.dir}/ has no PNGs — every layer needs at least one`);

  const parts = files.map(describe).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  const seen = new Set();
  for (const part of parts) {
    if (seen.has(part.id)) throw new Error(`${layer.dir}: two files resolve to the id "${part.id}"`);
    seen.add(part.id);
  }

  for (const [i, part] of parts.entries()) {
    const file = files[files.map((f) => describe(f).id).indexOf(part.id)];
    const full = path.join(dir, file);
    const grid = toGrid(readPng(full), `${layer.dir}/${file}`);
    sprites[`${layer.id}/${part.id}`] = toPaths(grid);
    labels[`${layer.id}/${part.id}`] = part.label;
    void i;
  }
  catalog[layer.id] = parts.map((p) => p.id);
  if (layer.optional) catalog[layer.id].unshift(NONE_ID);
}

const banner = (what) => `/**
 * GENERATED by \`npm run art\` from ${PARTS_DIR}/ — do not edit.
 *
 * ${what}
 */
`;

fs.writeFileSync(
  path.join(ROOT, 'src/engine/partCatalog.ts'),
  banner(`The parts a gnome can be built from, by layer. Ids come from the
 * filenames, so adding a part is adding a file and re-running the generator.
 *
 * These ids are stored in \`MatchRecord\` and sent over the wire: REMOVING one
 * breaks games that used it, so retire a part by deleting its file only if no
 * saved game needs to replay.`) +
`
export const PART_IDS = ${JSON.stringify(catalog, null, 2)} as const;

/** Layers a player picks from, in the order the picker shows them. */
export const CHOOSABLE_LAYERS = ${JSON.stringify(CHOOSABLE.map((l) => l.id))} as const;

/** The id an optional layer uses for "wearing nothing". Never a file. */
export const NONE_ID = ${JSON.stringify(NONE_ID)};

export type ChoosableLayer = (typeof CHOOSABLE_LAYERS)[number];
`,
);

fs.writeFileSync(
  path.join(ROOT, 'src/ui/appearance/spriteData.ts'),
  banner(`Each sprite is a map from fill key to SVG path data on a ${GRID}x${GRID}
 * viewBox. A single-character key ('0'-'4') is a step of the recolourable ramp,
 * darkest to lightest; a '#rrggbb' key is a fixed colour drawn as-is on every
 * team.`) +
`
/** The viewBox every sprite is drawn on. */
export const SPRITE_GRID = ${GRID};

/** Ramp step keys, darkest first. */
export const RAMP_KEYS = ['0', '1', '2', '3', '4'] as const;
export type RampKey = (typeof RAMP_KEYS)[number];

export type SpritePaths = Readonly<Record<string, string>>;

/** Keyed \`layer/id\`, e.g. \`cap/pointy\`. */
export const SPRITES: Readonly<Record<string, SpritePaths>> = ${JSON.stringify(sprites, null, 2)};

/** Human-readable part names, derived from the filenames. Keyed \`layer/id\`. */
export const PART_LABELS: Readonly<Record<string, string>> = ${JSON.stringify(labels, null, 2)};

/** Layer names for the picker's rows. */
export const LAYER_LABELS: Readonly<Record<string, string>> = ${JSON.stringify(
  Object.fromEntries(CHOOSABLE.map((l) => [l.id, l.label])),
  null,
  2,
)};

/** Bottom to top. */
export const LAYER_ORDER: readonly string[] = ${JSON.stringify(
  [...LAYERS].sort((a, b) => a.order - b.order).map((l) => l.id),
)};
`,
);

const counts = Object.entries(catalog).map(([k, v]) => `${k} ${v.length}`).join(', ');
console.log(`wrote partCatalog.ts + spriteData.ts (${counts})`);
