/**
 * New-game setup. The default screen holds only what an ordinary game needs:
 * player count, the seats (name, gnome, Human/CPU and a CPU's difficulty),
 * the board preview with its layout menu, size and re-roll, and Start. Every
 * other knob is behind Customize Game — board size, the economies, the Center
 * Star, the deck, the garden budget and the seed on its main page, and layout
 * management (classic layouts, drawing, editing, import/export, the map
 * number) on its Layouts page.
 *
 * The layout menu names what will be PLAYED, never an action: the three
 * generated modes (which fit every board size), this session's own layouts,
 * and any classic chosen on the Layouts page this session. So whatever is
 * selected, the main screen can say what it is.
 */

import { useEffect, useMemo, useState } from 'react';
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
  CENTER_STAR_BOONS,
  CLASSIC_PRESETS,
  DEFAULT_GARDEN_PRESET_ID,
  GARDEN_PRESETS,
  MODE_PRESETS,
  homePositions,
  posKey,
  seatHomes,
} from '../engine';
import { GARDEN_META, layoutSummary, playerColor, randomSeed, PLAYER_COLOR_NAMES } from './meta';
import { GardenIcon, UnitIcon } from './art';
import { AdvancedSettings } from './AdvancedSettings';
import { DEFAULT_ADVANCED_SETTINGS, isDefaultSettings, parseSeedText, settingsOptions } from './advancedSettings';
import type { AdvancedSettingsValue } from './advancedSettings';
import { PresetEditor } from './PresetEditor';
import type { PresetDraft } from './PresetEditor';
import { GnomeCreator, GnomePortrait } from './GnomeCreator';
import { defaultLook, randomLook } from './gnomeArt';
import type { GnomeLook } from './gnomeLook';
import {
  PRESET_LABEL_MAX_LENGTH,
  buildCustomPresetDef,
  downloadCustomPreset,
  nextUnnamedPresetLabel,
  parseCustomPresetFile,
} from './customPresets';

/**
 * The board a layout is played on, when the layout itself decides. A preset
 * drawn on a fixed board — a file-backed built-in, or one from the editor —
 * carries its gardens and homes as literal coordinates, so it only makes sense
 * at the size it was authored for (`minBoardSize`). Scaling and procedural
 * presets return null and follow the advanced board-size setting instead.
 */
function fixedBoardSize(def: GardenPresetDef): number | null {
  return !def.seeded && def.homes ? def.minBoardSize : null;
}

export interface SetupResult {
  options: CreateGameOptions;
  seed: number;
  /**
   * Each seat's gnome, by seat index. Kept beside `options` rather than in it
   * because the engine has no concept of a gnome's hat — see gnomeLook.ts.
   */
  looks: GnomeLook[];
}

interface SeatDraft {
  name: string;
  controller: PlayerController;
  difficulty: AiDifficulty;
}

/**
 * Seats are named for their colour, so the name on the panel, the dot beside
 * it and the tokens on the board all say the same thing. (Typing over one is
 * still the first thing a hot-seat table does — these only have to be right
 * for the table that doesn't bother.)
 */
const DEFAULT_NAMES = PLAYER_COLOR_NAMES;
const DIFFICULTIES: readonly AiDifficulty[] = ['easy', 'normal', 'hard'];
const DIFFICULTY_LABELS: Record<AiDifficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

function isCustomPresetId(id: string): boolean {
  return id.startsWith('custom:');
}

/**
 * What the editor is open on: a blank board, or a layout to start from. A
 * session preset is edited in place (`draft.id` kept); a built-in is forked
 * into a new one, since the registry is fixed at build time — export the fork
 * and drop it in `src/engine/presets/` to make it stock.
 */
type EditorTarget = { mode: 'new' } | { mode: 'edit'; draft: PresetDraft };

/** A preset resolved to the board it draws: what the preview shows and what plays. */
interface PreviewLayout extends RandomLayout {
  boardSize: number;
}

/**
 * Read-only thumbnail of the selected preset's map — procedural, built-in or
 * player-drawn alike. Homes the current seating won't use (the north/south
 * pair in a 2-player game) are dimmed rather than hidden, so the layout's
 * symmetry still reads at a glance.
 */
