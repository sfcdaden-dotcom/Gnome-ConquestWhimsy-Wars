/**
 * The poof: what a gnome leaves behind when it loses a fight.
 *
 * Each file is one animation laid out as a horizontal strip of 64×64 frames,
 * cut from the "Free Smoke Fx — Pixel" pack. The art is a WHITE SILHOUETTE on
 * transparency, which is the whole trick: the picture is used as a CSS mask
 * (see `.poof` in index.css), so the puff comes out in the dying gnome's seat
 * colour rather than a fixed grey. Nothing here knows about colour.
 *
 * `frames` has to match the file — the CSS steps() animation walks the strip
 * by background/mask position, so one frame too many shows empty space at the
 * end and one too few clips the tail off. Re-cut a strip and fix the number.
 *
 * Sibling of artAssets.ts, and separate for the same reason: plain data, so a
 * components module never has to re-export it.
 */

import poofBall from '../assets/art/FX/poof-ball.png';
import poofBlob from '../assets/art/FX/poof-blob.png';
import poofBurst from '../assets/art/FX/poof-burst.png';
import poofRing from '../assets/art/FX/poof-ring.png';
import poofStar from '../assets/art/FX/poof-star.png';
import poofSwirl from '../assets/art/FX/poof-swirl.png';

export interface PoofFx {
  /** Sprite strip: `frames` cells of 64×64, left to right. */
  src: string;
  frames: number;
}

/**
 * Every poof a death can draw. Order is not meaningful — a death picks one at
 * random — but the INDEX is what gets stored on a poof and handed to the
 * component, so appending is safe and reordering is not.
 */
export const POOF_FX: readonly PoofFx[] = [
  { src: poofBurst, frames: 11 },
  { src: poofBall, frames: 11 },
  { src: poofStar, frames: 11 },
  { src: poofBlob, frames: 15 },
  { src: poofSwirl, frames: 14 },
  { src: poofRing, frames: 13 },
];

/** How long one poof takes, start to gone. Mirrored by `--poof-ms` in the CSS. */
export const POOF_MS = 620;

/** A random poof, as an index into `POOF_FX`. */
export function randomPoofVariant(): number {
  return Math.floor(Math.random() * POOF_FX.length);
}
