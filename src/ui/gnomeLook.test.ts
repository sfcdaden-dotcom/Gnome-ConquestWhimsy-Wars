/**
 * The colour half of the character creator.
 *
 * Most of what can go wrong here is invisible in a screenshot and obvious on a
 * board: a garment ramp that comes out the same for two seats, a swap table
 * that misses a hex and leaves blue-grey rims on a red gnome, or a skin tone
 * that flattens the face's shading into one colour. These pin all three.
 */

import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS } from './meta';
import {
  GARMENT_SOURCES,
  GARMENT_VARIANTS,
  HAIR_COLORS,
  HAIR_SOURCE,
  SKIN_SOURCE,
  SKIN_SOURCES,
  SKIN_TONES,
  garmentAndSkinSwap,
  garmentRamp,
  hairSwap,
  hexToHsl,
  hslToHex,
  lookKey,
  shiftShade,
} from './gnomeLook';
import type { GnomeLook } from './gnomeLook';

/**
 * Every colour the gnome art is actually drawn in, taken off the PNGs.
 *
 * Duplicated here on purpose: it is the contract between the drawings and the
 * palette, and a new layer that introduces an unlisted colour should fail this
 * test rather than quietly render un-recoloured. Regenerate it by reading the
 * distinct pixel values out of `src/assets/art/Gnome Assets/`.
 */
const ART_COLORS = {
  /** Repainted by the seat's garment ramp. */
  garment: ['#37474f', '#3d2f3d', '#424242', '#616161', '#757575', '#78909c', '#90a4ae'],
  /** Repainted by the hair choice, and only on the hair and beard layers. */
  hair: ['#e0e0e0'],
  /** Repainted by the skin choice, shading included. */
  skin: ['#e5aa7a', '#cba37b', '#d09f70', '#d99d77', '#d99f73', '#cc936a'],
  /**
   * Left exactly as drawn. These are the only high-contrast pixels a gnome has
   * at board size, and tinting them costs more legibility than it buys.
   */
  fixed: ['#9c5a3c', '#ffc20e', '#99d9ea', '#709ad1', '#ffffff', '#000000'],
} as const;

const look = (patch: Partial<GnomeLook> = {}): GnomeLook => ({
  torso: 'torso-belt',
  face: 'a-face',
  shoes: 'shoes',
  beard: 'classic-beard',
  hair: null,
  cap: 'cone-cap',
  accessory: 'orb-accessory',
  garment: 0,
  hair_color: 0,
  skin: 1,
  ...patch,
});

describe('hex ↔ hsl', () => {
  it('round-trips every colour the art uses', () => {
    const all = Object.values(ART_COLORS).flat();
    for (const hex of all) {
      expect(hslToHex(hexToHsl(hex)), hex).toBe(hex);
    }
  });

  it('clamps rather than wrapping when a shade runs past white or black', () => {
    expect(hslToHex({ h: 0.5, s: 0.5, l: 1.4 })).toBe('#ffffff');
    expect(hslToHex({ h: 0.5, s: 0.5, l: -0.4 })).toBe('#000000');
  });
});

describe('garmentRamp', () => {
  it('runs dark to light in every seat and variant', () => {
    for (let seat = 0; seat < PLAYER_COLORS.length; seat++) {
      for (let v = 0; v < GARMENT_VARIANTS.length; v++) {
        const r = garmentRamp(seat, v);
        const ls = [r.shadow, r.medDark, r.medium, r.light].map((h) => hexToHsl(h).l);
        for (let i = 1; i < ls.length; i++) {
          expect(ls[i], `seat ${seat} variant ${v} step ${i}`).toBeGreaterThan(ls[i - 1]);
        }
      }
    }
  });

  it('keeps every variant inside its own seat’s hue', () => {
    // Board tokens have no coloured disc any more, so the clothes ARE the
    // ownership signal. A variant that drifted far enough to read as another
    // seat's colour would make the board ambiguous.
    for (let seat = 0; seat < PLAYER_COLORS.length; seat++) {
      const base = hexToHsl(PLAYER_COLORS[seat]).h;
      for (let v = 0; v < GARMENT_VARIANTS.length; v++) {
        const h = hexToHsl(garmentRamp(seat, v).medium).h;
        const drift = Math.min(Math.abs(h - base), 1 - Math.abs(h - base));
        expect(drift, `seat ${seat} variant ${v}`).toBeLessThan(0.06);
      }
    }
  });

  it('never gives two seats the same medium shade', () => {
    const mediums = new Set<string>();
    for (let seat = 0; seat < PLAYER_COLORS.length; seat++) {
      for (let v = 0; v < GARMENT_VARIANTS.length; v++) mediums.add(garmentRamp(seat, v).medium);
    }
    expect(mediums.size).toBe(PLAYER_COLORS.length * GARMENT_VARIANTS.length);
  });

  it('falls back to the first variant rather than throwing on a bad index', () => {
    expect(garmentRamp(0, 99)).toEqual(garmentRamp(0, 0));
  });
});

