/**
 * The game's picture assets: one map from garden type to file, one from unit
 * kind to file.
 *
 * Gardens and units used to be emoji, which meant the board looked like a
 * different game on every platform (and like nothing at all where a glyph was
 * missing). The art is drawn by hand instead — see `tools/art/generate.py`,
 * which renders every file in `src/assets/art/` — and imported here so Vite
 * hashes and inlines it like any other asset.
 *
 * `art.tsx` next door renders these; keeping the imports separate from the
 * components is what lets a module either be all-components (fast refresh) or
 * plain data, and never half of each.
 */

import type { GardenType, UnitKind } from '../engine';

import gardenHome from '../assets/art/garden-home.png';
import gardenDandelion from '../assets/art/garden-dandelion.png';
import gardenMushroom from '../assets/art/garden-mushroom.png';
import gardenFlytrap from '../assets/art/garden-flytrap.png';
import gardenMaize from '../assets/art/garden-maize.png';
import gardenSlippery from '../assets/art/garden-slippery.png';
import gardenTunnel from '../assets/art/garden-tunnel.png';
import unitGnome from '../assets/art/unit-gnome.png';
import unitSnail from '../assets/art/unit-snail.png';

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
