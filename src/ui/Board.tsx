/**
 * The 7×7 (N×N) board. Pure presentation: gardens, the Center Star, unit
 * stacks, and highlight overlays; all legality comes from the parent via the
 * `highlights` map.
 */

import type { CSSProperties } from 'react';
import type { GameState, Pos, Unit } from '../engine';
import { centerPos, posKey, samePos, unitsAt } from '../engine';
import { GARDEN_META, playerColor, playerDisc } from './meta';
import { GardenIcon, UnitIcon } from './art';
import { GnomeAvatar } from './appearance/gnome';
import { unitNameLive } from './gnomeNames';

export type HighlightKind = 'move' | 'decision' | 'target' | 'picked';

export interface BoardProps {
  state: GameState;
  /** posKey → highlight style. */
  highlights: ReadonlyMap<string, HighlightKind>;
  /** posKey of the currently selected unit's space (ring marker). */
  selectedKey: string | null;
  onCellClick: (pos: Pos) => void;
}

interface StackGroup {
  owner: number;
  kind: Unit['kind'];
  count: number;
  allMoved: boolean;
}

function groupUnits(state: GameState, units: Unit[]): StackGroup[] {
  const turnNo = state.turn?.number ?? -1;
  const map = new Map<string, StackGroup>();
  for (const u of units) {
    const key = `${u.owner}:${u.kind}`;
    const g = map.get(key);
    if (g) {
      g.count += 1;
      g.allMoved = g.allMoved && u.movedOnTurn === turnNo;
    } else {
      map.set(key, {
        owner: u.owner,
        kind: u.kind,
        count: 1,
        allMoved: u.movedOnTurn === turnNo,
      });
    }
  }
  return [...map.values()];
}

export function Board({ state, highlights, selectedKey, onCellClick }: BoardProps) {
  const n = state.config.boardSize;
  const center = centerPos(state);
  const cells = [];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const pos = { x, y };
      const key = posKey(pos);
      const garden = state.gardens[key] ?? null;
      const units = unitsAt(state, pos);
      const hl = highlights.get(key);
      const isCenter = state.config.centerStar && samePos(pos, center);

      const classes = ['cell'];
      if (garden) classes.push(`g-${garden.type}`);
      if (hl) classes.push(`hl-${hl}`);
      if (selectedKey === key) classes.push('sel');
      const style: Record<string, string> = {};
      if (garden?.type === 'home' && garden.owner !== undefined) {
        style['--pc'] = playerColor(state, garden.owner);
      }

      cells.push(
        <button
          key={key}
          type="button"
          className={classes.join(' ')}
          style={style as CSSProperties}
          data-testid={`cell-${key}`}
          data-highlight={hl ?? ''}
          data-selected={selectedKey === key ? 'true' : 'false'}
          onClick={() => onCellClick(pos)}
          aria-label={`Space ${key}${garden ? `, ${garden.upgraded ? GARDEN_META[garden.type].upgradeLabel : GARDEN_META[garden.type].label}` : ''}`}
          title={cellTitle(state, pos)}
        >
          {garden && (
            <GardenIcon
              type={garden.type}
              className={`garden-icon${gardenInactive(state, garden.plantedOnTurn) ? ' inactive' : ''}`}
            />
          )}
          {garden?.upgraded && <span className="upgraded" data-testid="upgraded-badge">⭐</span>}
          {garden?.type === 'flytrap' && garden.stunnedForPlayerTurn !== null && (
            <span className="stun">💫</span>
          )}
          {isCenter && <span className="star">⭐</span>}
          {units.length > 0 && (
            <span className="tokens" data-testid={`units-${key}`} data-count={units.length}>
              {groupUnits(state, units).map((g) => (
                <span
                  key={`${g.owner}:${g.kind}`}
                  className={`token ${g.kind}${g.allMoved ? ' moved' : ''}`}
                  style={{ '--pc': playerColor(state, g.owner), '--pc-deep': playerDisc(state, g.owner) } as CSSProperties}
                  data-owner={g.owner}
                  data-kind={g.kind}
                  data-count={g.count}
                >
                  {/* A gnome wears its owner's look; the Immortal Snail is
                      nobody's character, so it keeps the shipped art. */}
                  {g.kind === 'gnome' ? (
                    <GnomeAvatar appearance={state.players[g.owner].appearance} className="token-face" />
                  ) : (
                    <UnitIcon kind={g.kind} className="token-face" />
                  )}
                  {g.count > 1 && <span className="token-count">{g.count}</span>}
                </span>
              ))}
            </span>
          )}
        </button>,
      );
    }
  }

  return (
    <div
      className="board"
      style={{ '--n': n } as CSSProperties}
      role="grid"
      aria-label="Game board"
    >
      {cells}
    </div>
  );
}

function gardenInactive(state: GameState, plantedOnTurn: number): boolean {
  const turnNo = state.turn?.number ?? 1;
  return plantedOnTurn >= turnNo; // planted this turn — not Active yet
}

function cellTitle(state: GameState, pos: Pos): string {
  const parts: string[] = [posKey(pos)];
  const g = state.gardens[posKey(pos)];
  if (g) {
    const meta = GARDEN_META[g.type];
    parts.push(
      g.upgraded
        ? `${meta.upgradeLabel} (upgraded ${meta.label})${g.owner !== undefined ? ` (${state.players[g.owner]?.name})` : ''} — ${meta.upgradeBlurb}`
        : `${meta.label}${g.owner !== undefined ? ` (${state.players[g.owner]?.name})` : ''} — ${meta.blurb}`,
    );
    if (gardenInactive(state, g.plantedOnTurn)) parts.push('Freshly planted (inactive until next turn).');
    if (g.type === 'flytrap' && g.stunnedForPlayerTurn !== null) parts.push('Stunned this turn.');
    if (g.type === 'maize' && g.doubledForPlayerTurn !== null) parts.push('Exit cost doubled this turn.');
    if (g.skipNextHarvest) parts.push('Skips its next harvest.');
  }
  for (const u of unitsAt(state, pos)) {
    parts.push(
      u.kind === 'snail'
        ? unitNameLive(state, u.id)
        : `${unitNameLive(state, u.id)} (${state.players[u.owner]?.name})`,
    );
  }
  return parts.join('\n');
}
