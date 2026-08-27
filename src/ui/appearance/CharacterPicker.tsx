/**
 * Character select for one seat: a live gnome, one row per layer, and a palette.
 *
 * Nothing here knows what a cap is. The rows come from `CHOOSABLE_LAYERS` and
 * the buttons from `PART_IDS`, both generated from the art folders — so a hat
 * dropped into `src/assets/art/parts/cap/` becomes a button with no edit to
 * this file, and a whole new layer becomes a new row.
 *
 * Deliberately not a wizard. Every choice is one tap away and visible at once,
 * because this sits in front of a game people came to play — the dice are the
 * point, the hat is not. The whole thing is optional: a seat that never opens
 * it still gets a gnome, derived from the seed at `createGame`.
 *
 * A palette another seat holds is not refused — it is how you JOIN them. Two
 * seats wearing red are one team (see engine/teams.ts), so the swatch shows
 * who already has it rather than locking you out, and picking it is the only
 * way to team up.
 */

import {
  CHOOSABLE_LAYERS,
  PART_IDS,
  type ChoosableLayer,
  type PaletteId,
  type PlayerAppearance,
} from '../../engine';
import { PALETTE_LIST } from './palettes';
import { GnomeAvatar } from './gnome';
import { LAYER_LABELS, PART_LABELS } from './spriteData';

/** "Cap", falling back to the layer id if the generator has not been re-run. */
const layerLabel = (layer: string) => LAYER_LABELS[layer] ?? layer;

/**
 * "Wide Brim". `none` is not a file so it has no generated label; everything
 * else falls back to its own id rather than rendering blank.
 */
const partLabel = (layer: string, id: string) =>
  id === 'none' ? 'None' : (PART_LABELS[`${layer}/${id}`] ?? id);

interface CharacterPickerProps {
  appearance: PlayerAppearance;
  onChange: (next: PlayerAppearance) => void;
  /**
   * Palettes other seats hold, with the names holding them — picking one of
   * these joins that team rather than being refused.
   */
  taken?: readonly { palette: PaletteId; name: string }[];
  /** A seat you may look at but not edit (another player's, in an online lobby). */
  readOnly?: boolean;
}

export function CharacterPicker({
  appearance,
  onChange,
  taken = [],
  readOnly = false,
}: CharacterPickerProps) {
  const roll = () => {
    // Palette is kept: re-rolling your look should neither take a colour off
    // somebody else nor silently change which team you are on.
    const next = { ...appearance } as Record<string, string>;
    for (const layer of CHOOSABLE_LAYERS) {
      const ids = PART_IDS[layer] as readonly string[];
      next[layer] = ids[Math.floor(Math.random() * ids.length)];
    }
    onChange(next as unknown as PlayerAppearance);
  };

  return (
    <div className="char-picker" data-testid="character-picker" aria-disabled={readOnly}>
      <div className="cc-preview">
        <GnomeAvatar appearance={appearance} className="cc-gnome" alt="Your gnome" />
        {!readOnly && (
          <button type="button" className="btn small" onClick={roll} data-testid="cc-random">
            🎲 Random
          </button>
        )}
      </div>

      <div className="cc-rows">
        <div className="cc-row">
          <span className="cc-label">Colour</span>
          <div className="cc-swatches">
            {PALETTE_LIST.map((p) => {
              const holders = taken.filter((t) => t.palette === p.id).map((t) => t.name);
              const shared = holders.length > 0;
              const label = shared ? `${p.label} — team up with ${holders.join(' and ')}` : p.label;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`cc-swatch${appearance.palette === p.id ? ' sel' : ''}${shared ? ' shared' : ''}`}
                  style={{ background: p.accent }}
                  disabled={readOnly}
                  aria-pressed={appearance.palette === p.id}
                  aria-label={label}
                  title={label}
                  data-testid={`cc-palette-${p.id}`}
                  onClick={() => onChange({ ...appearance, palette: p.id })}
                />
              );
            })}
          </div>
        </div>

        {!readOnly &&
          CHOOSABLE_LAYERS.map((layer: ChoosableLayer) => (
            <div className="cc-row" key={layer}>
              <span className="cc-label">{layerLabel(layer)}</span>
              <div className="btn-row">
                {(PART_IDS[layer] as readonly string[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`btn small${appearance[layer] === id ? ' accent' : ''}`}
                    aria-pressed={appearance[layer] === id}
                    data-testid={`cc-${layer}-${id}`}
                    onClick={() => onChange({ ...appearance, [layer]: id })}
                  >
                    {partLabel(layer, id)}
                  </button>
                ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
