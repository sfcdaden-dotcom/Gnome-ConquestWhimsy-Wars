/**
 * Advanced setup: the knobs that change the shape of a game rather than who
 * is playing it — board size, the wish and gnome economies, and the deck.
 *
 * Opened as a modal from the setup screen and edited on a working copy, so
 * backing out with Cancel leaves the pending game exactly as it was. The
 * values themselves, and the rules about them, live in advancedSettings.ts.
 */

import { useState } from 'react';
import type { CardId } from '../engine';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS, MAX_CARD_COPIES } from '../engine';
import {
  BOARD_SIZES,
  DEFAULT_ADVANCED_SETTINGS,
  SETTING_FIELDS,
  curseTotal,
  deckCountOf,
  deckTotal,
  isDefaultSettings,
  settingsProblem,
  stockCount,
  whimsyTotal,
} from './advancedSettings';
import type { AdvancedSettingsValue } from './advancedSettings';

function Stepper({
  value,
  min,
  max,
  label,
  onChange,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (n: number) => void;
  testId?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div className="stepper">
      <button
        type="button"
        className="btn small"
        aria-label={`${label}: one fewer`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        −
      </button>
      <input
        type="number"
        className="stepper-input"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        data-testid={testId}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(clamp(Math.round(n)));
        }}
      />
      <button
        type="button"
        className="btn small"
        aria-label={`${label}: one more`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        +
      </button>
    </div>
  );
}

/**
 * The deck editor: one row per card, with the stock count marked so a change
 * is visible at a glance. Counts are stored sparsely — a row set back to its
 * stock value drops out of the override map entirely.
 */
function DeckEditor({
  value,
  onChange,
  onBack,
}: {
  value: AdvancedSettingsValue;
  onChange: (v: AdvancedSettingsValue) => void;
  onBack: () => void;
}) {
  function setCount(id: CardId, n: number) {
    const next = { ...value.deckCounts };
    if (n === stockCount(id)) delete next[id];
    else next[id] = n;
    onChange({ ...value, deckCounts: next });
  }

  const rows = [
    ...CARD_DEFINITIONS.map((c) => ({ id: c.id, name: c.name, text: c.text, tag: c.timing })),
    ...CURSE_DEFINITIONS.map((c) => ({ id: c.id, name: c.name, text: c.text, tag: 'curse' as const })),
  ];

  return (
    <div className="advanced-body" data-testid="deck-editor">
      <div className="setup-row">
        <span className="setup-label">Deck</span>
        <span className="muted small">
          {deckTotal(value)} cards — {whimsyTotal(value)} whimsy,{' '}
          {curseTotal(value)} curses
        </span>
      </div>

      <div className="deck-list">
        {rows.map((row) => {
          const count = deckCountOf(value, row.id);
          const changed = count !== stockCount(row.id);
          return (
            <div key={row.id} className={`deck-row${changed ? ' changed' : ''}`} title={row.text}>
              <span className={`deck-tag tag-${row.tag}`}>{row.tag}</span>
              <span className="deck-name">{row.name}</span>
              <Stepper
                value={count}
                min={0}
                max={MAX_CARD_COPIES}
                label={`${row.name} copies`}
                testId={`deck-count-${row.id}`}
                onChange={(n) => setCount(row.id, n)}
              />
            </div>
          );
        })}
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn small"
          data-testid="deck-reset"
          disabled={Object.keys(value.deckCounts).length === 0}
          onClick={() => onChange({ ...value, deckCounts: {} })}
        >
          ↩️ Stock deck
        </button>
        <button type="button" className="btn small" data-testid="deck-back" onClick={onBack}>
          ← Back to settings
        </button>
      </div>
    </div>
  );
}

export function AdvancedSettings({
  value,
  onApply,
  onCancel,
  /**
   * Board size is fixed by the chosen layout (a player-drawn preset is baked
   * at the size it was drawn on), so the control is shown disabled with the
   * reason rather than silently ignored.
   */
  boardSizeLockedReason,
}: {
  value: AdvancedSettingsValue;
  onApply: (v: AdvancedSettingsValue) => void;
  onCancel: () => void;
  boardSizeLockedReason?: string;
}) {
  const [draft, setDraft] = useState<AdvancedSettingsValue>(value);
  const [view, setView] = useState<'settings' | 'deck'>('settings');
  const problem = settingsProblem(draft);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Advanced settings">
      <div className="overlay-card advanced-card">
        <h2 className="advanced-title">⚙️ Advanced settings</h2>

        {view === 'deck' ? (
          <DeckEditor value={draft} onChange={setDraft} onBack={() => setView('settings')} />
        ) : (
          <div className="advanced-body">
            <div className="setup-row">
              <span className="setup-label">Board size</span>
              <div className="btn-row">
                {BOARD_SIZES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`btn small${draft.boardSize === n ? ' accent' : ''}`}
                    data-testid={`board-size-${n}`}
                    disabled={boardSizeLockedReason !== undefined}
                    onClick={() => setDraft({ ...draft, boardSize: n })}
                  >
                    {n}×{n}
                  </button>
                ))}
              </div>
            </div>
            {boardSizeLockedReason && <p className="muted small">{boardSizeLockedReason}</p>}

            {SETTING_FIELDS.map((f) => (
              <div key={f.key} className="setup-row">
                <span className="setup-label" title={f.hint}>
                  {f.label}
                </span>
                <Stepper
                  value={draft[f.key]}
                  min={f.min}
                  max={f.max}
                  label={f.label}
                  testId={`setting-${f.key}`}
                  onChange={(n) => setDraft({ ...draft, [f.key]: n })}
                />
              </div>
            ))}

            <div className="setup-row">
              <span className="setup-label">Deck</span>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn small"
                  data-testid="open-deck-editor"
                  onClick={() => setView('deck')}
                >
                  🃏 Edit the deck ({deckTotal(draft)} cards)
                </button>
              </div>
            </div>

            <div className="setup-row">
              <span
                className="setup-label"
                title="Fixes every roll and shuffle: the same seed replays the same game. Blank rolls a fresh one."
              >
                Seed
              </span>
              <input
                type="text"
                className="seed-input"
                placeholder="random"
                value={draft.seedText}
                onChange={(e) => setDraft({ ...draft, seedText: e.target.value })}
                aria-label="Random seed (optional)"
                data-testid="seed-input"
              />
            </div>
          </div>
        )}

        {problem && <div className="setup-error">{problem}</div>}

        <div className="btn-row">
          <button
            type="button"
            className="btn small"
            data-testid="advanced-reset"
            disabled={isDefaultSettings(draft)}
            onClick={() => setDraft(DEFAULT_ADVANCED_SETTINGS)}
          >
            ↩️ Reset all
          </button>
          <button
            type="button"
            className="btn accent"
            data-testid="advanced-done"
            disabled={problem !== null}
            onClick={() => onApply(draft)}
          >
            Done
          </button>
          <button type="button" className="btn ghost" data-testid="advanced-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
