/**
 * In-game garden-preset editor: paint a layout on the board the game is set
 * to play, name it, and either play it or keep it.
 *
 * The two exits share one validated result and differ only in whether a file
 * is written: "Play without saving" hands the finished preset straight back to
 * setup, while "Save & export" additionally downloads a standalone .json file
 * (the project's "no localStorage" posture means kept presets live on disk,
 * not in the browser). Neither path re-imports anything — the setup screen
 * uses the in-memory preset it is handed.
 *
 * The board can start blank or from any preset the setup screen hands over
 * (built-in ones included — those come in as an unowned draft, so saving makes
 * a new preset rather than pretending to overwrite the registry).
 *
 * Home Gardens are also movable here: click one to pick it up, then click an
 * empty space to drop it. There are always exactly 4 (seat order
 * west/north/east/south by convention) — 2-player games use Home 1 & Home 3,
 * matching how the engine's default layout already picks the opposite pair.
 *
 * The board is drawn at a constant cell size on a pan-and-zoom stage that
 * fills the screen, with the naming fields, the palette and the exits floating
 * over it as HUD panels. A 13×13 board therefore gets 13×13 full-size cells
 * you scroll around rather than a postage stamp squeezed inside a card, and
 * zooming magnifies the board alone — the HUD keeps its own scale.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type { GardenPresetDef, PlantableGardenType, Pos } from '../engine';
import { PLANTABLE_GARDEN_TYPES, posKey } from '../engine';
import { GARDEN_META } from './meta';
import { GardenIcon } from './art';
import { PanZoom } from './PanZoom';
import type { Insets } from './panZoom';
import {
  CUSTOM_EDITOR_BOARD_SIZE,
  editorBoardPx,
  maxPerType,
  PRESET_DESCRIPTION_MAX_LENGTH,
  PRESET_LABEL_MAX_LENGTH,
  buildCustomPresetDef,
  downloadCustomPreset,
  makeCustomPresetId,
  reservedHomePositions,
  validateCustomPresetLayout,
} from './customPresets';

type Tool = PlantableGardenType | 'erase';

/**
 * A layout to open the editor on, already resolved to concrete spaces — any
 * preset can produce one (see `SetupScreen.selectionAsDraft`), which is what
 * lets ✏️ Edit start from a built-in as readily as from a session preset.
 * `id` present ⇒ save over that preset; absent ⇒ this is a new one.
 */
export interface PresetDraft {
  id?: string;
  label: string;
  description: string;
  /** The board these positions were drawn on — anything else would crop them. */
  boardSize: number;
  gardens: Array<{ pos: Pos; type: PlantableGardenType }>;
  homes: Pos[];
}

export interface PresetEditorProps {
  /** Layout to start from; omit to start on a blank board. */
  initial?: PresetDraft;
  /**
   * Board to draw on when starting blank. A draft brings its own size, which
   * wins — a layout must be edited on the board it was drawn for, or the
   * gardens outside a smaller grid would silently vanish.
   */
  boardSize?: number;
  onCancel: () => void;
  /** Hand the finished layout back to setup, which selects it and closes the editor. */
  onApply: (def: GardenPresetDef) => void;
}

/**
 * How tall an element currently is, tracked as it changes. The stage fits the
 * board into the space the HUD leaves, and the HUD's height depends on the
 * palette wrapping — which depends on the window — so it has to be measured
 * rather than assumed.
 */
/** The HUD's own padding, and the width of the zoom cluster — both from index.css. */
const HUD_EDGE_PX = 12;
const ZOOM_CLUSTER_PX = 56;

function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

function initialGardens(initial: PresetEditorProps['initial']): Map<string, PlantableGardenType> {
  const map = new Map<string, PlantableGardenType>();
  if (!initial) return map;
  for (const g of initial.gardens) map.set(posKey(g.pos), g.type);
  return map;
}

