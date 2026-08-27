/**
 * One-off: renders the ASCII starter sprites in `sprites.mjs` out to PNG files
 * in the part folders, so the art that shipped is editable in the same way as
 * anything added later.
 *
 * `npm run art` does NOT run this. The folders are the source of truth; this
 * only exists so the starter set is reproducible and so its provenance is not
 * a mystery. Re-running it OVERWRITES those files, discarding hand edits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRID, SCALE, parse } from './pixel.mjs';
import { PARTS_DIR } from './layers.mjs';
import { writePng } from './png.mjs';
import * as SPRITES from './sprites.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `CAP_POINTY` -> `cap/pointy`. */
const DEST = {
  BASE: 'base/gnome',
  CAP_POINTY: 'cap/pointy',
  CAP_BULBOUS: 'cap/bulbous',
  CAP_WIDE: 'cap/wide',
  BEARD_POINTY: 'beard/pointy',
  BEARD_WILD: 'beard/wild',
  BEARD_BUSHY: 'beard/bushy',
  WEAPON_SHOVEL: 'weapon/shovel',
  WEAPON_PITCHFORK: 'weapon/pitchfork',
  WEAPON_STAFF: 'weapon/staff',
  ACC_MONOCLE: 'accessory/monocle',
  ACC_PIPE: 'accessory/pipe',
  ACC_LANTERN: 'accessory/lantern',
  CAP_TALL: 'cap/tall',
  CAP_DROOPY: 'cap/droopy',
  BEARD_BRAIDED: 'beard/braided',
  BEARD_STUBBLE: 'beard/stubble',
  WEAPON_AXE: 'weapon/axe',
  WEAPON_BROOM: 'weapon/broom',
  ACC_FLOWER: 'accessory/flower',
  ACC_GLASSES: 'accessory/glasses',
};

const hex = (h) => (h === null ? [0, 0, 0, 0] : [...h.slice(1).match(/../g).map((v) => parseInt(v, 16)), 255]);

let written = 0;
for (const [name, dest] of Object.entries(DEST)) {
  const grid = parse(SPRITES[name], name);
  const file = path.join(ROOT, PARTS_DIR, `${dest}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const size = GRID * SCALE;
  writePng(file, size, size, (x, y) => hex(grid[Math.floor(y / SCALE)][Math.floor(x / SCALE)]));
  written++;
}
console.log(`exported ${written} starter parts to ${PARTS_DIR}/`);
