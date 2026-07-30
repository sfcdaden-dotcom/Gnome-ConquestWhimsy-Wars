/**
 * The garden-preset FILE FORMAT — one JSON shape with two producers and two
 * consumers.
 *
 * Produced by: the in-game editor's "Save & export" (a download), and by hand.
 * Consumed by: the setup screen's "Import…" (a session-only preset), and by
 * `gardenPresets.ts`, which registers every file under `presets/` as a
 * built-in. That second consumer is the point of this module living in the
 * engine rather than the UI: a layout drawn in the editor can be dropped into
 * `src/engine/presets/` verbatim and ships as a stock preset, no code written.
 *
 * The format is deliberately plain data — positions and types, no functions —
 * so a file is a fixed layout for one board size. Presets that scale with the
 * board (or roll from the seed) are the ones that stay hand-written in
 * `gardenPresets.ts`.
 */

import type { GardenPresetDef } from './gardenPresets';
import type { PlantableGardenType, Pos } from './types';
import { PLANTABLE_GARDEN_TYPES } from './types';
import { posKey } from './helpers';

/** Magic string identifying a preset file; anything else is rejected on load. */
export const PRESET_FILE_KIND = 'whimsy-wars-garden-preset';
/** v1: gardens only, homes fixed at the standard formula. v2: added movable `homes`. */
export const PRESET_FILE_VERSION = 2;

/** Shared with the editor's `<input maxLength>` so imported files can't carry oversized text. */
export const PRESET_LABEL_MAX_LENGTH = 40;
export const PRESET_DESCRIPTION_MAX_LENGTH = 120;

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

export interface GardenPresetFile {
  kind: typeof PRESET_FILE_KIND;
  version: number;
  label: string;
  description: string;
  boardSize: number;
  /** 4 positions, seat order west/north/east/south by convention. Absent in v1 files. */
  homes?: Pos[];
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>;
}

/** Build the `GardenPresetDef` that setup renders and the engine plays for a fixed layout. */
export function presetDefFromLayout(
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

/** The serializable form of a preset — what "Save & export" writes to disk. */
export function toPresetFile(def: GardenPresetDef, boardSize: number): GardenPresetFile {
  return {
    kind: PRESET_FILE_KIND,
    version: PRESET_FILE_VERSION,
    label: def.label,
    description: def.description,
    boardSize,
    homes: def.homes ?? reservedHomePositions(boardSize),
    gardens: def.build(boardSize),
  };
}

/** A validated layout, ready to hand to `presetDefFromLayout`. */
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
 * Takes `unknown` because it also vets files, whose contents are untyped until
 * they've been through here; on success it hands back the narrowed, copied
 * positions so callers never re-walk the input.
 */
export function validatePresetLayout(
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

/**
 * Validate already-parsed file data and turn it into a preset under `id`.
 * Throws a human-readable Error on anything malformed — the setup screen shows
 * that text to the player, and the registry puts it in a build-time failure.
 */
export function presetDefFromFile(data: unknown, id: string): GardenPresetDef {
  if (typeof data !== 'object' || data === null) throw new Error('That file is not a garden preset.');
  const f = data as Partial<GardenPresetFile>;
  if (f.kind !== PRESET_FILE_KIND) throw new Error('That file is not a Whimsy Wars garden preset.');
  if (typeof f.version !== 'number' || f.version > PRESET_FILE_VERSION) {
    throw new Error('That preset was saved by a newer version of Whimsy Wars.');
  }
  if (typeof f.label !== 'string' || f.label.trim() === '') throw new Error('The preset has no name.');
  if (typeof f.boardSize !== 'number' || !Number.isInteger(f.boardSize) || f.boardSize < 5 || f.boardSize % 2 === 0) {
    throw new Error('The preset has an invalid board size.');
  }
  // v1 files predate movable homes — they always used the standard formula.
  const result = validatePresetLayout(f.boardSize, f.homes ?? reservedHomePositions(f.boardSize), f.gardens);
  if (!result.ok) throw new Error(result.error);

  return presetDefFromLayout(
    id,
    f.label.trim().slice(0, PRESET_LABEL_MAX_LENGTH),
    typeof f.description === 'string' ? f.description.slice(0, PRESET_DESCRIPTION_MAX_LENGTH) : '',
    f.boardSize,
    result.layout.gardens,
    result.layout.homes,
  );
}

/** Parse+validate preset file text. Throws a human-readable Error on anything malformed. */
export function parsePresetFile(raw: string, id: string): GardenPresetDef {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  return presetDefFromFile(data, id);
}
