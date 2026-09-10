/**
 * What a player's gnome looks like: the pure data model behind the character
 * creator, with no DOM and no React in it.
 *
 * A `GnomeLook` is seven layer choices plus three colour choices. It is
 * cosmetic all the way down — the engine never sees one, because a gnome's
 * hat has no bearing on the rules and putting it in `PlayerState` would drag
 * it through encode/decode, the AI fingerprint and every recorded self-play
 * match for no gain. The UI keeps a look per seat; online, it rides alongside
 * the seat's name (see `SeatInfo` in src/net/protocol.ts).
 *
 * ## Recolouring
 *
 * The art is drawn in fixed "filler" colours that get swapped for the player's
 * palette at render time (`gnomeArt.ts` does the swapping). Every filler hex
 * belongs to exactly one slot:
 *
 *   garment  the seat's 4-shade ramp — cap, torso and the metal of a tool
 *   hair     one flat colour — hair and beard only
 *   skin     face, the hand holding a tool, and the arms on the overalls
 *
 * Anything not listed in a slot is left exactly as drawn: the brown shoes and
 * tool shafts, the gold belt buckle, the orb's glass, the white cap dots and
 * the black eyes. Those are the only high-contrast pixels a gnome has left
 * once it is 20px wide on a board cell, and tinting them costs more legibility
 * than it buys expression.
 *
 * ## Why the garment ramp is scoped to the seat colour
 *
 * Board tokens used to sit on a disc filled with the seat's colour, which is
 * what told you whose gnome you were looking at. The custom gnome replaces the
 * disc, so the gnome itself has to carry that signal: `garmentRamp` derives
 * every shade from the seat's own colour, and a player picks which *variation*
 * of their colour to wear, never a different hue. Two red gnomes may differ;
 * a red gnome and a blue one never look alike.
 */

import { PLAYER_COLORS } from './meta';

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * Back to front — the order the layers are composited in. The art is drawn on
 * one shared 48×64 canvas with every layer already in position, so this is a
 * pure paint order and no layer needs an offset.
 *
 * Shoes sitting between the face and the beard looks odd written down, and is
 * harmless in practice: shoes occupy the bottom rows and a beard the middle
 * ones, so the two never overlap a pixel.
 */
export const GNOME_LAYERS = ['torso', 'face', 'shoes', 'beard', 'hair', 'cap', 'accessory'] as const;
export type GnomeLayer = (typeof GNOME_LAYERS)[number];

/**
 * Layers a gnome may go without. Everything else is always drawn, so a look
 * can never resolve to a bald patch where a head should be.
 */
export const OPTIONAL_LAYERS = ['hair', 'beard'] as const;
export type OptionalLayer = (typeof OPTIONAL_LAYERS)[number];

export function isOptionalLayer(layer: GnomeLayer): layer is OptionalLayer {
  return (OPTIONAL_LAYERS as readonly string[]).includes(layer);
}

/** A variant id for every layer; `null` only where the layer is optional. */
export type GnomeParts = { [L in GnomeLayer]: L extends OptionalLayer ? string | null : string };

export interface GnomeLook extends GnomeParts {
  /** Index into `GARMENT_VARIANTS` — which shade of the seat's colour to wear. */
  garment: number;
  /** Index into `HAIR_COLORS`. */
  hair_color: number;
  /** Index into `SKIN_TONES`. */
  skin: number;
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): Hsl {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 1) + 1) % 1;
  const sat = clamp01(s);
  const lum = clamp01(l);
  let r: number;
  let g: number;
  let b: number;
  if (sat === 0) {
    r = g = b = lum;
  } else {
    const q = lum < 0.5 ? lum * (1 + sat) : lum + sat - lum * sat;
    const p = 2 * lum - q;
    const channel = (t: number) => {
      const tt = ((t % 1) + 1) % 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    };
    r = channel(hue + 1 / 3);
    g = channel(hue);
    b = channel(hue - 1 / 3);
  }
  const to255 = (v: number) => Math.round(clamp01(v) * 255);
  return `#${((1 << 24) | (to255(r) << 16) | (to255(g) << 8) | to255(b)).toString(16).slice(1)}`;
}

