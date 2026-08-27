import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_IDS,
  BEARD_IDS,
  CAP_IDS,
  PALETTE_IDS,
  WEAPON_IDS,
  type PlayerAppearance,
} from '../../engine';
import { gnomeImageUrl, lookKey } from './gnomeImage';
import { PALETTES } from './palettes';
import { RAMP_KEYS, SPRITES } from './spriteData';

const BASE: PlayerAppearance = {
  palette: 'red',
  cap: 'pointy',
  beard: 'bushy',
  weapon: 'shovel',
  accessory: 'none',
};

/** Every look the catalogue can produce. */
function everyLook(): PlayerAppearance[] {
  const out: PlayerAppearance[] = [];
  for (const palette of PALETTE_IDS)
    for (const cap of CAP_IDS)
      for (const beard of BEARD_IDS)
        for (const weapon of WEAPON_IDS)
          for (const accessory of ACCESSORY_IDS) out.push({ palette, cap, beard, weapon, accessory });
  return out;
}

describe('sprite data', () => {
  it('has a sprite for every catalogue id', () => {
    expect(SPRITES.BASE).toBeDefined();
    for (const id of CAP_IDS) expect(SPRITES[`CAP_${id.toUpperCase()}`]).toBeDefined();
    for (const id of BEARD_IDS) expect(SPRITES[`BEARD_${id.toUpperCase()}`]).toBeDefined();
    for (const id of WEAPON_IDS) expect(SPRITES[`WEAPON_${id.toUpperCase()}`]).toBeDefined();
    for (const id of ACCESSORY_IDS)
      if (id !== 'none') expect(SPRITES[`ACC_${id.toUpperCase()}`]).toBeDefined();
  });

  it('only uses fill keys the recolourer can resolve', () => {
    for (const [name, paths] of Object.entries(SPRITES)) {
      for (const key of Object.keys(paths)) {
        const known = key.startsWith('#') || (RAMP_KEYS as readonly string[]).includes(key);
        expect(known, `${name} uses unknown fill key ${key}`).toBe(true);
      }
    }
  });
});

describe('gnomeImageUrl', () => {
  it('builds an SVG data URI', () => {
    expect(gnomeImageUrl(BASE)).toMatch(/^data:image\/svg\+xml,/);
  });

  it('renders every look in the catalogue without an unresolved fill', () => {
    for (const look of everyLook()) {
      const svg = decodeURIComponent(gnomeImageUrl(look).replace('data:image/svg+xml,', ''));
      expect(svg, lookKey(look)).not.toMatch(/fill="(undefined|null|)"/);
      expect(svg).toMatch(/^<svg /);
      expect(svg).toContain('</svg>');
    }
  });

  it('paints the seat palette and nothing else', () => {
    const svg = decodeURIComponent(gnomeImageUrl({ ...BASE, palette: 'teal' }).replace('data:image/svg+xml,', ''));
    const fills = new Set([...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]));
    const allowed = new Set<string>(Object.values(PALETTES.teal.ramp));
    for (const fill of fills) {
      // Anything not in the ramp must be a literal fixed colour (skin, eyes) —
      // never another palette's ramp.
      if (allowed.has(fill)) continue;
      expect(fill, `${fill} is neither teal ramp nor a fixed colour`).toMatch(/^#[0-9a-f]{6}$/);
      for (const other of PALETTE_IDS.filter((p) => p !== 'teal')) {
        expect(Object.values(PALETTES[other].ramp)).not.toContain(fill);
      }
    }
  });

  it('gives two palettes of the same parts different pixels', () => {
    expect(gnomeImageUrl({ ...BASE, palette: 'red' })).not.toBe(gnomeImageUrl({ ...BASE, palette: 'blue' }));
  });

  it('gives each part choice a distinct image', () => {
    const urls = new Set([
      gnomeImageUrl(BASE),
      ...CAP_IDS.map((cap) => gnomeImageUrl({ ...BASE, cap })),
      ...BEARD_IDS.map((beard) => gnomeImageUrl({ ...BASE, beard })),
      ...WEAPON_IDS.map((weapon) => gnomeImageUrl({ ...BASE, weapon })),
      ...ACCESSORY_IDS.map((accessory) => gnomeImageUrl({ ...BASE, accessory })),
    ]);
    // 1 base + 3 caps + 3 beards + 3 weapons + 4 accessories, less the four
    // that restate BASE's own choices.
    expect(urls.size).toBe(1 + 3 + 3 + 3 + 4 - 4);
  });

  it('returns the identical string for the same look — the cache is the point', () => {
    expect(gnomeImageUrl({ ...BASE })).toBe(gnomeImageUrl({ ...BASE }));
  });

  it('draws the accessory layer only when there is one', () => {
    const bare = decodeURIComponent(gnomeImageUrl(BASE).replace('data:image/svg+xml,', ''));
    const worn = decodeURIComponent(gnomeImageUrl({ ...BASE, accessory: 'monocle' }).replace('data:image/svg+xml,', ''));
    expect(worn.length).toBeGreaterThan(bare.length);
  });

  it('layers the weapon under the body and the cap over it', () => {
    // Order is load-bearing: the beard must overlap the shaft, and the cap must
    // sit on the head rather than behind it.
    const svg = decodeURIComponent(
      gnomeImageUrl({ ...BASE, weapon: 'staff', accessory: 'monocle' }).replace('data:image/svg+xml,', ''),
    );
    const at = (paths: Record<string, string>) => {
      const first = Object.values(paths)[0];
      return svg.indexOf(first);
    };
    expect(at(SPRITES.WEAPON_STAFF)).toBeLessThan(at(SPRITES.BASE));
    expect(at(SPRITES.BASE)).toBeLessThan(at(SPRITES.CAP_POINTY));
    expect(at(SPRITES.CAP_POINTY)).toBeLessThan(at(SPRITES.ACC_MONOCLE));
  });
});

describe('palettes', () => {
  it('gives every catalogue palette a full ramp, a disc and an accent', () => {
    for (const id of PALETTE_IDS) {
      const p = PALETTES[id];
      expect(p.label).toBeTruthy();
      expect(p.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.disc).toMatch(/^#[0-9a-f]{6}$/);
      for (const k of RAMP_KEYS) expect(p.ramp[k]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('sits the disc between the dark and light halves of its own ramp', () => {
    // The disc needs contrast in BOTH directions: darker than the cap's light
    // steps and lighter than the beard's dark ones. A disc below the whole
    // ramp makes every team a dark blob at board-token size.
    const lum = (hex: string) =>
      hex.slice(1).match(/../g)!.reduce((sum, v) => sum + parseInt(v, 16), 0);
    for (const id of PALETTE_IDS) {
      const p = PALETTES[id];
      expect(lum(p.disc), `${id} disc vs dark step 1`).toBeGreaterThan(lum(p.ramp['1']));
      expect(lum(p.disc), `${id} disc vs light step 2`).toBeLessThan(lum(p.ramp['2']));
    }
  });

  it('keeps its ramp monotonically lighter, darkest step first', () => {
    const lum = (hex: string) =>
      hex.slice(1).match(/../g)!.reduce((sum, v) => sum + parseInt(v, 16), 0);
    for (const id of PALETTE_IDS) {
      const steps = RAMP_KEYS.map((k) => lum(PALETTES[id].ramp[k]));
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i], `${id} step ${i} vs ${i - 1}`).toBeGreaterThan(steps[i - 1]);
      }
    }
  });

  it('gives the eight teams eight distinguishable accents', () => {
    expect(new Set(PALETTE_IDS.map((id) => PALETTES[id].accent)).size).toBe(PALETTE_IDS.length);
  });
});
