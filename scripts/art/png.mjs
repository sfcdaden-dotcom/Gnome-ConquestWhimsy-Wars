/**
 * PNG read/write for the part compiler.
 *
 * Deliberately dependency-free: the build already runs on plain node, and a
 * decoder for the handful of PNG flavours an image editor emits is ~80 lines.
 * Handles 8-bit greyscale, RGB, indexed and their alpha variants, plus the
 * 1/2/4-bit indexed files small pixel-art tools like to write.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode to `{ width, height, at(x, y) -> [r, g, b, a] }`. */
export function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);

  let off = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error(`${file}: no IHDR`);
  if (ihdr.interlace) throw new Error(`${file}: interlaced PNGs are not supported — re-export without Adam7`);

  const { width, height, depth, color } = ihdr;
  const channels = CHANNELS[color];
  if (channels === undefined) throw new Error(`${file}: unsupported colour type ${color}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) / 8);
  const bytesPerRow = Math.ceil((width * channels * depth) / 8);
  const out = Buffer.alloc(height * bytesPerRow);

  // Undo the per-row filters (PNG spec §9).
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + bytesPerRow);
    pos += bytesPerRow;
    const cur = out.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    const prev = y > 0 ? out.subarray((y - 1) * bytesPerRow, y * bytesPerRow) : Buffer.alloc(bytesPerRow);
    for (let x = 0; x < bytesPerRow; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }

  const perByte = 8 / depth;
  const max = (1 << depth) - 1;
  const sample = (x, y, ch) => {
    const i = x * channels + ch;
    if (depth === 8) return out[y * bytesPerRow + i];
    if (depth === 16) return out[y * bytesPerRow + i * 2]; // high byte is plenty
    const byte = out[y * bytesPerRow + Math.floor(i / perByte)];
    return (byte >> (8 - depth * ((i % perByte) + 1))) & max;
  };
  const scale = depth === 8 || depth === 16 ? 1 : 255 / max;

  function at(x, y) {
    if (color === 3) {
      const idx = sample(x, y, 0);
      if (!plte) throw new Error(`${file}: indexed PNG with no palette`);
      const a = trns && idx < trns.length ? trns[idx] : 255;
      return [plte[idx * 3], plte[idx * 3 + 1], plte[idx * 3 + 2], a];
    }
    if (color === 0 || color === 4) {
      const g = Math.round(sample(x, y, 0) * scale);
      return [g, g, g, color === 4 ? Math.round(sample(x, y, 1) * scale) : 255];
    }
    const r = Math.round(sample(x, y, 0) * scale);
    const g = Math.round(sample(x, y, 1) * scale);
    const b = Math.round(sample(x, y, 2) * scale);
    return [r, g, b, color === 6 ? Math.round(sample(x, y, 3) * scale) : 255];
  }

  return { width, height, at };
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

/** Write RGBA pixels (`get(x, y) -> [r,g,b,a]`) as an 8-bit RGBA PNG. */
export function writePng(file, width, height, get) {
  const stride = width * 4 + 1;
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = get(x, y);
      rows[o++] = r; rows[o++] = g; rows[o++] = b; rows[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
