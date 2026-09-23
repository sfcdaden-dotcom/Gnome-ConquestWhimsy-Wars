/**
 * The character creator: a carousel per layer, a swatch row per colour, and a
 * live preview of the gnome being built.
 *
 * Opened as a modal over the setup screen, one seat at a time, and edited on a
 * working copy — backing out with Cancel leaves the seat's gnome exactly as it
 * was, the same bargain AdvancedSettings makes.
 *
 * The garment swatches are the seat's own colour and nothing else. That is not
 * a stylistic choice: board tokens no longer sit on a coloured disc, so the
 * clothes are what tells you whose gnome you are looking at, and a player who
 * could dress in another seat's colour could make the board unreadable. The
 * hair and skin rows are unrestricted, because neither carries that signal.
 */

import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { GnomeLayer, GnomeLook } from './gnomeLook';
import { GARMENT_VARIANTS, HAIR_COLORS, SKIN_TONES, garmentRamp } from './gnomeLook';
import {
  LAYER_LABELS,
  choosableLayers,
  layerOptions,
  randomLook,
  useGnomeSprite,
} from './gnomeArt';
import { PLAYER_COLOR_NAMES, playerColor } from './meta';

/**
 * The gnome as it will appear in play. Deliberately the same code path as a
 * board token — a preview drawn any other way is a preview that can lie.
 */
export function GnomePortrait({
  look,
  seatId,
  className,
  alt = '',
}: {
  look: GnomeLook;
  seatId: number;
  className?: string;
  alt?: string;
}) {
  const sprite = useGnomeSprite(look, seatId);
  if (!sprite) return <span className={`gnome-portrait pending${className ? ` ${className}` : ''}`} />;
  return <img className={`gnome-portrait${className ? ` ${className}` : ''}`} src={sprite} alt={alt} draggable={false} />;
}

/** One layer's ← / → carousel, with the current variant's name between them. */
function LayerCarousel({
  layer,
  look,
  onChange,
}: {
  layer: GnomeLayer;
  look: GnomeLook;
  onChange: (id: string | null) => void;
}) {
  const options = layerOptions(layer);
  const current = look[layer];
  const at = Math.max(
    0,
    options.findIndex((o) => (o?.id ?? null) === (current ?? null)),
  );
  const step = (by: number) => {
    const next = (at + by + options.length) % options.length;
    onChange(options[next]?.id ?? null);
  };
  const label = options[at]?.label ?? 'None';

  return (
    <div className="gnome-carousel" data-testid={`gnome-layer-${layer}`}>
      <span className="setup-label">{LAYER_LABELS[layer]}</span>
      <button
        type="button"
        className="btn small"
        aria-label={`Previous ${LAYER_LABELS[layer].toLowerCase()}`}
        data-testid={`gnome-${layer}-prev`}
        disabled={options.length < 2}
        onClick={() => step(-1)}
      >
        ‹
      </button>
      <span className="gnome-variant" data-testid={`gnome-${layer}-value`}>
        {label}
        <small className="muted">
          {' '}
          {at + 1}/{options.length}
        </small>
      </span>
      <button
        type="button"
        className="btn small"
        aria-label={`Next ${LAYER_LABELS[layer].toLowerCase()}`}
        data-testid={`gnome-${layer}-next`}
        disabled={options.length < 2}
        onClick={() => step(1)}
      >
        ›
      </button>
    </div>
  );
}

/** A row of colour buttons; `swatch` paints each one with what it will do. */
function SwatchRow({
  label,
  count,
  selected,
  swatch,
  name,
  testId,
  onPick,
}: {
  label: string;
  count: number;
  selected: number;
  swatch: (i: number) => string;
  name: (i: number) => string;
  testId: string;
  onPick: (i: number) => void;
}) {
  return (
    <div className="gnome-carousel" data-testid={testId}>
      <span className="setup-label">{label}</span>
      <div className="swatch-row">
        {Array.from({ length: count }, (_, i) => (
          <button
            key={i}
            type="button"
            className={`swatch${selected === i ? ' picked' : ''}`}
            style={{ '--sw': swatch(i) } as CSSProperties}
            title={name(i)}
            aria-label={name(i)}
            aria-pressed={selected === i}
            data-testid={`${testId}-${i}`}
            onClick={() => onPick(i)}
          />
        ))}
      </div>
    </div>
  );
}

export function GnomeCreator({
  seatId,
  seatName,
  value,
  onSave,
  onCancel,
}: {
  seatId: number;
  seatName: string;
  value: GnomeLook;
  onSave: (look: GnomeLook) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<GnomeLook>(value);
  const set = (patch: Partial<GnomeLook>) => setDraft((d) => ({ ...d, ...patch }));
  const colorName = PLAYER_COLOR_NAMES[seatId % PLAYER_COLOR_NAMES.length];

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Gnome for ${seatName || colorName}`}
      style={{ '--pc': playerColor(seatId) } as CSSProperties}
    >
      <div className="overlay-card gnome-card" data-testid="gnome-creator">
        <h2 className="advanced-title">
          <span className="pp-dot" /> {seatName || colorName}&apos;s gnome
        </h2>

        <div className="gnome-creator-body">
          <div className="gnome-stage">
            <GnomePortrait look={draft} seatId={seatId} className="big" alt="" />
            {/* At play size the gnome is a fifth of this, and details that
                read here vanish there. Showing both is cheaper than
                explaining it. */}
            <div className="gnome-scale-check" title="Actual size on the board">
              <GnomePortrait look={draft} seatId={seatId} className="tiny" alt="" />
              <span className="muted small">on the board</span>
            </div>
          </div>

          <div className="gnome-controls">
            {choosableLayers().map((layer) => (
              <LayerCarousel
                key={layer}
                layer={layer}
                look={draft}
                onChange={(id) => set({ [layer]: id } as Partial<GnomeLook>)}
              />
            ))}

            <SwatchRow
              label="Clothes"
              testId="gnome-garment"
              count={GARMENT_VARIANTS.length}
              selected={draft.garment}
              swatch={(i) => garmentRamp(seatId, i).medium}
              name={(i) => `${GARMENT_VARIANTS[i].label} ${colorName.toLowerCase()}`}
              onPick={(garment) => set({ garment })}
            />
            <SwatchRow
              label="Hair"
              testId="gnome-hair-color"
              count={HAIR_COLORS.length}
              selected={draft.hair_color}
              swatch={(i) => HAIR_COLORS[i].hex}
              name={(i) => HAIR_COLORS[i].label}
              onPick={(hair_color) => set({ hair_color })}
            />
            <SwatchRow
              label="Skin"
              testId="gnome-skin"
              count={SKIN_TONES.length}
              selected={draft.skin}
              swatch={(i) => SKIN_TONES[i].hex}
              name={(i) => SKIN_TONES[i].label}
              onPick={(skin) => set({ skin })}
            />
            <p className="muted small">
              Clothes come in {colorName.toLowerCase()} only — on the board they are what says the
              gnome is yours.
            </p>
          </div>
        </div>

        <div className="btn-row gnome-actions">
          <button
            type="button"
            className="btn small"
            data-testid="gnome-randomize"
            onClick={() => setDraft(randomLook())}
          >
            🎲 Surprise me
          </button>
          <span className="spacer" />
          <button type="button" className="btn small ghost" data-testid="gnome-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn small primary"
            data-testid="gnome-save"
            onClick={() => onSave(draft)}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
