/**
 * The shape a gnome look must have before the room will store or rebroadcast
 * it.
 *
 * The room used to keep whatever a client sent as `look`, verbatim, and hand
 * it back out in every snapshot to every connection. Appearance is still the
 * clients' business — this checks SHAPE, never the catalogue — but a look is
 * now exactly the `GnomeLookWire` keys, each holding what that key can hold,
 * and nothing else. That bounds it by construction: seven short ids and three
 * small integers, a few hundred bytes at most.
 *
 * Why not validate against the real catalogue: the catalogue is the asset
 * folder tree (see src/ui/gnomeArt.ts), and "adding a hat is dropping a PNG"
 * must not come to mean "and redeploying the server". An id the receiving
 * client does not know is still mapped to a default by `sanitizeLook` there,
 * exactly as before. So the id rule is the shape `variantId()` produces from a
 * filename, and the indices are bounded loosely rather than by today's palette
 * lengths (which live in UI modules the server should not import).
 */

import type { GnomeLookWire } from './protocol';

/** Layer ids: what `variantId()` in gnomeArt.ts makes of a filename. */
const VARIANT_ID = /^[a-z0-9-]{1,40}$/;

/** Palette indices. Today's palettes have 5, 6 and 8 entries; this is headroom, not a mirror. */
export const MAX_LOOK_INDEX = 63;

const REQUIRED_LAYERS = ['torso', 'face', 'shoes', 'cap', 'accessory'] as const;
const OPTIONAL_LAYERS = ['beard', 'hair'] as const;
const INDICES = ['garment', 'hair_color', 'skin'] as const;

const ALL_KEYS: ReadonlySet<string> = new Set<string>([...REQUIRED_LAYERS, ...OPTIONAL_LAYERS, ...INDICES]);

function isVariantId(v: unknown): v is string {
  return typeof v === 'string' && VARIANT_ID.test(v);
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_LOOK_INDEX;
}

/**
 * A fresh, well-formed look built from `value`, or null when `value` is not
 * one. Never returns the caller's object: what the room stores is built here,
 * key by key, so nothing unvalidated can ride along.
 */
export function validateLookWire(value: unknown): GnomeLookWire | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== ALL_KEYS.size || !keys.every((k) => ALL_KEYS.has(k))) return null;

  for (const k of REQUIRED_LAYERS) if (!isVariantId(raw[k])) return null;
  for (const k of OPTIONAL_LAYERS) if (raw[k] !== null && !isVariantId(raw[k])) return null;
  for (const k of INDICES) if (!isIndex(raw[k])) return null;

  return {
    torso: raw.torso as string,
    face: raw.face as string,
    shoes: raw.shoes as string,
    beard: raw.beard as string | null,
    hair: raw.hair as string | null,
    cap: raw.cap as string,
    accessory: raw.accessory as string,
    garment: raw.garment as number,
    hair_color: raw.hair_color as number,
    skin: raw.skin as number,
  };
}
