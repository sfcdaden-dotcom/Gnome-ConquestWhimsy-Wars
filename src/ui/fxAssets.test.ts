/**
 * The poof strips carry an invariant TypeScript cannot see: the frame count
 * declared beside a file has to be the number of frames actually IN it. Get it
 * wrong and nothing fails — the smoke just clips halfway or trails a beat of
 * empty air — so the count is checked against each PNG's own header here.
 *
 * The files arrive through Vite (`?inline`, i.e. as data URIs) rather than the
 * filesystem, because these sources compile with browser types only — and it
 * buys the second test for nothing: the glob is every strip in the folder, so
 * a file nobody imported is caught as readily as an import with no file.
 */

import { describe, expect, it } from 'vitest';
import { POOF_FX, POOF_MS, randomPoofVariant } from './fxAssets';

const STRIPS = import.meta.glob('../assets/art/FX/*.png', {
  query: '?inline',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** One frame of every strip, square. */
const FRAME = 64;

/** Width and height straight out of a PNG's IHDR chunk. */
function pngSize(dataUri: string): { width: number; height: number } {
  const bytes = Uint8Array.from(atob(dataUri.slice(dataUri.indexOf(',') + 1)), (c) =>
    c.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const basename = (path: string): string => path.split('/').pop() as string;

/** The inlined bytes of a strip, found by filename. */
function stripFor(src: string): string {
  const key = Object.keys(STRIPS).find((path) => basename(path) === basename(src));
  if (!key) throw new Error(`no file behind ${src}`);
  return STRIPS[key];
}

describe('poof assets', () => {
  it('declares the frame count each strip actually has', () => {
    for (const fx of POOF_FX) {
      const { width, height } = pngSize(stripFor(fx.src));
      expect(height, fx.src).toBe(FRAME);
      expect(width, fx.src).toBe(fx.frames * FRAME);
    }
  });

  it('ships every strip in the folder, each exactly once', () => {
    const onDisk = Object.keys(STRIPS).map(basename).sort();
    const used = POOF_FX.map((fx) => basename(fx.src)).sort();
    expect(used).toEqual(onDisk);
  });

  it('only ever draws a variant that exists', () => {
    for (let i = 0; i < 200; i++) {
      const v = randomPoofVariant();
      expect(Number.isInteger(v)).toBe(true);
      expect(POOF_FX[v]).toBeDefined();
    }
  });

  it('gives the frames time to play before the puff is dropped', () => {
    // Two display frames apiece is the floor worth having; below that the
    // animation is a flicker, whatever --poof-ms in the CSS says.
    const slowest = Math.max(...POOF_FX.map((fx) => fx.frames));
    expect(POOF_MS / slowest).toBeGreaterThan(2 * (1000 / 60));
  });
});
