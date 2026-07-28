/**
 * Encoder tests (Milestone 13 Phase 1).
 *
 * Load-bearing properties:
 *  - SHAPE: vectors always have the advertised sizes, with finite values.
 *  - INFO-SET BOUNDARY: an observation never depends on hidden information
 *    (opponents' hand contents, deck/discard order) — only on what the seat
 *    may legally see.
 *  - GROUND TRUTH: hand-crafted states light up exactly the documented plane
 *    and scalar slots.
 *  - SEAT RELATIVITY: "me" is always slot 0, whichever seat encodes.
 */

import { describe, expect, it } from 'vitest';
import {
  ENCODED_CARD_IDS,
  OBS_PLANES,
  OBS_SCALARS,
  OPTION_SIZE,
  encodeObservation,
  encodeOption,
  getLegalActionIntents,
  obsSize,
  posKey,
} from './index';
import type { Action, GameState } from './index';
import { activePlayer, drive, mutate, newGame, toActionPhase, withGarden, withGnome, withHand } from './testkit';

const N = 7;
const CELLS = N * N;
const SCALAR_BASE = OBS_PLANES * CELLS;

/** Flat index of (plane, x, y) in a 7×7 observation. */
function planeAt(plane: number, x: number, y: number): number {
  return plane * CELLS + y * N + x;
}

