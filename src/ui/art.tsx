/**
 * The two tiny components that put the game's art on screen.
 *
 * Sizing is deliberately NOT set here: an icon is 20px on a board cell and 1em
 * in a sentence, so each caller's stylesheet decides. All these do is pick the
 * right file and stay out of the accessibility tree by default — every site
 * that shows one already carries its own label or visible text, so an alt
 * string here would only be read out twice. Pass `alt` where the picture
 * genuinely is the only label.
 */

import type { GardenType, UnitKind } from '../engine';
import { GARDEN_ART, UNIT_ART } from './artAssets';

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

export function UnitIcon({ kind = 'gnome', className, alt = '', title }: IconProps & { kind?: UnitKind }) {
  return (
    <img
      className={`art${className ? ` ${className}` : ''}`}
      src={UNIT_ART[kind]}
      alt={alt}
      title={title}
      draggable={false}
      data-art={`unit-${kind}`}
    />
  );
}