export function PresetEditor({ initial, boardSize, onCancel, onApply }: PresetEditorProps) {
  const n = initial?.boardSize ?? boardSize ?? CUSTOM_EDITOR_BOARD_SIZE;
  const maxThisType = maxPerType(n);
  const boardPx = editorBoardPx(n);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [gardens, setGardens] = useState<Map<string, PlantableGardenType>>(() => initialGardens(initial));
  const [homes, setHomes] = useState<Pos[]>(() => initial?.homes.map((h) => ({ ...h })) ?? reservedHomePositions(n));
  const [pickedHome, setPickedHome] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>('tunnel');
  const [error, setError] = useState<string | null>(null);

  // The HUD's footprint, so the stage can fit the board into the gap between
  // the panels instead of parking half of it underneath one.
  const topPanel = useRef<HTMLDivElement>(null);
  const bottomPanel = useRef<HTMLDivElement>(null);
  const insets: Insets = {
    top: useHeight(topPanel) + HUD_EDGE_PX,
    bottom: useHeight(bottomPanel) + HUD_EDGE_PX,
    left: 0,
    right: ZOOM_CLUSTER_PX,
  };

  const counts: Record<PlantableGardenType, number> = {
    dandelion: 0,
    mushroom: 0,
    flytrap: 0,
    maize: 0,
    slippery: 0,
    tunnel: 0,
  };
  for (const type of gardens.values()) counts[type] += 1;

  function cellClick(pos: Pos) {
    const key = posKey(pos);
    const homeIdx = homes.findIndex((h) => posKey(h) === key);

    if (pickedHome !== null) {
      if (homeIdx === pickedHome) {
        setPickedHome(null); // clicked its own space again: cancel the pick
        return;
      }
      if (homeIdx !== -1) {
        setPickedHome(homeIdx); // switch to carrying that home instead
        return;
      }
      if (gardens.has(key)) {
        setError('Clear the garden there first, or pick a different space.');
        return;
      }
      setHomes((hs) => hs.map((h, i) => (i === pickedHome ? pos : h)));
      setPickedHome(null);
      setError(null);
      return;
    }

    if (homeIdx !== -1) {
      setPickedHome(homeIdx);
      return;
    }

    setGardens((prev) => {
      const next = new Map(prev);
      if (tool === 'erase') {
        next.delete(key);
        return next;
      }
      if (next.get(key) === tool) {
        next.delete(key); // clicking the same type again clears it
        return next;
      }
      if (counts[tool] >= maxThisType && next.get(key) !== tool) {
        return prev; // at supply cap for this type
      }
      next.set(key, tool);
      return next;
    });
  }

  /**
   * Validate the painted board and turn it into a preset, or report why not.
   * Both exits go through here, so playing and saving can never disagree about
   * what a legal layout is; only naming differs (a saved file needs a
   * filename, while an unsaved layout may come back nameless — setup numbers
   * those, since only it knows what is already in the list).
   */
  function buildDef(requireName: boolean): GardenPresetDef | null {
    if (requireName && label.trim() === '') {
      setError('Give the preset a name first.');
      return null;
    }
    const gardenList: Array<{ pos: Pos; type: PlantableGardenType }> = [...gardens.entries()].map(([key, type]) => {
      const [x, y] = key.split(',').map(Number);
      return { pos: { x, y }, type };
    });
    const result = validateCustomPresetLayout(n, homes, gardenList);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setError(null);
    return buildCustomPresetDef(
      initial?.id ?? makeCustomPresetId(),
      label.trim(),
      description,
      n,
      result.layout.gardens,
      result.layout.homes,
    );
  }

  /** Steps 1–3: validate, convert, apply. No file is written. */
  function playWithoutSaving() {
    const def = buildDef(false);
    if (def) onApply(def);
  }

  /** Steps 1–4: the same, plus a .json download to keep. */
  function saveAndExport() {
    const def = buildDef(true);
    if (!def) return;
    downloadCustomPreset(def, n);
    onApply(def);
  }

  return (
    <div className="editor-screen">
      {/* The board is the backdrop: it pans and zooms under the HUD, which
          keeps its own scale so the palette stays readable at any zoom. */}
      <PanZoom
        className="editor-stage"
        label="Board viewport"
        contentWidth={boardPx}
        contentHeight={boardPx}
        insets={insets}
      >
        <div
          className="board editor-board"
          style={{ '--n': n, width: `${boardPx}px`, height: `${boardPx}px` } as CSSProperties}
          role="grid"
          aria-label="Preset editor board"
        >
          {Array.from({ length: n * n }, (_, i) => {
            const pos = { x: i % n, y: Math.floor(i / n) };
            const key = posKey(pos);
            const homeIdx = homes.findIndex((h) => posKey(h) === key);
            const type = gardens.get(key);
            const classes = ['cell'];
            if (type) classes.push(`g-${type}`);
            if (homeIdx !== -1) classes.push('editor-home');
            if (pickedHome === homeIdx && homeIdx !== -1) classes.push('picked');
            const label =
              homeIdx !== -1
                ? `Home ${homeIdx + 1}${pickedHome === homeIdx ? ' (selected — click a space to move it)' : ''}`
                : type
                  ? GARDEN_META[type].label
                  : null;
            return (
              <button
                key={key}
                type="button"
                className={classes.join(' ')}
                onClick={() => cellClick(pos)}
                aria-label={`Space ${key}${label ? `, ${label}` : ''}`}
                title={label ?? `Space ${key}`}
              >
                {homeIdx !== -1 && (
                  <>
                    <GardenIcon type="home" className="garden-icon" />
                    <span className="home-index">{homeIdx + 1}</span>
                  </>
                )}
                {type && <GardenIcon type={type} className="garden-icon" />}
              </button>
            );
          })}
        </div>
      </PanZoom>

      {/* HUD: the layer itself is click-through, so dragging in the gaps
          between panels pans the board; the panels themselves are not. */}
      <div className="editor-hud">
        <div className="editor-panel editor-panel-top" ref={topPanel}>
          <div className="editor-heading">
            <h1 className="editor-title">🎨 Garden Preset Editor</h1>
            <span className="muted small">
              {n}×{n} board · drag to pan, scroll to zoom
            </span>
          </div>

          <div className="setup-row">
            <span className="setup-label">Name</span>
            <input
              type="text"
              className="editor-input"
              value={label}
              maxLength={PRESET_LABEL_MAX_LENGTH}
              placeholder="e.g. Twin Rivers"
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Preset name"
            />
          </div>
          <div className="setup-row">
            <span className="setup-label">Blurb</span>
            <input
              type="text"
              className="editor-input"
              value={description}
              maxLength={PRESET_DESCRIPTION_MAX_LENGTH}
              placeholder="One line describing the layout (optional)"
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Preset description"
            />
          </div>

          <div className="editor-palette" role="toolbar" aria-label="Garden type to paint">
            {PLANTABLE_GARDEN_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className={`btn small${tool === type ? ' accent' : ''}`}
                onClick={() => setTool(type)}
                disabled={counts[type] >= maxThisType && tool !== type}
                title={GARDEN_META[type].blurb}
              >
                <GardenIcon type={type} className="btn-icon" /> {GARDEN_META[type].label} ({counts[type]}/
                {maxThisType})
              </button>
            ))}
            <button
              type="button"
              className={`btn small${tool === 'erase' ? ' accent' : ''}`}
              onClick={() => setTool('erase')}
              title="Clear a space"
            >
              🧹 Erase
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => setGardens(new Map())}
              title="Clear all planted gardens"
            >
              🗑️ Clear board
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setHomes(reservedHomePositions(n));
                setPickedHome(null);
              }}
              title="Put all 4 Home Gardens back at their default spaces"
            >
              ↺ Reset homes
            </button>
          </div>
        </div>

        <div className="editor-panel editor-panel-bottom" ref={bottomPanel}>
          <p className="preset-description muted small">
            {pickedHome !== null
              ? `Moving Home ${pickedHome + 1} — click an empty space to drop it, or click it again to cancel.`
              : 'Click a Home Garden to move it. 2-player games use Home 1 & Home 3; 4-player games use all four.'}
          </p>

          {error && <div className="setup-error">{error}</div>}

          <div className="btn-row editor-actions">
            <button type="button" className="btn ghost" data-testid="preset-cancel" onClick={onCancel}>
              Cancel
            </button>
            {/* The two ways to use the layout stay together when the row wraps. */}
            <div className="btn-row editor-exits">
              <button type="button" className="btn" data-testid="preset-save" onClick={saveAndExport}>
                💾 Save &amp; Export
              </button>
              <button type="button" className="btn accent" data-testid="preset-play" onClick={playWithoutSaving}>
                ▶️ Play Without Saving
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
