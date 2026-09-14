/**
 * How big a board is drawn, in pixels, before any zoom.
 *
 * Both boards — the game's and the preset editor's — sit on a pan-and-zoom
 * stage (PanZoom.tsx) that needs a content box of a known size, and both draw
 * a cell at the same fixed size whatever the board size, so that a 13×13 is a
 * BIGGER board rather than one with smaller squares. The numbers match
 * `.board`'s own padding and gap in index.css, so the box handed to the stage
 * is exactly what the grid renders.
 */

/** Rendered size of one cell at zoom 1. */
export const CELL_PX = 64;
const BOARD_PADDING_PX = 8;
const BOARD_GAP_PX = 3;

export function boardPixelSize(boardSize: number): number {
  return boardSize * CELL_PX + (boardSize - 1) * BOARD_GAP_PX + BOARD_PADDING_PX * 2;
}
