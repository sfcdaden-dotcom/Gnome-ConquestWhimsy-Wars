/**
 * What a `PaletteId` looks like.
 *
 * The engine stores a palette as a name, because a name is what replays and
 * what travels over the wire. This file is the only place a name becomes a
 * colour — the rendering half of the same split `GARDEN_META` makes for
 * gardens.
 *
 * Each palette is one base colour blended toward black and white to give the
 * five ramp steps the sprites are drawn against. Authoring sprites in grey and
 * mapping the greys here is what lets one set of art serve every team: see
 * `scripts/art/pixel.mjs` for the five greys this ramp replaces.
 */

import { PALETTE_IDS, type PaletteId } from '../../engine';
import { RAMP_KEYS, type RampKey } from './spriteData';

/** Blend toward black (t < 0) or white (t > 0). */
function mix(hex: string, t: number): string {
  const [r, g, b] = hex.slice(1).match(/../g)!.map((v) => parseInt(v, 16));
  const f = (c: number) => (t < 0 ? c * (1 + t) : c + (255 - c) * t);
  return '#' + [f(r), f(g), f(b)].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

/**
 * Where each ramp step sits between black and white. Beards are drawn in the
 * dark half (0-2) and caps in the light half (2-4), so these stops are what
 * keeps a gnome's two big masses apart — do not compress them.
 */
const STOPS: Record<RampKey, number> = { '0': -0.78, '1': -0.45, '2': 0, '3': 0.28, '4': 0.6 };

/**
 * Where the token disc sits: strictly between ramp steps 1 and 2, so it has
 * contrast in BOTH directions — the beard (dark half) reads darker than the
 * disc and the cap (light half) reads lighter.
 *
 * Taking it below the whole ramp instead is the obvious-looking move and it is
 * wrong: a near-black disc under near-black beards makes all eight teams look
 * like the same dark blob at the ~20px a board token actually gets, which
 * costs the one thing the disc is there for.
 */
const DISC_STOP = -0.28;

interface PaletteDef {
  label: string;
  /** The seat's identity colour: name text, panel edges, highlight rings. */
  accent: string;
}

/**
 * The eight teams. The first four are the colours the game shipped with, in
 * their original seat order, so a pre-character-select `MatchRecord` replays
 * looking like it did. The other four exist because a palette now belongs to
 * whoever picked it, and four options for four seats is not a choice.
 */
const DEFS: Record<PaletteId, PaletteDef> = {
  red: { label: 'Red', accent: '#d8504d' },
  blue: { label: 'Blue', accent: '#3f7ad8' },
  yellow: { label: 'Yellow', accent: '#c9930a' },
  purple: { label: 'Purple', accent: '#9256cf' },
  green: { label: 'Green', accent: '#4a9d4a' },
  teal: { label: 'Teal', accent: '#2fa39b' },
  orange: { label: 'Orange', accent: '#dd7a2e' },
  pink: { label: 'Pink', accent: '#d861a0' },
};

export interface Palette {
  id: PaletteId;
  label: string;
  accent: string;
  /** Token background. */
  disc: string;
  ramp: Record<RampKey, string>;
}

export const PALETTES: Record<PaletteId, Palette> = Object.fromEntries(
  PALETTE_IDS.map((id) => {
    const { label, accent } = DEFS[id];
    return [id, {
      id,
      label,
      accent,
      disc: mix(accent, DISC_STOP),
      ramp: Object.fromEntries(RAMP_KEYS.map((k) => [k, mix(accent, STOPS[k])])) as Record<RampKey, string>,
    } satisfies Palette];
  }),
) as Record<PaletteId, Palette>;

export const PALETTE_LIST: readonly Palette[] = PALETTE_IDS.map((id) => PALETTES[id]);
