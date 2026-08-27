/**
 * The layer sprites, as ASCII on the shared 32x32 grid.
 *
 * Every layer is drawn in the SAME frame, so the pieces line up by
 * construction: the head sits at x 9-22 / y 9-23, a cap hangs off the top of
 * it, a beard hangs off the bottom, a weapon runs down the right margin and an
 * accessory sits wherever it belongs on the face. Nothing is positioned at
 * runtime — a layer is either drawn in the right place or it is redrawn.
 *
 * Characters: see `pixel.mjs`. `0`-`4` are the recolourable ramp (dark to
 * light); `K/S/s/h/e/w` are fixed colours that survive recolouring; `.` is
 * transparent.
 */

import { GRID, sprite } from './pixel.mjs';

/** One row: `str` placed at column `start`, transparent either side. */
function R(start, str) {
  if (start + str.length > GRID) throw new Error(`row overflows: ${start} + ${str.length}`);
  return '.'.repeat(start) + str + '.'.repeat(GRID - start - str.length);
}

/** `n` blank rows. */
function blank(n) {
  return Array.from({ length: n }, () => '.'.repeat(GRID));
}

/** Repeat a character. Keeps the wide shapes readable as shapes. */
const r = (ch, n) => ch.repeat(n);

// ---------------------------------------------------------------------------
// Base — the head every other layer hangs off. Drawn in skin, not ramp: a
// gnome's face is not his team colour. Eyes sit at y15 and the nose at y17-18,
// low enough that the deepest cap brim (y13) never crowds them and high enough
// that the tallest beard (y19) never reaches them.
// ---------------------------------------------------------------------------

export const BASE = sprite([
  ...blank(8),
  R(12, r('K', 8)),
  R(10, 'K' + r('s', 10) + 'K'),
  R(9, 'K' + 'h' + r('s', 10) + 'S' + 'K'),
  R(8, 'K' + r('h', 2) + r('s', 10) + r('S', 2) + 'K'),
  R(8, 'K' + r('h', 2) + r('s', 10) + r('S', 2) + 'K'),
  R(8, 'K' + r('h', 2) + r('s', 10) + r('S', 2) + 'K'),
  R(8, 'K' + r('s', 14) + 'K'),
  R(8, 'K' + r('s', 2) + 'wew' + r('s', 4) + 'wew' + r('s', 2) + 'K'),
  R(8, 'K' + r('s', 14) + 'K'),
  R(8, 'K' + r('s', 6) + r('S', 2) + r('s', 6) + 'K'),
  R(8, 'K' + r('s', 6) + r('S', 2) + r('s', 6) + 'K'),
  R(8, 'K' + r('s', 14) + 'K'),
  R(8, 'K' + r('s', 14) + 'K'),
  R(8, 'K' + r('s', 14) + 'K'),
  R(9, 'K' + r('s', 12) + 'K'),
  R(10, 'K' + r('s', 10) + 'K'),
  R(12, r('K', 8)),
]);

// ---------------------------------------------------------------------------
// Caps — all three are mushrooms; they differ in silhouette, which is the only
// part of a sprite that survives being 20px wide in a board cell.
// ---------------------------------------------------------------------------

export const CAP_POINTY = sprite([
  ...blank(1),
  R(15, '00'),
  R(14, '0330'),
  R(13, '033330'),
  R(12, '03333230'),
  R(11, '0333332230'),
  R(11, '0334433220'),
  R(10, '033443332210'),
  R(9, '03334433322210'),
  R(8, '0333333443322210'),
  R(7, '033333344333222110'),
  R(6, '03333333443332222110'),
  R(6, '0' + r('1', 18) + '0'),
  R(7, r('0', 18)),
]);

export const CAP_BULBOUS = sprite([
  ...blank(2),
  R(13, '033330'),
  R(11, '0333333230'),
  R(9, '03333344333210'),
  R(8, '0333344433332210'),
  R(7, '033333444333322210'),
  R(6, '03333334443333222110'),
  R(5, '0333333344433332222110'),
  R(5, '0333333334433332222110'),
  R(5, '0' + r('3', 13) + r('2', 5) + '110'),
  R(5, '0' + r('1', 20) + '0'),
  R(6, r('0', 20)),
]);

export const CAP_WIDE = sprite([
  ...blank(4),
  R(13, '033330'),
  R(10, '033333443210'),
  R(7, '033333344443332210'),
  R(5, '0333333344443333222110'),
  R(3, '03333333344443333322222110'),
  R(3, '0' + r('3', 16) + r('2', 6) + '110'),
  R(3, '0' + r('1', 24) + '0'),
  R(6, r('0', 20)),
]);

