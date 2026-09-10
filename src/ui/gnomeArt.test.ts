/**
 * The layer catalogue and the validation around it.
 *
 * The catalogue is built from the folder tree at build time, so these tests
 * are really about the art: a renamed folder, a layer that lost its last
 * drawing, or two files that slug down to the same id would all pass
 * TypeScript and break the creator.
 *
 * `sanitizeLook` gets the closest attention, because it is the only thing
 * standing between a stranger's `hello` and the board you are looking at.
 */

import { describe, expect, it } from 'vitest';
import type { GnomeLookWire } from '../net/protocol';
import {
  GNOME_CATALOGUE,
  LAYER_LABELS,
  choosableLayers,
  defaultLook,
  layerOptions,
  randomLook,
  sanitizeLook,
} from './gnomeArt';
import { GNOME_LAYERS, OPTIONAL_LAYERS, isOptionalLayer } from './gnomeLook';
import type { GnomeLook } from './gnomeLook';

/**
 * The look the UI builds and the look that travels must stay the same shape.
 * Declared here rather than in either module so neither can quietly widen and
 * take the other with it; a mismatch is a compile error in this file.
 */
const _wireMatchesModel: GnomeLookWire = defaultLook();
const _modelMatchesWire: GnomeLook = _wireMatchesModel;
void _modelMatchesWire;

describe('the catalogue', () => {
  it('found art for every layer', () => {
    for (const layer of GNOME_LAYERS) {
      expect(GNOME_CATALOGUE[layer].length, layer).toBeGreaterThan(0);
    }
  });

  it('gives every variant a distinct id within its layer', () => {
    for (const layer of GNOME_LAYERS) {
      const ids = GNOME_CATALOGUE[layer].map((v) => v.id);
      expect(new Set(ids).size, layer).toBe(ids.length);
    }
  });

  it('gives every variant an id, a label and a file', () => {
    for (const layer of GNOME_LAYERS) {
      for (const v of GNOME_CATALOGUE[layer]) {
        expect(v.id, `${layer} id`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        expect(v.label.trim(), `${layer} label`).not.toBe('');
        expect(v.url, `${layer} url`).toBeTruthy();
      }
    }
  });

  it('never points two variants at the same drawing', () => {
    const urls = GNOME_LAYERS.flatMap((l) => GNOME_CATALOGUE[l].map((v) => v.url));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('is in a stable order, whatever order the glob returned', () => {
    for (const layer of GNOME_LAYERS) {
      const ids = GNOME_CATALOGUE[layer].map((v) => v.id);
      expect(ids, layer).toEqual([...ids].sort());
    }
  });

  it('names every layer for the creator', () => {
    for (const layer of GNOME_LAYERS) expect(LAYER_LABELS[layer], layer).toBeTruthy();
  });
});

describe('layer options', () => {
  it('offers "None" on the optional layers and only those', () => {
    for (const layer of GNOME_LAYERS) {
      const hasNone = layerOptions(layer).some((o) => o === null);
      expect(hasNone, layer).toBe(isOptionalLayer(layer));
    }
    expect([...OPTIONAL_LAYERS]).toEqual(['hair', 'beard']);
  });

  it('only offers a carousel where there is something to cycle through', () => {
    for (const layer of choosableLayers()) {
      expect(layerOptions(layer).length, layer).toBeGreaterThan(1);
    }
  });
});

describe('defaultLook', () => {
  it('fills every required layer', () => {
    const look = defaultLook();
    for (const layer of GNOME_LAYERS) {
      if (isOptionalLayer(layer)) continue;
      expect(look[layer], layer).toBeTruthy();
    }
  });

  it('survives its own validation unchanged', () => {
    expect(sanitizeLook(defaultLook())).toEqual(defaultLook());
  });
});

describe('randomLook', () => {
  it('always produces something that renders', () => {
    // A fixed sequence rather than Math.random: a flake here would be a
    // one-in-many-runs mystery rather than a failing test.
    for (let seed = 0; seed < 50; seed++) {
      let n = seed;
      const pick = () => {
        n = (n * 1103515245 + 12345) & 0x7fffffff;
        return n / 0x7fffffff;
      };
      const look = randomLook(pick);
      expect(sanitizeLook(look), `seed ${seed}`).toEqual(look);
    }
  });

  it('varies', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(JSON.stringify(randomLook()));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe('sanitizeLook', () => {
  it('replaces an unknown variant id with the default', () => {
    const out = sanitizeLook({ ...defaultLook(), cap: 'crown-of-thorns' });
    expect(out.cap).toBe(defaultLook().cap);
  });

  it('refuses to leave a required layer empty', () => {
    for (const layer of GNOME_LAYERS) {
      if (isOptionalLayer(layer)) continue;
      const out = sanitizeLook({ ...defaultLook(), [layer]: null });
      expect(out[layer], layer).toBeTruthy();
    }
  });

  it('keeps a deliberate null on an optional layer', () => {
    expect(sanitizeLook({ ...defaultLook(), hair: null, beard: null }).hair).toBeNull();
    expect(sanitizeLook({ ...defaultLook(), hair: null, beard: null }).beard).toBeNull();
  });

  it('rejects palette indices that are out of range, fractional or negative', () => {
    const base = defaultLook();
    for (const bad of [-1, 1.5, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = sanitizeLook({ ...base, garment: bad, skin: bad, hair_color: bad });
      expect(out.garment, String(bad)).toBe(base.garment);
      expect(out.skin, String(bad)).toBe(base.skin);
      expect(out.hair_color, String(bad)).toBe(base.hair_color);
    }
  });

  it('survives anything at all, because this is what arrives from the network', () => {
    for (const junk of [null, undefined, 42, 'gnome', [], { cap: 7 }, { __proto__: { cap: 'x' } }]) {
      expect(() => sanitizeLook(junk)).not.toThrow();
      expect(sanitizeLook(junk).cap).toBeTruthy();
    }
  });

  it('is idempotent', () => {
    const once = sanitizeLook({ cap: 'nope', garment: -3 });
    expect(sanitizeLook(once)).toEqual(once);
  });
});
