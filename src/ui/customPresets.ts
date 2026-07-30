/**
 * Player-authored garden presets: built in the in-game editor, kept only in
 * memory for the current session, and saved/loaded as standalone .json files
 * (never localStorage — see DEPLOYMENT.md's "no local storage" posture).
 *
 * The file FORMAT itself lives in the engine (`engine/presetFile.ts`), because
 * the same files also ship as built-in presets when dropped into
 * `src/engine/presets/`. What is left here is the browser half: minting
 * session ids, naming, and the download itself.
 */

import type { GardenPresetDef } from '../engine';
import { toPresetFile, parsePresetFile } from '../engine';

/** Fixed board size the in-game editor designs for (matches the engine default). */
export const CUSTOM_EDITOR_BOARD_SIZE = 7;

export {
  PRESET_LABEL_MAX_LENGTH,
  PRESET_DESCRIPTION_MAX_LENGTH,
  reservedHomePositions,
  validatePresetLayout as validateCustomPresetLayout,
  presetDefFromLayout as buildCustomPresetDef,
} from '../engine';
export type { ValidatedPresetLayout, PresetLayoutValidation } from '../engine';

/**
 * Layouts played straight out of the editor need not be named, so they are
 * numbered instead — "Unnamed preset 1", "Unnamed preset 2", … — which keeps
 * two of them apart in the setup dropdown.
 */
export const UNNAMED_PRESET_PREFIX = 'Unnamed preset';

const UNNAMED_PRESET_PATTERN = new RegExp(`^${UNNAMED_PRESET_PREFIX} (\\d+)$`);

/** The next free "Unnamed preset N", counting past whatever is already listed. */
export function nextUnnamedPresetLabel(existing: ReadonlyArray<{ label: string }>): string {
  let highest = 0;
  for (const { label } of existing) {
    const n = Number(UNNAMED_PRESET_PATTERN.exec(label.trim())?.[1]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `${UNNAMED_PRESET_PREFIX} ${highest + 1}`;
}

export function makeCustomPresetId(): string {
  return `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse an imported file into a session preset (a fresh `custom:` id each time). */
export function parseCustomPresetFile(raw: string): GardenPresetDef {
  return parsePresetFile(raw, makeCustomPresetId());
}

/**
 * Trigger a browser download of a preset as a standalone .json file. The
 * filename doubles as the preset id if the file is later dropped into
 * `src/engine/presets/` (see gardenPresets.ts), so it is slugified from the
 * label rather than the session id.
 */
export function downloadCustomPreset(def: GardenPresetDef, boardSize: number): void {
  const blob = new Blob([JSON.stringify(toPresetFile(def, boardSize), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(def.label)}.whimsy-preset.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function slugify(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'custom-preset';
}
