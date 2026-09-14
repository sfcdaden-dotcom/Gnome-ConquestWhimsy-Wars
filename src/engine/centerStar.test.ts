/**
 * The Center Star's configurable boon (RULES.md "Setup", item 6) and the
 * per-type garden budget — both chosen in the setup screen's advanced panel.
 *
 * Scenarios are hand-crafted via the testkit on a bare 7×7, where the center
 * space is (3,3) and the homes sit at (0,3)/(6,3).
 */

import { describe, expect, it } from 'vitest';
import type { CenterStarBoon, CreateGameOptions, GameState, PlantableGardenType, PlayerId } from './index';
import {
  EngineError,
  applyAction,
  createGame,
  getLegalActionIntents,
  gnomeBoardCap,
  posKey,
  upgradeWishCost,
  wishCap,
} from './index';
import { activePlayer, mutate, toActionPhase, withGarden, withGnome } from './testkit';

const CENTER = { x: 3, y: 3 };

/** A game at `me`'s Action Phase, with a gnome of theirs on the Center Star. */
function onTheStar(
  boon: CenterStarBoon | undefined,
  wishes: number,
  extra: Partial<Omit<CreateGameOptions, 'players'>> = {},
): { s: GameState; me: PlayerId } {
  const base = toActionPhase(5, { ...(boon ? { centerStarBoon: boon } : {}), ...extra });
  const me = activePlayer(base);
  const withUnit = withGnome(base, me, CENTER).state;
  const s = mutate(withUnit, (d) => {
    d.players[me].wishes = wishes;
  });
  return { s, me };
}

describe('the Center Star boon', () => {
  it("defaults to the rulebook's wish-limit star", () => {
    const { s, me } = onTheStar(undefined, 0);
    expect(s.config.centerStarBoon).toBe('wishCap');
    expect(wishCap(s, me)).toBe(s.config.wishLimit + 1);
    expect(gnomeBoardCap(s, me)).toBe(s.config.gnomeBoardLimit);
  });

  it('grants nothing at all while the star is switched off', () => {
    const { s, me } = onTheStar('wishCap', 0, { centerStar: false });
    expect(wishCap(s, me)).toBe(s.config.wishLimit);
  });

  it("'gnomeLimit' raises the board limit instead of the wish cap", () => {
    const { s, me } = onTheStar('gnomeLimit', 0);
    expect(gnomeBoardCap(s, me)).toBe(s.config.gnomeBoardLimit + 1);
    expect(wishCap(s, me)).toBe(s.config.wishLimit);
    // Only while you are standing there: the seat that is not on it gets nothing.
    expect(gnomeBoardCap(s, ((me + 1) % 2) as PlayerId)).toBe(s.config.gnomeBoardLimit);
  });

  it("'freePlant' makes planting on the star cost nothing", () => {
    const { s, me } = onTheStar('freePlant', 0);
    const plant = getLegalActionIntents(s).filter(
      (a) => a.type === 'plant' && posKey(a.pos) === posKey(CENTER),
    );
    expect(plant.length).toBeGreaterThan(0);
    const after = applyAction(s, { type: 'plant', player: me, pos: CENTER, gardenType: 'dandelion' });
    expect(after.players[me].wishes).toBe(0);
    expect(after.gardens[posKey(CENTER)].type).toBe('dandelion');
  });

  it("'freePlant' still charges for planting anywhere else", () => {
    const { s, me } = onTheStar('freePlant', 0);
    const elsewhere = { x: 2, y: 2 };
    const broke = withGnome(s, me, elsewhere).state;
    expect(
      getLegalActionIntents(broke).some(
        (a) => a.type === 'plant' && posKey(a.pos) === posKey(elsewhere),
      ),
    ).toBe(false);
    expect(() =>
      applyAction(broke, { type: 'plant', player: me, pos: elsewhere, gardenType: 'dandelion' }),
    ).toThrow(/costs 1 Wish/i);
  });

  it("'freeUpgrade' upgrades the garden on the star for nothing", () => {
    const { s, me } = onTheStar('freeUpgrade', 0);
    const planted = withGarden(s, CENTER, 'dandelion', 0, me);
    expect(upgradeWishCost(planted, CENTER)).toBe(0);
    expect(
      getLegalActionIntents(planted).some(
        (a) => a.type === 'upgrade' && posKey(a.pos) === posKey(CENTER),
      ),
    ).toBe(true);
    const after = applyAction(planted, { type: 'upgrade', player: me, pos: CENTER });
    expect(after.gardens[posKey(CENTER)].upgraded).toBe(true);
    expect(after.players[me].wishes).toBe(0);
  });

  it("'freeUpgrade' still charges 2 Wishes off the star", () => {
    const { s, me } = onTheStar('freeUpgrade', 1);
    const elsewhere = { x: 2, y: 2 };
    const withUnit = withGnome(s, me, elsewhere).state;
    const planted = withGarden(withUnit, elsewhere, 'dandelion', 0, me);
    expect(upgradeWishCost(planted, elsewhere)).toBe(2);
    expect(() => applyAction(planted, { type: 'upgrade', player: me, pos: elsewhere })).toThrow(
      /costs 2 Wishes/i,
    );
  });

  it('refuses a boon it does not know', () => {
    expect(() =>
      createGame(
        {
          players: [
            { name: 'A', controller: 'cpu' },
            { name: 'B', controller: 'cpu' },
          ],
          gardenPreset: 'none',
          centerStarBoon: 'unlimited-power' as never,
        },
        1,
      ),
    ).toThrow(EngineError);
  });
});

describe('the per-type garden budget', () => {
  function game(tileCounts: Partial<Record<PlantableGardenType, number>>): GameState {
    return createGame(
      {
        players: [
          { name: 'A', controller: 'cpu' },
          { name: 'B', controller: 'cpu' },
        ],
        gardenPreset: 'none',
        tileCounts,
      },
      1,
    );
  }

  it('gives every seat the configured supply, defaulting the types it omits', () => {
    const s = game({ mushroom: 9, flytrap: 0 });
    for (const p of s.players) {
      expect(p.supply.mushroom).toBe(9);
      expect(p.supply.flytrap).toBe(0);
      expect(p.supply.dandelion).toBe(s.config.tilesPerType);
    }
  });

  it('keeps a type budgeted to 0 out of the legal plants', () => {
    const base = toActionPhase(5, { tileCounts: { flytrap: 0 } });
    const me = activePlayer(base);
    const s = mutate(withGnome(base, me, { x: 2, y: 2 }).state, (d) => {
      d.players[me].wishes = 3;
    });
    const plants = getLegalActionIntents(s).filter((a) => a.type === 'plant');
    expect(plants.length).toBeGreaterThan(0);
    expect(plants.some((a) => a.gardenType === 'flytrap')).toBe(false);
    expect(plants.some((a) => a.gardenType === 'dandelion')).toBe(true);
  });

  it('refuses a budget nobody could ever plant from, or a bad entry', () => {
    expect(() =>
      game({ dandelion: 0, mushroom: 0, flytrap: 0, maize: 0, slippery: 0, tunnel: 0 }),
    ).toThrow(EngineError);
    expect(() => game({ mushroom: -1 })).toThrow(EngineError);
    expect(() => game({ bonsai: 2 } as Partial<Record<PlantableGardenType, number>>)).toThrow(EngineError);
  });
});
