/**
 * Turning a `GnomeLook` into a picture: the layer catalogue, the recolouring,
 * and the sprite cache the UI reads from.
 *
 * ## Why a canvas and not seven stacked `<img>`s
 *
 * The obvious rendering is one `<img>` per layer, absolutely positioned. It
 * cannot work here, because the palette swap is per-region, not per-layer: the
 * blue-grey `#90a4ae` is a cap, a torso AND the metal head of a shovel, and a
 * CSS filter cannot repaint one of those without repainting the other two. So
 * each layer is drawn to an offscreen canvas, its pixels are swapped by exact
 * value, and the seven results are flattened into a single data URL.
 *
 * Flattening pays for itself twice over: a board with sixteen gnomes on it
 * renders sixteen `<img>`s instead of a hundred and twelve, and the recolour
 * runs once per distinct look rather than once per token.
 *
 * ## The catalogue is the folder tree
 *
 * Layers and variants are read off disk with `import.meta.glob` rather than
 * listed here, so adding a new hat is dropping a PNG into `Hats/` — no code
 * change, no registry to forget to update. The folder name is the layer and
 * the file name is the variant. (`unit-gnome.png` and the garden art keep
 * their hand-written map in `artAssets.ts`: those are one-per-game-type and
 * the filename really is the whole contract.)
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { GnomeLayer, GnomeLook } from './gnomeLook';
import {
  GNOME_LAYERS,
  GARMENT_VARIANTS,
  HAIR_COLORS,
  HAIR_TINTED_LAYERS,
  SKIN_TONES,
  garmentAndSkinSwap,
  hairSwap,
  isOptionalLayer,
  lookKey,
} from './gnomeLook';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface GnomeVariant {
  id: string;
  label: string;
  url: string;
}

/** Folder name on disk → the layer it provides. */
const FOLDER_LAYERS: Record<string, GnomeLayer> = {
  Torso: 'torso',
  Faces: 'face',
  Shoes: 'shoes',
  Beards: 'beard',
  Hair: 'hair',
  Hats: 'cap',
  Accessories: 'accessory',
};

/**
 * Every layer PNG.
 *
 * The glob matches files exactly one folder deep, which is deliberate: it
 * takes everything inside `Hats/`, `Beards/` and friends while ignoring
 * `Gnome-Background.png`, a fully transparent 48×64 spacer sitting loose at
 * the top of `Gnome Assets/`.
 */