function LayoutPreview({
  layout,
  playerCount,
  centerStar,
}: {
  layout: PreviewLayout;
  playerCount: 2 | 4;
  centerStar: boolean;
}) {
  const n = layout.boardSize;
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
              <GardenIcon type="home" className="garden-icon" />
            ) : type ? (
              <GardenIcon type={type} className="garden-icon" />
            ) : isCenter && centerStar ? (
              <span className="garden-icon is-glyph">⭐</span>
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
  /**
   * A gnome per seat. Seat 0 is the one a person is most likely to be sitting
   * in, so it gets the stock gnome and an invitation to change it; the rest
   * are rolled, which is also what makes a table of CPUs look like four
   * different characters rather than four copies in four colours.
   */
  const [looks, setLooks] = useState<GnomeLook[]>(() => [
    defaultLook(),
    randomLook(),
    randomLook(),
    randomLook(),
  ]);
  /** Seat whose gnome the creator is open on, or null when it is closed. */
  const [gnomeSeat, setGnomeSeat] = useState<number | null>(null);
  const [preset, setPreset] = useState<GardenPreset>(DEFAULT_GARDEN_PRESET_ID);
  const [customPresets, setCustomPresets] = useState<GardenPresetDef[]>([]);
  // Which layout the editor is open on: a brand-new one, an existing custom
  // preset, or nothing (closed). Not derived from `preset`, so opening the
  // editor never disturbs the selection.
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AdvancedSettingsValue>(DEFAULT_ADVANCED_SETTINGS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** Classic layouts chosen on the Layouts page this session: they join the menu. */
  const [usedClassics, setUsedClassics] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The editor, requested from the Customize dialog. It opens on the render
   * AFTER the dialog's settings were applied, so it sees the board size just
   * chosen rather than the one before it.
   */
  const [pendingEditor, setPendingEditor] = useState<'new' | 'edit' | null>(null);
  /** Explains a preset the board size forced us to change (cleared on the next choice). */
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  // The procedural preset's map seed, kept apart from the game seed so
  // re-rolling the board doesn't also re-roll the dice and the deck.
  const [layoutSeed, setLayoutSeed] = useState(randomSeed);

  const allPresets = [...GARDEN_PRESETS, ...customPresets];
  // A classic can also become the selection without the Layouts page (the
  // board-size fallback below), and a selection the menu does not list would
  // render as blank — so the current one is always in.
  const menuClassics = CLASSIC_PRESETS.filter((p) => usedClassics.has(p.id) || p.id === preset);
  const presetDef = allPresets.find((p) => p.id === preset) ?? allPresets.find((p) => p.id === DEFAULT_GARDEN_PRESET_ID)!;
  /** The selected preset, when it is one the player drew (remove applies only to those). */
  const selectedCustom = isCustomPresetId(preset) ? customPresets.find((p) => p.id === preset) : undefined;

  /**
   * The board this game will actually be played on: the selected layout's own
   * size when it has one, otherwise whatever the advanced panel is set to.
   */
  const boardSize = fixedBoardSize(presetDef) ?? settings.boardSize;

  // What you see in the preview is what you play: the rolled layout is handed
  // to the engine verbatim rather than re-derived from the game seed. It is
  // rolled through the PRESET rather than by calling the generator directly,
  // so each mode previews its own kind of board.
  const rolled = useMemo<RandomLayout | null>(
    () =>
      presetDef.seeded && presetDef.buildHomes
        ? { gardens: presetDef.build(boardSize, layoutSeed), homes: presetDef.buildHomes(boardSize, layoutSeed) }
        : null,
    [presetDef, boardSize, layoutSeed],
  );

  /**
   * Every preset previews, not just the procedural one. The two non-rolled
   * cases mirror exactly what `createGame` will do with them: a built-in
   * preset builds its gardens from the id and takes the standard homes, while
   * a player-drawn one carries its own (see `layoutOptions` below).
   */
  const previewLayout = useMemo<PreviewLayout>(() => {
    if (rolled) return { ...rolled, boardSize };
    return {
      boardSize,
      gardens: presetDef.build(boardSize),
      // Same order of preference as `createGame`, so the thumbnail cannot
      // disagree with the game it starts.
      homes: presetDef.buildHomes?.(boardSize, layoutSeed) ?? presetDef.homes ?? homePositions(boardSize, 4),
    };
  }, [presetDef, boardSize, rolled, layoutSeed]);

  /**
   * The selected preset as a concrete layout the editor can open — the map
   * currently on screen, whichever kind of preset produced it (a rolled one is
   * snapshotted as previewed, not re-rolled). Built-in presets come back
   * without an id: the registry is fixed at build time, so editing one forks
   * it, and exporting the fork into `src/engine/presets/` is what makes the
   * change stock.
   */
  function selectionAsDraft(): PresetDraft {
    const own = isCustomPresetId(presetDef.id);
    return {
      ...(own ? { id: presetDef.id } : {}),
      label: own ? presetDef.label : `${presetDef.label} (copy)`.slice(0, PRESET_LABEL_MAX_LENGTH),
      description: presetDef.description,
      boardSize: previewLayout.boardSize,
      gardens: previewLayout.gardens,
      homes: previewLayout.homes,
    };
  }

  /** The same snapshot as a preset, for 💾 Export (a rolled map exports as previewed). */
  function selectionAsPreset(): GardenPresetDef {
    const draft = selectionAsDraft();
    return buildCustomPresetDef(
      presetDef.id,
      presetDef.label,
      draft.description,
      previewLayout.boardSize,
      draft.gardens,
      draft.homes,
    );
  }

  function updateSeat(i: number, patch: Partial<SeatDraft>) {
    setSeats((s) => {
      // Handing a seat to the CPU rolls it a new gnome: nobody is going to
      // open the creator for a bot, and a table of identical CPUs was the
      // thing this feature exists to stop.
      if (patch.controller === 'cpu' && s[i].controller !== 'cpu') {
        setLooks((l) => l.map((look, j) => (j === i ? randomLook() : look)));
      }
      return s.map((seat, j) => (j === i ? { ...seat, ...patch } : seat));
    });
  }

  function updateLook(i: number, look: GnomeLook) {
    setLooks((l) => l.map((prev, j) => (j === i ? look : prev)));
  }

  /**
   * The editor's single exit: select the finished layout and close. Saving is
   * the editor's own business (it writes the file before calling this), so
   * playing without saving lands here unchanged — the preset lives in this
   * component's state for the session and is never persisted. A layout played
   * without being named is numbered here, where the rest of the list is.
   */
  function addOrUpdateCustomPreset(def: GardenPresetDef) {
    setCustomPresets((list) => {
      const idx = list.findIndex((p) => p.id === def.id);
      // Numbering skips the preset being replaced, so re-playing an unnamed
      // layout keeps its number instead of climbing one every time.
      const named =
        def.label.trim() === ''
          ? { ...def, label: nextUnnamedPresetLabel(list.filter((p) => p.id !== def.id)) }
          : def;
      if (idx === -1) return [...list, named];
      const next = [...list];
      next[idx] = named;
      return next;
    });
    setPreset(def.id);
    setEditorTarget(null);
  }

  /** Every choice of layout, from the menu or the Layouts page, lands here. */
  function choosePreset(id: string) {
    setPresetNotice(null);
    setPreset(id);
    if (CLASSIC_PRESETS.some((p) => p.id === id)) setUsedClassics((s) => new Set(s).add(id));
  }

  /** Can this layout be played on an `size`×`size` board? */
  function layoutFits(def: GardenPresetDef, size: number): boolean {
    return fixedBoardSize(def) !== null || def.minBoardSize <= size;
  }
  const presetFits = (def: GardenPresetDef) => layoutFits(def, settings.boardSize);

  /** Leave the Customize dialog for the editor, applying its settings on the way. */
  function openEditorFromDialog(next: AdvancedSettingsValue, mode: 'new' | 'edit') {
    applySettings(next);
    setPendingEditor(mode);
  }
  useEffect(() => {
    if (pendingEditor === null) return;
    setEditorTarget(pendingEditor === 'new' ? { mode: 'new' } : { mode: 'edit', draft: selectionAsDraft() });
    setPendingEditor(null);
    // selectionAsDraft reads this render's layout, which is the point: the
    // one after the dialog's settings landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEditor]);

  /**
   * Closing the advanced panel can strand the selected preset — Gauntlet needs
   * a 7×7 board and cannot be drawn on a 5×5 one — so the largest stock layout
   * that does fit takes over, with a line saying so. Better here than as an
   * engine error after "Start the war".
   */
  function applySettings(next: AdvancedSettingsValue) {
    setSettings(next);
    setAdvancedOpen(false);
    if (fixedBoardSize(presetDef) !== null || presetDef.minBoardSize <= next.boardSize) {
      setPresetNotice(null);
      return;
    }
    const fits = (p: GardenPresetDef) => fixedBoardSize(p) === null && p.minBoardSize <= next.boardSize;
    // A mode first: it is generated, so it fits whatever size was just chosen.
    const fallback = MODE_PRESETS.find(fits) ?? GARDEN_PRESETS.find(fits);
    if (!fallback) return;
    setPreset(fallback.id);
    setPresetNotice(
      `${presetDef.label} needs a ${presetDef.minBoardSize}×${presetDef.minBoardSize} board, so the layout is now ${fallback.label}.`,
    );
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
        setPresetNotice(null);
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
        boardSize,
        customGardens: rolled.gardens,
        customHomes: seatHomes(rolled.homes, count),
      };
    }
    if (!isCustomPresetId(preset)) return { boardSize };
    return {
      boardSize,
      customGardens: presetDef.build(boardSize),
      ...(presetDef.homes ? { customHomes: seatHomes(presetDef.homes, count) } : {}),
    };
  }

  function start() {
    // A blank seed is the common case: roll one here, so every game the panel
    // did not pin is a fresh one. Anything unparseable was already refused by
    // the panel (`settingsProblem`), which is why there is no error path.
    const seed = parseSeedText(settings.seedText) ?? randomSeed();
    const options: CreateGameOptions = {
      gardenPreset: preset,
      ...layoutOptions(),
      ...settingsOptions(settings),
      players: seats.slice(0, count).map((s, i) => ({
        name: s.name.trim() || DEFAULT_NAMES[i],
        controller: s.controller,
        ...(s.controller === 'cpu' ? { difficulty: s.difficulty } : {}),
      })),
    };
    onStart({ options, seed, looks: looks.slice(0, count) });
  }

  const creatorSeat = gnomeSeat !== null && gnomeSeat < count ? gnomeSeat : null;
  /** What "Customised" means, for its tooltip: the star and a pinned seed. */
  const centerStarSummary = settings.centerStar
    ? `Center Star: ${CENTER_STAR_BOONS.find((b) => b.id === settings.centerStarBoon)?.label ?? settings.centerStarBoon}`
    : 'No Center Star';
  const customisedTitle = [
    'Some settings differ from the defaults.',
    centerStarSummary,
    ...(settings.seedText.trim() !== '' ? [`Seed ${settings.seedText.trim()}`] : []),
  ].join(' · ');
  const layoutLine = layoutSummary(presetDef);

  if (editorTarget) {
    return (
      <PresetEditor
        initial={editorTarget.mode === 'edit' ? editorTarget.draft : undefined}
        // A draft is edited on the board it was drawn for; a blank one is drawn
        // on the board this game is set up to play, not on a fixed 7×7.
        boardSize={settings.boardSize}
        onCancel={() => setEditorTarget(null)}
        onApply={addOrUpdateCustomPreset}
      />
    );
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <h1 className="game-title">
          <UnitIcon className="title-art" />
          Whimsy Wars
          <GardenIcon type="dandelion" className="title-art" />
        </h1>
        <p className="tagline">Harvest gardens, hoard wishes, and gnome your enemies into the compost.</p>

        <div className="setup-row">
          <span className="setup-label">Players</span>
          <div className="btn-row">
            {([2, 4] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={`btn${count === n ? ' on' : ''}`}
                aria-pressed={count === n}
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
              <button
                type="button"
                className="gnome-chip"
                data-testid={`seat-${i}-gnome`}
                aria-label={`Customize seat ${i + 1}'s gnome`}
                title="Customize this gnome"
                onClick={() => setGnomeSeat(i)}
              >
                <GnomePortrait look={looks[i]} seatId={i} />
              </button>
              <input
                type="text"
                value={seat.name}
                maxLength={16}
                aria-label={`Seat ${i + 1} name`}
                onChange={(e) => updateSeat(i, { name: e.target.value })}
              />
              {/* One button that says who is playing the seat and switches it:
                  Human ⇄ CPU. Two buttons for a two-way choice cost a phone a
                  whole row. */}
              <button
                type="button"
                className="btn small seat-controller"
                data-testid={`seat-${i}-controller`}
                data-controller={seat.controller}
                aria-label={`Seat ${i + 1}: ${seat.controller === 'human' ? 'Human' : 'CPU'} — switch to ${seat.controller === 'human' ? 'CPU' : 'Human'}`}
                title={`Switch to ${seat.controller === 'human' ? 'CPU' : 'Human'}`}
                onClick={() => updateSeat(i, { controller: seat.controller === 'human' ? 'cpu' : 'human' })}
              >
                {seat.controller === 'human' ? 'Human' : 'CPU'}
              </button>
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

        {/* The board: its picture, what it is, and a re-roll. Managing layouts
            is on the Layouts page of Customize Game. No label in here — the
            menu's own value says what the control is. */}
        <div className="preset-section" data-testid="preset-section">
          <LayoutPreview layout={previewLayout} playerCount={count} centerStar={settings.centerStar} />
          <div className="preset-controls">
            <select
              className="preset-select"
              value={preset}
              onChange={(e) => choosePreset(e.target.value)}
              aria-label="Extra-garden preset"
              data-testid="preset-select"
            >
              <optgroup label="Modes">
                {MODE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id} disabled={!presetFits(p)}>
                    {p.label}
                    {presetFits(p) ? '' : ` (needs ${p.minBoardSize}×${p.minBoardSize})`}
                  </option>
                ))}
              </optgroup>
              {customPresets.length > 0 && (
                <optgroup label="This session">
                  {customPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {menuClassics.length > 0 && (
                <optgroup label="Classic layouts">
                  {menuClassics.map((p) => (
                    <option key={p.id} value={p.id} disabled={!presetFits(p)}>
                      {p.label}
                      {presetFits(p) ? '' : ` (needs ${p.minBoardSize}×${p.minBoardSize})`}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span
              className="board-dims muted small"
              data-testid="board-dims"
              title={
                fixedBoardSize(presetDef) !== null
                  ? 'Fixed by this layout'
                  : 'Board size — change it in Customize game'
              }
            >
              {boardSize}×{boardSize}
            </span>
            {rolled && (
              <button
                type="button"
                className="btn small"
                data-testid="reroll-layout"
                title="Roll a new map in this mode"
                onClick={() => setLayoutSeed(randomSeed())}
              >
                🎲 Re-roll
              </button>
            )}
          </div>
          <p className="layout-summary muted small" title={presetDef.description} data-testid="layout-summary">
            {layoutLine}
          </p>
          {presetNotice && <p className="preset-description muted small">{presetNotice}</p>}
        </div>

        {error && <div className="setup-error">{error}</div>}

        <button type="button" className="btn primary big" data-testid="start-game" onClick={start}>
          🌱 Start the war
        </button>

        <div className="setup-footer">
          {onBack ? (
            <button type="button" className="btn ghost" data-testid="setup-back" onClick={onBack}>
              ← Back
            </button>
          ) : (
            <span />
          )}
          <span className="setup-customize">
            {!isDefaultSettings(settings) && (
              <span className="customised-tag" data-testid="customised-tag" title={customisedTitle}>
                Customised
              </span>
            )}
            <button
              type="button"
              className="btn ghost"
              data-testid="open-advanced"
              onClick={() => setAdvancedOpen(true)}
            >
              ⚙️ Customize game
            </button>
          </span>
        </div>

        {advancedOpen && (
          <AdvancedSettings
            value={settings}
            onApply={applySettings}
            onCancel={() => setAdvancedOpen(false)}
            boardSizeLockedReason={
              fixedBoardSize(presetDef) !== null
                ? `“${presetDef.label}” is drawn on a fixed ${boardSize}×${boardSize} board. Pick a scaling layout to change the board size.`
                : undefined
            }
            layouts={{
              selected: presetDef,
              boardSize,
              mapNumber: rolled ? layoutSeed : null,
              classics: CLASSIC_PRESETS,
              session: customPresets,
              fits: layoutFits,
              error,
              onSelect: choosePreset,
              onImport: importPresetFile,
              onExport: () => downloadCustomPreset(selectionAsPreset(), previewLayout.boardSize),
              onRemove: () => selectedCustom && removeCustomPreset(selectedCustom.id),
            }}
            onDrawLayout={(next) => openEditorFromDialog(next, 'new')}
            onEditLayout={(next) => openEditorFromDialog(next, 'edit')}
          />
        )}

        {creatorSeat !== null && (
          <GnomeCreator
            seatId={creatorSeat}
            seatName={seats[creatorSeat].name.trim()}
            value={looks[creatorSeat]}
            onSave={(look) => {
              updateLook(creatorSeat, look);
              setGnomeSeat(null);
            }}
            onCancel={() => setGnomeSeat(null)}
          />
        )}

      </div>
    </div>
  );
}