export const CAP_TALL = sprite([
  R(15, '00'),
  R(14, '0330'),
  R(14, '0330'),
  R(13, '033330'),
  R(13, '034430'),
  R(12, '03343230'),
  R(12, '03443230'),
  R(11, '0334333220'),
  R(11, '0333433220'),
  R(10, '033343332210'),
  R(9, '03333433322210'),
  R(8, '0333334433322210'),
  R(8, '0' + r('1', 14) + '0'),
  R(9, r('0', 14)),
]);

export const CAP_DROOPY = sprite([
  ...blank(3),
  R(13, '033330'),
  R(11, '0333333230'),
  R(10, '033333443210'),
  R(9, '03333344433210'),
  R(8, '0333334443332210'),
  R(7, '033333444433322210'),
  R(6, '0' + r('3', 7) + r('4', 4) + r('3', 3) + r('2', 3) + '1110'),
  R(6, '0' + r('3', 7) + r('4', 3) + r('3', 4) + r('2', 3) + '110'),
  R(5, '0' + r('3', 8) + r('4', 2) + r('3', 4) + r('2', 4) + '1110'),
  R(5, '0' + r('1', 21) + '0'),
  // The brim curls down at the sides — the silhouette that separates this from
  // the bulbous cap once both are 20px wide.
  R(5, '01110' + '.'.repeat(13) + '01110'),
  R(5, '0110' + '.'.repeat(15) + '0110'),
  R(5, '000' + '.'.repeat(17) + '000'),
]);

export const CAPS = {
  pointy: CAP_POINTY,
  bulbous: CAP_BULBOUS,
  wide: CAP_WIDE,
  tall: CAP_TALL,
  droopy: CAP_DROOPY,
};

// ---------------------------------------------------------------------------
// Beards — hung from y19, below the nose, so a beard never reads as a mask
// across the eyes. Kept to the DARK half of the ramp (1-2) while caps live in
// the light half (3-4): same team colour, two separate masses, which is what
// keeps a gnome legible once he is 20px wide.
// ---------------------------------------------------------------------------

export const BEARD_POINTY = sprite([
  ...blank(19),
  R(9, '0' + r('2', 12) + '0'),
  R(9, '0' + r('2', 12) + '0'),
  R(10, '0' + r('2', 10) + '0'),
  R(10, '0' + r('1', 10) + '0'),
  R(11, '0' + r('1', 8) + '0'),
  R(11, '0' + r('1', 8) + '0'),
  R(12, '0' + r('1', 6) + '0'),
  R(13, '0' + r('1', 4) + '0'),
  R(14, '0' + r('1', 2) + '0'),
  R(15, '00'),
]);

export const BEARD_WILD = sprite([
  ...blank(19),
  R(8, '0' + r('2', 14) + '0'),
  R(6, '0' + r('2', 18) + '0'),
  R(5, '0' + r('2', 9) + r('1', 11) + '0'),
  R(5, '0' + r('1', 20) + '0'),
  R(5, '0' + r('1', 20) + '0'),
  R(6, '0' + r('1', 18) + '0'),
  R(6, '0' + r('1', 7) + '00' + r('1', 9) + '0'),
  R(6, '0' + r('1', 5) + '0..0' + r('1', 7) + '0'),
  R(7, '0' + r('1', 3) + '0...0' + r('1', 4) + '0'),
  R(8, '00...' + '0' + r('1', 2) + '0'),
]);

export const BEARD_BUSHY = sprite([
  ...blank(19),
  R(8, '0' + r('2', 14) + '0'),
  R(7, '0' + r('2', 16) + '0'),
  R(7, '0' + r('2', 8) + r('1', 8) + '0'),
  R(6, '0' + r('2', 9) + r('1', 9) + '0'),
  R(6, '0' + r('1', 18) + '0'),
  R(6, '0' + r('1', 18) + '0'),
  R(7, '0' + r('1', 16) + '0'),
  R(8, '0' + r('1', 14) + '0'),
  R(9, '0' + r('1', 12) + '0'),
  R(11, '0' + r('1', 8) + '0'),
  R(13, r('0', 6)),
]);

export const BEARD_BRAIDED = sprite([
  ...blank(19),
  R(8, '0' + r('2', 14) + '0'),
  R(8, '0' + r('2', 14) + '0'),
  R(9, '0' + r('1', 12) + '0'),
  R(9, '0' + r('1', 12) + '0'),
  R(10, '0' + r('1', 4) + '00' + r('1', 4) + '0'),
  R(10, '0' + r('1', 3) + '0..0' + r('1', 3) + '0'),
  R(10, '0' + r('2', 3) + '0..0' + r('2', 3) + '0'),
  R(10, '0' + r('1', 3) + '0..0' + r('1', 3) + '0'),
  R(10, '0' + r('2', 3) + '0..0' + r('2', 3) + '0'),
  R(11, '010..010'),
  R(11, '00....00'),
]);

export const BEARD_STUBBLE = sprite([
  ...blank(19),
  R(8, '0' + r('2', 14) + '0'),
  R(8, '0' + r('1', 14) + '0'),
  R(8, '0' + r('1', 14) + '0'),
  R(9, '0' + r('1', 12) + '0'),
  R(10, '0' + r('1', 10) + '0'),
  R(12, r('0', 8)),
]);

