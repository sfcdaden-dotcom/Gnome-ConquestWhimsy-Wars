/**
 * The art tables are exhaustive by type, but TypeScript only checks that a key
 * EXISTS — it cannot see that two gardens point at the same drawing, or that a
 * file went missing after a rename. These tests cover exactly that gap.
 */

import { describe, expect, it } from 'vitest';
import { PLANTABLE_GARDEN_TYPES } from '../engine';
import type { GardenType, UnitKind } from '../engine';
import { GARDEN_ART, UI_ICON_ART, UNIT_ART } from './artAssets';
import { UI_ICON_GLYPH, UI_ICON_KINDS, UI_ICON_LABEL } from './uiIcons';

const GARDEN_TYPES: GardenType[] = ['home', ...PLANTABLE_GARDEN_TYPES];
const UNIT_KINDS: UnitKind[] = ['gnome', 'snail'];

describe('art assets', () => {
  it('has a picture for every garden type', () => {
    for (const type of GARDEN_TYPES) {
      expect(GARDEN_ART[type], type).toBeTruthy();
    }
    expect(Object.keys(GARDEN_ART).sort()).toEqual([...GARDEN_TYPES].sort());
  });

  it('has a picture for every unit kind', () => {
    for (const kind of UNIT_KINDS) {
      expect(UNIT_ART[kind], kind).toBeTruthy();
    }
    expect(Object.keys(UNIT_ART).sort()).toEqual([...UNIT_KINDS].sort());
  });

  it('has a picture, a label and a text fallback for every interface icon', () => {
    for (const kind of UI_ICON_KINDS) {
      expect(UI_ICON_ART[kind], kind).toBeTruthy();
      expect(UI_ICON_LABEL[kind], kind).toBeTruthy();
      expect(UI_ICON_GLYPH[kind], kind).toBeTruthy();
    }
    expect(Object.keys(UI_ICON_ART).sort()).toEqual([...UI_ICON_KINDS].sort());
  });

  it('never shows two things the same picture', () => {
    const all = [...Object.values(GARDEN_ART), ...Object.values(UNIT_ART), ...Object.values(UI_ICON_ART)];
    expect(new Set(all).size).toBe(all.length);
  });
});
