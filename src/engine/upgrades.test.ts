/**
 * Garden Upgrades + per-player tile supply (RULES.md "Garden Upgrades",
 * "Per-player supply"; design notes in GARDEN_UPGRADES.md).
 *
 * Scenarios are hand-crafted via the testkit. Unless noted, `me` is the
 * active player at their Action Phase; positions are chosen away from both
 * homes ((0,3)/(6,3) on the default 7×7) and the center star (3,3).
 */

import { describe, expect, it } from 'vitest';
import type { GameState, PlayerId, Pos } from './index';
import { applyAction, getLegalActionIntents, posKey, wishCap } from './index';
import {
  activePlayer,
  drive,
  mutate,
  toActionPhase,
  withGarden,
  withGnome,
} from './testkit';

function scenario(seed = 5): { s: GameState; me: PlayerId; foe: PlayerId } {
  const s = toActionPhase(seed);
  const me = activePlayer(s);
  return { s, me, foe: (me + 1) % 2 };
}

function setWishes(s: GameState, player: PlayerId, wishes: number): GameState {
  return mutate(s, (d) => {
    d.players[player].wishes = wishes;
  });
}

/** End `me`'s turn and drive through the foe's turn to `me`'s chooseHarvest. */
function toMyChooseHarvest(s: GameState, me: PlayerId): GameState {
  const out = drive(
    applyAction(s, { type: 'endTurn', player: me }),
    (x) => x.turn?.activePlayer === me && x.pendingDecision?.kind === 'chooseHarvest',
    300,
  );
  expect(out.pendingDecision?.kind).toBe('chooseHarvest');
  return out;
}

const asKeys = (ps: readonly Pos[]) => ps.map(posKey).sort();

// ---------------------------------------------------------------------------
// The upgrade action
// ---------------------------------------------------------------------------

describe('upgrade action', () => {
  it('costs 2 Wishes, flips the garden, and is offered as a legal intent', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'dandelion', 0, me);
    s = setWishes(s, me, 3);
    expect(
      getLegalActionIntents(s).some((a) => a.type === 'upgrade' && posKey(a.pos) === '2,2'),
    ).toBe(true);
    s = applyAction(s, { type: 'upgrade', player: me, pos: { x: 2, y: 2 } });
    expect(s.gardens['2,2'].upgraded).toBe(true);
    expect(s.players[me].wishes).toBe(1);
    expect(
      s.events.some((e) => e.type === 'gardenUpgraded' && e.player === me && e.gardenType === 'dandelion'),
    ).toBe(true);
  });

  it('rejects Home Gardens, re-upgrades, empty wallets and contested spaces', () => {
    const { s, me, foe } = scenario();
    const home = s.players[me].homePos;
    const rich = setWishes(s, me, 3);
    // Home (the starting gnome sits on it).
    expect(() => applyAction(rich, { type: 'upgrade', player: me, pos: home })).toThrow(/cannot be upgraded/i);
    // Already upgraded.
    const g = withGnome(rich, me, { x: 2, y: 2 });
    let st = withGarden(g.state, { x: 2, y: 2 }, 'dandelion', 0, me);
    const once = applyAction(st, { type: 'upgrade', player: me, pos: { x: 2, y: 2 } });
    expect(() => applyAction(once, { type: 'upgrade', player: me, pos: { x: 2, y: 2 } })).toThrow(/already upgraded/i);
    // Too few wishes.
    const poor = setWishes(st, me, 1);
    expect(() => applyAction(poor, { type: 'upgrade', player: me, pos: { x: 2, y: 2 } })).toThrow(/costs 2/i);
    // Enemy unit on the space.
    const contested = withGnome(st, foe, { x: 2, y: 2 }).state;
    expect(() => applyAction(contested, { type: 'upgrade', player: me, pos: { x: 2, y: 2 } })).toThrow(/enemy/i);
  });

  it('works on a garden planted this turn and on a captured (foe-planted) garden', () => {
    let { s, me, foe } = scenario();
    // Plant now, upgrade now (3 Wishes total in one turn).
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = setWishes(g.state, me, 3);
    s = applyAction(s, { type: 'plant', player: me, pos: { x: 2, y: 2 }, gardenType: 'mushroom' });
    expect(s.gardens['2,2'].plantedBy).toBe(me);
    expect(s.players[me].supply.mushroom).toBe(3);
    s = applyAction(s, { type: 'upgrade', player: me, pos: { x: 2, y: 2 } });
    expect(s.gardens['2,2'].upgraded).toBe(true);
    // A garden the FOE planted: control is occupancy, so it is upgradable too.
    const { s: s2, me: me2 } = scenario(7);
    const g2 = withGnome(s2, me2, { x: 4, y: 4 });
    let st = withGarden(g2.state, { x: 4, y: 4 }, 'dandelion', 0, foe);
    st = setWishes(st, me2, 2);
    st = applyAction(st, { type: 'upgrade', player: me2, pos: { x: 4, y: 4 } });
    expect(st.gardens['4,4'].upgraded).toBe(true);
    expect(st.gardens['4,4'].plantedBy).toBe(foe); // tile still returns to its planter
  });
});

