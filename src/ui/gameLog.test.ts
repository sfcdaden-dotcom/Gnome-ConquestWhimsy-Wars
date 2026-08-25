import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState } from '../engine';
import { LOG_WINDOW, groupByTurn, isPinnedToBottom, logLines } from './gameLog';

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

describe('groupByTurn', () => {
  const turnStart = (turnNumber: number, player: number) =>
    ({ type: 'turnStarted', player, turnNumber }) as GameEvent;
  const line = (n: number) => ({ type: 'actionPhaseStarted', player: n }) as GameEvent;

  it('puts each turn under its own header, and drops the header from the lines', () => {
    const events = [turnStart(1, 0), line(0), line(0), turnStart(2, 1), line(1)];
    const turns = groupByTurn(logLines(stateWith(events)));
    expect(turns.map((t) => [t.turnNumber, t.player, t.lines.length])).toEqual([
      [1, 0, 2],
      [2, 1, 1],
    ]);
    expect(turns.flatMap((t) => t.lines).some((l) => l.ev.type === 'turnStarted')).toBe(false);
  });

  it('keeps a turn that produced no lines of its own', () => {
    const turns = groupByTurn(logLines(stateWith([turnStart(1, 0), turnStart(2, 1), line(1)])));
    expect(turns).toHaveLength(2);
    expect(turns[0].lines).toEqual([]);
  });

  it('labels the pre-turn lines as the match start when they are the match start', () => {
    const turns = groupByTurn(logLines(stateWith([line(0), turnStart(1, 0)])));
    expect(turns[0].turnNumber).toBeNull();
    expect(turns[0].matchStart).toBe(true);
  });

  it('does not claim the match start for a turn whose header was trimmed away', () => {
    // The window opens mid-turn: 40 events were trimmed before line #40.
    const turns = groupByTurn(logLines(stateWith([line(0), turnStart(9, 1)], 42)));
    expect(turns[0].turnNumber).toBeNull();
    expect(turns[0].matchStart).toBe(false);
  });

  it('keys every group distinctly, so React never reuses one turn for another', () => {
    const events = [line(0), turnStart(1, 0), turnStart(2, 1), turnStart(3, 0)];
    const keys = groupByTurn(logLines(stateWith(events))).map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is empty for an empty log', () => {
    expect(groupByTurn([])).toEqual([]);
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
