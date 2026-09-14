import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, NO_INSETS, clampView, clampZoom, center, fitView, wheelZoomFactor, zoomAt } from './panZoom';

const viewport = { width: 800, height: 600 };

describe('clampZoom', () => {
  it('holds the scale inside the usable range', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });
});

describe('fitView', () => {
  it('shrinks a board that is bigger than the screen until it fits, and centres it', () => {
    const content = { width: 1200, height: 1200 };
    const view = fitView(content, viewport, NO_INSETS, 24);
    expect(content.height * view.scale).toBeLessThanOrEqual(viewport.height - 48);
    expect(view.x).toBeCloseTo((viewport.width - content.width * view.scale) / 2);
    expect(view.y).toBeCloseTo((viewport.height - content.height * view.scale) / 2);
  });

  it('leaves a small board at its natural size rather than blowing it up', () => {
    const view = fitView({ width: 200, height: 200 }, viewport);
    expect(view.scale).toBe(1);
    expect(view.x).toBe(300);
    expect(view.y).toBe(200);
  });

  it('fits into the space left over when panels cover the top and bottom', () => {
    const content = { width: 400, height: 400 };
    const insets = { top: 200, right: 0, bottom: 200, left: 0 };
    const view = fitView(content, viewport, insets, 0);
    // 200px of free height, so the board is halved and lands in the gap.
    expect(view.scale).toBe(0.5);
    expect(view.y).toBe(200);
    expect(view.y + content.height * view.scale).toBe(400);
  });

  it('enlarges a small board only as far as the caller allows', () => {
    const content = { width: 200, height: 200 };
    // The game board asks for some growth so it does not sit small on a wide
    // monitor; the ceiling still holds once the free space runs out.
    expect(fitView(content, viewport, NO_INSETS, 0, 1.25).scale).toBe(1.25);
    expect(fitView(content, { width: 240, height: 240 }, NO_INSETS, 0, 1.25).scale).toBe(1.2);
  });

  it('survives being measured before anything has been laid out', () => {
    expect(fitView({ width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('zoomAt', () => {
  it('keeps the point under the cursor over the same part of the board', () => {
    const content = { width: 1000, height: 1000 };
    const before = center({ scale: 1, x: 0, y: 0 }, content, viewport);
    const focus = { x: 300, y: 250 };
    // Where in the content that screen point sits, before and after.
    const contentPoint = (v: typeof before) => ({ x: (focus.x - v.x) / v.scale, y: (focus.y - v.y) / v.scale });
    const was = contentPoint(before);
    const after = zoomAt(before, 2, focus);
    expect(after.scale).toBe(2);
    expect(contentPoint(after).x).toBeCloseTo(was.x);
    expect(contentPoint(after).y).toBeCloseTo(was.y);
  });

  it('does not drift when the zoom is already at the limit', () => {
    const at = { scale: MAX_ZOOM, x: -100, y: -50 };
    expect(zoomAt(at, 4, { x: 400, y: 300 })).toEqual(at);
  });
});

describe('clampView', () => {
  it('centres content smaller than the viewport, however far it was dragged', () => {
    const content = { width: 400, height: 300 };
    const clamped = clampView({ scale: 1, x: -9999, y: 9999 }, content, viewport);
    expect(clamped).toEqual({ scale: 1, x: 200, y: 150 });
  });

  it('centres a small board between the panels, not behind one', () => {
    const content = { width: 400, height: 300 };
    const insets = { top: 200, right: 0, bottom: 100, left: 0 };
    // The 300px gap fits the board exactly: it sits right under the top panel.
    expect(clampView({ scale: 1, x: 0, y: 0 }, content, viewport, insets).y).toBe(200);
  });

  it('lets a board taller than the gap be dragged out from behind a panel', () => {
    const content = { width: 400, height: 500 };
    const insets = { top: 100, right: 0, bottom: 100, left: 0 };
    const y = (dragged: number) => clampView({ scale: 1, x: 0, y: dragged }, content, viewport, insets).y;
    expect(y(50)).toBe(50); // mid-drag positions are left alone…
    expect(y(400)).toBe(100); // …until the top edge reaches the gap's top…
    expect(y(-400)).toBe(0); // …or its bottom edge reaches the gap's bottom.
  });

  it('lets a big board be dragged only until its edge meets the viewport', () => {
    const content = { width: 2000, height: 2000 };
    expect(clampView({ scale: 1, x: 500, y: 0 }, content, viewport).x).toBe(0);
    expect(clampView({ scale: 1, x: -5000, y: 0 }, content, viewport).x).toBe(-1200);
    expect(clampView({ scale: 1, x: -300, y: -200 }, content, viewport)).toEqual({ scale: 1, x: -300, y: -200 });
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in on a scroll up and out on a scroll down', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('caps one violent mouse notch so it cannot cross the whole range', () => {
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-300));
    expect(wheelZoomFactor(-300)).toBeLessThan(2);
  });
});
