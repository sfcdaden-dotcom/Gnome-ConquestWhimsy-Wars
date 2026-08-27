import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_IDS,
  BEARD_IDS,
  CAP_IDS,
  PALETTE_IDS,
  WEAPON_IDS,
  createGame,
  isPlayerAppearance,
  randomLook,
  replayMatch,
  resolveAppearances,
  type PlayerAppearance,
} from './index';
import { newGame } from './testkit';

const FULL: PlayerAppearance = {
  palette: 'teal',
  cap: 'wide',
  beard: 'wild',
  weapon: 'staff',
  accessory: 'lantern',
};

describe('randomLook', () => {
  it('is a pure function of salt and seat', () => {
    expect(randomLook(1234, 0)).toEqual(randomLook(1234, 0));
    expect(randomLook(1234, 2)).toEqual(randomLook(1234, 2));
  });

  it('only ever returns catalogue ids', () => {
    for (let salt = 0; salt < 200; salt++) {
      for (let seat = 0; seat < 4; seat++) {
        const look = randomLook(salt, seat);
        expect(CAP_IDS).toContain(look.cap);
        expect(BEARD_IDS).toContain(look.beard);
        expect(WEAPON_IDS).toContain(look.weapon);
        expect(ACCESSORY_IDS).toContain(look.accessory);
      }
    }
  });

  it('survives a hostile seed the way normalizeSeed promises', () => {
    for (const salt of [0, -1, -99999, 2 ** 32, 1.5, Number.MAX_SAFE_INTEGER]) {
      const look = randomLook(salt, 0);
      expect(CAP_IDS).toContain(look.cap);
      expect(BEARD_IDS).toContain(look.beard);
    }
  });

  it('spreads across the catalogue rather than sticking on one id', () => {
    const caps = new Set(Array.from({ length: 60 }, (_, i) => randomLook(i, 0).cap));
    expect(caps.size).toBe(CAP_IDS.length);
  });

  it('does not move a seat in lockstep with its neighbour', () => {
    // The failure this guards is a hash that mixes seat in linearly: seat n and
    // seat n+1 would then differ by a constant in every slot at once.
    const pairs = Array.from({ length: 40 }, (_, salt) => {
      const a = randomLook(salt, 0);
      const b = randomLook(salt, 1);
      return a.cap === b.cap && a.beard === b.beard && a.weapon === b.weapon;
    });
    expect(pairs.filter(Boolean).length).toBeLessThan(pairs.length / 2);
  });
});

describe('resolveAppearances', () => {
  it('gives every seat a complete look', () => {
    for (const a of resolveAppearances([undefined, undefined, undefined, undefined], 7)) {
      expect(isPlayerAppearance(a)).toBe(true);
    }
  });

  it('keeps palettes distinct even when every seat asks for the same one', () => {
    const out = resolveAppearances(Array.from({ length: 4 }, () => ({ palette: 'teal' as const })), 7);
    expect(out[0].palette).toBe('teal'); // first claim wins
    expect(new Set(out.map((a) => a.palette)).size).toBe(4);
  });

  it('keeps palettes distinct when nobody asks', () => {
    for (let salt = 0; salt < 100; salt++) {
      const out = resolveAppearances([undefined, undefined, undefined, undefined], salt);
      expect(new Set(out.map((a) => a.palette)).size).toBe(4);
    }
  });

  it('honours a full request exactly', () => {
    expect(resolveAppearances([FULL], 99)[0]).toEqual(FULL);
  });

  it('fills only the parts a partial request left out', () => {
    const out = resolveAppearances([{ cap: 'pointy', palette: 'pink' }], 42)[0];
    expect(out.cap).toBe('pointy');
    expect(out.palette).toBe('pink');
    expect(out.beard).toBe(randomLook(42, 0).beard);
  });

  it('ignores junk fields rather than trusting them', () => {
    const out = resolveAppearances(
      [{ cap: 'sombrero', palette: 'chartreuse' } as unknown as Partial<PlayerAppearance>],
      42,
    )[0];
    expect(CAP_IDS).toContain(out.cap);
    expect(PALETTE_IDS).toContain(out.palette);
  });

  it('is deterministic, so host and client resolve identically without talking', () => {
    const reqs = [{ palette: 'green' as const }, undefined, { cap: 'wide' as const }, undefined];
    expect(resolveAppearances(reqs, 555)).toEqual(resolveAppearances(reqs, 555));
  });
});

