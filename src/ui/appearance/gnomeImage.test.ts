import { describe, expect, it } from 'vitest';
import {
  CHOOSABLE_LAYERS,
  NONE_ID,
  PALETTE_IDS,
  PART_IDS,
  type PlayerAppearance,
} from '../../engine';
import { gnomeImageUrl, lookKey } from './gnomeImage';
import { PALETTES } from './palettes';
import { LAYER_LABELS, LAYER_ORDER, PART_LABELS, RAMP_KEYS, SPRITES } from './spriteData';

const BASE: PlayerAppearance = {
  palette: 'red',
  cap: 'pointy',
  beard: 'bushy',
  weapon: 'shovel',
  accessory: 'none',
};

/** Every look the catalogue can produce — the cartesian product of the folders. */
function everyLook(): PlayerAppearance[] {
  let looks: Record<string, string>[] = PALETTE_IDS.map((palette) => ({ palette }));
  for (const layer of CHOOSABLE_LAYERS) {
    looks = looks.flatMap((base) =>
      (PART_IDS[layer] as readonly string[]).map((id) => ({ ...base, [layer]: id })),
    );
  }
  return looks as unknown as PlayerAppearance[];
}

describe('sprite data', () => {
  it('has a sprite for every catalogue id', () => {
    // The generator writes both files from the same folder walk, so a missing
    // sprite means someone edited one by hand.
    expect(SPRITES[`base/${PART_IDS.base[0]}`]).toBeDefined();
    for (const layer of CHOOSABLE_LAYERS) {
      for (const id of PART_IDS[layer] as readonly string[]) {
        if (id === NONE_ID) continue;
        expect(SPRITES[`${layer}/${id}`], `${layer}/${id}`).toBeDefined();
      }
    }
  });

  it('labels every part and every choosable layer', () => {
    for (const layer of CHOOSABLE_LAYERS) {
      expect(LAYER_LABELS[layer], layer).toBeTruthy();
      for (const id of PART_IDS[layer] as readonly string[]) {
        if (id === NONE_ID) continue;
        expect(PART_LABELS[`${layer}/${id}`], `${layer}/${id}`).toBeTruthy();
      }
    }
  });

  it('draws every layer, with the body between the weapon and the cap', () => {
    // Order is load-bearing: the beard must overlap the weapon shaft, and the
    // cap must sit on the head rather than behind it.
    expect(LAYER_ORDER).toContain('base');
    expect(LAYER_ORDER.indexOf('weapon')).toBeLessThan(LAYER_ORDER.indexOf('base'));
    expect(LAYER_ORDER.indexOf('base')).toBeLessThan(LAYER_ORDER.indexOf('beard'));
    expect(LAYER_ORDER.indexOf('beard')).toBeLessThan(LAYER_ORDER.indexOf('cap'));
    for (const layer of CHOOSABLE_LAYERS) expect(LAYER_ORDER).toContain(layer);
  });

  it('never leaves a sprite empty', () => {
    // A part that compiled to nothing is a file drawn fully transparent, or
    // drawn below the alpha floor — it would render as an invisible option.
    for (const [name, paths] of Object.entries(SPRITES)) {
      expect(Object.keys(paths).length, `${name} has no pixels`).toBeGreaterThan(0);
    }
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

  it('gives every part choice a distinct image', () => {
    // Two different parts rendering identically would mean a duplicate file or
    // a sprite that compiled to the same pixels as its neighbour.
    for (const layer of CHOOSABLE_LAYERS) {
      const urls = new Set(
        (PART_IDS[layer] as readonly string[]).map((id) => gnomeImageUrl({ ...BASE, [layer]: id })),
      );
      expect(urls.size, `${layer} options are not all distinct`).toBe(PART_IDS[layer].length);
    }
  });

  it('returns the identical string for the same look — the cache is the point', () => {
    expect(gnomeImageUrl({ ...BASE })).toBe(gnomeImageUrl({ ...BASE }));
  });

  it('draws the accessory layer only when there is one', () => {
    const bare = decodeURIComponent(gnomeImageUrl(BASE).replace('data:image/svg+xml,', ''));
    const worn = decodeURIComponent(gnomeImageUrl({ ...BASE, accessory: 'monocle' }).replace('data:image/svg+xml,', ''));
    expect(worn.length).toBeGreaterThan(bare.length);
  });

  it('emits the layers in draw order', () => {
    const svg = decodeURIComponent(
      gnomeImageUrl({ ...BASE, weapon: 'staff', accessory: 'monocle' }).replace('data:image/svg+xml,', ''),
    );
    const at = (key: string) => svg.indexOf(Object.values(SPRITES[key])[0]);
    expect(at('weapon/staff')).toBeLessThan(at(`base/${PART_IDS.base[0]}`));
    expect(at(`base/${PART_IDS.base[0]}`)).toBeLessThan(at('beard/bushy'));
    expect(at('beard/bushy')).toBeLessThan(at('cap/pointy'));
    expect(at('cap/pointy')).toBeLessThan(at('accessory/monocle'));
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

describe('the part folders are the catalogue', () => {
  it('offers every layer more than one option', () => {
    // A layer with one option is a row of one button — the generator should
    // have found the folder, and the folder should have art in it.
    for (const layer of CHOOSABLE_LAYERS) {
      expect(PART_IDS[layer].length, `${layer} has nothing to choose from`).toBeGreaterThan(1);
    }
  });

  it('uses ids safe for a filename, a URL and a wire message', () => {
    // These travel in MatchRecord and over the socket, and index sprite tables.
    for (const layer of CHOOSABLE_LAYERS) {
      for (const id of PART_IDS[layer] as readonly string[]) {
        expect(id, `${layer}/${id}`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      }
    }
  });

  it('keeps ids unique within a layer', () => {
    for (const layer of CHOOSABLE_LAYERS) {
      const ids = PART_IDS[layer] as readonly string[];
      expect(new Set(ids).size, layer).toBe(ids.length);
    }
  });

  it('puts none first on the layers that allow it, and nowhere else', () => {
    for (const layer of CHOOSABLE_LAYERS) {
      const ids = PART_IDS[layer] as readonly string[];
      const at = ids.indexOf(NONE_ID);
      expect(at === -1 || at === 0, `${layer} lists ${NONE_ID} at ${at}`).toBe(true);
    }
  });

  it('draws every part inside the shared frame', () => {
    // A part drawn outside the 32x32 grid would be silently cropped; the path
    // data is the proof it was sampled onto the frame at all.
    for (const [name, paths] of Object.entries(SPRITES)) {
      for (const d of Object.values(paths)) {
        for (const [, x, y] of d.matchAll(/M(\d+) (\d+)/g)) {
          expect(Number(x), `${name} x`).toBeLessThan(32);
          expect(Number(y), `${name} y`).toBeLessThan(32);
        }
      }
    }
  });
});
