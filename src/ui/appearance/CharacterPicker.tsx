/**
 * Character select for one seat: a live gnome, four part rows and a palette.
 *
 * Deliberately not a wizard. Every choice is one tap away and visible at once,
 * because this sits in front of a game people came to play — the dice are the
 * point, the hat is not. The whole thing is optional: a seat that never opens
 * it still gets a gnome, drawn from the seed at `createGame`.
 *
 * A palette another seat holds is not refused — it is how you JOIN them. Two
 * seats wearing red are one team (see engine/teams.ts), so the swatch shows
 * who already has it rather than locking you out, and picking it is the only
 * way to team up.
 */

import {
  ACCESSORY_IDS,
  BEARD_IDS,
  CAP_IDS,
  WEAPON_IDS,
  randomLook,
  type AccessoryId,
  type PaletteId,
  type PlayerAppearance,
} from '../../engine';
import { PALETTE_LIST } from './palettes';
import { GnomeAvatar } from './gnome';

const CAP_LABELS: Record<(typeof CAP_IDS)[number], string> = {
  pointy: 'Pointy',
  bulbous: 'Bulbous',
  wide: 'Wide',
};
const BEARD_LABELS: Record<(typeof BEARD_IDS)[number], string> = {
  pointy: 'Pointy',
  wild: 'Wild',
  bushy: 'Bushy',
};
const WEAPON_LABELS: Record<(typeof WEAPON_IDS)[number], string> = {
  shovel: 'Shovel',
  pitchfork: 'Pitchfork',
  staff: 'Staff',
};
const ACCESSORY_LABELS: Record<AccessoryId, string> = {
  none: 'None',
  monocle: 'Monocle',
  pipe: 'Pipe',
  lantern: 'Lantern',
};

interface RowProps<T extends string> {
  label: string;
  ids: readonly T[];
  labels: Record<T, string>;
  value: T;
  onPick: (id: T) => void;
}

function PartRow<T extends string>({ label, ids, labels, value, onPick }: RowProps<T>) {
  return (
    <div className="cc-row">
      <span className="cc-label">{label}</span>
      <div className="btn-row">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            className={`btn small${value === id ? ' accent' : ''}`}
            aria-pressed={value === id}
            data-testid={`cc-${label.toLowerCase()}-${id}`}
            onClick={() => onPick(id)}
          >
            {labels[id]}
          </button>
        ))}
      </div>
    </div>
  );
}

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
  /** Feeds the 🎲 button. Any number: this only ever picks a look, never game randomness. */
  randomSalt?: number;
}

export function CharacterPicker({
  appearance,
  onChange,
  taken = [],
  readOnly = false,
  randomSalt = 0,
}: CharacterPickerProps) {
  const set = <K extends keyof PlayerAppearance>(key: K, value: PlayerAppearance[K]) =>
    onChange({ ...appearance, [key]: value });

  const roll = () => {
    // Palette is kept: re-rolling your look should not take a colour off
    // somebody else, and the colour is the one choice the board depends on.
    onChange({ ...appearance, ...randomLook(randomSalt ^ Date.now(), 0) });
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
                  onClick={() => set('palette', p.id)}
                >
                  {shared && <span className="cc-swatch-mark" aria-hidden="true">+</span>}
                </button>
              );
            })}
          </div>
        </div>

        {!readOnly && (
          <>
            <PartRow label="Cap" ids={CAP_IDS} labels={CAP_LABELS} value={appearance.cap} onPick={(v) => set('cap', v)} />
            <PartRow label="Beard" ids={BEARD_IDS} labels={BEARD_LABELS} value={appearance.beard} onPick={(v) => set('beard', v)} />
            <PartRow label="Weapon" ids={WEAPON_IDS} labels={WEAPON_LABELS} value={appearance.weapon} onPick={(v) => set('weapon', v)} />
            <PartRow label="Extra" ids={ACCESSORY_IDS} labels={ACCESSORY_LABELS} value={appearance.accessory} onPick={(v) => set('accessory', v)} />
          </>
        )}
      </div>
    </div>
  );
}
