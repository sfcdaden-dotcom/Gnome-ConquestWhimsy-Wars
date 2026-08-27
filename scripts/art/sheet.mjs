/** Dev-only: composite the sprites onto team discs and write one contact sheet. */
import fs from 'node:fs';
import { GRID, parse, RAMP } from './pixel.mjs';
import * as S from './sprites.mjs';

const PAD = 2, CELL = GRID + PAD * 2, SCALE = 6;

const args = process.argv.slice(2);
const out = args[0];
const cols = JSON.parse(fs.readFileSync(args[1], 'utf8'));
const stacks = JSON.parse(fs.readFileSync(args[2], 'utf8'));

function ramp(base) {
  const [r0, g0, b0] = base.slice(1).match(/../g).map((v) => parseInt(v, 16));
  const mix = (t) => (t < 0 ? [r0 * (1 + t), g0 * (1 + t), b0 * (1 + t)] : [r0 + (255 - r0) * t, g0 + (255 - g0) * t, b0 + (255 - b0) * t]);
  const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  return { [RAMP['0']]: hex(mix(-0.78)), [RAMP['1']]: hex(mix(-0.45)), [RAMP['2']]: hex(mix(0)), [RAMP['3']]: hex(mix(0.28)), [RAMP['4']]: hex(mix(0.6)) };
}

const rows = stacks.length, colsN = cols.length;
const W = colsN * CELL * SCALE, H = rows * CELL * SCALE;
const px = Buffer.alloc(W * H * 3, 0x14);

for (let ri = 0; ri < rows; ri++) {
  for (let ci = 0; ci < colsN; ci++) {
    const map = ramp(cols[ci]);
    const bg = map[RAMP["0"]].slice(1).match(/../g).map((v) => parseInt(v, 16));
    const layers = stacks[ri].map((n) => parse(S[n], n));
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      const cx = GRID / 2 - 0.5, cy = GRID / 2 - 0.5;
      let c = (x - cx) ** 2 + (y - cy) ** 2 <= (GRID / 2) ** 2 ? bg : [20, 20, 20];
      for (const L of layers) { const v = L[y][x]; if (v) c = (map[v] ?? v).slice(1).match(/../g).map((q) => parseInt(q, 16)); }
      for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) {
        const X = (ci * CELL + PAD + x) * SCALE + sx, Y = (ri * CELL + PAD + y) * SCALE + sy;
        const o = (Y * W + X) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
      }
    }
  }
}

const zlib = await import('node:zlib');
const stride = W * 3 + 1, raw = Buffer.alloc(H * stride);
for (let y = 0; y < H; y++) px.copy(raw, y * stride + 1, y * W * 3, (y + 1) * W * 3);
let T = null; const crc32 = (b) => { if (!T) { T = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } } let c = 0xffffffff; for (const v of b) c = T[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
