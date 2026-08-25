import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState } from '../engine';
import { LOG_WINDOW, isPinnedToBottom, logLines } from './gameLog';

/** Just enough state for the log: a window of events and the match-wide count. */
function stateWith(events: GameEvent[], eventCount = events.length): GameState {
  return { events, eventCount } as unknown as GameState;
}

function turnEvents(n: number, from = 0): GameEvent[] {
  return Array.from(
    { length: n },
    (_, i) => ({ type: 'turnStarted', player: 0, turnNumber: from + i }) as GameEvent,
  );
}

describe('logLines', () => {
  it('returns every event of a short game, keyed by ordinal', () => {
    const lines = logLines(stateWith(turnEvents(3)));
    expect(lines.map((l) => l.key)).toEqual([0, 1, 2]);
  });

  it('renders only the last LOG_WINDOW events', () => {
    const lines = logLines(stateWith(turnEvents(LOG_WINDOW + 40)));
    expect(lines).toHaveLength(LOG_WINDOW);
    expect(lines[0].key).toBe(40);
  });

  it('gives an event the same key before and after the window slides past it', () => {
    // Turn 500's event, first as the last line of a 3-line window...
    const early = logLines(stateWith(turnEvents(3, 498), 501));
    // ...then, 200 events later, as the first line of a window the engine trimmed.
    const late = logLines(stateWith(turnEvents(200, 500), 700));
    expect(early[early.length - 1].key).toBe(500);
    expect(late[0].key).toBe(500);
  });

  it('is empty before anything has happened', () => {
    expect(logLines(stateWith([]))).toEqual([]);
  });
});

describe('isPinnedToBottom', () => {
  it('is true at the bottom, and a hair short of it', () => {
    expect(isPinnedToBottom({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 })).toBe(true);
    expect(isPinnedToBottom({ scrollTop: 390, scrollHeight: 600, clientHeight: 200 })).toBe(true);
  });

  it('is false once the reader has scrolled away', () => {
    expect(isPinnedToBottom({ scrollTop: 200, scrollHeight: 600, clientHeight: 200 })).toBe(false);
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 600, clientHeight: 200 })).toBe(false);
  });

  it('is true when there is nothing to scroll', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true);
  });
});