describe('encodeObservation', () => {
  it('has the advertised size and only finite values in [-1, 2]', () => {
    const s = toActionPhase(1);
    const obs = encodeObservation(s, activePlayer(s));
    expect(obs.length).toBe(obsSize(N));
    expect(obs.length).toBe(OBS_PLANES * CELLS + OBS_SCALARS);
    for (const v of obs) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(2);
    }
  });

  it('is deterministic', () => {
    const s = toActionPhase(2);
    expect(encodeObservation(s, 0)).toEqual(encodeObservation(s, 0));
  });

  it('rejects an out-of-range seat', () => {
    const s = newGame(1);
    expect(() => encodeObservation(s, 2)).toThrow(/seat 2/);
  });

  it('places my gnomes in plane 0 and enemy gnomes in the relative-seat plane', () => {
    const base = toActionPhase(3);
    const me = activePlayer(base);
    const opp = 1 - me;
    const s1 = withGnome(base, me, { x: 3, y: 2 }).state;
    const s2 = withGnome(s1, opp, { x: 5, y: 4 }).state;

    const mine = encodeObservation(s2, me);
    expect(mine[planeAt(0, 3, 2)]).toBeCloseTo(0.25); // 1 gnome / 4
    expect(mine[planeAt(1, 5, 4)]).toBeCloseTo(0.25); // relative seat 1

    // The same board seen from the other seat swaps the planes.
    const theirs = encodeObservation(s2, opp);
    expect(theirs[planeAt(0, 5, 4)]).toBeCloseTo(0.25);
    expect(theirs[planeAt(1, 3, 2)]).toBeCloseTo(0.25);
  });

  it('stacked gnomes accumulate in the count plane', () => {
    const base = toActionPhase(3);
    const me = activePlayer(base);
    let s = withGnome(base, me, { x: 3, y: 2 }).state;
    s = withGnome(s, me, { x: 3, y: 2 }).state;
    expect(encodeObservation(s, me)[planeAt(0, 3, 2)]).toBeCloseTo(0.5);
  });

  it('lights the garden one-hot, Active and home-owner planes', () => {
    const base = toActionPhase(4);
    const me = activePlayer(base);
    // Planted pre-game (plantedOnTurn 0) ⇒ already Active.
    const s = withGarden(base, { x: 2, y: 5 }, 'mushroom');
    const obs = encodeObservation(s, me);
    expect(obs[planeAt(8 + 2, 2, 5)]).toBe(1); // mushroom is GARDEN_TYPES[2]
    expect(obs[planeAt(19, 2, 5)]).toBe(1); // Active
    // My own Home Garden: home one-hot + owner slot 0.
    const home = s.players[me].homePos;
    expect(obs[planeAt(8, home.x, home.y)]).toBe(1);
    expect(obs[planeAt(15, home.x, home.y)]).toBe(1);
    // A garden planted THIS turn is not Active.
    const fresh = withGarden(base, { x: 2, y: 5 }, 'mushroom', s.turn!.number);
    expect(encodeObservation(fresh, me)[planeAt(19, 2, 5)]).toBe(0);
  });

  it('marks the Center Star plane at the center space', () => {
    const s = toActionPhase(1);
    const obs = encodeObservation(s, 0);
    expect(obs[planeAt(23, 3, 3)]).toBe(1);
    const noStar = toActionPhase(1, { centerStar: false });
    expect(encodeObservation(noStar, 0)[planeAt(23, 3, 3)]).toBe(0);
  });

  it('never leaks hidden information: opponent hand contents and deck order', () => {
    const base = toActionPhase(5);
    const me = activePlayer(base);
    const opp = 1 - me;

    // Swap WHICH card the opponent holds (same hand size) — my view unchanged.
    const a = mutate(base, (d) => {
      d.players[opp].hand = ['nope-gnome', ...d.players[opp].hand.slice(1)];
    });
    const b = mutate(base, (d) => {
      d.players[opp].hand = ['mushroom-cloud', ...d.players[opp].hand.slice(1)];
    });
    expect(encodeObservation(a, me)).toEqual(encodeObservation(b, me));
    // ...but the opponent's own view of course differs.
    expect(encodeObservation(a, opp)).not.toEqual(encodeObservation(b, opp));

    // Permute the (hidden) deck — nobody's view changes.
    const shuffledTop = mutate(base, (d) => {
      const last = d.deck.length - 1;
      [d.deck[0], d.deck[last]] = [d.deck[last], d.deck[0]];
    });
    expect(encodeObservation(shuffledTop, me)).toEqual(encodeObservation(base, me));
    expect(encodeObservation(shuffledTop, opp)).toEqual(encodeObservation(base, opp));
  });

  it('encodes my own hand as card-type counts', () => {
    const base = toActionPhase(6);
    const me = activePlayer(base);
    const empty = mutate(base, (d) => {
      d.players[me].hand = [];
    });
    const two = withHand(empty, me, 'nope-gnome', 'nope-gnome');
    const obs = encodeObservation(two, me);
    const handBase = SCALAR_BASE + 4 * 12;
    const idx = ENCODED_CARD_IDS.indexOf('nope-gnome');
    expect(obs[handBase + idx]).toBeCloseTo(1); // 2 copies / 2
    // All other card slots stay zero.
    for (let c = 0; c < ENCODED_CARD_IDS.length; c++) {
      if (c !== idx) expect(obs[handBase + c]).toBe(0);
    }
  });

  it('tracks wishes in the per-seat scalar block (slot 5 of relative seat 0)', () => {
    const base = toActionPhase(7);
    const me = activePlayer(base);
    const rich = mutate(base, (d) => {
      d.players[me].wishes = 4;
    });
    expect(encodeObservation(rich, me)[SCALAR_BASE + 5]).toBeCloseTo(0.4);
    // The opponent sees those wishes in THEIR relative seat 1 block.
    expect(encodeObservation(rich, 1 - me)[SCALAR_BASE + 12 + 5]).toBeCloseTo(0.4);
  });

  it('one-hots the pending decision kind (roll-off at game start)', () => {
    const s = newGame(1);
    expect(s.pendingDecision?.kind).toBe('rollOff');
    const obs = encodeObservation(s, 0);
    const kindBase = SCALAR_BASE + 4 * 12 + ENCODED_CARD_IDS.length + 3 + 5 + 3 + 2 + 1;
    expect(obs[kindBase]).toBe(1); // 'rollOff' is DECISION_KINDS[0]
    // No decision pending in an open Action Phase ⇒ all kind slots zero.
    const idle = toActionPhase(1);
    const idleObs = encodeObservation(idle, activePlayer(idle));
    for (let k = 0; k < 13; k++) expect(idleObs[kindBase + k]).toBe(0);
  });

  it('active curses appear for every seat (public information)', () => {
    const base = toActionPhase(8);
    const cursed = mutate(base, (d) => {
      d.activeCurses.push('curse-antsy-pants');
    });
    const curseBase = SCALAR_BASE + 4 * 12 + ENCODED_CARD_IDS.length + 3;
    expect(encodeObservation(cursed, 0)[curseBase + 4]).toBe(1); // 5th curse
    expect(encodeObservation(cursed, 1)[curseBase + 4]).toBe(1);
  });

  it('encodes a 4-player game with all four seat blocks populated', () => {
    const s = toActionPhase(1, {}, 4);
    const obs = encodeObservation(s, 2);
    for (let rel = 0; rel < 4; rel++) {
      expect(obs[SCALAR_BASE + rel * 12]).toBe(1); // every seat exists
    }
    // In a 2-player game, relative seats 2 and 3 stay empty.
    const two = encodeObservation(toActionPhase(1), 0);
    expect(two[SCALAR_BASE + 2 * 12]).toBe(0);
    expect(two[SCALAR_BASE + 3 * 12]).toBe(0);
  });
});

