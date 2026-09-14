/**
 * The arithmetic behind a pan-and-zoom viewport, kept apart from the component
 * that wires it to pointers (PanZoom.tsx) so the awkward parts — keeping the
 * point under the cursor still while zooming, and never letting the content be
 * dragged off into nowhere — can be reasoned about and tested on their own.
 *
 * The model is one transform: `translate(x, y) scale(scale)` applied to a
 * content box of a known pixel size, with the transform origin at its top-left
 * corner. Every function here takes a view and returns a new one; nothing
 * mutates, and nothing touches the DOM.
 */

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;

/** How far one wheel notch (or one zoom button press) moves the scale. */
export const ZOOM_STEP = 1.15;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Edges of the viewport that something else is sitting on — HUD panels, in the
 * editor's case. Fitting and centring aim at the space left over, so a board
 * that "fits" is one you can actually see and click all of.
 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** A viewport's current transform: content scaled by `scale`, then offset. */
export interface View extends Point {
  scale: number;
}

export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/**
 * The view that shows all of `content` in the part of `viewport` nothing else
 * covers, centred there with a little breathing room. Never zooms past 1: a
 * small board is shown at its natural size rather than blown up to fill a wide
 * monitor.
 */
export function fitView(content: Size, viewport: Size, insets: Insets = NO_INSETS, padding = 16): View {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { scale: 1, x: 0, y: 0 };
  }
  const free = freeSpace(viewport, insets, padding);
  const scale = clampZoom(Math.min(1, free.width / content.width, free.height / content.height));
  return center({ scale, x: 0, y: 0 }, content, viewport, insets);
}

/** The same scale, re-centred in the space the viewport has left over. */
export function center(view: View, content: Size, viewport: Size, insets: Insets = NO_INSETS): View {
  return {
    scale: view.scale,
    x: insets.left + (viewport.width - insets.left - insets.right - content.width * view.scale) / 2,
    y: insets.top + (viewport.height - insets.top - insets.bottom - content.height * view.scale) / 2,
  };
}

/** What is left of the viewport once the insets and a margin are taken off. */
function freeSpace(viewport: Size, insets: Insets, padding: number): Size {
  return {
    width: Math.max(1, viewport.width - insets.left - insets.right - padding * 2),
    height: Math.max(1, viewport.height - insets.top - insets.bottom - padding * 2),
  };
}

/**
 * Scale by `factor` while holding `focus` (a point in viewport coordinates)
 * over the same spot of the content — the zoom every map expects, whether the
 * focus is the mouse pointer or the middle of the screen.
 */
export function zoomAt(view: View, factor: number, focus: Point): View {
  const scale = clampZoom(view.scale * factor);
  const applied = scale / view.scale; // what the clamp actually allowed
  return {
    scale,
    x: focus.x - (focus.x - view.x) * applied,
    y: focus.y - (focus.y - view.y) * applied,
  };
}

/**
 * Keep the content reachable, in terms of the free space rather than the whole
 * viewport: content that fits the gap between the panels is centred there, and
 * content bigger than the gap may be dragged until either of its edges reaches
 * the gap's. That last part is what lets rows hidden behind a panel be brought
 * out into the open — while still making it impossible to fling the board off
 * the screen entirely.
 */
export function clampView(view: View, content: Size, viewport: Size, insets: Insets = NO_INSETS): View {
  return {
    scale: view.scale,
    x: clampAxis(view.x, content.width * view.scale, insets.left, viewport.width - insets.right),
    y: clampAxis(view.y, content.height * view.scale, insets.top, viewport.height - insets.bottom),
  };
}

function clampAxis(offset: number, length: number, from: number, to: number): number {
  const free = to - from;
  if (length <= free) return from + (free - length) / 2;
  return Math.min(from, Math.max(to - length, offset));
}

/**
 * A wheel notch as a zoom factor. Trackpads report small continuous deltas and
 * mice one big jump, so the delta is capped before it becomes an exponent —
 * otherwise a single mouse notch would cross the whole zoom range.
 */
export function wheelZoomFactor(deltaY: number): number {
  const notches = Math.max(-3, Math.min(3, -deltaY / 100));
  return Math.pow(ZOOM_STEP, notches);
}
