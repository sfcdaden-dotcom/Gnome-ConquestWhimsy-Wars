import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '../engine';
import type { RoomSnapshot, SeatInfo } from '../net/protocol';
import { blockerAction, blockerText, canStart, lobbyBlocker } from './lobbyStatus';

function seat(index: number, over: Partial<SeatInfo> = {}): SeatInfo {
  return {
    index,
    name: ['Rose', 'Thistle', 'Marigold', 'Bramble'][index],
    controller: 'human',
    difficulty: 'normal',
    appearance: { palette: PALETTE_IDS[index], cap: 'pointy', beard: 'bushy', weapon: 'shovel', accessory: 'none' },
    connected: true,
    takenOver: false,
    ...over,
  };
}

function room(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    protocol: 1,
    code: 'ABC123',
    phase: 'lobby',
    seats: [seat(0), seat(1)],
    hostSeat: 0,
    hasHost: true,
    hostGrace: null,
    boardSize: 7,
    gardenPreset: 'random',
    commitment: null,
    spectators: 0,
    ...over,
  };
}

describe('what the lobby is waiting for', () => {
  it('names the empty seat rather than the host', () => {
    const blocker = lobbyBlocker(room({ seats: [seat(0), seat(1, { connected: false })] }));
    expect(blocker).toEqual({ kind: 'seats', seats: [2] });
    expect(canStart(blocker)).toBe(false);
  });

  it('waits on the host once every seat is filled', () => {
    const blocker = lobbyBlocker(room());
    expect(blocker).toEqual({ kind: 'host', hostName: 'Rose' });
    expect(canStart(blocker)).toBe(true);
  });

  it('does not count CPU seats as empty', () => {
    const seats = [seat(0), seat(1, { controller: 'cpu', connected: false })];
    expect(lobbyBlocker(room({ seats }))).toEqual({ kind: 'host', hostName: 'Rose' });
  });

  it('lists every empty seat, not just the first', () => {
    const seats = [seat(0), seat(1, { connected: false }), seat(2, { connected: false }), seat(3)];
    expect(lobbyBlocker(room({ seats }))).toEqual({ kind: 'seats', seats: [2, 3] });
  });

  // The whole point of the module: the room describes its own state, so the
  // host and the guest are never reading two different stories.
  it('tells the host and the guest exactly the same thing', () => {
    const snapshot = room({ seats: [seat(0), seat(1, { connected: false })] });
    const blocker = lobbyBlocker(snapshot);
    expect(blockerText(blocker)).toBe('Waiting for a player to sit down in seat 2.');
    // Same sentence for both; only the instruction differs.
    expect(blockerAction(blocker, true)).toContain('switch seat 2 to CPU');
    expect(blockerAction(blocker, false)).toBeNull();
  });

  it('says the host is missing only when nobody holds the room', () => {
    // A host who took a CPU seat is spectating, not gone.
    expect(lobbyBlocker(room({ hostSeat: null, hasHost: true }))).toEqual({
      kind: 'host',
      hostName: null,
    });
    expect(lobbyBlocker(room({ hostSeat: null, hasHost: false }))).toEqual({ kind: 'hostless' });
  });

  it('reads as a sentence in every case', () => {
    expect(blockerText({ kind: 'seats', seats: [2] })).toBe(
      'Waiting for a player to sit down in seat 2.',
    );
    expect(blockerText({ kind: 'seats', seats: [2, 3] })).toBe(
      'Waiting for players to sit down in seat 2 and 3.',
    );
    expect(blockerText({ kind: 'host', hostName: 'Rose' })).toBe(
      'Everyone is here. Waiting for Rose to start the game.',
    );
    expect(blockerText({ kind: 'host', hostName: null })).toBe(
      'Everyone is here. Waiting for the host to start the game.',
    );
    expect(blockerText({ kind: 'hostless' })).toBe('The host left this room.');
  });
});
