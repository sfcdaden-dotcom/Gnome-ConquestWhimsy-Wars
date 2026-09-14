/**
 * A pan-and-zoom viewport: a fixed-size content box (a board, in practice)
 * that can be dragged around and scaled inside whatever space this component
 * is given, with the chrome around it left alone.
 *
 * The point is that only the content moves. Menus, palettes and HUD panels are
 * siblings layered over the viewport, not children of it, so zooming in on a
 * 13×13 board magnifies the board and nothing else.
 *
 * Interactions: drag to pan (wheel/trackpad or two fingers to zoom, pinch
 * included), the on-screen +/−/fit cluster, and +/−/0 on the keyboard. A drag
 * that actually moved swallows the click it would otherwise end with, so
 * dragging across a painted board never paints.
 *
 * The transform maths lives in `panZoom.ts`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { MAX_ZOOM, MIN_ZOOM, NO_INSETS, ZOOM_STEP, clampView, fitView, wheelZoomFactor, zoomAt } from './panZoom';
import type { Insets, Point, Size, View } from './panZoom';

/** Pointer travel (px) that turns a press into a pan rather than a click. */
const DRAG_THRESHOLD = 4;

export interface PanZoomProps {
  /** Natural pixel size of the content, before any zoom. */
  contentWidth: number;
  contentHeight: number;
  /** Extra class on the viewport element (the thing that clips and scrolls). */
  className?: string;
  /** Accessible name for the viewport region. */
  label: string;
  /**
   * Edges covered by chrome layered over this viewport. Fitting and centring
   * aim at what is left, so the whole board lands where it can be seen and
   * clicked rather than half of it under a panel.
   */
  insets?: Insets;
  /**
   * How far "fit" may ENLARGE the content to fill the free space (1 = never).
   * A board drawn at a fixed cell size would otherwise sit small in the middle
   * of a wide monitor with room going spare.
   */
  maxFitScale?: number;
  children: ReactNode;
}

