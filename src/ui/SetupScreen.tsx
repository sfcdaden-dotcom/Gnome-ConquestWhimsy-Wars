/**
 * New-game setup: player count, per-seat name + human/CPU, board preset,
 * Center Star toggle, optional seed.
 */

import { useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  AiDifficulty,
  CreateGameOptions,
  GardenPreset,
  GardenPresetDef,
  PlayerController,
  RandomLayout,
} from '../engine';
import {
  DEFAULT_CONFIG,
  DEFAULT_GARDEN_PRESET_ID,
  GARDEN_PRESETS,
  generateRandomLayout,
  posKey,
  seatHomes,
} from '../engine';
import { GARDEN_META, playerColor, randomSeed, PLAYER_COLOR_NAMES } from './meta';
import { PresetEditor } from './PresetEditor';
import { CUSTOM_EDITOR_BOARD_SIZE, downloadCustomPreset, parseCustomPresetFile } from './customPresets';

/** Board size the procedural preset previews (and plays) on. */
const PREVIEW_BOARD_SIZE = DEFAULT_CONFIG.boardSize;

export interface SetupResult {
  options: CreateGameOptions;
  seed: number;
}

interface SeatDraft {
  name: string;
  controller: PlayerController;
  difficulty: AiDifficulty;
}

const DEFAULT_NAMES = ['Alice', 'Bob', 'Carol', 'Dave'];
const DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'normal', 'hard'];
const DIFFICULTY_LABELS: Record<AiDifficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

function isCustomPresetId(id: string): boolean {
  return id.startsWith('custom:');
}

/**
 * Dropdown value for "Custom": an action, not a preset. Picking it opens the
 * editor (on the selected custom preset, if there is one) and leaves the
 * selection alone until the editor hands back a finished layout — so backing
 * out keeps whatever was chosen before.
 */
const CUSTOM_PRESET_OPTION = '__custom__';

/**
 * Read-only thumbnail of a rolled map. Homes the current seating won't use
 * (the north/south pair in a 2-player game) are dimmed rather than hidden, so
 * the layout's symmetry still reads at a glance.
 */
