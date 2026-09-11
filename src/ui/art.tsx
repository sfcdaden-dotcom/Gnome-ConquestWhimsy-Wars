/**
 * The tiny components that put the game's art on screen.
 *
 * Sizing is deliberately NOT set here: an icon is 20px on a board cell and 1em
 * in a sentence, so each caller's stylesheet decides. All these do is pick the
 * right file and stay out of the accessibility tree by default — every site
 * that shows one already carries its own label or visible text, so an alt
 * string here would only be read out twice. Pass `alt` where the picture
 * genuinely is the only label.
 *
 * `UnitIcon` has one wrinkle: a gnome belonging to a seat is that seat's
 * CUSTOM gnome, composited and recoloured at runtime (see gnomeArt.ts). Pass
 * `owner` wherever the gnome on screen belongs to somebody. Leave it off and
 * you get the stock gnome, which is what the rules screen, the page header and
 * the "spawn a gnome" button want — those are gnomes in the abstract, not
 * anyone's in particular.
 */

import type { CSSProperties } from 'react';
import type { GardenType, UnitKind } from '../engine';
import { GARDEN_ART, UNIT_ART } from './artAssets';
import { POOF_FX } from './fxAssets';
import { useGnomeSprite } from './gnomeArt';
import { useSeatLook } from './gnomeLooks';

interface IconProps {
  /** Extra classes, appended to the base `art` class. */
  className?: string;
  /** Non-empty only where the picture is the sole label. */
  alt?: string;
  title?: string;
}

export function GardenIcon({ type, className, alt = '', title }: IconProps & { type: GardenType }) {
  return (
    <img
      className={`art${className ? ` ${className}` : ''}`}
      src={GARDEN_ART[type]}
      alt={alt}
      title={title}
      draggable={false}
      data-art={`garden-${type}`}
    />
  );
}

export function UnitIcon({
  kind = 'gnome',
  owner,
  className,
  alt = '',
  title,
}: IconProps & {
  kind?: UnitKind;
  /** Seat this unit belongs to. Gnomes only; the snail has no custom art. */
  owner?: number;
}) {
  const look = useSeatLook(kind === 'gnome' ? owner : undefined);
  const sprite = useGnomeSprite(look, owner ?? 0);
  // The stock gnome stands in until the sprite is composited, which is a frame
  // or two the first time a look is seen and instant on every one after. A
  // placeholder beats a hole, and both are the same size.
  const src = sprite ?? UNIT_ART[kind];
  return (
    <img
      className={`art${className ? ` ${className}` : ''}${sprite ? ' custom-gnome' : ''}`}
      src={src}
      alt={alt}
      title={title}
      draggable={false}
      data-art={`unit-${kind}`}
      data-custom={sprite ? 'true' : undefined}
    />
  );
}

/**
 * One puff of smoke, played once and then gone — the caller decides when it
 * stops existing (see `poofs` in sessionFx.ts), because an element that has
 * finished its animation still sits in the layout.
 *
 * The sprite is a mask, not a picture: the strip is white-on-transparent, so
 * masking a `--pc`-coloured box with it tints the puff to whoever just died.
 * Frame count and cell width live in the custom properties the CSS reads.
 */
export function Poof({
  variant,
  color,
  className,
}: {
  /** Index into POOF_FX; out-of-range falls back to the first. */
  variant: number;
  /** The puff's colour — a seat colour at every call site today. */
  color: string;
  className?: string;
}) {
  const fx = POOF_FX[variant] ?? POOF_FX[0];
  return (
    <span
      className={`poof${className ? ` ${className}` : ''}`}
      data-testid="poof"
      aria-hidden="true"
      style={
        {
          '--poof-src': `url(${fx.src})`,
          '--poof-frames': String(fx.frames),
          '--pc': color,
        } as CSSProperties
      }
    />
  );
}