export const BEARDS = {
  pointy: BEARD_POINTY,
  wild: BEARD_WILD,
  bushy: BEARD_BUSHY,
  braided: BEARD_BRAIDED,
  stubble: BEARD_STUBBLE,
};

// ---------------------------------------------------------------------------
// Weapons — down the right margin, drawn BEHIND the body so the beard overlaps
// the shaft and the gnome reads as holding it rather than standing beside it.
// Shafts are dark (wood), heads light, so the business end is what you see.
// ---------------------------------------------------------------------------

export const WEAPON_SHOVEL = sprite([
  ...blank(6),
  R(25, r('0', 4)),
  ...Array.from({ length: 19 }, () => R(25, '0210')),
  R(23, r('0', 8)),
  R(23, '0' + r('4', 3) + r('3', 3) + '0'),
  R(23, '0' + r('4', 3) + r('3', 3) + '0'),
  R(24, '0' + r('3', 4) + '0'),
  R(25, r('0', 4)),
]);

export const WEAPON_PITCHFORK = sprite([
  ...blank(3),
  R(24, '0..0..0'),
  R(24, '4..4..4'),
  R(24, '4..4..4'),
  R(24, '4..4..4'),
  R(24, r('4', 7)),
  R(24, '0' + r('3', 5) + '0'),
  ...Array.from({ length: 20 }, () => R(25, '0210')),
  R(25, r('0', 4)),
]);

export const WEAPON_STAFF = sprite([
  ...blank(2),
  R(26, '00'),
  R(25, '0440'),
  R(24, '044440'),
  R(24, '043340'),
  R(24, '004400'),
  R(25, '0330'),
  ...Array.from({ length: 22 }, () => R(25, '0210')),
  R(25, r('0', 4)),
]);

export const WEAPON_AXE = sprite([
  ...blank(3),
  R(23, r('0', 6)),
  R(23, '0' + r('4', 4) + '0'),
  R(23, '0' + r('4', 4) + '0'),
  R(23, '0' + r('3', 4) + '0'),
  R(24, '0' + r('3', 2) + '0'),
  ...Array.from({ length: 21 }, () => R(25, '0210')),
  R(25, r('0', 4)),
]);

export const WEAPON_BROOM = sprite([
  ...blank(5),
  R(25, r('0', 4)),
  ...Array.from({ length: 19 }, () => R(25, '0210')),
  R(24, r('0', 6)),
  R(23, '0' + r('3', 6) + '0'),
  R(23, '0' + r('3', 6) + '0'),
  R(23, '0' + r('2', 6) + '0'),
  R(23, '0' + r('2', 6) + '0'),
  R(23, '00.00.00'),
]);

export const WEAPONS = {
  shovel: WEAPON_SHOVEL,
  pitchfork: WEAPON_PITCHFORK,
  staff: WEAPON_STAFF,
  axe: WEAPON_AXE,
  broom: WEAPON_BROOM,
};

// ---------------------------------------------------------------------------
// Accessories — drawn last, over everything. These three are a guess at what
// the slot is for, not a spec: the layer exists and the pieces in it are cheap
// to replace.
// ---------------------------------------------------------------------------

export const ACC_MONOCLE = sprite([
  ...blank(13),
  R(17, '.444.'),
  R(17, '4...4'),
  R(17, '4...4'),
  R(17, '.444.'),
  R(21, '4'),
  R(21, '4'),
  R(20, '4'),
]);

export const ACC_PIPE = sprite([
  ...blank(21),
  R(6, r('1', 7)),
  R(4, '000'),
  R(3, '0110'),
  R(3, '0110'),
  R(3, '0110'),
  R(4, '00'),
]);

export const ACC_LANTERN = sprite([
  ...blank(15),
  R(5, '00'),
  R(4, '0..0'),
  R(3, r('0', 6)),
  R(3, '044440'),
  R(3, '044440'),
  R(3, '043340'),
  R(3, r('0', 6)),
]);

export const ACC_FLOWER = sprite([
  ...blank(5),
  R(9, '.4.'),
  R(9, '404'),
  R(9, '.4.'),
]);

export const ACC_GLASSES = sprite([
  ...blank(13),
  R(10, '.444...444.'.replace('...', '..').padEnd(12, '.')),
  R(10, '4...4' + '..' + '4...4'),
  R(10, '4...4' + '44' + '4...4'),
  R(10, '4...4' + '..' + '4...4'),
  R(10, '.444.' + '..' + '.444.'),
]);

export const ACCESSORIES = {
  monocle: ACC_MONOCLE,
  pipe: ACC_PIPE,
  lantern: ACC_LANTERN,
  flower: ACC_FLOWER,
  glasses: ACC_GLASSES,
};
