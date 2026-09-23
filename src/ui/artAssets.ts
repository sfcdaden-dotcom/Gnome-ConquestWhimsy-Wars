/**
 * The game's picture assets: one map from garden type to file, one from unit
 * kind to file, and one from interface icon to file.
 *
 * Gardens and units used to be emoji, which meant the board looked like a
 * different game on every platform (and like nothing at all where a glyph was
 * missing). The art is drawn by hand instead, and imported here so Vite hashes
 * and inlines it like any other asset.
 *
 * This file is the only place a game type is tied to a filename: swapping a
 * picture is dropping a new file into `src/assets/art/` under the same name,
 * and renaming one (or moving to SVG/WebP) is a one-line edit here. See the
 * Art section in README.md for what the drawings have to survive.
 *
 * `art.tsx` next door renders these; keeping the imports separate from the
 * components is what lets a module either be all-components (fast refresh) or
 * plain data, and never half of each.
 */

import type { GardenType, UnitKind } from '../engine';
import type { UiIconKind } from './uiIcons';

import gardenHome from '../assets/art/Gardens/garden-home.png';
import gardenDandelion from '../assets/art/Gardens/garden-dandelion.png';
import gardenMushroom from '../assets/art/Gardens/garden-mushroom.png';
import gardenFlytrap from '../assets/art/Gardens/garden-flytrap.png';
import gardenMaize from '../assets/art/Gardens/garden-maize.png';
import gardenSlippery from '../assets/art/Gardens/garden-slippery.png';
import gardenTunnel from '../assets/art/Gardens/garden-tunnel.png';
import unitGnome from '../assets/art/unit-gnome.png';
import unitSnail from '../assets/art/unit-snail.png';
import uiWish from '../assets/art/ui-wish.png';
import uiReinforcement from '../assets/art/ui-reinforcement.png';
import uiCard from '../assets/art/ui-card.png';
import uiPlant from '../assets/art/ui-sapling.png';

export const GARDEN_ART: Record<GardenType, string> = {
  home: gardenHome,
  dandelion: gardenDandelion,
  mushroom: gardenMushroom,
  flytrap: gardenFlytrap,
  maize: gardenMaize,
  slippery: gardenSlippery,
  tunnel: gardenTunnel,
};

export const UNIT_ART: Record<UnitKind, string> = {
  gnome: unitGnome,
  snail: unitSnail,
};

/** Resource and action icons — see uiIcons.ts for what each one means. */
export const UI_ICON_ART: Record<UiIconKind, string> = {
  wish: uiWish,
  reinforcement: uiReinforcement,
  card: uiCard,
  plant: uiPlant,
};
