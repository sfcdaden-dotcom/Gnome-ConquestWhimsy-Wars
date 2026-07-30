/**
 * The file-backed half of the preset registry: layouts drawn in the in-game
 * editor, exported as .json, and dropped into `presets/` (see that folder's
 * README). These tests pin the contract that makes the drop-in safe — the id
 * comes from the filename, the homes come along, and the engine plays exactly
 * what the file says.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GARDEN_PRESET_ID,
  GARDEN_PRESETS,
  createGame,
  findGardenPreset,
  homePositions,
  parsePresetFile,
  presetDefFromFile,
  presetDefFromLayout,
  toPresetFile,
} from './index';

const players = [
  { name: 'A', controller: 'cpu' as const },
  { name: 'B', controller: 'cpu' as const },
];

describe('the registry', () => {
  it('registers every preset under a unique id, default included', () => {
    const ids = GARDEN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_GARDEN_PRESET_ID);
  });

  it('picks up presets/*.json under an id taken from the filename', () => {
    // midfield.whimsy-preset.json — both suffixes stripped.
    const midfield = findGardenPreset('midfield');
    expect(midfield?.label).toBe('Midfield');
    expect(midfield?.minBoardSize).toBe(7);
  });

  it('carries a file-backed preset\'s moved homes into the game', () => {
    const midfieldHomes = findGardenPreset('midfield')!.homes!;
    expect(midfieldHomes).toEqual([
      { x: 1, y: 3 },
      { x: 3, y: 1 },
      { x: 5, y: 3 },
      { x: 3, y: 5 },
    ]);

    // 2 players take the opposite pair (indices 0 and 2), as everywhere else.
    const duel = createGame({ players, gardenPreset: 'midfield' }, 7);
    expect(duel.players.map((p) => p.homePos)).toEqual([
      { x: 1, y: 3 },
      { x: 5, y: 3 },
    ]);
    expect(duel.gardens['1,3'].type).toBe('home');

    const four = createGame({ players: [...players, ...players], gardenPreset: 'midfield' }, 7);
    expect(four.players.map((p) => p.homePos)).toEqual(midfieldHomes);
  });

  it('leaves the standard formula in place for presets that set no homes', () => {
    const s = createGame({ players, gardenPreset: 'none' }, 7);
    expect(s.players.map((p) => p.homePos)).toEqual(homePositions(7, 2));
  });

  it('is deterministic for a fixed preset: same config + seed, same board', () => {
    const a = createGame({ players, gardenPreset: 'midfield' }, 99);
    const b = createGame(a.config, a.seed);
    expect(b.gardens).toEqual(a.gardens);
    expect(b.players.map((p) => p.homePos)).toEqual(a.players.map((p) => p.homePos));
    // A built-in travels as an id — no layout is copied into the config.
    expect(a.config.customGardens).toBeUndefined();
    expect(a.config.customHomes).toBeUndefined();
  });

  it('lets customHomes still override a preset that has its own', () => {
    const s = createGame(
      { players, gardenPreset: 'midfield', customHomes: [{ x: 0, y: 0 }, { x: 6, y: 6 }] },
      7,
    );
    expect(s.players.map((p) => p.homePos)).toEqual([
      { x: 0, y: 0 },
      { x: 6, y: 6 },
    ]);
  });
});

describe('editor export → built-in preset', () => {
  const drawn = () =>
    presetDefFromLayout(
      'custom:drawn',
      'Twin Rivers',
      'Two lanes.',
      7,
      [
        { pos: { x: 1, y: 1 }, type: 'tunnel' },
        { pos: { x: 5, y: 5 }, type: 'flytrap' },
      ],
      [
        { x: 2, y: 2 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 2, y: 6 },
      ],
    );

  it('round-trips a drawn layout through the file format under a new id', () => {
    const file = toPresetFile(drawn(), 7);
    const registered = presetDefFromFile(file, 'twin-rivers');
    expect(registered.id).toBe('twin-rivers');
    expect(registered.label).toBe('Twin Rivers');
    expect(registered.homes).toEqual(drawn().homes);
    expect(registered.build(7)).toEqual(drawn().build(7));
  });

  it('plays the exported layout verbatim once registered', () => {
    const file = toPresetFile(drawn(), 7);
    const registered = presetDefFromFile(file, 'twin-rivers');
    // What createGame would do with it, without mutating the global registry.
    const s = createGame(
      {
        players,
        customGardens: registered.build(7),
        customHomes: [registered.homes![0], registered.homes![2]],
      },
      3,
    );
    expect(s.gardens['1,1'].type).toBe('tunnel');
    expect(s.gardens['5,5'].type).toBe('flytrap');
    expect(s.players.map((p) => p.homePos)).toEqual([
      { x: 2, y: 2 },
      { x: 4, y: 4 },
    ]);
  });

  it('rejects a malformed file with a message naming the problem', () => {
    const bad = { ...toPresetFile(drawn(), 7), homes: [{ x: 0, y: 3 }] };
    expect(() => presetDefFromFile(bad, 'twin-rivers')).toThrow(/exactly 4/);
    expect(() => parsePresetFile('{', 'twin-rivers')).toThrow(/valid JSON/);
    expect(() => presetDefFromFile({ kind: 'nope' }, 'x')).toThrow(/not a Whimsy Wars garden preset/);
  });
});