describe('the swap table', () => {
  it('covers every garment and skin colour in the art', () => {
    const swap = garmentAndSkinSwap(look(), 0);
    for (const hex of [...ART_COLORS.garment, ...ART_COLORS.skin]) {
      expect(swap[hex], hex).toBeTruthy();
    }
  });

  it('leaves the fixed colours alone', () => {
    const swap = { ...garmentAndSkinSwap(look(), 0), ...hairSwap(look()) };
    for (const hex of ART_COLORS.fixed) {
      expect(swap[hex], hex).toBeUndefined();
    }
  });

  it('keeps hair out of the shared swap, so eye whites stay white', () => {
    // `#e0e0e0` is a beard on a beard layer and the whites of the eyes on a
    // face. Only the hair and beard layers may repaint it.
    expect(garmentAndSkinSwap(look(), 0)[HAIR_SOURCE]).toBeUndefined();
    expect(hairSwap(look())[HAIR_SOURCE]).toBe(HAIR_COLORS[0].hex);
  });

  it('maps each garment source to the ramp step it was drawn as', () => {
    const swap = garmentAndSkinSwap(look({ garment: 2 }), 3);
    const ramp = garmentRamp(3, 2);
    for (const [source, step] of Object.entries(GARMENT_SOURCES)) {
      expect(swap[source], source).toBe(ramp[step]);
    }
  });

  it('keeps the face’s five shadows distinct after a skin change', () => {
    for (let tone = 0; tone < SKIN_TONES.length; tone++) {
      const swap = garmentAndSkinSwap(look({ skin: tone }), 0);
      const shaded = new Set(SKIN_SOURCES.map((s) => swap[s]));
      expect(shaded.size, SKIN_TONES[tone].label).toBe(SKIN_SOURCES.length);
    }
  });

  it('paints the base skin pixel the tone that was picked', () => {
    for (let tone = 0; tone < SKIN_TONES.length; tone++) {
      const swap = garmentAndSkinSwap(look({ skin: tone }), 0);
      expect(swap[SKIN_SOURCE], SKIN_TONES[tone].label).toBe(SKIN_TONES[tone].hex);
    }
  });

  it('falls back rather than producing undefined colours for bad indices', () => {
    const swap = garmentAndSkinSwap(look({ skin: 99, garment: 99 }), 0);
    for (const hex of Object.values(swap)) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.values(hairSwap(look({ hair_color: 99 })))[0]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('shiftShade', () => {
  it('returns the target itself when the source is the reference', () => {
    expect(shiftShade('#e5aa7a', '#e5aa7a', '#7d4f2c')).toBe('#7d4f2c');
  });

  it('keeps a darker source darker than the target', () => {
    const out = shiftShade('#cc936a', SKIN_SOURCE, '#f2ccae');
    expect(hexToHsl(out).l).toBeLessThan(hexToHsl('#f2ccae').l);
  });
});

describe('lookKey', () => {
  it('changes when anything visible changes', () => {
    const base = lookKey(look(), 0);
    expect(lookKey(look(), 1)).not.toBe(base);
    expect(lookKey(look({ cap: 'wide-cap' }), 0)).not.toBe(base);
    expect(lookKey(look({ hair: 'long-hair' }), 0)).not.toBe(base);
    expect(lookKey(look({ garment: 1 }), 0)).not.toBe(base);
    expect(lookKey(look({ hair_color: 1 }), 0)).not.toBe(base);
    expect(lookKey(look({ skin: 0 }), 0)).not.toBe(base);
  });

  it('is the same for two equal looks', () => {
    expect(lookKey(look(), 2)).toBe(lookKey(look(), 2));
  });

  it('tells a missing optional layer apart from a present one', () => {
    expect(lookKey(look({ beard: null }), 0)).not.toBe(lookKey(look({ beard: 'lush-beard' }), 0));
  });
});