describe('isPlayerAppearance', () => {
  it('accepts a complete in-catalogue look', () => {
    expect(isPlayerAppearance(FULL)).toBe(true);
  });

  it('rejects partials, junk and the wrong shape', () => {
    expect(isPlayerAppearance({ ...FULL, cap: undefined })).toBe(false);
    expect(isPlayerAppearance({ ...FULL, palette: 'chartreuse' })).toBe(false);
    expect(isPlayerAppearance({ ...FULL, accessory: 'sword' })).toBe(false);
    expect(isPlayerAppearance(null)).toBe(false);
    expect(isPlayerAppearance('teal')).toBe(false);
    expect(isPlayerAppearance([])).toBe(false);
  });

  it('accepts "none" as an accessory — the empty slot is a real choice', () => {
    expect(isPlayerAppearance({ ...FULL, accessory: 'none' })).toBe(true);
  });
});

describe('createGame', () => {
  it('resolves every seat and keeps the palettes distinct', () => {
    const s = newGame(42, {}, 4);
    expect(new Set(s.players.map((p) => p.appearance.palette)).size).toBe(4);
    for (const p of s.players) expect(isPlayerAppearance(p.appearance)).toBe(true);
  });

  it('honours a requested appearance', () => {
    const s = createGame(
      { players: [{ controller: 'human', appearance: FULL }, { controller: 'cpu' }] },
      1,
    );
    expect(s.players[0].appearance).toEqual(FULL);
  });

  it('gives the same seed the same gnomes, and different seeds different ones', () => {
    const look = (seed: number) =>
      createGame({ players: [{ controller: 'human' }, { controller: 'cpu' }] }, seed)
        .players.map((p) => `${p.appearance.cap}/${p.appearance.beard}/${p.appearance.weapon}`);
    expect(look(1)).toEqual(look(1));
    expect(new Set(Array.from({ length: 30 }, (_, i) => look(i).join()))).not.toHaveLength(1);
  });

  it('consumes no randomness — appearances do not disturb the deck or the dice', () => {
    // The whole reason looks are derived rather than drawn. Two games that
    // differ ONLY in appearance must be identical in every seeded outcome.
    const plain = createGame({ players: [{ controller: 'human' }, { controller: 'cpu' }] }, 12345);
    const dressed = createGame(
      { players: [{ controller: 'human', appearance: FULL }, { controller: 'cpu' }] },
      12345,
    );
    expect(dressed.deck).toEqual(plain.deck);
    expect(dressed.rngState).toEqual(plain.rngState);
  });
});

describe('replay', () => {
  it('replays a recorded game with the gnomes it was played with', () => {
    const state = createGame(
      {
        players: [
          { controller: 'human', appearance: FULL },
          { controller: 'cpu', appearance: { palette: 'orange', cap: 'bulbous' } },
        ],
      },
      2024,
    );
    const replayed = replayMatch({
      schemaVersion: 2,
      config: state.config,
      seed: state.seed,
      actions: [],
      result: { winner: null, winnerName: null, winnerController: null, turns: 0, actionCount: 0, reason: 'unfinished' },
    });
    expect(replayed.players.map((p) => p.appearance)).toEqual(state.players.map((p) => p.appearance));
  });

  it('replays a record written before character select existed', () => {
    const state = newGame(42);
    // Exactly what an old MatchRecord holds: seating with no appearance field.
    const config = {
      ...state.config,
      players: state.config.players.map(({ name, controller, difficulty }) => ({ name, controller, difficulty })),
    };
    const replayed = replayMatch({
      schemaVersion: 2,
      config,
      seed: state.seed,
      actions: [],
      result: { winner: null, winnerName: null, winnerController: null, turns: 0, actionCount: 0, reason: 'unfinished' },
    });
    for (const p of replayed.players) expect(isPlayerAppearance(p.appearance)).toBe(true);
    expect(new Set(replayed.players.map((p) => p.appearance.palette)).size).toBe(2);
  });
});