describe('encodeOption', () => {
  function firstOfType(state: GameState, type: Action['type']): Action {
    const a = getLegalActionIntents(state).find((x) => x.type === type);
    expect(a, `expected a legal ${type}`).toBeDefined();
    return a!;
  }

  it('always yields OPTION_SIZE finite values in [0, 1]', () => {
    const s = toActionPhase(1);
    for (const a of getLegalActionIntents(s)) {
      const v = encodeOption(s, activePlayer(s), a);
      expect(v.length).toBe(OPTION_SIZE);
      for (const x of v) {
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1);
      }
    }
  });

  it('endTurn is pure action-type one-hot (exactly one nonzero slot)', () => {
    const s = toActionPhase(2);
    const v = encodeOption(s, activePlayer(s), firstOfType(s, 'endTurn'));
    expect(v.reduce((sum, x) => sum + (x !== 0 ? 1 : 0), 0)).toBe(1);
    expect(v[20]).toBe(1); // 'endTurn' is ACTION_TYPES[20] (schema v2 added 'upgrade')
  });

  it('a move encodes both origin and destination blocks', () => {
    const s = toActionPhase(3);
    const move = firstOfType(s, 'move');
    const v = encodeOption(s, activePlayer(s), move);
    const OPT_DEST = 21 + ENCODED_CARD_IDS.length + 6 + 5 + 4;
    expect(v[OPT_DEST]).toBe(1); // destination present
    expect(v[OPT_DEST + 15]).toBe(1); // origin present
  });

  it('distinguishes plant options by garden type and destination contents', () => {
    // Starting gnomes sit on their Home Garden (unplantable), so give the
    // active player a gnome on an open square first.
    const base = toActionPhase(4);
    const me = activePlayer(base);
    const s = withGnome(base, me, { x: 2, y: 2 }).state;
    const plants = getLegalActionIntents(s).filter((a) => a.type === 'plant');
    expect(plants.length).toBeGreaterThan(0);
    const encoded = plants.map((a) => encodeOption(s, me, a));
    // Same-position, different-type options differ; identical inputs match.
    const [first] = plants;
    if (first.type !== 'plant') throw new Error('unreachable');
    const twin = plants.find((a) => a.type === 'plant' && a.gardenType !== first.gardenType && posKey(a.pos) === posKey(first.pos));
    if (twin) {
      expect(encodeOption(s, me, twin)).not.toEqual(encoded[0]);
    }
    expect(encodeOption(s, me, first)).toEqual(encoded[0]);
  });

  it('chooseHarvest options carry the source position from the live decision', () => {
    // Drive a real game until it offers a chooseHarvest decision (home + at
    // least one planted garden). Deterministic: fixed seed, fixed AI.
    const found = drive(newGame(9), (x) => x.pendingDecision?.kind === 'chooseHarvest', 4000);
    expect(found.pendingDecision?.kind).toBe('chooseHarvest');
    const actor = found.pendingDecision!.player;
    const options = getLegalActionIntents(found);
    expect(options.length).toBeGreaterThan(1);
    const OPT_DEST = 21 + ENCODED_CARD_IDS.length + 6 + 5 + 4;
    for (const a of options) {
      const v = encodeOption(found, actor, a);
      expect(v[OPT_DEST]).toBe(1); // every harvest source has a position
    }
    // Different sources encode differently.
    const [a, b] = options;
    expect(encodeOption(found, actor, a)).not.toEqual(encodeOption(found, actor, b));
  });
});
