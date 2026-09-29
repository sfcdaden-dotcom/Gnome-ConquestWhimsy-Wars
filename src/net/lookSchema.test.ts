/**
 * The room's look validator. The property that matters most is the first one:
 * everything the real client produces must pass, or hardening the room would
 * quietly strip players' gnomes.
 */

import { describe, expect, it } from 'vitest';
import { defaultLook, randomLook } from '../ui/gnomeArt';
import { MAX_LOOK_INDEX, validateLookWire } from './lookSchema';

/** A deterministic stand-in for Math.random, so the draws are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('validateLookWire', () => {
  it('accepts every look the client itself can produce', () => {
    expect(validateLookWire(defaultLook())).toEqual(defaultLook());
    const pick = lcg(7);
    for (let i = 0; i < 50; i++) {
      const look = randomLook(pick);
      expect(validateLookWire(look), JSON.stringify(look)).toEqual(look);
    }
  });

  it('returns a fresh object, never the one it was given', () => {
    const look = defaultLook();
    const out = validateLookWire(look);
    expect(out).not.toBe(look);
    expect(out).toEqual(look);
  });

  it('accepts null for the optional layers only', () => {
    expect(validateLookWire({ ...defaultLook(), beard: null, hair: null })).not.toBeNull();
    expect(validateLookWire({ ...defaultLook(), cap: null })).toBeNull();
    expect(validateLookWire({ ...defaultLook(), torso: null })).toBeNull();
  });

  it('accepts a well-formed id the catalogue has never heard of', () => {
    // Shape, not catalogue: a hat drawn after the server was deployed must still pass.
    expect(validateLookWire({ ...defaultLook(), cap: 'brand-new-cap-2' })).not.toBeNull();
  });

  it('refuses anything that is not a plain object', () => {
    for (const v of [null, undefined, 'look', 42, true, [], [defaultLook()]]) {
      expect(validateLookWire(v), String(v)).toBeNull();
    }
  });

  it('refuses a missing key and an extra key', () => {
    const { torso: _torso, ...missing } = defaultLook();
    expect(validateLookWire(missing)).toBeNull();
    expect(validateLookWire({ ...defaultLook(), extra: 'x' })).toBeNull();
    expect(validateLookWire({ ...defaultLook(), anything: { nested: true } })).toBeNull();
  });

  it('refuses ids that are not the shape a filename becomes', () => {
    for (const bad of ['', 'Round-Cap', 'round cap', 'round_cap', 'cap/../x', 'x'.repeat(41), 7, {}, ['cap']]) {
      expect(validateLookWire({ ...defaultLook(), cap: bad }), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses indices that are negative, fractional, oversized or not numbers', () => {
    for (const bad of [-1, 1.5, MAX_LOOK_INDEX + 1, Number.NaN, Infinity, '1', null]) {
      expect(validateLookWire({ ...defaultLook(), skin: bad }), String(bad)).toBeNull();
    }
    expect(validateLookWire({ ...defaultLook(), skin: MAX_LOOK_INDEX })).not.toBeNull();
  });

  it('refuses the oversized payload the audit found the room accepting', () => {
    expect(validateLookWire({ ...defaultLook(), torso: 'x'.repeat(200_000) })).toBeNull();
  });
});
