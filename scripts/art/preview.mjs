/**
 * Dev tool: renders a contact sheet of every part, composited onto a gnome and
 * recoloured to a team palette, so a new drawing can be checked before it
 * reaches the game.
 *
 *   npm run art:preview            # all layers, default palette
 *   npm run art:preview -- cap     # one layer
 *   npm run art:preview -- cap teal
 *
 * Writes `art-preview.png` in the repo root (git-ignored). Each part is shown
 * on a full gnome, because a cap alone tells you nothing about whether it
 * collides with the beard.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRID, RAMP } from './pixel.mjs';
import { CHOOSABLE, LAYERS, PARTS_DIR } from './layers.mjs';
import { readPng, writePng } from './png.mjs';
import fs from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [wantLayer, wantPalette = 'red'] = process.argv.slice(2);

/** Must match src/ui/appearance/palettes.ts — this is a preview, not the app. */
const ACCENTS = {
  red: '#d8504d', blue: '#3f7ad8', yellow: '#c9930a', purple: '#9256cf',
  green: '#4a9d4a', teal: '#2fa39b', orange: '#dd7a2e', pink: '#d861a0',
};
const STOPS = { '0': -0.78, '1': -0.45, '2': 0, '3': 0.28, '4': 0.6 };
const DISC_STOP = -0.28;

function mix(hex, t) {
  const [r, g, b] = hex.slice(1).match(/../g).map((v) => parseInt(v, 16));
  const f = (c) => (t < 0 ? c * (1 + t) : c + (255 - c) * t);
  return [f(r), f(g), f(b)].map((c) => Math.round(Math.max(0, Math.min(255, c))));
}

const accent = ACCENTS[wantPalette] ?? ACCENTS.red;
const ramp = Object.fromEntries(Object.entries(STOPS).map(([k, t]) => [RAMP[k], mix(accent, t)]));
const disc = mix(accent, DISC_STOP);

function loadGrid(file) {
  const img = readPng(file);
  const cell = img.width / GRID;
  return Array.from({ length: GRID }, (_, y) =>
    Array.from({ length: GRID }, (_, x) =>
      img.at(Math.min(img.width - 1, Math.floor((x + 0.5) * cell)), Math.min(img.height - 1, Math.floor((y + 0.5) * cell))),
    ),
  );
}

function partsIn(layer) {
  const dir = path.join(ROOT, PARTS_DIR, layer.dir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort()
    .map((f) => ({ name: f.replace(/\.png$/i, ''), grid: loadGrid(path.join(dir, f)) }));
}

const base = partsIn(LAYERS.find((l) => l.id === 'base'))[0];
if (!base) throw new Error('no base part to preview against');

/** Defaults the varied layer is shown against. */
const defaults = Object.fromEntries(
  CHOOSABLE.map((l) => [l.id, partsIn(l)[0] ?? null]),
);

const layers = CHOOSABLE.filter((l) => !wantLayer || l.id === wantLayer);
if (layers.length === 0) throw new Error(`unknown layer "${wantLayer}"`);

const rows = layers.map((layer) => ({ layer, parts: partsIn(layer) }));
const cols = Math.max(...rows.map((r) => r.parts.length));
const PAD = 2, CELL = GRID + PAD * 2, SCALE = 6;
const W = cols * CELL * SCALE, H = rows.length * CELL * SCALE;
const px = Buffer.alloc(W * H * 3, 0x14);

const ORDER = [...LAYERS].sort((a, b) => a.order - b.order);

rows.forEach(({ layer, parts }, ri) => {
  parts.forEach((part, ci) => {
    const stack = ORDER.map((l) => {
      if (l.id === 'base') return base.grid;
      if (l.id === layer.id) return part.grid;
      return defaults[l.id]?.grid ?? null;
    }).filter(Boolean);

    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const c = (x - (GRID / 2 - 0.5)) ** 2 + (y - (GRID / 2 - 0.5)) ** 2 <= (GRID / 2) ** 2 ? disc : [20, 20, 20];
        let out = c;
        for (const g of stack) {
          const [r, gr, b, a] = g[y][x];
          if (a < 128) continue;
          const spread = Math.max(r, gr, b) - Math.min(r, gr, b);
          if (spread > 10) { out = [r, gr, b]; continue; }
          // Snap the grey to the nearest ramp step, then paint it in the team's.
          const level = (r + gr + b) / 3;
          let best = null, bestD = Infinity;
          for (const [hex, rgb] of Object.entries(ramp)) {
            const d = Math.abs(parseInt(hex.slice(1, 3), 16) - level);
            if (d < bestD) { bestD = d; best = rgb; }
          }
          out = best;
        }
        for (let sy = 0; sy < SCALE; sy++) {
          for (let sx = 0; sx < SCALE; sx++) {
            const X = (ci * CELL + PAD + x) * SCALE + sx;
            const Y = (ri * CELL + PAD + y) * SCALE + sy;
            const o = (Y * W + X) * 3;
            px[o] = out[0]; px[o + 1] = out[1]; px[o + 2] = out[2];
          }
        }
      }
    }
  });
});

const outFile = path.join(ROOT, 'art-preview.png');
writePng(outFile, W, H, (x, y) => {
  const o = (y * W + x) * 3;
  return [px[o], px[o + 1], px[o + 2], 255];
});
console.log(`wrote art-preview.png — ${rows.map((r) => `${r.layer.id} ${r.parts.length}`).join(', ')}, ${wantPalette}`);
