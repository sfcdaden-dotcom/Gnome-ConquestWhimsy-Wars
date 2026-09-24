/**
 * Hand-built game states for the UI laboratory (`?ui=preview`).
 *
 * The preview's rule is that it shows PRODUCTION components, not mock-ups of
 * them — so every panel on that page needs a real `GameState` to read. These
 * build them.
 *
 * They are constructed the way the engine's own scenario tests are (see
 * `engine/testkit.ts`): start from `createGame`, clone, and mutate the clone.
 * GameState is documented as plain JSON-serializable data and the engine never
 * trusts prior state shape beyond its invariants, so this is a supported way
 * to reach a position — and nothing here calls `applyAction`, so no rule is
 * being simulated or bent. These states exist to be LOOKED at.
 *
 * Nothing in this file is imported by the game. It is dev-only, reached only
 * through the `import.meta.env.DEV` branch in App.tsx.
 */

import type {
  FightState,
  GameEvent,
  GameState,
  GardenType,
  PendingDecision,
  PlayerId,
  Pos,
  Unit,
} from '../../engine';
import { createGame, posKey } from '../../engine';
import type { GnomeLook } from '../gnomeLook';
import { randomLook } from '../gnomeArt';

/** Board size every fixture uses. Big enough to show all 7 gardens at once. */
export const PREVIEW_BOARD_SIZE = 9;

/** Names with enough character to tell the four seats apart at a glance. */
const SEAT_NAMES = ['Bramblewick', 'Thistlebrook', 'Marigold', 'Pumpernickel'];

/**
 * Four gnomes that are the same on every reload. `randomLook` takes its own
 * `pick`, precisely so a caller can be deterministic without touching the
 * engine's seeded RNG — a preview whose cast changes every refresh would make
 * "did that change?" impossible to answer while art-directing.
 */
export function previewLooks(): GnomeLook[] {
  let s = 0x5eed;
  const pick = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return [0, 1, 2, 3].map(() => randomLook(pick));
}

function baseGame(): GameState {
  return createGame(
    {
      players: SEAT_NAMES.map((name) => ({ name, controller: 'human' as const })),
      boardSize: PREVIEW_BOARD_SIZE,
      gardenPreset: 'none',
    },
    7,
  );
}

function edit(state: GameState, fn: (draft: GameState) => void): GameState {
  const draft = structuredClone(state);
  fn(draft);
  return draft;
}

let nextId = 1;
function gnome(owner: PlayerId, pos: Pos, moved = false): Unit {
  return { id: `u${nextId++}`, owner, kind: 'gnome', pos, movedOnTurn: moved ? 3 : null };
}
function snail(owner: PlayerId, pos: Pos): Unit {
  return { id: `u${nextId++}`, owner, kind: 'snail', pos, movedOnTurn: null };
}

function put(draft: GameState, units: Unit[]) {
  for (const u of units) draft.units[u.id] = u;
}

function garden(draft: GameState, pos: Pos, type: GardenType, extra: Record<string, unknown> = {}) {
  draft.gardens[posKey(pos)] = { type, plantedOnTurn: 0, ...extra } as GameState['gardens'][string];
}

/**
 * The everyday position: mid-game, four seats in four different conditions,
 * every garden type on the board, and a stack, a standoff and a snail so the
 * unit art shows in each of its forms.
 *
 * Seat conditions are deliberately spread — one active, one flush, one nearly
 * out of reinforcements, one eliminated — because the player panel has to
 * carry all four and they should be comparable side by side.
 */
