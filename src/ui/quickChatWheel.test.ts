/**
 * The wheel's geometry, and the one invariant that is easy to lose.
 *
 * A clipped button can look perfect and still lie about where it is. The first
 * version of this wheel stretched every wedge across the whole ring and clipped
 * it down: identical on screen, correct under the pointer, and yet every button
 * reported the same bounding box centred on the hub — so anything aiming at
 * "the middle of that category" hit Close instead. `boxCentre` is what pins the
 * fix, and it fails loudly if the layout ever drifts back.
 */

import { describe, expect, it } from 'vitest';
import { RING_INNER, RING_OUTER, boxCentre, petalWidth, wedgeGeometry, wedgeMidDeg } from './quickChatWheel';

/** The smallest angle between two bearings, in degrees. */
function angleGap(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

describe('wedge geometry', () => {
  const COUNTS = [2, 3, 4, 5, 6, 7, 8, 9];

  it('centres the first wedge at the top and goes clockwise', () => {
    expect(wedgeMidDeg(0, 7)).toBe(-90);
    expect(wedgeMidDeg(1, 4)).toBe(0); // a quarter turn clockwise: the right
    expect(wedgeMidDeg(2, 4)).toBe(90); // straight down
  });

  /**
   * The invariant. A click that aims at the element's own centre — which is
   * what a test runner, an automation tool or scroll-into-view all do — has to
   * land inside the wedge it belongs to.
   */
  for (const n of COUNTS) {
    it(`puts every box centre inside its own wedge, with ${n} categories`, () => {
      for (let i = 0; i < n; i++) {
        const c = boxCentre(wedgeGeometry(i, n));
        // Inside the band, not over the hub and not past the rim.
        expect(c.radius).toBeGreaterThan(RING_INNER);
        expect(c.radius).toBeLessThan(RING_OUTER);
        // And in this wedge's slice of the circle rather than a neighbour's.
        expect(angleGap(c.deg, wedgeMidDeg(i, n))).toBeLessThan(360 / n / 2);
      }
    });
  }

  it('keeps every wedge inside the ring box', () => {
    for (let i = 0; i < 7; i++) {
      const g = wedgeGeometry(i, 7);
      expect(g.left).toBeGreaterThanOrEqual(0);
      expect(g.top).toBeGreaterThanOrEqual(0);
      expect(g.left + g.width).toBeLessThanOrEqual(100);
      expect(g.top + g.height).toBeLessThanOrEqual(100);
    }
  });

  it('gives each wedge a box of its own rather than the whole ring', () => {
    // The bug this file exists for: seven identical full-size boxes.
    const boxes = Array.from({ length: 7 }, (_, i) => {
      const g = wedgeGeometry(i, 7);
      return `${g.left.toFixed(1)},${g.top.toFixed(1)},${g.width.toFixed(1)},${g.height.toFixed(1)}`;
    });
    expect(new Set(boxes).size).toBe(7);
    for (const g of Array.from({ length: 7 }, (_, i) => wedgeGeometry(i, 7))) {
      expect(g.width).toBeLessThan(100);
      expect(g.height).toBeLessThan(100);
    }
  });

  /**
   * Labels are placed against the ring, not the button, because they are drawn
   * in a layer above the petals — `clip-path` would otherwise cut the ends off
   * a long word sitting on a diagonal petal. They still have to land on the
   * petal they name, and inside the ring.
   */
  it('puts each label on its own petal, within the ring', () => {
    for (let i = 0; i < 7; i++) {
      const g = wedgeGeometry(i, 7);
      const r = Math.hypot(g.labelX - 50, g.labelY - 50);
      expect(r).toBeGreaterThan(RING_INNER);
      expect(r).toBeLessThan(RING_OUTER);
      const deg = (Math.atan2(g.labelY - 50, g.labelX - 50) * 180) / Math.PI;
      expect(angleGap(deg, wedgeMidDeg(i, 7))).toBeLessThan(0.01);
    }
  });

  it('points every petal away from the same centre when it lifts', () => {
    // The transform origin is the flower's middle, seen from inside each
    // button's own box — so focus grows the petal outward rather than in place.
    for (let i = 0; i < 7; i++) {
      const g = wedgeGeometry(i, 7);
      expect(g.left + (g.originX / 100) * g.width).toBeCloseTo(50, 6);
      expect(g.top + (g.originY / 100) * g.height).toBeCloseTo(50, 6);
    }
  });

  it('builds a polygon in percentages, so it scales with the box', () => {
    const g = wedgeGeometry(0, 7);
    expect(g.clipPath.startsWith('polygon(')).toBe(true);
    expect(g.clipPath).not.toMatch(/px/);
    // Enough points that the curve does not read as a bevel. The exact count
    // is sampling detail and deliberately not pinned.
    expect(g.clipPath.split(',').length).toBeGreaterThan(20);
  });

  /**
   * The petal, as opposed to the pie slice it started as.
   *
   * A straight-sided sector has a half-width that rises linearly from hub to
   * rim. What makes this read as a flower is that the sides bow OUT — the
   * middle of the petal is markedly wider than a straight edge between the same
   * two ends. If this ever collapses back to the diagonal, the wheel is a pie
   * chart again and nothing else in the file will say so.
   */
  /**
   * The petal profile, stated as the three things that make it a bloom rather
   * than a pie slice. Each would be visible immediately if it broke, and none
   * of them is obvious from reading the formula.
   */
  describe('the petal profile', () => {
    it('meets the eye narrow and closes at the tip', () => {
      expect(petalWidth(0)).toBeCloseTo(0, 5);
      expect(petalWidth(1)).toBeCloseTo(0, 5);
    });

    it('has broad shoulders — most of its width in the first third', () => {
      // A straight-sided wedge would be at 0.25 here. A forget-me-not petal is
      // a lobe hanging off the eye, so it is most of the way out already.
      expect(petalWidth(0.25)).toBeGreaterThan(0.6);
      expect(petalWidth(0.1)).toBeGreaterThan(0.4);
    });

    it('holds that width across the middle instead of peaking', () => {
      for (const u of [0.4, 0.5, 0.62, 0.75]) {
        expect(petalWidth(u)).toBeGreaterThan(0.8);
      }
    });

    /**
     * The end is ROUND, which is a claim about how it closes rather than that
     * it closes. A circular falloff still has real width very near the tip and
     * then turns hard; a straight taper to the same point would be a spike.
     */
    it('rounds over at the end rather than coming to a spike', () => {
      expect(petalWidth(0.95)).toBeGreaterThan(0.4);
      expect(petalWidth(0.99)).toBeGreaterThan(0.15);
    });
  });
});
