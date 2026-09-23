/**
 * The Layouts page of the Customize Game dialog: everything about the
 * starting board that is not simply "pick a mode".
 *
 * The setup screen keeps only what an ordinary game needs — the preview, the
 * layout menu, the board size and a re-roll. Managing layouts is a different
 * job, so it lives here: the classic hand-drawn boards, the layouts made this
 * session, drawing a new one, editing, exporting, importing and removing, and
 * the map number of a rolled board.
 *
 * Choosing a layout here takes effect at once, exactly as the old buttons on
 * the setup screen did — Cancel on the dialog discards SETTINGS, not the
 * layout. A classic chosen here also joins the setup screen's menu for the
 * rest of the session, so the main screen always names what will be played.
 */

import { useRef } from 'react';
import type { GardenPresetDef } from '../engine';

export interface LayoutControls {
  /** The layout that will be played. */
  selected: GardenPresetDef;
  /** The board it will be played on (the applied setting, or its own size). */
  boardSize: number;
  /** The rolled map's number, for a generated layout; null for a fixed one. */
  mapNumber: number | null;
  classics: readonly GardenPresetDef[];
  /** Layouts drawn or imported this session. */
  session: readonly GardenPresetDef[];
  /** Can `def` be played on a `boardSize`×`boardSize` board? */
  fits: (def: GardenPresetDef, boardSize: number) => boolean;
  /** Why the last import failed, if it did. */
  error: string | null;
  onSelect: (id: string) => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onRemove: () => void;
}

export function LayoutsPage({
  layouts,
  boardSize,
  editorBlocked,
  onDraw,
  onEdit,
  onBack,
}: {
  layouts: LayoutControls;
  /** The board size in the dialog's working copy — what a layout must fit. */
  boardSize: number;
  /** The working copy is invalid, so it cannot be carried into the editor. */
  editorBlocked: boolean;
  onDraw: () => void;
  onEdit: () => void;
  onBack: () => void;
}) {
  const importRef = useRef<HTMLInputElement>(null);
  const { selected } = layouts;
  const isSession = layouts.session.some((p) => p.id === selected.id);

  return (
    <div className="advanced-body" data-testid="layouts-page">
      <div className="layouts-current">
        <div className="layouts-current-name">
          {selected.label} · {layouts.boardSize}×{layouts.boardSize}
          {layouts.mapNumber !== null && (
            <span className="muted meta" data-testid="layout-map-number">
              {' '}
              · Map #{layouts.mapNumber}
            </span>
          )}
        </div>
        <p className="muted small">{selected.description}</p>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn small"
          data-testid="draw-layout"
          disabled={editorBlocked}
          onClick={onDraw}
        >
          ✏️ Draw your own…
        </button>
        {/* Edit and Export work on any layout: a built-in opens as a copy, and
            its exported .json is what `src/engine/presets/` takes. */}
        <button
          type="button"
          className="btn small"
          data-testid="edit-preset"
          disabled={editorBlocked}
          title={isSession ? 'Edit this layout' : 'Open this layout in the editor as a new one'}
          onClick={onEdit}
        >
          Edit this layout
        </button>
        <button type="button" className="btn small" data-testid="export-preset" onClick={layouts.onExport}>
          💾 Export
        </button>
        <button
          type="button"
          className="btn small"
          data-testid="import-preset"
          onClick={() => importRef.current?.click()}
        >
          📂 Import…
        </button>
        {isSession && (
          <button type="button" className="btn small danger" data-testid="remove-preset" onClick={layouts.onRemove}>
            🗑️ Remove
          </button>
        )}
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          aria-label="Import a garden preset file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) layouts.onImport(file);
            e.target.value = '';
          }}
        />
      </div>
      {layouts.error && <div className="setup-error">{layouts.error}</div>}

      {layouts.session.length > 0 && (
        <LayoutList
          title="This session"
          defs={layouts.session}
          layouts={layouts}
          boardSize={boardSize}
        />
      )}
      <LayoutList title="Classic layouts" defs={layouts.classics} layouts={layouts} boardSize={boardSize} />

      <div className="btn-row">
        <button type="button" className="btn small ghost" data-testid="layouts-back" onClick={onBack}>
          ← Back to settings
        </button>
      </div>
    </div>
  );
}

/**
 * One group of layouts as a single-choice list. Buttons with aria-pressed
 * rather than radios, because choosing one ACTS (the setup screen switches to
 * it at once) rather than filling in a form.
 */
function LayoutList({
  title,
  defs,
  layouts,
  boardSize,
}: {
  title: string;
  defs: readonly GardenPresetDef[];
  layouts: LayoutControls;
  boardSize: number;
}) {
  return (
    <section className="layouts-group" aria-label={title}>
      <h3 className="layouts-group-title">{title}</h3>
      <div className="layouts-list">
        {defs.map((def) => {
          const fits = layouts.fits(def, boardSize);
          const on = def.id === layouts.selected.id;
          return (
            <button
              key={def.id}
              type="button"
              className={`layout-option${on ? ' on' : ''}`}
              aria-pressed={on}
              disabled={!fits}
              data-testid={`layout-option-${def.id}`}
              onClick={() => layouts.onSelect(def.id)}
            >
              <span className="layout-option-name">
                {def.label}
                {!fits && <span className="muted"> · needs {def.minBoardSize}×{def.minBoardSize}</span>}
              </span>
              <span className="layout-option-text">{def.description}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
