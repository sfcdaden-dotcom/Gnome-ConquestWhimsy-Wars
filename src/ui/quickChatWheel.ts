/**
 * The geometry of the quick-chat category wheel.
 *
 * Kept out of the component for the same reason `panZoom.ts` is: it is
 * arithmetic, it has invariants worth asserting, and neither needs React to
 * say so. `QuickChat.tsx` renders what this returns.
 *
 * The wheel is a bloom: broad rounded petals around a small pale eye, after a
 * forget-me-not. Every number here is a PERCENTAGE of the ring
 * box rather than a pixel, so one CSS width decides how big the menu is and the
 * petals, their labels and the hub all follow. That only works because the box
 * is square: `polygon()` reads x as a share of width and y as a share of
 * height, and the maths below assumes those agree, which is what the
 * `aspect-ratio: 1` in the stylesheet is for.
 */

/** The petal's tip — the ring box itself. */
export const RING_OUTER = 50;
/** The hole in the middle, where the hub sits. */
export const RING_INNER = 17;
/**
 * The gap between neighbouring petals, in degrees.
 *
 * Enough that the shapes read as separate and no more. A forget-me-not's petals
 * very nearly touch — the bloom is a rounded disc with seams in it, not a star
 * — so the gap is a seam rather than a wedge of background.
 */
const PETAL_GAP_DEG = 5;

/**
 * Samples along each side of a petal.
 *
 * Spaced unevenly, bunched towards the tip: that is where the outline turns
 * fastest, and evenly-spaced points there leave a rounded end looking like a
 * cut corner.
 */
const SIDE_STEPS = 22;
/** How hard the sampling crowds towards the tip. 1 would be even spacing. */
const SIDE_EASE = 1.6;

/**
 * How wide a petal is, as a fraction of its maximum, at `u` along its length
 * (0 where it meets the eye, 1 at the rim).
 *
 * This is the shape, and it is the whole difference between a pie chart and a
 * flower. Two terms, doing two different jobs — see below. Between them the
 * petal leaves the eye narrow, is broad almost at once, holds that width for
 * most of its length, and closes over into a round end.
 */
export function petalWidth(u: number): number {
  // Shoulders: a low exponent makes the petal reach most of its width within
  // the first third, so it is a broad lobe hanging off the eye rather than a
  // wedge that widens all the way out. This is most of what separates a
  // forget-me-not from a daisy.
  const shoulder = Math.sin((Math.PI / 2) * u) ** 0.3;
  // Cap: a circular falloff, which closes the outline with a vertical tangent.
  // That is what makes the end read as ROUND. A linear taper to the same point
  // would come to a spike, and a flat chord across the rim would look cut off.
  const cap = Math.sqrt(1 - u ** 6);
  return shoulder * cap;
}

/** Where along its length a petal is sampled, crowded towards the tip. */
function sideAt(k: number): number {
  return 1 - (1 - k / SIDE_STEPS) ** SIDE_EASE;
}

/**
 * Where a label sits along the petal, as a fraction of its length.
 *
 * Further out than the middle, and not for looks: a petal is narrowest near the
 * hub, so a label centred on the band's midpoint is wider than the petal
 * carrying it and spills over both edges. Out here the petal is near its full
 * width and the longest category fits inside its own shape.
 */
const LABEL_ALONG = 0.62;

/** The angle a petal is centred on. The first sits at the top, then clockwise. */
export function wedgeMidDeg(i: number, n: number): number {
  return (360 / n) * i - 90;
}

/** A point on the ring, in percentages of the ring box. */
function ringPoint(radiusPct: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [50 + radiusPct * Math.cos(a), 50 + radiusPct * Math.sin(a)];
}

export interface WedgeGeometry {
  /** Where the button sits in the ring box. Percentages. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The sector, re-expressed as a fraction of the BUTTON's own box. */
  clipPath: string;
  /**
   * Where this petal's label sits — relative to the RING, not to the button.
   *
   * The label is drawn in a layer above the petals rather than inside one,
   * because `clip-path` would cut it: the text runs horizontally and the petal
   * it belongs to is usually on a diagonal, so the ends of a long word fall
   * outside the shape carrying it and simply vanish.
   */
  labelX: number;
  labelY: number;
  /**
   * The flower's centre, expressed in the button's own coordinates.
   *
   * A petal lifting on focus has to grow AWAY from the middle, the way a real
   * one opens. Since each button's box is somewhere off-centre, that origin is
   * a different point inside every one of them.
   */
  originX: number;
  originY: number;
}

/**
 * One petal: its bounding box, the shape clipped inside it, and where its
 * label goes.
 *
 * Clipping a real `<button>` rather than drawing the shape separately is the
 * point: the thing you see and the thing you click are one element, so there is
 * no pixel where the highlight and the hit test disagree, and it stays a native
 * button — focusable, activatable by Enter and Space, announced as a menu item,
 * none of it reimplemented.
 *
 * The bounding box is why this is more than a `clip-path` call. The first
 * version stretched every button across the whole ring and clipped it down,
 * which looks identical and hit-tests correctly — `clip-path` culls pointer
 * events — but left seven buttons all REPORTING the same box, centred on the
 * hub. Anything that reasons about where an element is rather than what it
 * paints then aims at the middle and misses: that is how the browser tests
 * clicked straight through a category and hit Close. Sizing each button to its
 * own sector makes the reported geometry true, and `boxCentre` below is the
 * invariant that keeps it that way.
 */
export function wedgeGeometry(i: number, n: number): WedgeGeometry {
  const mid = wedgeMidDeg(i, n);
  const halfMax = (360 / n) / 2 - PETAL_GAP_DEG / 2;
  const span = RING_OUTER - RING_INNER;
  const at = (u: number, side: number): [number, number] =>
    ringPoint(RING_INNER + u * span, mid + side * halfMax * petalWidth(u));

  // Up one side from the hub and back down the other. There is no separate arc
  // across the end: the profile closes to nothing at the tip, so the two sides
  // meet there and the cap above is what rounds the join.
  const points: Array<[number, number]> = [];
  for (let k = 0; k <= SIDE_STEPS; k++) points.push(at(sideAt(k), -1));
  for (let k = SIDE_STEPS; k >= 0; k--) points.push(at(sideAt(k), 1));

  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;

  // Measured against the same sampled points the box came from, so the clip can
  // never fall outside the button however coarse the sampling is.
  const rel = ([x, y]: [number, number]): string =>
    `${(((x - left) / width) * 100).toFixed(2)}% ${(((y - top) / height) * 100).toFixed(2)}%`;

  const [labelX, labelY] = ringPoint(RING_INNER + LABEL_ALONG * span, mid);
  return {
    left,
    top,
    width,
    height,
    clipPath: `polygon(${points.map(rel).join(', ')})`,
    labelX,
    labelY,
    originX: ((50 - left) / width) * 100,
    originY: ((50 - top) / height) * 100,
  };
}

/**
 * Where a wedge's bounding box is centred, in polar terms around the ring.
 *
 * This is the thing a click lands on when something aims at "the element" —
 * a test runner, an automation tool, a browser scrolling it into view. It has
 * to be inside the wedge, or the aim silently lands on whatever is underneath.
 */
export function boxCentre(g: WedgeGeometry): { radius: number; deg: number } {
  const x = g.left + g.width / 2 - 50;
  const y = g.top + g.height / 2 - 50;
  return { radius: Math.hypot(x, y), deg: (Math.atan2(y, x) * 180) / Math.PI };
}
