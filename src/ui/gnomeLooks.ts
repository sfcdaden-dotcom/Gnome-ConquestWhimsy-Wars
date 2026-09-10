/**
 * Where a screen finds out what each seat's gnome looks like.
 *
 * Looks are cosmetic and live entirely outside the engine, so there is no
 * `state.players[i].look` to read them from. They arrive from two different
 * places — the setup screen for a local game, the room snapshot for an online
 * one — and are then wanted by roughly every component that draws a gnome, at
 * every depth. That is what a context is for; the alternative was threading a
 * `looks` prop through Board, panels, DecisionPanel and GameScreen purely to
 * pass it on.
 *
 * An empty context is the honest default: `UnitIcon` falls back to the stock
 * `unit-gnome.png` for any seat it has no look for, so a screen that never
 * provides one (the rules, the home screen) keeps working untouched.
 */

import { createContext, useContext } from 'react';
import type { GnomeLook } from './gnomeLook';

/** Looks by seat index. A missing entry means "draw the stock gnome". */
export type SeatLooks = ReadonlyArray<GnomeLook | undefined>;

export const GnomeLooksContext = createContext<SeatLooks>([]);

export function useSeatLooks(): SeatLooks {
  return useContext(GnomeLooksContext);
}

export function useSeatLook(seatId: number | undefined): GnomeLook | undefined {
  const looks = useContext(GnomeLooksContext);
  return seatId === undefined ? undefined : looks[seatId];
}
