/**
 * The pixel-art toolkit the layer sprites are generated with.
 *
 * Sprites are authored as ASCII: one character per logical pixel on a 32x32
 * grid, scaled up 8x to the 256x256 PNGs the game loads. Authoring in text is
 * what makes a beard reviewable in a diff — and what lets a shape be nudged a
 * pixel without opening an image editor.
 *
 * The five ramp characters are written out as five EXACT greys. That is the
 * whole contract with the recolourer at runtime (`appearance/recolor.ts`): it
 * maps those five values onto a team ramp and passes every other colour
 * through untouched. So skin, eyes and outlines are written as real colours
 * here and survive recolouring; anything drawn in the ramp takes the team's.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

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

function rgba(hex) {
  if (hex === null) return [0, 0, 0, 0];
  const [r, g, b] = hex.slice(1).match(/../g).map((v) => parseInt(v, 16));
  return [r, g, b, 255];
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const v of buf) c = CRC_TABLE[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Nearest-neighbour upscale to `GRID * SCALE`, written as an RGBA PNG. */
export function writePng(file, grid) {
  const size = GRID * SCALE;
  const stride = size * 4 + 1;
  const rows = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const src = grid[Math.floor(y / SCALE)];
    let o = y * stride + 1;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = rgba(src[Math.floor(x / SCALE)]);
      rows[o++] = r; rows[o++] = g; rows[o++] = b; rows[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