function LayoutPreview({
  layout,
  playerCount,
  centerStar,
}: {
  layout: RandomLayout;
  playerCount: 2 | 4;
  centerStar: boolean;
}) {
  const n = PREVIEW_BOARD_SIZE;
  const c = (n - 1) / 2;
  const gardens = new Map(layout.gardens.map((g) => [posKey(g.pos), g.type]));
  const homeSeat = new Map(seatHomes(layout.homes, playerCount).map((h, i) => [posKey(h), i]));
  const homeKeys = new Set(layout.homes.map(posKey));

  const summary = `${layout.gardens.length} extra gardens around ${playerCount} home gardens`;
  return (
    <div className="board preset-preview" style={{ '--n': n } as CSSProperties} role="img" aria-label={summary}>
      {Array.from({ length: n * n }, (_, i) => {
        const pos = { x: i % n, y: Math.floor(i / n) };
        const key = posKey(pos);
        const type = gardens.get(key);
        const seat = homeSeat.get(key);
        const isHome = homeKeys.has(key);
        const isCenter = pos.x === c && pos.y === c;
        const classes = ['cell'];
        if (type) classes.push(`g-${type}`);
        if (isHome) classes.push('editor-home');
        if (isHome && seat === undefined) classes.push('unseated');
        const title = isHome
          ? seat === undefined
            ? 'Home Garden (unused in a 2-player game)'
            : `${PLAYER_COLOR_NAMES[seat]}'s Home Garden`
          : type
            ? GARDEN_META[type].label
            : isCenter && centerStar
              ? 'Center Star'
              : `Space ${key}`;
        return (
          <div key={key} className={classes.join(' ')} title={title}>
            {isHome ? (
              <span className="garden-emoji">🏡</span>
            ) : type ? (
              <span className="garden-emoji">{GARDEN_META[type].emoji}</span>
            ) : isCenter && centerStar ? (
              <span className="garden-emoji">⭐</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function SetupScreen({
  onStart,
  onBack,
}: {
  onStart: (r: SetupResult) => void;
  /** Absent ⇒ no back link (the setup screen was the entry point). */
  onBack?: () => void;
}) {
  const [count, setCount] = useState<2 | 4>(2);
  const [seats, setSeats] = useState<SeatDraft[]>([
    { name: DEFAULT_NAMES[0], controller: 'human', difficulty: 'normal' },
    { name: DEFAULT_NAMES[1], controller: 'cpu', difficulty: 'normal' },
    { name: DEFAULT_NAMES[2], controller: 'cpu', difficulty: 'normal' },
    { name: DEFAULT_NAMES[3], controller: 'cpu', difficulty: 'normal' },
  ]);
  const [preset, setPreset] = useState<GardenPreset>(DEFAULT_GARDEN_PRESET_ID);
  const [customPresets, setCustomPresets] = useState<GardenPresetDef[]>([]);
  const [editing, setEditing] = useState(false);
  const [centerStar, setCenterStar] = useState(true);
  const [seedText, setSeedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The procedural preset's map seed, kept apart from the game seed so
  // re-rolling the board doesn't also re-roll the dice and the deck.
  const [layoutSeed, setLayoutSeed] = useState(randomSeed);
  const importInputRef = useRef<HTMLInputElement>(null);

  const allPresets = [...GARDEN_PRESETS, ...customPresets];
  const presetDef = allPresets.find((p) => p.id === preset) ?? allPresets.find((p) => p.id === DEFAULT_GARDEN_PRESET_ID)!;
  const editingExisting = isCustomPresetId(preset) ? customPresets.find((p) => p.id === preset) : undefined;

  // What you see in the preview is what you play: the rolled layout is handed
  // to the engine verbatim rather than re-derived from the game seed.
  const rolled = useMemo(
    () => (presetDef.seeded ? generateRandomLayout(PREVIEW_BOARD_SIZE, layoutSeed) : null),
    [presetDef, layoutSeed],
  );

  function updateSeat(i: number, patch: Partial<SeatDraft>) {
    setSeats((s) => s.map((seat, j) => (j === i ? { ...seat, ...patch } : seat)));
  }

  /**
   * The editor's single exit: select the finished layout and close. Saving is
   * the editor's own business (it writes the file before calling this), so
   * playing without saving lands here unchanged — the preset lives in this
   * component's state for the session and is never persisted.
   */
  function addOrUpdateCustomPreset(def: GardenPresetDef) {
    setCustomPresets((list) => {
      const idx = list.findIndex((p) => p.id === def.id);
      if (idx === -1) return [...list, def];
      const next = [...list];
      next[idx] = def;
      return next;
    });
    setPreset(def.id);
    setEditing(false);
  }

  /** Dropdown handler: every option but "Custom" resolves to a preset id. */
  function choosePreset(value: string) {
    if (value === CUSTOM_PRESET_OPTION) {
      setEditing(true);
      return;
    }
    setPreset(value);
  }

  function removeCustomPreset(id: string) {
    setCustomPresets((list) => list.filter((p) => p.id !== id));
    setPreset(DEFAULT_GARDEN_PRESET_ID);
  }

  function importPresetFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const def = parseCustomPresetFile(String(reader.result));
        setCustomPresets((list) => [...list, def]);
        setPreset(def.id);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read that preset file.');
      }
    };
    reader.readAsText(file);
  }

  /**
   * The layout half of the engine options. Both the rolled map and a preset
   * drawn in the editor carry 4 homes (seat order west/north/east/south) and
   * ride the same `customGardens`/`customHomes` path; built-in fixed presets
   * pass nothing and let the engine build them from the id.
   */
  function layoutOptions(): Partial<CreateGameOptions> {
    if (rolled) {
      return {
        boardSize: PREVIEW_BOARD_SIZE,
        customGardens: rolled.gardens,
        customHomes: seatHomes(rolled.homes, count),
      };
    }
    if (!isCustomPresetId(preset)) return {};
    return {
      boardSize: CUSTOM_EDITOR_BOARD_SIZE,
      customGardens: presetDef.build(CUSTOM_EDITOR_BOARD_SIZE),
      ...(presetDef.homes ? { customHomes: seatHomes(presetDef.homes, count) } : {}),
    };
  }

  function start() {
    const parsed = seedText.trim() === '' ? randomSeed() : Number(seedText.trim());
    if (!Number.isFinite(parsed)) {
      setError('Seed must be a number (or leave it blank for a random one).');
      return;
    }
    const options: CreateGameOptions = {
      gardenPreset: preset,
      ...layoutOptions(),
      centerStar,
      players: seats.slice(0, count).map((s, i) => ({
        name: s.name.trim() || DEFAULT_NAMES[i],
        controller: s.controller,
        ...(s.controller === 'cpu' ? { difficulty: s.difficulty } : {}),
      })),
    };
    onStart({ options, seed: Math.floor(parsed) });
  }

  if (editing) {
    return (
      <PresetEditor initial={editingExisting} onCancel={() => setEditing(false)} onApply={addOrUpdateCustomPreset} />
    );
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1 className="game-title">🧙 Whimsy Wars 🌼</h1>
        <p className="tagline">Harvest gardens, hoard wishes, and gnome your enemies into the compost.</p>

        <div className="setup-row">
          <span className="setup-label">Players</span>
          <div className="btn-row">
            {([2, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={`btn${count === n ? ' accent' : ''}`}
                data-testid={`player-count-${n}`}
                onClick={() => setCount(n)}
              >
                {n} players
              </button>
            ))}
          </div>
        </div>

        <div className="seat-list">
          {seats.slice(0, count).map((seat, i) => (
            <div key={i} className="seat-row" style={{ '--pc': playerColor(i) } as CSSProperties}>
              <span className="pp-dot" title={PLAYER_COLOR_NAMES[i]} />
              <input
                type="text"
                value={seat.name}
                maxLength={16}
                aria-label={`Seat ${i + 1} name`}
                onChange={(e) => updateSeat(i, { name: e.target.value })}
              />
              <div className="btn-row">
                <button
                  type="button"
                  className={`btn small${seat.controller === 'human' ? ' accent' : ''}`}
                  data-testid={`seat-${i}-human`}
                  onClick={() => updateSeat(i, { controller: 'human' })}
                >
                  🧑 Human
                </button>
                <button
                  type="button"
                  className={`btn small${seat.controller === 'cpu' ? ' accent' : ''}`}
                  data-testid={`seat-${i}-cpu`}
                  onClick={() => updateSeat(i, { controller: 'cpu' })}
                >
                  🤖 CPU
                </button>
              </div>
              {seat.controller === 'cpu' && (
                <select
                  className="preset-select small"
                  value={seat.difficulty}
                  aria-label={`Seat ${i + 1} CPU difficulty`}
                  onChange={(e) => updateSeat(i, { difficulty: e.target.value as AiDifficulty })}
                >
                  {DIFFICULTIES.map((d) => (
                    <option key={d} value={d}>
                      {DIFFICULTY_LABELS[d]}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>

        {/* Preview first, then every preset control together underneath it. */}
        <div className="preset-section" data-testid="preset-section">
          {rolled && <LayoutPreview layout={rolled} playerCount={count} centerStar={centerStar} />}
          <div className="preset-controls">
            <select
              className="preset-select"
              value={preset}
              onChange={(e) => choosePreset(e.target.value)}
              aria-label="Extra-garden preset"
              data-testid="preset-select"
            >
              <optgroup label="Built-in">
                {GARDEN_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    Preset: {p.label}
                  </option>
                ))}
              </optgroup>
              {customPresets.length > 0 && (
                <optgroup label="This session">
                  {customPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      Preset: {p.label}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={CUSTOM_PRESET_OPTION}>Preset: Custom</option>
            </select>
            <div className="btn-row">
              {rolled && (
                <>
                  <button
                    type="button"
                    className="btn small"
                    data-testid="reroll-layout"
                    onClick={() => setLayoutSeed(randomSeed())}
                  >
                    🎲 Re-roll the map
                  </button>
                  <span className="muted small">Map #{layoutSeed}</span>
                </>
              )}
              <button type="button" className="btn small" onClick={() => importInputRef.current?.click()}>
                📂 Import…
              </button>
              {editingExisting && (
                <>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => downloadCustomPreset(editingExisting, CUSTOM_EDITOR_BOARD_SIZE)}
                  >
                    💾 Export
                  </button>
                  <button type="button" className="btn small warn" onClick={() => removeCustomPreset(editingExisting.id)}>
                    🗑️ Remove
                  </button>
                </>
              )}
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="visually-hidden"
                aria-label="Import a garden preset file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importPresetFile(file);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
          <p className="preset-description muted small">{presetDef.description}</p>
        </div>

        <div className="setup-row">
          <span className="setup-label">Center Star ⭐</span>
          <label className="check-label">
            <input type="checkbox" checked={centerStar} onChange={(e) => setCenterStar(e.target.checked)} />
            Occupying the center raises your wish cap to 6
          </label>
        </div>

        <div className="setup-row">
          <span className="setup-label">Seed</span>
          <input
            type="text"
            className="seed-input"
            placeholder="random"
            value={seedText}
            onChange={(e) => setSeedText(e.target.value)}
            aria-label="Random seed (optional)"
            data-testid="seed-input"
          />
        </div>

        {error && <div className="setup-error">{error}</div>}

        <button type="button" className="btn accent big" data-testid="start-game" onClick={start}>
          🌱 Start the war
        </button>

        {onBack && (
          <button type="button" className="btn ghost" data-testid="setup-back" onClick={onBack}>
            ← Back
          </button>
        )}
      </div>
    </div>
  );
}
