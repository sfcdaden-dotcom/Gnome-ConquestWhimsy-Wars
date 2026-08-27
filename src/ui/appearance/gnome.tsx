/**
 * The component that puts a gnome on screen.
 *
 * Split from `gnomeImage.ts` for the same reason `art.tsx` is split from
 * `artAssets.ts`: a module is either all components (and gets fast refresh) or
 * plain data, never half of each.
 */

import type { PlayerAppearance } from '../../engine';
import { gnomeImageUrl, lookKey } from './gnomeImage';

interface GnomeProps {
  appearance: PlayerAppearance;
  className?: string;
  /** Non-empty only where the picture is the sole label — see art.tsx. */
  alt?: string;
  title?: string;
}

export function GnomeAvatar({ appearance, className, alt = '', title }: GnomeProps) {
  return (
    <img
      className={`art${className ? ` ${className}` : ''}`}
      src={gnomeImageUrl(appearance)}
      alt={alt}
      title={title}
      draggable={false}
      data-art="gnome"
      data-look={lookKey(appearance)}
    />
  );
}