// ---------------------------------------------------------------------------
// Per-player supply
// ---------------------------------------------------------------------------

describe('per-player supply', () => {
  it('planting draws from the actor\'s own supply and stamps plantedBy', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = setWishes(g.state, me, 2);
    s = applyAction(s, { type: 'plant', player: me, pos: { x: 2, y: 2 }, gardenType: 'dandelion' });
    expect(s.players[me].supply.dandelion).toBe(3);
    expect(s.gardens['2,2'].plantedBy).toBe(me);
  });

  it('an empty own supply blocks planting even when the foe still has tiles', () => {
    let { s, me, foe } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = mutate(g.state, (d) => {
      d.players[me].supply.dandelion = 0;
      d.players[me].wishes = 2;
    });
    expect(s.players[foe].supply.dandelion).toBe(4);
    expect(() =>
      applyAction(s, { type: 'plant', player: me, pos: { x: 2, y: 2 }, gardenType: 'dandelion' }),
    ).toThrow(/your supply/i);
    expect(
      getLegalActionIntents(s).some((a) => a.type === 'plant' && a.gardenType === 'dandelion'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Golden Dandelion (upgraded dandelion): +1 wish cap while controlled
// ---------------------------------------------------------------------------

describe('Golden Dandelion', () => {
  it('raises the controller\'s wish cap by 1 per controlled Golden Dandelion', () => {
    const { s, me, foe } = scenario();
    const base = wishCap(s, me);
    const g = withGnome(s, me, { x: 2, y: 2 });
    let st = withGarden(g.state, { x: 2, y: 2 }, 'dandelion', 0, me);
    st = mutate(st, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    expect(wishCap(st, me)).toBe(base + 1);
    expect(wishCap(st, foe)).toBe(base); // not the foe's garden to enjoy
    // A second one stacks.
    const g2 = withGnome(st, me, { x: 4, y: 4 });
    let st2 = withGarden(g2.state, { x: 4, y: 4 }, 'dandelion', 0, me);
    st2 = mutate(st2, (d) => {
      d.gardens['4,4'].upgraded = true;
    });
    expect(wishCap(st2, me)).toBe(base + 2);
    // Contested ⇒ not controlled ⇒ no bonus from that garden.
    const contested = withGnome(st2, foe, { x: 2, y: 2 }).state;
    expect(wishCap(contested, me)).toBe(base + 1);
  });
});

// ---------------------------------------------------------------------------
// Elder Mushroom (upgraded mushroom): clone up to 3
// ---------------------------------------------------------------------------

describe('Elder Mushroom', () => {
  it('offers up to 3 clones at harvest', () => {
    let { s, me } = scenario();
    const a = withGnome(s, me, { x: 2, y: 2 });
    const b = withGnome(a.state, me, { x: 2, y: 2 });
    const c = withGnome(b.state, me, { x: 2, y: 2 });
    s = withGarden(c.state, { x: 2, y: 2 }, 'mushroom', 0, me);
    s = mutate(s, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    s = toMyChooseHarvest(s, me);
    s = applyAction(s, { type: 'chooseHarvest', player: me, sourceKey: '2,2' });
    expect(s.pendingDecision).toMatchObject({ kind: 'mushroomClones', player: me, max: 3 });
    const before = Object.values(s.units).filter((u) => u.owner === me && u.kind === 'gnome').length;
    s = applyAction(s, { type: 'mushroomClones', player: me, count: 3 });
    const after = Object.values(s.units).filter((u) => u.owner === me && u.kind === 'gnome').length;
    expect(after).toBe(before + 3);
  });
});

// ---------------------------------------------------------------------------
// Thorn Maize (upgraded maize): base exit toll 2
// ---------------------------------------------------------------------------

describe('Thorn Maize', () => {
  it('charges 2 Wishes to exit (and blocks the move when unaffordable)', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'maize', 0, me);
    s = mutate(s, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    const poor = setWishes(s, me, 1);
    expect(() =>
      applyAction(poor, { type: 'move', player: me, unitId: g.unitId, to: { x: 2, y: 1 } }),
    ).toThrow(/exit costs 2/i);
    const rich = setWishes(s, me, 3);
    const out = applyAction(rich, { type: 'move', player: me, unitId: g.unitId, to: { x: 2, y: 1 } });
    expect(out.players[me].wishes).toBe(1);
    expect(out.events.some((e) => e.type === 'maizeExitPaid' && e.cost === 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snapping Maw (upgraded flytrap): system die +1
// ---------------------------------------------------------------------------

describe('Snapping Maw', () => {
  it('adds exactly +1 to the flytrap\'s first roll vs the identical un-upgraded state', () => {
    const { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 1 });
    const base = withGarden(g.state, { x: 2, y: 2 }, 'flytrap', 0, me);
    const upgraded = mutate(base, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    const move = { type: 'move', player: me, unitId: g.unitId, to: { x: 2, y: 2 } } as const;
    // Same RNG stream in both runs, so the first fight roll pair differs only
    // by the maw's +1 on the flytrap side (sides[0] of an entry fight).
    const rollsIn = (st: GameState) => {
      const done = applyAction(st, move);
      const ev = done.events.find((e) => e.type === 'fightRolled');
      expect(ev).toBeDefined();
      return (ev as Extract<typeof ev, { type: 'fightRolled' }>)!.rolls;
    };
    const [flytrapBase, gnomeBase] = rollsIn(base);
    const [flytrapUp, gnomeUp] = rollsIn(upgraded);
    expect(flytrapUp).toBe(flytrapBase + 1);
    expect(gnomeUp).toBe(gnomeBase);
  });
});

// ---------------------------------------------------------------------------
// Glacier (upgraded slippery)
// ---------------------------------------------------------------------------

describe('Glacier', () => {
  it('entry slide offers diagonals too', () => {
    let { s, me } = scenario();
    const g = withGnome(s, me, { x: 2, y: 1 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'slippery', 0, me);
    s = mutate(s, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    s = applyAction(s, { type: 'move', player: me, unitId: g.unitId, to: { x: 2, y: 2 } });
    expect(s.pendingDecision).toMatchObject({ kind: 'slide', optional: true });
    const d = s.pendingDecision as Extract<typeof s.pendingDecision, { kind: 'slide' }>;
    expect(d.options).toHaveLength(8); // all 8 neighbors of an interior space
  });

  it('harvest slide is exactly 2 orthogonally (through the middle) or 1 diagonally', () => {
    let { s, me, foe } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'slippery', 0, me);
    s = mutate(s, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    // An enemy on the middle space of the eastward line: slid PAST, no fight.
    const blocker = withGnome(s, foe, { x: 3, y: 2 });
    s = toMyChooseHarvest(blocker.state, me);
    s = applyAction(s, { type: 'chooseHarvest', player: me, sourceKey: '2,2' });
    expect(s.pendingDecision).toMatchObject({ kind: 'slide', optional: false });
    const d = s.pendingDecision as Extract<typeof s.pendingDecision, { kind: 'slide' }>;
    expect(asKeys(d.options)).toEqual(asKeys([
      { x: 2, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 2 }, // straight 2s
      { x: 1, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 3 }, { x: 3, y: 3 }, // diagonal 1s
    ]));
    const fights = s.events.filter((e) => e.type === 'fightStarted').length;
    s = applyAction(s, { type: 'slide', player: me, to: { x: 4, y: 2 } });
    expect(s.units[g.unitId].pos).toEqual({ x: 4, y: 2 });
    // Whooshed past the blocker on (3,2): no new fight, nobody destroyed.
    expect(s.events.filter((e) => e.type === 'fightStarted').length).toBe(fights);
    expect(s.units[blocker.unitId]).toBeDefined();
  });

  it('a wall on the middle space blocks that straight line', () => {
    let { s, me, foe } = scenario();
    const g = withGnome(s, me, { x: 2, y: 2 });
    s = withGarden(g.state, { x: 2, y: 2 }, 'slippery', 0, me);
    s = mutate(s, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    s = toMyChooseHarvest(s, me);
    // Raise the wall mid-harvest (a Great Wall expires at the start of its
    // caster's turn, so only a wall raised during THIS phase can be standing
    // when the slide options are computed — they are read from live state).
    s = withGarden(s, { x: 3, y: 2 }, 'dandelion', 0, foe); // walls need a garden
    s = mutate(s, (d) => {
      d.timedEffects.push({ kind: 'greatWall', caster: foe, pos: { x: 3, y: 2 } });
    });
    s = applyAction(s, { type: 'chooseHarvest', player: me, sourceKey: '2,2' });
    const d = s.pendingDecision as Extract<typeof s.pendingDecision, { kind: 'slide' }>;
    expect(d.kind).toBe('slide');
    expect(asKeys(d.options)).not.toContain('4,2'); // line through the wall is gone
    expect(asKeys(d.options)).toContain('2,0'); // other lines unaffected
  });
});

// ---------------------------------------------------------------------------
// Grand Burrow (upgraded tunnel)
// ---------------------------------------------------------------------------

describe('Grand Burrow', () => {
  it('entry offers other tunnels AND gardens occupied by own gnomes', () => {
    let { s, me } = scenario();
    const mover = withGnome(s, me, { x: 2, y: 1 });
    const holder = withGnome(mover.state, me, { x: 5, y: 5 });
    s = withGarden(holder.state, { x: 2, y: 2 }, 'tunnel', 0, me);
    s = withGarden(s, { x: 4, y: 4 }, 'tunnel', 0, me);
    s = withGarden(s, { x: 5, y: 5 }, 'dandelion', 0, me);
    // Base tunnel: entry offers only the other tunnel.
    const base = applyAction(s, { type: 'move', player: me, unitId: mover.unitId, to: { x: 2, y: 2 } });
    const dBase = base.pendingDecision as Extract<typeof base.pendingDecision, { kind: 'tunnel' }>;
    expect(dBase.kind).toBe('tunnel');
    expect(asKeys(dBase.options)).toEqual(['4,4']);
    // Grand Burrow: the held dandelion joins the destination list; no "stay".
    const up = mutate(s, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    const after = applyAction(up, { type: 'move', player: me, unitId: mover.unitId, to: { x: 2, y: 2 } });
    const dUp = after.pendingDecision as Extract<typeof after.pendingDecision, { kind: 'tunnel' }>;
    expect(dUp.kind).toBe('tunnel');
    // Other tunnel + the held dandelion (the own Home Garden also qualifies —
    // the starting gnome stands on it); "stay" is excluded on entry.
    const keys = asKeys(dUp.options);
    expect(keys).toContain('4,4');
    expect(keys).toContain('5,5');
    expect(keys).not.toContain('2,2');
  });
});

// ---------------------------------------------------------------------------
// Capture: the upgrade belongs to the tile
// ---------------------------------------------------------------------------

describe('tile-sticky upgrades', () => {
  it('whoever controls an upgraded garden harvests its upgraded effect', () => {
    let { s, me, foe } = scenario();
    // The FOE built and upgraded this mushroom; my gnomes now hold it.
    const a = withGnome(s, me, { x: 2, y: 2 });
    const b = withGnome(a.state, me, { x: 2, y: 2 });
    const c = withGnome(b.state, me, { x: 2, y: 2 });
    s = withGarden(c.state, { x: 2, y: 2 }, 'mushroom', 0, foe);
    s = mutate(s, (d) => {
      d.gardens['2,2'].upgraded = true;
    });
    s = toMyChooseHarvest(s, me);
    s = applyAction(s, { type: 'chooseHarvest', player: me, sourceKey: '2,2' });
    // Elder Mushroom's max-3, for ME — the capture stole the upgrade.
    expect(s.pendingDecision).toMatchObject({ kind: 'mushroomClones', player: me, max: 3 });
  });
});
