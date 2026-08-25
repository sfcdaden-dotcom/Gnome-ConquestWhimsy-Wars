/**
 * What a lobby is waiting for, worked out once and rendered the same way for
 * everyone in the room.
 *
 * This exists because the two sides used to answer the question separately and
 * disagreed. The host's start button said "Waiting for seat 2…" whenever a
 * human seat was empty; the guest's line said "Waiting for Rose to start…"
 * whenever they were not the host. Both are true sentences about different
 * facts, and a room with an empty seat showed one of each — so both players
 * read "the other one has to do something" and nobody did anything.
 *
 * So the blocker is a property of the ROOM, not of who is looking at it.
 * Everybody is told the same thing is missing. What differs by viewer is only
 * whether they are the one who can fix it, which is `blockerAction`.
 */

import type { RoomSnapshot } from '../net/protocol';

/** The one thing standing between this lobby and a dealt game. */
export type LobbyBlocker =
  /** Human seats nobody is sitting in. Seat numbers are 1-based, for people. */
  | { kind: 'seats'; seats: number[] }
  /** Everyone is here; the host has not pressed start. */
  | { kind: 'host'; hostName: string | null }
  /** The room has no host at all — they left and nobody has taken over. */
  | { kind: 'hostless' };

/**
 * What the room is waiting for.
 *
 * Order matters: an empty seat outranks the host, because a host who cannot
 * start yet is not the blocker — the missing player is. Getting this backwards
 * is what produced the original bug.
 */
export function lobbyBlocker(room: RoomSnapshot): LobbyBlocker {
  const empty = room.seats
    .filter((s) => s.controller === 'human' && !s.connected)
    .map((s) => s.index + 1);
  if (empty.length > 0) return { kind: 'seats', seats: empty };
  if (room.hostSeat === null && !room.hasHost) return { kind: 'hostless' };
  return { kind: 'host', hostName: hostName(room) };
}

/** The host's display name, when they hold a seat. Spectating hosts have none. */
function hostName(room: RoomSnapshot): string | null {
  if (room.hostSeat === null) return null;
  return room.seats[room.hostSeat]?.name ?? null;
}

/**
 * The shared sentence. Identical on every screen in the room, including the
 * host's — the host reads the same description of the situation everyone else
 * does, and gets their instructions from `blockerAction` instead.
 */
export function blockerText(blocker: LobbyBlocker): string {
  switch (blocker.kind) {
    case 'seats': {
      const list = blocker.seats.join(' and ');
      const plural = blocker.seats.length > 1;
      return `Waiting for ${plural ? 'players' : 'a player'} to sit down in seat ${list}.`;
    }
    case 'host':
      return blocker.hostName === null
        ? 'Everyone is here. Waiting for the host to start the game.'
        : `Everyone is here. Waiting for ${blocker.hostName} to start the game.`;
    case 'hostless':
      return 'The host left this room.';
  }
}

/**
 * What the viewer can do about it, or null when the answer is "wait". Only the
 * person who can act is given an instruction, which is the entire difference
 * between the two screens.
 */
export function blockerAction(blocker: LobbyBlocker, isHost: boolean): string | null {
  if (!isHost) return null;
  switch (blocker.kind) {
    case 'seats':
      return `Share the code so they can join — or switch seat ${blocker.seats.join(' and ')} to CPU to play without them.`;
    case 'host':
      return null; // the start button is the instruction
    case 'hostless':
      return null;
  }
}

/** Can the game be dealt right now? */
export function canStart(blocker: LobbyBlocker): boolean {
  return blocker.kind === 'host';
}