export function previewState(): GameState {
  nextId = 1;
  return edit(baseGame(), (d) => {
    d.status = 'playing';
    d.turn = {
      number: 3,
      activePlayer: 0,
      phase: 'action',
      snailLostFight: false,
      snailEatOffered: false,
    };

    d.players[0].wishes = 2;
    d.players[0].hand = ['nope-gnome', 'wild-growth', 'lawnmower-of-doom'];
    d.players[0].gnomesSpawned = 6;
    d.players[0].gnomesLost = 1;

    d.players[1].wishes = 3;
    d.players[1].hand = ['snake-eyes', 'instigation'];
    d.players[1].gnomesSpawned = 5;
    d.players[1].gnomesLost = 2;

    // Nearly out of reinforcements: the panel's most alarming live state.
    d.players[2].wishes = 0;
    d.players[2].hand = ['plot-twist'];
    d.players[2].gnomesSpawned = 15;
    d.players[2].gnomesLost = 14;

    d.players[3].status = 'out';
    d.players[3].wishes = 0;
    d.players[3].hand = [];
    d.players[3].gnomesSpawned = 16;
    d.players[3].gnomesLost = 16;

    // Every garden type, laid out left to right so they can be compared. The
    // homes are already placed by createGame at the edge midpoints.
    garden(d, { x: 1, y: 1 }, 'dandelion', { plantedBy: 0 });
    garden(d, { x: 2, y: 1 }, 'dandelion', { plantedBy: 0, upgraded: true });
    garden(d, { x: 3, y: 1 }, 'mushroom', { plantedBy: 1 });
    garden(d, { x: 4, y: 1 }, 'mushroom', { plantedBy: 1, upgraded: true });
    garden(d, { x: 5, y: 1 }, 'maize', { plantedBy: 2 });
    garden(d, { x: 6, y: 1 }, 'maize', { plantedBy: 2, upgraded: true });
    garden(d, { x: 1, y: 3 }, 'slippery', { plantedBy: 3 });
    garden(d, { x: 2, y: 3 }, 'slippery', { plantedBy: 3, upgraded: true });
    garden(d, { x: 3, y: 3 }, 'tunnel', { plantedBy: 0 });
    garden(d, { x: 4, y: 3 }, 'tunnel', { plantedBy: 0, upgraded: true });
    garden(d, { x: 5, y: 3 }, 'flytrap');
    garden(d, { x: 6, y: 3 }, 'flytrap', { upgraded: true });
    // Freshly planted: drawn faded until it goes Active next turn.
    garden(d, { x: 7, y: 3 }, 'dandelion', { plantedBy: 1, plantedOnTurn: 3 });

    put(d, [
      gnome(0, { x: 1, y: 1 }),
      // A single seat's stack: one token with a count badge.
      gnome(0, { x: 3, y: 5 }),
      gnome(0, { x: 3, y: 5 }),
      gnome(0, { x: 3, y: 5 }),
      // Already moved this turn: drawn dimmed.
      gnome(1, { x: 4, y: 1 }, true),
      // A standoff: two seats on one space widens the square.
      gnome(1, { x: 5, y: 5 }),
      gnome(2, { x: 5, y: 5 }),
      gnome(2, { x: 6, y: 3 }),
      snail(3, { x: 7, y: 7 }),
    ]);

    d.events = previewEvents();
    d.eventCount = d.events.length;
  });
}

/**
 * A log with one of every line worth reading: chat, a plant, an upgrade, a
 * fight, a death, an elimination. `GameLogView` and the chat transcript both
 * render off `state.events`, so this is what fills them.
 */
function previewEvents(): GameEvent[] {
  return [
    { type: 'turnStarted', player: 0, turnNumber: 3 },
    { type: 'quickChatSaid', player: 0, phraseId: 'hi' },
    { type: 'wishesGained', player: 0, requested: 2, gained: 1, lost: 1 },
    { type: 'gardenPlanted', player: 1, pos: { x: 7, y: 3 }, gardenType: 'dandelion' },
    { type: 'gardenUpgraded', player: 0, pos: { x: 2, y: 1 }, gardenType: 'dandelion' },
    { type: 'cardDrawn', player: 0, cardId: 'wild-growth' },
    { type: 'cardPlayed', player: 2, cardId: 'plot-twist' },
    { type: 'quickChatSaid', player: 2, phraseId: 'nice-one' },
    { type: 'fightStarted', fightId: 1, pos: { x: 5, y: 5 }, sides: [{ kind: 'player', player: 1 }, { kind: 'player', player: 2 }], cause: 'entry' },
    { type: 'fightRoundStarted', fightId: 1, round: 1 },
    { type: 'fightRolled', fightId: 1, round: 1, rolls: [4, 4], tie: true, casualtyCandidates: ['u6', 'u7'] },
    { type: 'fightRolled', fightId: 1, round: 2, rolls: [6, 2], tie: false, casualtyCandidates: ['u6', 'u7'] },
    { type: 'quickChatSaid', player: 1, phraseId: 'uh-oh' },
    { type: 'unitDestroyed', player: 3, unitId: 'u99', unitKind: 'gnome', pos: { x: 8, y: 4 }, cause: 'fight' },
    { type: 'playerEliminated', player: 3, reason: 'reinforcements' },
  ] as GameEvent[];
}

/** The same board with every highlight kind on show, plus a selected space. */
export function previewHighlights(): Map<string, 'move' | 'decision' | 'target' | 'picked'> {
  return new Map([
    [posKey({ x: 2, y: 5 }), 'move' as const],
    [posKey({ x: 3, y: 6 }), 'move' as const],
    [posKey({ x: 4, y: 5 }), 'decision' as const],
    [posKey({ x: 5, y: 5 }), 'target' as const],
    [posKey({ x: 6, y: 3 }), 'picked' as const],
  ]);
}

/** The space `Board` draws its selection ring on. */
export const PREVIEW_SELECTED_KEY = posKey({ x: 3, y: 5 });

/**
 * A live fight, mid-round, with a response window open for seat 1 — which is
 * what puts `FightPanel` into its interactive form rather than its watching
 * one. The two rolls above are the same fight, so the clash shows a real
 * result rather than an empty frame.
 */
export function fightFixture(): GameState {
  return edit(previewState(), (d) => {
    const fight: FightState = {
      id: 1,
      pos: { x: 5, y: 5 },
      sides: [{ kind: 'player', player: 1 }, { kind: 'player', player: 2 }],
      targetUnit: null,
      pinned: null,
      cause: 'entry',
      round: 2,
      respondIdx: 0,
      passes: 0,
    };
    d.fight = fight;
    d.pendingDecision = {
      kind: 'fightRespond',
      player: 1,
      fightId: 1,
      playableCards: ['snake-eyes'],
    };
  });
}