/**
 * Recolour `source` as though it were `reference` repainted in `target`,
 * keeping how much lighter or darker it was than the reference. This is what
 * carries a layer's built-in shading across a colour change: the face's five
 * shadow tones stay five distinct shadows of whichever skin tone is picked,
 * rather than flattening into one.
 */
export function shiftShade(source: string, reference: string, target: string): string {
  const src = hexToHsl(source);
  const ref = hexToHsl(reference);
  const dst = hexToHsl(target);
  return hslToHex({ h: dst.h, s: dst.s, l: dst.l + (src.l - ref.l) });
}

// ---------------------------------------------------------------------------
// The garment ramp
// ---------------------------------------------------------------------------

/** A garment's four shades, darkest to lightest. */
export interface GarmentRamp {
  shadow: string;
  medDark: string;
  medium: string;
  light: string;
}

/**
 * Lightness of each ramp step. Fixed rather than derived from the seat colour
 * so that all four seats land on the same contrast relationships — a purple
 * gnome and a yellow one are equally readable, which they would not be if the
 * ramp started from each colour's own lightness.
 */
const RAMP_LIGHTNESS = [0.2, 0.38, 0.55, 0.82] as const;

/**
 * The variations of a seat's colour a player may wear. Each is a hue nudge and
 * a saturation scale applied to the seat's own colour, so every variant of the
 * red seat is unmistakably red and none of them is blue.
 */
export const GARMENT_VARIANTS = [
  { id: 'classic', label: 'Classic', hue: 0, sat: 1 },
  { id: 'deep', label: 'Deep', hue: -0.02, sat: 1.1 },
  { id: 'bright', label: 'Bright', hue: 0.02, sat: 1.35 },
  { id: 'dusty', label: 'Dusty', hue: -0.04, sat: 0.45 },
  { id: 'ember', label: 'Ember', hue: 0.045, sat: 1 },
] as const;

