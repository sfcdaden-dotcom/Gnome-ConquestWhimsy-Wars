/**
 * Two small hooks for laying one thing out around another: what size an
 * element currently is, and whether a media query matches.
 *
 * Both exist because the pan-and-zoom stages fit their board into the space
 * the surrounding chrome leaves, and that space is not a constant — the
 * editor's palette wraps with the window, the game's side panels are a `clamp`
 * of the viewport width, and below 1080px the whole layout stacks and there is
 * no chrome over the board at all.
 */

import { useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export interface Box {
  width: number;
  height: number;
}

const NO_BOX: Box = { width: 0, height: 0 };

/** The element's current border-box size, tracked as it changes. */
export function useSize(ref: RefObject<HTMLElement | null>): Box {
  const [box, setBox] = useState<Box>(NO_BOX);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setBox(NO_BOX); // the element went away (a panel that stopped rendering)
      return;
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setBox((prev) => (prev.width === rect.width && prev.height === rect.height ? prev : { width: rect.width, height: rect.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/** Whether `query` matches right now. False anywhere `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query);
    if (!mql) return;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