/** Every curse in the game, revealed — the panel at its tallest. */
export function cursedFixture(): GameState {
  return edit(previewState(), (d) => {
    d.activeCurses = [
      'curse-compost-combustion',
      'curse-snailmaggedon',
      'curse-magic-drain',
      'curse-mulch-fever',
      'curse-antsy-pants',
    ];
  });
}

/** The decisions worth showing, each with the state it belongs to. */
export interface DecisionFixture {
  label: string;
  note: string;
  state: GameState;
  decision: PendingDecision;
  interactive: boolean;
}

export function decisionFixtures(): DecisionFixture[] {
  const base = previewState();
  const withDecision = (decision: PendingDecision): GameState =>
    edit(base, (d) => {
      d.pendingDecision = decision;
    });

  const rollOff: PendingDecision = { kind: 'rollOff', player: 0 };
  const homeHarvest: PendingDecision = {
    kind: 'homeHarvest',
    player: 0,
    options: ['wish', 'gnome'],
  };
  const slide: PendingDecision = {
    kind: 'slide',
    player: 0,
    unitId: 'u1',
    from: { x: 1, y: 1 },
    options: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
    optional: true,
    context: 'entry',
    hops: 0,
  };
  const mushroom: PendingDecision = {
    kind: 'mushroomClones',
    player: 0,
    pos: { x: 3, y: 1 },
    max: 2,
  };

  return [
    {
      label: 'Roll-off',
      note: 'The opening decision — the loudest title in the panel.',
      state: withDecision(rollOff),
      decision: rollOff,
      interactive: true,
    },
    {
      label: 'Home harvest',
      note: 'A two-option choice; both options carry a resource icon.',
      state: withDecision(homeHarvest),
      decision: homeHarvest,
      interactive: true,
    },
    {
      label: 'Slide (optional)',
      note: 'Board-position options, plus a decline.',
      state: withDecision(slide),
      decision: slide,
      interactive: true,
    },
    {
      label: 'Mushroom clones',
      note: 'A numeric choice.',
      state: withDecision(mushroom),
      decision: mushroom,
      interactive: true,
    },
    {
      label: 'Waiting (not interactive)',
      note: 'What every seat sees while somebody else decides.',
      state: withDecision(rollOff),
      decision: rollOff,
      interactive: false,
    },
  ];
}

/** The preview game with the first seat's hand emptied. */
export function emptyHandFixture(): GameState {
  return edit(previewState(), (d) => {
    d.players[0].hand = [];
  });
}

/**
 * TEMPORARY — the Board Art Scale specimen (see UiPreview.tsx, `#board-art`).
 *
 * A 7×7 board — the default size, so the `cqi / --n` clamps land where a real
 * game's do — laid out as a table rather than a position. Rows 0–5 are the six
 * gardens under review; row 6 is the same three unit states with no garden, as
 * the baseline a gnome has to read against anyway.
 *
 *   col 0  garden only
 *   col 1  garden + one gnome
 *   col 2  garden + a 3-gnome stack (count badge)
 *   col 3  upgraded garden + one gnome (the ⭐ badge also lives top-left)
 *   col 4+ empty, unoccupied cells
 *
 * The seat rotates by row so every gnome colourway meets a garden; the Home
 * row is seat 0 standing on its own home, which is the common case.
 */
export const BOARD_ART_ROWS: GardenType[] = ['mushroom', 'flytrap', 'dandelion', 'tunnel', 'slippery', 'home'];

export function boardArtScaleFixture(): GameState {
  nextId = 1;
  const base = createGame(
    {
      players: SEAT_NAMES.map((name) => ({ name, controller: 'human' as const })),
      boardSize: 7,
      gardenPreset: 'none',
      centerStar: false,
    },
    7,
  );
  return edit(base, (d) => {
    d.status = 'playing';
    d.turn = { number: 3, activePlayer: 0, phase: 'action', snailLostFight: false, snailEatOffered: false };
    d.gardens = {};
    d.units = {};
    BOARD_ART_ROWS.forEach((type, y) => {
      const seat = type === 'home' ? 0 : (y + 1) % 4;
      // A flytrap left without `stunnedForPlayerTurn: null` draws as stunned.
      const extra = type === 'home' ? { owner: 0 } : type === 'flytrap' ? { stunnedForPlayerTurn: null } : {};
      for (let x = 0; x < 4; x++) {
        if (x === 3 && type === 'home') continue; // a home has no upgraded form
        garden(d, { x, y }, type, x === 3 ? { ...extra, upgraded: true } : extra);
      }
      put(d, [gnome(seat, { x: 1, y }), gnome(seat, { x: 2, y }), gnome(seat, { x: 2, y }), gnome(seat, { x: 2, y })]);
      if (type !== 'home') put(d, [gnome(seat, { x: 3, y })]);
    });
    put(d, [gnome(1, { x: 1, y: 6 }), gnome(2, { x: 2, y: 6 }), gnome(2, { x: 2, y: 6 }), gnome(2, { x: 2, y: 6 })]);
  });
}
