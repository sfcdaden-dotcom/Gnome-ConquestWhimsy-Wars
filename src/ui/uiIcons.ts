/**
 * The interface icons: the game's resources and its commonest actions, drawn
 * to match the board art instead of borrowed from the platform's emoji font.
 *
 * Each kind has ONE meaning. The emoji they replace were overloaded — `✨` was
 * the Wish resource in one place and decoration in the next, `🌱` meant both
 * "plant a garden" and "let's go" — so an icon is used only where it stands
 * for exactly the thing named here, never as a flourish.
 *
 * This module is plain data (no image imports), so text-only code such as the
 * log and action descriptions in meta.ts can use the glyph fallbacks without
 * pulling pictures along. The files themselves are mapped in artAssets.ts and
 * drawn by `<UiIcon>` in art.tsx.
 */

export type UiIconKind = 'wish' | 'reinforcement' | 'card' | 'plant';

export const UI_ICON_KINDS: readonly UiIconKind[] = ['wish', 'reinforcement', 'card', 'plant'];

/** What the icon stands for — its accessible name where it has no visible label. */
export const UI_ICON_LABEL: Record<UiIconKind, string> = {
  wish: 'Wishes',
  reinforcement: 'Reserve gnomes',
  card: 'Cards',
  plant: 'Plant a garden',
};

/**
 * The stand-in for plain-text contexts (log lines, generated labels), which
 * cannot hold a picture. Kept to the emoji each icon replaced, so a string
 * reads the same as it always did.
 */
export const UI_ICON_GLYPH: Record<UiIconKind, string> = {
  wish: '✨',
  reinforcement: '📦',
  card: '🃏',
  plant: '🌱',
};
