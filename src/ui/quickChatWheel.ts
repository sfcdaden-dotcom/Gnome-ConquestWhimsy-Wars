/**
 * The geometry of the quick-chat category wheel.
 *
 * Kept out of the component for the same reason `panZoom.ts` is: it is
 * arithmetic, it has invariants worth asserting, and neither needs React to
 * say so. `QuickChat.tsx` renders what this returns.
 *
 * The wheel is a ring of petals. Every number here is a PERCENTAGE of the ring
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
 * Generous on purpose. A hairline reads as a dividing line drawn on a disc; it
 * takes real background between the shapes before the eye stops seeing a pie
 * with its slices separated and starts seeing petals with air around them.
 */
const PETAL_GAP_DEG = 8;
/** Samples along each curved side. */
const SIDE_STEPS = 14;
/** Samples across the rounded tip. */
const TIP_STEPS = 10;

/**
 * How wide a petal is, as a fraction of its maximum, at `u` along its length
 * (0 at the hub, 1 at the rim).
 *
 * This is the shape. A straight-sided sector is a pie chart: correct, and about
 * as charming as one, in a game whose whole subject is gardens. Bowing the
 * sides out turns the same ring into a flower — the petal narrows to a point
 * where it meets the hub and swells as it goes, which is how a petal actually
 * attaches.
 *
 * The exponent is what does it. A plain `sin` ramp is barely distinguishable
 * from a straight edge; taking it to a power below 1 lifts the middle well
 * clear of the diagonal, so the side reads as a curve rather than a bevel.
 */
export function petalWidth(u: number): number {
  // The sine term swells the petal out from its base; the second draws the very
  // tip back in so the end is a lobe rather than a flat chord across the rim.
  return Math.sin((Math.PI / 2) * u) ** 0.55 * (1 - 0.16 * u ** 6);
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

  // Up one side from the hub, across the tip, and back down the other.
  const points: Array<[number, number]> = [];
  for (let k = 0; k <= SIDE_STEPS; k++) points.push(at(k / SIDE_STEPS, -1));
  // The tip, at whatever width the profile actually ends on.
  const tipHalf = halfMax * petalWidth(1);
  for (let k = 1; k < TIP_STEPS; k++) {
    points.push(ringPoint(RING_OUTER, mid - tipHalf + (2 * tipHalf * k) / TIP_STEPS));
  }
  for (let k = SIDE_STEPS; k >= 0; k--) points.push(at(k / SIDE_STEPS, 1));

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
