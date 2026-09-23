/**
 * The seat colours live in two places on purpose: PLAYER_COLORS in meta.ts is
 * what the game paints with (the gnome compositor needs hex in JS), and the
 * `--color-player-*` tokens in index.css are the same colours for CSS. Nothing
 * but this test ties them together.
 */

/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS, PLAYER_COLOR_NAMES } from './meta';

// Read off disk: Vitest blanks CSS modules, `?raw` included.
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

function rootToken(name: string): string | undefined {
  // The first :root block is the light theme, where every token is defined.
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  return root.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
}

describe('theme tokens', () => {
  it('mirror PLAYER_COLORS in the --color-player-* tokens', () => {
    PLAYER_COLOR_NAMES.forEach((name, i) => {
      expect(rootToken(`--color-player-${name.toLowerCase()}`), name).toBe(PLAYER_COLORS[i]);
    });
  });

  it('redefine every colour token for the dark theme, in both places', () => {
    const colours = [...css.slice(0, css.indexOf('@media')).matchAll(/^\s*(--color-[\w-]+):/gm)].map((m) => m[1]);
    const media = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf(":root[data-theme='dark']"));
    const pinned = css.slice(css.indexOf(":root[data-theme='dark']"), css.indexOf(":root[data-theme='light']"));
    // Seat colours are deliberately the same in both themes.
    for (const c of colours.filter((c) => !c.startsWith('--color-player-'))) {
      expect(media, c).toContain(`${c}:`);
      expect(pinned, c).toContain(`${c}:`);
    }
  });
});