const FILES = import.meta.glob('../assets/art/Gnome Assets/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** `Classic Beard.png` → `classic-beard`; ids travel over the wire, so keep them terse and stable. */
function variantId(fileName: string): string {
  return fileName
    .replace(/\.png$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `Classic Beard.png` → `Classic Beard`; what the carousel shows. */
function variantLabel(fileName: string): string {
  return fileName.replace(/\.png$/i, '').replace(/[-_]+/g, ' ').trim();
}

function buildCatalogue(): Record<GnomeLayer, GnomeVariant[]> {
  const out = Object.fromEntries(GNOME_LAYERS.map((l) => [l, [] as GnomeVariant[]])) as Record<
    GnomeLayer,
    GnomeVariant[]
  >;
  for (const [path, url] of Object.entries(FILES)) {
    const parts = path.split('/');
    const fileName = parts[parts.length - 1];
    const layer = FOLDER_LAYERS[parts[parts.length - 2]];
    if (!layer) continue;
    out[layer].push({ id: variantId(fileName), label: variantLabel(fileName), url });
  }
  // Sorted by id so the carousel order is the same on every machine — glob
  // order is not guaranteed, and a carousel that reshuffles between reloads
  // would make "the third hat" mean nothing.
  for (const layer of GNOME_LAYERS) out[layer].sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export const GNOME_CATALOGUE = buildCatalogue();

/** Human-readable layer names, in the order the creator shows them. */
export const LAYER_LABELS: Record<GnomeLayer, string> = {
  cap: 'Cap',
  face: 'Face',
  hair: 'Hair',
  beard: 'Beard',
  torso: 'Torso',
  shoes: 'Shoes',
  accessory: 'Accessory',
};

/**
 * Carousel order — front of the character first, because that is the order a
 * person builds one in. This is NOT the paint order; `GNOME_LAYERS` is.
 *
 * A layer with fewer than two variants is left out: there is nothing to
 * carousel through, and an arrow that does nothing is worse than no arrow.
 * (Shoes has exactly one drawing today, so it is drawn on every gnome and
 * never offered as a choice. It reappears here the moment a second pair
 * lands in `Shoes/`.)
 */
export const CREATOR_LAYERS: GnomeLayer[] = ['cap', 'face', 'hair', 'beard', 'torso', 'accessory', 'shoes'];

export function choosableLayers(): GnomeLayer[] {
  return CREATOR_LAYERS.filter((l) => {
    const n = GNOME_CATALOGUE[l].length;
    return isOptionalLayer(l) ? n >= 1 : n >= 2;
  });
}

/** The options for a layer, with the "None" slot in front where one is allowed. */
export function layerOptions(layer: GnomeLayer): Array<GnomeVariant | null> {
  const variants = GNOME_CATALOGUE[layer] as Array<GnomeVariant | null>;
  return isOptionalLayer(layer) ? [null, ...variants] : [...variants];
}

// ---------------------------------------------------------------------------
// Making a look
// ---------------------------------------------------------------------------

function firstId(layer: GnomeLayer): string {
  return GNOME_CATALOGUE[layer][0]?.id ?? '';
}

/** The gnome a seat starts with before anyone touches the creator. */
export function defaultLook(): GnomeLook {
  return {
    torso: firstId('torso'),
    face: firstId('face'),
    shoes: firstId('shoes'),
    beard: firstId('beard') || null,
    hair: null,
    cap: firstId('cap'),
    accessory: firstId('accessory'),
    garment: 0,
    hair_color: 0,
    skin: 1,
  };
}

/**
 * A random gnome. `pick` returns a float in [0,1) — the caller supplies it, so
 * a test can be deterministic and CPU seats can be rolled without touching the
 * engine's RNG (which is seeded, and whose state every recorded match depends
 * on).
 */
export function randomLook(pick: () => number = Math.random): GnomeLook {
  const one = <T>(items: readonly T[]): T => items[Math.floor(pick() * items.length) % items.length];
  const optional = (layer: GnomeLayer, chance: number): string | null =>
    pick() < chance ? one(GNOME_CATALOGUE[layer]).id : null;
  return {
    torso: one(GNOME_CATALOGUE.torso).id,
    face: one(GNOME_CATALOGUE.face).id,
    shoes: firstId('shoes'),
    // Most gnomes have a beard and some have hair — an even split produced a
    // suspicious number of clean-shaven bald CPUs.
    beard: optional('beard', 0.8),
    hair: optional('hair', 0.5),
    cap: one(GNOME_CATALOGUE.cap).id,
    accessory: one(GNOME_CATALOGUE.accessory).id,
    garment: Math.floor(pick() * GARMENT_VARIANTS.length) % GARMENT_VARIANTS.length,
    hair_color: Math.floor(pick() * HAIR_COLORS.length) % HAIR_COLORS.length,
    skin: Math.floor(pick() * SKIN_TONES.length) % SKIN_TONES.length,
  };
}

/**
 * Coerce anything claiming to be a look into one that renders. Everything here
 * arrives over the network eventually, and an unknown hat id must not be able
 * to leave a hole in somebody else's board — every field falls back to the
 * default rather than throwing.
 */
export function sanitizeLook(value: unknown): GnomeLook {
  const base = defaultLook();
  if (!value || typeof value !== 'object') return base;
  const raw = value as Record<string, unknown>;
  const out = { ...base };
  for (const layer of GNOME_LAYERS) {
    const id = raw[layer];
    if (id === null && isOptionalLayer(layer)) {
      out[layer] = null as never;
    } else if (typeof id === 'string' && GNOME_CATALOGUE[layer].some((v) => v.id === id)) {
      out[layer] = id as never;
    }
  }
  const index = (key: 'garment' | 'hair_color' | 'skin', length: number) => {
    const v = raw[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < length) out[key] = v;
  };
  index('garment', GARMENT_VARIANTS.length);
  index('hair_color', HAIR_COLORS.length);
  index('skin', SKIN_TONES.length);
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SPRITE_W = 48;
const SPRITE_H = 64;

const sprites = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();

/** The finished sprite for this look, if it has already been rendered. */
export function cachedSprite(look: GnomeLook, seatId: number): string | undefined {
  return sprites.get(lookKey(look, seatId));
}

export function subscribeSprites(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const images = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${url}`));
      img.src = url;
    });
    images.set(url, p);
  }
  return p;
}

/** `#aabbcc` → `0xaabbcc`, for comparing against packed pixel values. */
function packed(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

/**
 * Draw one layer into `ctx`, swapping the palette on the way.
 *
 * The swap is by exact value: the art is flat-shaded pixel work with no
 * anti-aliasing, so every pixel is one of a dozen or so known hexes and a
 * lookup is both exact and fast. Anything not in the map — the brown shoes,
 * the gold buckle, the white cap dots — is copied through untouched.
 */
function drawRecoloured(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  swap: Map<number, [number, number, number]>,
): void {
  const layer = document.createElement('canvas');
  layer.width = SPRITE_W;
  layer.height = SPRITE_H;
  const lctx = layer.getContext('2d');
  if (!lctx) return;
  lctx.imageSmoothingEnabled = false;
  lctx.drawImage(img, 0, 0, SPRITE_W, SPRITE_H);
  const data = lctx.getImageData(0, 0, SPRITE_W, SPRITE_H);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const to = swap.get((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (!to) continue;
    px[i] = to[0];
    px[i + 1] = to[1];
    px[i + 2] = to[2];
  }
  lctx.putImageData(data, 0, 0);
  ctx.drawImage(layer, 0, 0);
}

function swapMap(swap: Record<string, string>): Map<number, [number, number, number]> {
  const m = new Map<number, [number, number, number]>();
  for (const [from, to] of Object.entries(swap)) {
    const n = packed(to);
    m.set(packed(from), [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  }
  return m;
}

async function render(look: GnomeLook, seatId: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_W;
  canvas.height = SPRITE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas context');
  ctx.imageSmoothingEnabled = false;

  const base = garmentAndSkinSwap(look, seatId);
  const shared = swapMap(base);
  const hair = swapMap({ ...base, ...hairSwap(look) });
  const hairTinted = new Set<GnomeLayer>(HAIR_TINTED_LAYERS);

  for (const layer of GNOME_LAYERS) {
    const id = look[layer];
    if (!id) continue;
    const variant = GNOME_CATALOGUE[layer].find((v) => v.id === id);
    if (!variant) continue;
    const img = await loadImage(variant.url);
    // Only some layers have hair in them — the face's eyebrows count, the cap's
    // polka dots would not if they were this grey. See HAIR_TINTED_LAYERS.
    drawRecoloured(ctx, img, hairTinted.has(layer) ? hair : shared);
  }
  return canvas.toDataURL('image/png');
}

/**
 * Render this look if it has not been rendered already, and tell subscribers
 * when it lands. Safe to call on every render pass: a look already in the
 * cache costs a map lookup, and one already in flight is not started twice.
 */
export function ensureSprite(look: GnomeLook, seatId: number): string | undefined {
  const key = lookKey(look, seatId);
  const done = sprites.get(key);
  if (done) return done;
  if (pending.has(key)) return undefined;
  if (typeof document === 'undefined') return undefined;
  const p = render(look, seatId)
    .then((url) => {
      sprites.set(key, url);
      return url;
    })
    .catch(() => '')
    .finally(() => {
      pending.delete(key);
      for (const fn of listeners) fn();
    });
  pending.set(key, p);
  return undefined;
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

/**
 * The sprite for a look, rendering it on first use.
 *
 * Returns `undefined` until the canvas work finishes, which is a frame or two
 * on a cold cache and never again afterwards — callers show the stock gnome in
 * the meantime rather than a gap. The cache is module-level and shared, so the
 * sixteen tokens of one seat's gnomes all resolve from a single render.
 */
export function useGnomeSprite(look: GnomeLook | undefined, seatId: number): string | undefined {
  const key = look ? lookKey(look, seatId) : '';
  const subscribe = useCallback((fn: () => void) => subscribeSprites(fn), []);
  const snapshot = useCallback(() => (key ? sprites.get(key) : undefined), [key]);
  const url = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (look) ensureSprite(look, seatId);
  }, [look, seatId, key]);
  return url;
}