/** The four shades seat `seatId` wears in garment variant `variant`. */
export function garmentRamp(seatId: number, variant: number): GarmentRamp {
  const v = GARMENT_VARIANTS[variant] ?? GARMENT_VARIANTS[0];
  const base = hexToHsl(PLAYER_COLORS[seatId % PLAYER_COLORS.length]);
  const shade = (l: number) => hslToHex({ h: base.h + v.hue, s: Math.min(base.s * v.sat, 1), l });
  return {
    shadow: shade(RAMP_LIGHTNESS[0]),
    medDark: shade(RAMP_LIGHTNESS[1]),
    medium: shade(RAMP_LIGHTNESS[2]),
    light: shade(RAMP_LIGHTNESS[3]),
  };
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/**
 * Hair and beard colour. Deliberately NOT scoped to the seat's colour: the
 * garment already carries ownership, and a red gnome with a red beard under a
 * red hat reads as a red blob rather than a character. `#e0e0e0` is the only
 * hex the hair and beard art uses, so one flat colour per choice is all these
 * layers can take.
 */
export const HAIR_COLORS = [
  { id: 'snow', label: 'Snow', hex: '#e8e8e8' },
  { id: 'ash', label: 'Ash', hex: '#a8a29a' },
  { id: 'straw', label: 'Straw', hex: '#d9bd7a' },
  { id: 'ginger', label: 'Ginger', hex: '#c16a34' },
  { id: 'chestnut', label: 'Chestnut', hex: '#8a5a3b' },
  { id: 'soot', label: 'Soot', hex: '#4a4a4a' },
] as const;

/** The hex the hair and beard art is drawn in. */
export const HAIR_SOURCE = '#e0e0e0';

/** The hex the skin is drawn in; every other skin pixel is a shade of it. */
export const SKIN_SOURCE = '#e5aa7a';

/**
 * Skin pixels, and their shadows. Listed explicitly rather than detected by
 * hue because the face's darkest shadow and the accessory's wooden shaft sit
 * close enough in colour that guessing would repaint the shovel.
 */
export const SKIN_SOURCES = [
  '#e5aa7a',
  '#cba37b',
  '#d09f70',
  '#d99d77',
  '#d99f73',
  '#cc936a',
] as const;

export const SKIN_TONES = [
  { id: 'porcelain', label: 'Porcelain', hex: '#f2ccae' },
  { id: 'fair', label: 'Fair', hex: '#e5aa7a' },
  { id: 'tan', label: 'Tan', hex: '#c98a58' },
  { id: 'olive', label: 'Olive', hex: '#a9713f' },
  { id: 'umber', label: 'Umber', hex: '#7d4f2c' },
  { id: 'ebony', label: 'Ebony', hex: '#54331d' },
  { id: 'moss', label: 'Moss', hex: '#8aa06a' },
  { id: 'stone', label: 'Stone', hex: '#9aa3ab' },
] as const;

/**
 * Which ramp step each garment filler hex becomes.
 *
 * The art carries more neutrals than the four the ramp names, because shading
 * was drawn with whatever read well rather than from a fixed ramp. Each extra
 * one is snapped to the nearest step it was already acting as — without that,
 * a recoloured gnome keeps blue-grey rims around the shovel head and the belt
 * strap, which is exactly as odd as it sounds.
 *
 * `light` is absent on purpose: no garment pixel is drawn in the lightest
 * shade. It exists on the ramp because the palette is a four-shade one, and
 * because new art may want it.
 */
export const GARMENT_SOURCES: Record<string, keyof GarmentRamp> = {
  '#37474f': 'shadow',
  '#3d2f3d': 'shadow',
  '#424242': 'shadow',
  '#616161': 'medDark',
  '#757575': 'medDark',
  '#78909c': 'medDark',
  '#90a4ae': 'medium',
};

// ---------------------------------------------------------------------------
// Building a look
// ---------------------------------------------------------------------------

/**
 * The colour swaps a look implies, as a plain `source hex -> target hex` map.
 * `gnomeArt.ts` applies it pixel by pixel; keeping it a pure value is what
 * makes the recolouring testable without a canvas.
 *
 * Hair is handled by the caller, not here: `#e0e0e0` also paints the whites of
 * the eyes, so swapping it globally would give a player ash-coloured eyes.
 * See `hairSwap`.
 */
export function garmentAndSkinSwap(look: GnomeLook, seatId: number): Record<string, string> {
  const ramp = garmentRamp(seatId, look.garment);
  const swap: Record<string, string> = {};
  for (const [source, step] of Object.entries(GARMENT_SOURCES)) swap[source] = ramp[step];
  const skin = (SKIN_TONES[look.skin] ?? SKIN_TONES[1]).hex;
  for (const source of SKIN_SOURCES) swap[source] = shiftShade(source, SKIN_SOURCE, skin);
  return swap;
}

/** The one swap the hair and beard layers get, on top of the shared ones. */
export function hairSwap(look: GnomeLook): Record<string, string> {
  const hair = (HAIR_COLORS[look.hair_color] ?? HAIR_COLORS[0]).hex;
  return { [HAIR_SOURCE]: hair };
}

/**
 * A stable identity for a rendered gnome: same look and seat ⇒ same string.
 * This is the sprite cache's key, so it has to cover everything that changes a
 * pixel — the seat included, since the garment ramp is derived from it.
 */
export function lookKey(look: GnomeLook, seatId: number): string {
  const parts = GNOME_LAYERS.map((l) => look[l] ?? '-').join('|');
  return `${seatId}|${parts}|${look.garment}|${look.hair_color}|${look.skin}`;
}
