import { describe, expect, it } from 'vitest';
import {
  PRESET_DESCRIPTION_MAX_LENGTH,
  PRESET_LABEL_MAX_LENGTH,
  buildCustomPresetDef,
  nextUnnamedPresetLabel,
  parseCustomPresetFile,
  reservedHomePositions,
  validateCustomPresetLayout,
} from './customPresets';

describe('customPresets', () => {
  it('round-trips a valid preset file, including moved homes', () => {
    const movedHomes = [
      { x: 2, y: 2 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 6 },
    ];
    const def = buildCustomPresetDef(
      'custom:x',
      'My Layout',
      'A blurb',
      7,
      [
        { pos: { x: 1, y: 1 }, type: 'tunnel' },
        { pos: { x: 5, y: 5 }, type: 'flytrap' },
      ],
      movedHomes,
    );
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 2,
      label: def.label,
      description: def.description,
      boardSize: 7,
      homes: def.homes,
      gardens: def.build(7),
    });
    const parsed = parseCustomPresetFile(json);
    expect(parsed.label).toBe('My Layout');
    expect(parsed.homes).toEqual(movedHomes);
    expect(parsed.build(7)).toEqual([
      { pos: { x: 1, y: 1 }, type: 'tunnel' },
      { pos: { x: 5, y: 5 }, type: 'flytrap' },
    ]);
  });

  it('defaults to the standard home layout for a v1 file with no homes field', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'Old Preset',
      description: '',
      boardSize: 7,
      gardens: [{ pos: { x: 1, y: 1 }, type: 'tunnel' }],
    });
    const parsed = parseCustomPresetFile(json);
    expect(parsed.homes).toEqual(reservedHomePositions(7));
  });

  it('rejects a preset without exactly 4 homes', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 2,
      label: 'Bad',
      description: '',
      boardSize: 7,
      homes: [{ x: 0, y: 3 }],
      gardens: [],
    });
    expect(() => parseCustomPresetFile(json)).toThrow(/exactly 4/);
  });

  it('rejects two homes at the same space', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 2,
      label: 'Bad',
      description: '',
      boardSize: 7,
      homes: [
        { x: 0, y: 3 },
        { x: 0, y: 3 },
        { x: 6, y: 3 },
        { x: 3, y: 6 },
      ],
      gardens: [],
    });
    expect(() => parseCustomPresetFile(json)).toThrow(/more than one Home Garden/);
  });

  it('rejects a garden placed on a moved Home Garden space', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 2,
      label: 'Bad',
      description: '',
      boardSize: 7,
      homes: [
        { x: 2, y: 2 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
        { x: 2, y: 6 },
      ],
      gardens: [{ pos: { x: 2, y: 2 }, type: 'tunnel' }],
    });
    expect(() => parseCustomPresetFile(json)).toThrow(/Home Garden/);
  });

  it('rejects a file that is not JSON', () => {
    expect(() => parseCustomPresetFile('not json')).toThrow();
  });

  it('rejects a file of the wrong kind', () => {
    expect(() => parseCustomPresetFile(JSON.stringify({ kind: 'something-else' }))).toThrow();
  });

  it('rejects a garden placed on a reserved Home Garden space', () => {
    const [west] = reservedHomePositions(7);
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [{ pos: west, type: 'tunnel' }],
    });
    expect(() => parseCustomPresetFile(json)).toThrow(/Home Garden/);
  });

  it('rejects an out-of-bounds garden', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [{ pos: { x: 9, y: 9 }, type: 'tunnel' }],
    });
    expect(() => parseCustomPresetFile(json)).toThrow();
  });

  it('rejects an unknown garden type', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [{ pos: { x: 1, y: 1 }, type: 'home' }],
    });
    expect(() => parseCustomPresetFile(json)).toThrow();
  });

  it('truncates an oversized label/description instead of rejecting the file', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 1,
      label: 'x'.repeat(PRESET_LABEL_MAX_LENGTH + 50),
      description: 'y'.repeat(PRESET_DESCRIPTION_MAX_LENGTH + 50),
      boardSize: 7,
      gardens: [],
    });
    const parsed = parseCustomPresetFile(json);
    expect(parsed.label).toHaveLength(PRESET_LABEL_MAX_LENGTH);
    expect(parsed.description).toHaveLength(PRESET_DESCRIPTION_MAX_LENGTH);
  });

  // The editor's "Play without saving" and "Save & export" both run the
  // layout through this, as does every imported file — one rule set, three
  // entry points.
  describe('validateCustomPresetLayout', () => {
    const homes = () => reservedHomePositions(7);

    it('accepts a legal layout and hands back copied positions', () => {
      const gardens = [{ pos: { x: 1, y: 1 }, type: 'tunnel' }];
      const res = validateCustomPresetLayout(7, homes(), gardens);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.layout.homes).toEqual(homes());
      expect(res.layout.gardens).toEqual(gardens);
      expect(res.layout.gardens[0]).not.toBe(gardens[0]);
    });

    it('accepts an empty board (homes only)', () => {
      expect(validateCustomPresetLayout(7, homes(), []).ok).toBe(true);
    });

    it('rejects the wrong number of homes', () => {
      const res = validateCustomPresetLayout(7, homes().slice(0, 3), []);
      expect(res).toMatchObject({ ok: false });
      if (!res.ok) expect(res.error).toMatch(/exactly 4/);
    });

    it('rejects an out-of-bounds garden', () => {
      const res = validateCustomPresetLayout(7, homes(), [{ pos: { x: 9, y: 0 }, type: 'tunnel' }]);
      expect(res).toMatchObject({ ok: false });
      if (!res.ok) expect(res.error).toMatch(/outside the board/);
    });

    it('rejects a garden on a home space', () => {
      const res = validateCustomPresetLayout(7, homes(), [{ pos: homes()[0], type: 'tunnel' }]);
      expect(res).toMatchObject({ ok: false });
      if (!res.ok) expect(res.error).toMatch(/Home Garden space/);
    });

    it('rejects two gardens on one space', () => {
      const res = validateCustomPresetLayout(7, homes(), [
        { pos: { x: 1, y: 1 }, type: 'tunnel' },
        { pos: { x: 1, y: 1 }, type: 'maize' },
      ]);
      expect(res).toMatchObject({ ok: false });
      if (!res.ok) expect(res.error).toMatch(/more than one garden/);
    });

    it('rejects an unknown garden type', () => {
      const res = validateCustomPresetLayout(7, homes(), [{ pos: { x: 1, y: 1 }, type: 'home' }]);
      expect(res).toMatchObject({ ok: false });
      if (!res.ok) expect(res.error).toMatch(/unknown garden type/);
    });
  });

  describe('nextUnnamedPresetLabel', () => {
    it('starts at 1 and counts up alongside named presets', () => {
      expect(nextUnnamedPresetLabel([])).toBe('Unnamed preset 1');
      expect(nextUnnamedPresetLabel([{ label: 'Twin Rivers' }])).toBe('Unnamed preset 1');
      expect(nextUnnamedPresetLabel([{ label: 'Unnamed preset 1' }])).toBe('Unnamed preset 2');
    });

    it('counts past the highest number rather than the list length', () => {
      // A preset can be removed mid-session; reusing its number would put two
      // identical entries in the dropdown.
      expect(nextUnnamedPresetLabel([{ label: 'Unnamed preset 3' }])).toBe('Unnamed preset 4');
      expect(
        nextUnnamedPresetLabel([{ label: 'Unnamed preset 2' }, { label: 'Unnamed preset 10' }, { label: 'Marsh' }]),
      ).toBe('Unnamed preset 11');
    });

    it('ignores names that merely look like numbered ones', () => {
      expect(nextUnnamedPresetLabel([{ label: 'Unnamed preset' }, { label: 'Unnamed preset two' }])).toBe(
        'Unnamed preset 1',
      );
    });
  });

  it('rejects a future file version', () => {
    const json = JSON.stringify({
      kind: 'whimsy-wars-garden-preset',
      version: 99,
      label: 'Bad',
      description: '',
      boardSize: 7,
      gardens: [],
    });
    expect(() => parseCustomPresetFile(json)).toThrow(/newer version/);
  });
});