export function PanZoom({
  contentWidth,
  contentHeight,
  className,
  label,
  insets = NO_INSETS,
  maxFitScale = 1,
  children,
}: PanZoomProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  const content: Size = { width: contentWidth, height: contentHeight };
  // Read inside pointer/wheel handlers that are registered once: those close
  // over the first render's values otherwise.
  const latest = useRef({ view, viewport, content, insets, maxFitScale });
  latest.current = { view, viewport, content, insets, maxFitScale };

  // Measure the space we were given. A viewport of zero size (first paint,
  // or a hidden tab) simply leaves the view where it is.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** True once the player has zoomed or panned: their view, not ours. */
  const steered = useRef(false);

  const fit = useCallback((manual = false) => {
    const { viewport: vp, content: c, insets: i, maxFitScale: max } = latest.current;
    if (manual) steered.current = false; // "fit" hands the view back to us
    setView(fitView(c, vp, i, undefined, max));
  }, []);

  // A different board is a different thing to look at, so it opens fitted
  // however the last one was left.
  useEffect(() => {
    steered.current = false;
    fit();
  }, [fit, contentWidth, contentHeight]);

  // The space around the board changes constantly — a window resize, the
  // palette wrapping, the action bar growing a row. Re-fit only while the view
  // is still ours; once the player has zoomed in somewhere, keep them there and
  // just hold the new bounds, or selecting a gnome would fling the board back.
  useEffect(() => {
    if (!steered.current) {
      fit();
      return;
    }
    // Read through the ref so this effect depends on the inset NUMBERS rather
    // than on the object identity a parent re-creates every render.
    const { content: c, viewport: vp, insets: i } = latest.current;
    setView((v) => clampView(v, c, vp, i));
  }, [
    fit,
    viewport.width,
    viewport.height,
    insets.top,
    insets.bottom,
    insets.left,
    insets.right,
    maxFitScale,
  ]);

  const zoomBy = useCallback((factor: number, focus?: Point) => {
    const { view: v, viewport: vp, content: c, insets: i } = latest.current;
    steered.current = true;
    const at = focus ?? { x: (i.left + vp.width - i.right) / 2, y: (i.top + vp.height - i.bottom) / 2 };
    setView(clampView(zoomAt(v, factor, at), c, vp, i));
  }, []);

  /** Viewport-local coordinates of a pointer event. */
  const localPoint = useCallback((clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  // Wheel has to be a manual listener: React's onWheel is passive, and a
  // passive handler may not preventDefault, so the page would scroll (or the
  // browser would zoom the whole UI) underneath us.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(wheelZoomFactor(e.deltaY), localPoint(e.clientX, e.clientY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy, localPoint]);

  /**
   * One press: window-level move/up listeners (so a drag survives leaving the
   * viewport) that only start panning once the pointer has travelled far
   * enough to mean it. Pointer capture is deliberately NOT used — capturing
   * would retarget the click away from the cell that was pressed.
   */
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    const startClient = { x: e.clientX, y: e.clientY };
    const startView = latest.current.view;
    let dragging = false;

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== e.pointerId) return;
      const dx = move.clientX - startClient.x;
      const dy = move.clientY - startClient.y;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        steered.current = true;
        setPanning(true);
      }
      move.preventDefault();
      const { viewport: vp, content: c, insets: i } = latest.current;
      setView(clampView({ scale: startView.scale, x: startView.x + dx, y: startView.y + dy }, c, vp, i));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!dragging) return;
      setPanning(false);
      // Swallow the click this drag ends with, so releasing over a cell after
      // dragging across the board does not also paint it. The listener is
      // dropped on the next tick either way, so a drag that ends without a
      // click (released off-window) never eats someone else's.
      const swallow = (click: MouseEvent) => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // Pinch: two touch points, tracked here rather than in the press handler
  // above because a pinch is about the pair, not either finger.
  const pinch = useRef<Map<number, Point>>(new Map());

  function onTouchPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'touch') return;
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function onTouchPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'touch' || pinch.current.size < 2) return;
    const before = [...pinch.current.values()];
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = [...pinch.current.values()];
    const spread = (pts: Point[]) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const wasApart = spread(before);
    const isApart = spread(after);
    if (wasApart <= 0 || isApart <= 0) return;
    const mid = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
    zoomBy(isApart / wasApart, localPoint(mid.x, mid.y));
  }

  function endTouchPointer(e: ReactPointerEvent<HTMLDivElement>) {
    pinch.current.delete(e.pointerId);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // typing in a control, not steering the board
    if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_STEP);
    else if (e.key === '0') fit(true);
    else return;
    e.preventDefault();
  }

  const percent = Math.round(view.scale * 100);

  return (
    <div
      ref={viewportRef}
      className={`panzoom${className ? ` ${className}` : ''}`}
      // The controls sit inside the free space too, so they are not parked
      // under whatever covers the viewport's edge.
      style={
        {
          '--pz-inset-top': `${insets.top}px`,
          '--pz-inset-right': `${insets.right}px`,
          '--pz-inset-bottom': `${insets.bottom}px`,
          '--pz-inset-left': `${insets.left}px`,
        } as CSSProperties
      }
      data-panning={panning}
      role="region"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        onTouchPointerDown(e);
        onPointerDown(e);
      }}
      onPointerMove={onTouchPointerMove}
      onPointerUp={endTouchPointer}
      onPointerCancel={endTouchPointer}
    >
      <div
        className="panzoom-content"
        style={
          {
            width: `${contentWidth}px`,
            height: `${contentHeight}px`,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          } as CSSProperties
        }
      >
        {children}
      </div>

      <div className="panzoom-controls" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn small"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={view.scale <= MIN_ZOOM}
          aria-label="Zoom out"
          title="Zoom out (−)"
        >
          −
        </button>
        <span className="panzoom-level" aria-live="off">
          {percent}%
        </span>
        <button
          type="button"
          className="btn small"
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={view.scale >= MAX_ZOOM}
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          +
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => fit(true)}
          aria-label="Fit board to screen"
          title="Fit to screen (0)"
        >
          ⤢
        </button>
      </div>
    </div>
  );
}
