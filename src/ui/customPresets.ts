/**
 * Player-authored garden presets: built in the in-game editor, kept only in
 * memory for the current session, and saved/loaded as standalone .json files
 * (never localStorage — see DEPLOYMENT.md's "no local storage" posture).
 *
 * A custom preset is shaped exactly like a `GardenPresetDef` (see
 * `engine/gardenPresets.ts`) so the setup UI can treat built-in and custom
 * presets identically; it's just never added to the built-in registry.
 */

import type { GardenPresetDef, PlantableGardenType, Pos } from '../engine';
import { PLANTABLE_GARDEN_TYPES, posKey } from '../engine';

/** Fixed board size the in-game editor designs for (matches the engine default). */
export const CUSTOM_EDITOR_BOARD_SIZE = 7;

/** The four edge-midpoint spaces reserved for Home Gardens (any seating). */
export function reservedHomePositions(boardSize: number): Pos[] {
  const c = (boardSize - 1) / 2;
  return [
    { x: 0, y: c },
    { x: c, y: 0 },
    { x: boardSize - 1, y: c },
    { x: c, y: boardSize - 1 },
  ];
}

const CUSTOM_PRESET_FILE_KIND = 'whimsy-wars-garden-preset';
/** v1: gardens only, homes fixed at the standard formula. v2: added movable `homes`. */
const CUSTOM_PRESET_FILE_VERSION = 2;

/** Shared with the editor's `<input maxLength>` so imported files can't carry oversized text. */
export const PRESET_LABEL_MAX_LENGTH = 40;
export const PRESET_DESCRIPTION_MAX_LENGTH = 120;

/** Name given to a layout played straight out of the editor without being saved. */
export const UNTITLED_CUSTOM_PRESET_LABEL = 'Custom layout';

interface CustomPresetFile {
  kind: typeof CUSTOM_PRESET_FILE_KIND;
  version: number;
  label: string;
  description: string;
  boardSize: number;
  /** 4 positions, seat order west/north/east/south by convention. Absent in v1 files. */
  homes?: Pos[];
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>;
}

export function makeCustomPresetId(): string {
  return `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build the `GardenPresetDef` the setup screen renders/uses for a freshly-edited layout. */
export function buildCustomPresetDef(
  id: string,
  label: string,
  description: string,
  boardSize: number,
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>,
  homes: Pos[],
): GardenPresetDef {
  return {
    id,
    label,
    description: description.trim() || 'A custom garden layout.',
    minBoardSize: boardSize,
    build: () => gardens,
    homes,
  };
}

/** Trigger a browser download of a custom preset as a standalone .json file. */
export function downloadCustomPreset(def: GardenPresetDef, boardSize: number): void {
  const file: CustomPresetFile = {
    kind: CUSTOM_PRESET_FILE_KIND,
    version: CUSTOM_PRESET_FILE_VERSION,
    label: def.label,
    description: def.description,
    boardSize,
    homes: def.homes ?? reservedHomePositions(boardSize),
    gardens: def.build(boardSize),
  };
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
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

/** A validated layout, ready to hand to `buildCustomPresetDef`. */
export interface ValidatedPresetLayout {
  homes: Pos[];
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>;
}

export type PresetLayoutValidation = { ok: true; layout: ValidatedPresetLayout } | { ok: false; error: string };

/**
 * The one place a garden layout is checked: exactly 4 in-bounds Home Gardens
 * on distinct spaces, and gardens that are in bounds, of a plantable type, one
 * per space, and never on top of a home.
 *
 * Takes `unknown` because it also vets imported files, whose contents are
 * untyped until they've been through here; on success it hands back the
 * narrowed, copied positions so callers never re-walk the input.
 */
export function validateCustomPresetLayout(
  boardSize: number,
  homesRaw: unknown,
  gardensRaw: unknown,
): PresetLayoutValidation {
  const fail = (error: string): PresetLayoutValidation => ({ ok: false, error });

  const inBounds = (pos: unknown): pos is Pos => {
    const p = pos as Partial<Pos> | null | undefined;
    return (
      !!p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x! >= 0 && p.y! >= 0 && p.x! < boardSize && p.y! < boardSize
    );
  };

  if (!Array.isArray(gardensRaw)) return fail('The preset has no garden layout.');
  if (!Array.isArray(homesRaw) || homesRaw.length !== 4) {
    return fail('The preset must have exactly 4 Home Garden positions.');
  }

  const homeKeys = new Set<string>();
  const homes: Pos[] = [];
  for (const pos of homesRaw) {
    if (!inBounds(pos)) return fail('The preset has a Home Garden outside the board.');
    const key = posKey(pos);
    if (homeKeys.has(key)) return fail(`The preset has more than one Home Garden at ${key}.`);
    homeKeys.add(key);
    homes.push({ x: pos.x, y: pos.y });
  }

  const plantable = new Set<string>(PLANTABLE_GARDEN_TYPES);
  const seen = new Set<string>();
  const gardens: Array<{ pos: Pos; type: PlantableGardenType }> = [];
  for (const g of gardensRaw) {
    const pos = (g as { pos?: unknown } | null)?.pos;
    const type = (g as { type?: unknown } | null)?.type;
    if (!inBounds(pos)) return fail('The preset has a garden outside the board.');
    if (typeof type !== 'string' || !plantable.has(type)) {
      return fail(`The preset has an unknown garden type "${String(type)}".`);
    }
    const key = posKey(pos);
    if (homeKeys.has(key)) return fail(`The preset places a garden on a Home Garden space (${key}).`);
    if (seen.has(key)) return fail(`The preset has more than one garden at ${key}.`);
    seen.add(key);
    gardens.push({ pos: { x: pos.x, y: pos.y }, type: type as PlantableGardenType });
  }

  return { ok: true, layout: { homes, gardens } };
}

/** Parse+validate an imported preset file. Throws a human-readable Error on anything malformed. */
export function parseCustomPresetFile(raw: string): GardenPresetDef {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (typeof data !== 'object' || data === null) throw new Error('That file is not a garden preset.');
  const f = data as Partial<CustomPresetFile>;
  if (f.kind !== CUSTOM_PRESET_FILE_KIND) throw new Error('That file is not a Whimsy Wars garden preset.');
  if (typeof f.version !== 'number' || f.version > CUSTOM_PRESET_FILE_VERSION) {
    throw new Error('That preset was saved by a newer version of Whimsy Wars.');
  }
  if (typeof f.label !== 'string' || f.label.trim() === '') throw new Error('The preset has no name.');
  if (typeof f.boardSize !== 'number' || !Number.isInteger(f.boardSize) || f.boardSize < 5 || f.boardSize % 2 === 0) {
    throw new Error('The preset has an invalid board size.');
  }
  // v1 files predate movable homes — they always used the standard formula.
  const result = validateCustomPresetLayout(f.boardSize, f.homes ?? reservedHomePositions(f.boardSize), f.gardens);
  if (!result.ok) throw new Error(result.error);

  return buildCustomPresetDef(
    makeCustomPresetId(),
    f.label.trim().slice(0, PRESET_LABEL_MAX_LENGTH),
    typeof f.description === 'string' ? f.description.slice(0, PRESET_DESCRIPTION_MAX_LENGTH) : '',
    f.boardSize,
    result.layout.gardens,
    result.layout.homes,
  );
}
