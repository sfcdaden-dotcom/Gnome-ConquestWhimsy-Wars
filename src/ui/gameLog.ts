/**
 * The game log's windowing rules, kept out of the component so they can be
 * tested without a DOM.
 *
 * Two problems live here, and both come from `state.events` being a *rolling*
 * window (the engine trims to the last 1000) rather than the whole history:
 * a line's array index is not its identity, and neither is a scroll position
 * measured against a list that shifts underneath it.
 */

import type { GameEvent, GameState } from '../engine';

/** How many of the most recent events the log renders. */
export const LOG_WINDOW = 250;

export interface LogLine {
  /**
   * The event's ordinal in the whole match — `eventCount` counts every event
   * ever emitted and is never trimmed, so this is stable even after the window
   * slides. Array indices are not: line #3 today is line #2 after one trim,
   * which hands React a key that means a different line than it did last
   * render.
   */
  key: number;
  ev: GameEvent;
}

/** The last `LOG_WINDOW` events, each tagged with its match-wide ordinal. */
export function logLines(state: GameState): LogLine[] {
  const start = Math.max(0, state.events.length - LOG_WINDOW);
  // The first event still in the window is this far into the match.
  const firstOrdinal = state.eventCount - state.events.length;
  const out: LogLine[] = [];
  for (let i = start; i < state.events.length; i++) {
    out.push({ key: firstOrdinal + i, ev: state.events[i] });
  }
  return out;
}

/** What `isPinnedToBottom` needs from a scroller — an element supplies all three. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How far from the bottom still counts as "at the bottom". A line is ~16px, so
 * this forgives sub-pixel scroll positions and a browser that lands a hair
 * short, without forgiving a deliberate scroll away.
 */
const PIN_SLACK_PX = 24;

/**
 * True when the scroller is at (or within a hair of) its bottom.
 *
 * The log auto-scrolls on every new event, which is right up until the moment
 * someone scrolls back to read what just happened — then it yanks them away
 * mid-sentence. So it follows the tail only while they are already watching
 * the tail.
 */
export function isPinnedToBottom(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= PIN_SLACK_PX;
}
