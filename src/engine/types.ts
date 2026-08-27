/**
 * Whimsy Wars engine — shared types.
 *
 * The engine is a pure, deterministic state machine:
 *   createGame(options, seed) -> GameState
 *   getLegalActions(state)    -> Action[]
 *   applyAction(state, act)   -> GameState   (never mutates its input)
 *
 * The state is always either awaiting a normal Action-Phase action from the
 * active player, or awaiting a specific typed decision (`state.pendingDecision`)
 * from a specific player. Everything in GameState is plain JSON-serializable
 * data (no functions, no class instances), so it can be snapshotted, diffed,
 * persisted and replayed.
 */

import type { PlayerAppearance } from './appearance';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Seat index, 0-based. Seats are arranged clockwise around the board. */
export type PlayerId = number;
/**
 * Unit identifier. **Contract:** `u` followed by a positive decimal integer,
 * allocated sequentially from `GameState.nextUnitId` across ALL unit kinds —
 * so snails consume ordinals too, and any one kind's ordinals have gaps.
 *
 * The ordinal is a stable, replayable per-game identity, which the UI's gnome
 * name generator indexes off (`src/ui/gnomeNames.ts`). Changing the format
 * means giving that generator another stable ordinal first; `engine.test.ts`
 * asserts the format at every creation site to make that a loud failure.
 */
export type UnitId = string;
export type CardId = string;
/** Id of a fixed quick-chat phrase (see quickchat.ts). Free text never exists. */
export type QuickChatId = string;

/** One entry of the quick-chat catalogue. */
export interface QuickChatPhrase {
  id: QuickChatId;
  /** Leading emoji, shown with the text everywhere. */
  emoji: string;
  /** The one and only wording a player can send with this id. */
  text: string;
}
/** `"x,y"` string key into `GameState.gardens`. */
export type PosKey = string;

export interface Pos {
  x: number;
  y: number;
}

export type GardenType =
  | 'home'
  | 'dandelion'
  | 'mushroom'
  | 'flytrap'
  | 'maize'
  | 'slippery'
  | 'tunnel';

export type PlantableGardenType = Exclude<GardenType, 'home'>;

/**
 * Every type a player can plant, or design a garden layout with (excludes
 * 'home'). Lives here rather than in setup.ts so the preset file format can
 * validate against it without importing the module that consumes presets.
 */
export const PLANTABLE_GARDEN_TYPES: readonly PlantableGardenType[] = [
  'dandelion',
  'mushroom',
  'flytrap',
  'maize',
  'slippery',
  'tunnel',
];

export type UnitKind = 'gnome' | 'snail';
export type PlayerController = 'human' | 'cpu';
/** CPU strength. Meaningless for 'human' seats, but stored uniformly. Default 'normal'. */
export type AiDifficulty = 'easy' | 'normal' | 'hard';

/**
 * 'playing'  — normal participant.
 * 'snail'    — eliminated, continuing as an Immortal Snail (cannot win).
 * 'out'      — eliminated and no longer on the board at all.
 */
export type PlayerStatus = 'playing' | 'snail' | 'out';

/** Id of a registered garden preset — see `GARDEN_PRESETS` in gardenPresets.ts. */
export type GardenPreset = string;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PlayerSetup {
  name?: string;
  controller: PlayerController;
  /** CPU strength; ignored for 'human'. Defaults to 'normal'. */
  difficulty?: AiDifficulty;
  /**
   * What this seat's gnome should look like. Every field is optional and any
   * field left out is DERIVED from the game's seed — an omitted appearance is
   * a random gnome, not a default one. See engine/appearance.ts.
   */
  appearance?: Partial<PlayerAppearance>;
}

/** Fully-resolved game configuration (stored on the state). */
export interface GameConfig {
  /** Odd number >= 5 (>= the chosen preset's minBoardSize). Default 7. */
  boardSize: number;
  /** Default 3. */
  startingWishes: number;
  /** Default 3. +1 while the player occupies the Center Star space. */
  wishLimit: number;
  /** Max gnomes on the board per player. Default 8. */
  gnomeBoardLimit: number;
  /** Total gnomes a player may ever spawn. Default 16. */
  totalReinforcements: number;
  /** Default 7. */
  handLimit: number;
  /** Center Star marker on the center space. Default true. */
  centerStar: boolean;
  /** Garden tiles of each plantable type in each player's supply. Default 4. */
  tilesPerType: number;
  /**
   * Per-card deck composition, overriding the stock copy counts (2 of each
   * Whimsy card, 1 of each Curse — see cards.ts). Sparse: only the cards that
   * differ need an entry, and 0 removes a card from the deck entirely. Plain
   * data, so it round-trips through save/replay like the rest of GameConfig.
   */
  deckCounts?: Record<CardId, number>;
  /** Additional-garden layout preset. Default 'none'. */
  gardenPreset: GardenPreset;
  /**
   * Explicit additional-garden layout, e.g. from a player-built custom
   * preset. When present, this is used verbatim instead of looking
   * `gardenPreset` up in the built-in registry (gardenPresets.ts) — but
   * `gardenPreset` is still stored for display purposes. Plain data, so it
   * round-trips through save/replay like the rest of GameConfig.
   */
  customGardens?: Array<{ pos: Pos; type: PlantableGardenType }>;
  /**
   * Explicit Home Garden positions, overriding the standard edge-midpoint
   * formula (`homePositions`). Must have exactly one entry per seat — a
   * player-built preset that moved the homes supplies all 4 in seat order
   * (west/north/east/south by convention) and the 2-player case uses indices
   * 0 and 2 of that array, mirroring how `homePositions` itself picks the
   * opposite pair for 2 players.
   */
  customHomes?: Pos[];
  /** 2 or 4 seats, clockwise. */
  players: Array<{
    name: string;
    controller: PlayerController;
    difficulty: AiDifficulty;
    /**
     * The seat's REQUEST, not its resolved look: absent fields are filled in
     * from the seed at `createGame`, and a requested palette can still be
     * refused if an earlier seat asked for it first. The resolved appearance
     * lands on `PlayerState.appearance`.
     *
     * Optional so a `MatchRecord` written before character select still
     * replays — such a game simply had no requests, and its seats derive.
     */
    appearance?: Partial<PlayerAppearance>;
  }>;
}

/** Input to createGame: players required, everything else defaulted. */
export type CreateGameOptions = Partial<Omit<GameConfig, 'players'>> & {
  players: PlayerSetup[];
};

// ---------------------------------------------------------------------------
// Board entities
// ---------------------------------------------------------------------------

export interface Garden {
  type: GardenType;
  /** Owner seat — Home Gardens only. */
  owner?: PlayerId;
  /**
   * Seat whose tile supply this garden came from. Destruction returns the
   * tile (as a basic tile) to this player's supply. Absent = wild tile
   * (preset/setup garden): destroyed wild gardens leave the game permanently.
   */
  plantedBy?: PlayerId;
  /**
   * Upgraded form (Golden Dandelion, Elder Mushroom, Snapping Maw, Thorn
   * Maize, Glacier, Grand Burrow). The upgrade belongs to the TILE — whoever
   * controls the garden gets the upgraded effect — and is lost on destruction.
   */
  upgraded?: true;
  /**
   * Global turn number the garden was planted on (0 = pre-game setup).
   * A garden is Active once `plantedOnTurn < turn.number`.
   */
  plantedOnTurn: number;
  /** Flytrap only: stunned until the end of this player's turn. */
  stunnedForPlayerTurn: PlayerId | null;
  /** Maize only: exit cost doubled until the end of this player's turn. */
  doubledForPlayerTurn: PlayerId | null;
  /** Sundown Sabotage: this garden skips its next harvest. */
  skipNextHarvest?: boolean;
}

export interface Unit {
  id: UnitId;
  owner: PlayerId;
  kind: UnitKind;
  pos: Pos;
  /** Global turn number this unit last used its own 1-space move. */
  movedOnTurn: number | null;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  /**
   * The seat's resolved gnome. Public information: it is on the board for
   * everyone to see, so `viewFor` does not redact it.
   */
  appearance: PlayerAppearance;
  /**
   * Which side this seat plays for — seats sharing a palette share a team.
   * Grouped once at `createGame` (see teams.ts) so that no RULE ever reads a
   * palette: character select decides the sides, and the rules only ever ask
   * about `team`.
   *
   * In a free-for-all every seat is its own team and this is just the seat
   * index, which is why teams changed no existing behaviour.
   */
  team: number;
  controller: PlayerController;
  difficulty: AiDifficulty;
  status: PlayerStatus;
  wishes: number;
  hand: CardId[];
  /** Total gnomes ever spawned (max = totalReinforcements). */
  gnomesSpawned: number;
  /** Total gnomes destroyed. gnomesLost === totalReinforcements ⇒ eliminated. */
  gnomesLost: number;
  /**
   * Where this player's Home Garden was placed at setup. Kept even if the
   * garden is later destroyed (the Snail is placed here on conversion).
   */
  homePos: Pos;
  /**
   * This player's remaining garden tiles per plantable type (no shared bank).
   * Destroyed gardens return to their original planter's supply.
   */
  supply: Record<PlantableGardenType, number>;
  /**
   * Quickchats sent since the allowance last refilled (start of any turn, and
   * game end). Capped by QUICK_CHAT_PER_TURN — see quickchat.ts.
   */
  quickChatsThisTurn: number;
}

// ---------------------------------------------------------------------------
// Turn / phase machinery
// ---------------------------------------------------------------------------

export type TurnPhase = 'harvest' | 'action';

export interface TurnState {
  /** Global player-turn counter, starts at 1. */
  number: number;
  activePlayer: PlayerId;
  phase: TurnPhase;
  /** Set when the active Snail lost a fight this turn (skips garden destruction). */
  snailLostFight: boolean;
}

export interface RolloffState {
  /** Players still competing in the current roll-off round. */
  participants: PlayerId[];
  /** Players who have not yet rolled this round. */
  pending: PlayerId[];
  /** Rolls of the current round, by seat (null = not rolled this round). */
  rolls: Array<number | null>;
}

// ---------------------------------------------------------------------------
// Harvest machinery
// ---------------------------------------------------------------------------

export type HarvestSourceKind = 'home' | 'garden' | 'flytrap';

export interface HarvestSource {
  /** Unique key used in ChooseHarvestAction. 'home' or the garden's PosKey. */
  key: string;
  kind: HarvestSourceKind;
  pos: Pos;
  gardenType: GardenType;
}

export interface HarvestMove {
  unitId: UnitId;
  effect: 'slippery' | 'tunnel';
  /** Position of the garden that triggered the move (unit must still be there). */
  pos: Pos;
}

export interface HarvestState {
  /** Unresolved harvest sources, resolved one at a time in owner-chosen order. */
  remaining: HarvestSource[];
  /** Pending per-gnome slide/tunnel resolutions of the current source. */
  moveQueue: HarvestMove[];
  /**
   * Snailmaggedon curse: snail owners who may still move their snail 1 space
   * during this Harvest Phase (in turn order).
   */
  snailMoves: PlayerId[];
}

// ---------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------

export type FightSide =
  | { kind: 'player'; player: PlayerId }
  | { kind: 'flytrap' };

export type FightCause = 'entry' | 'harvest' | 'placement' | 'card';

/**
 * sides[0] is the defender (responds first in the Respond window),
 * sides[1] is the attacker / initiator (relevant for the Mulch Fever curse).
 */
export interface FightState {
  id: number;
  pos: Pos;
  sides: [FightSide, FightSide];
  /** Flytrap fights are 1v1 against this specific unit. */
  targetUnit: UnitId | null;
  /**
   * Instigation: the fight is pinned to two specific gnomes ([defender,
   * attacker], matching `sides`) who fight without moving, wherever they are.
   */
  pinned: [UnitId, UnitId] | null;
  cause: FightCause;
  round: number;
  /** Which side's respond window is currently open (index into sides). */
  respondIdx: 0 | 1;
  /** Consecutive passes; 2 ⇒ Respond is over, Roll happens. */
  passes: number;
}

export interface QueuedFight {
  pos: Pos;
  sides: [FightSide, FightSide];
  targetUnit: UnitId | null;
  pinned: [UnitId, UnitId] | null;
  cause: FightCause;
}

// ---------------------------------------------------------------------------
// Eliminations
// ---------------------------------------------------------------------------

export type EliminationReason = 'home-captured' | 'home-destroyed' | 'reinforcements';

export interface PendingElimination {
  player: PlayerId;
  reason: EliminationReason;
}

// ---------------------------------------------------------------------------
// Card stack & timed effects
// ---------------------------------------------------------------------------

/** A Whimsy card that has been played and awaits resolution (LIFO stack). */
export interface CardStackEntry {
  player: PlayerId;
  cardId: CardId;
  targets?: CardTargets;
  /** A counter-card sets this on its victim; a cancelled card resolves to nothing. */
  cancelled: boolean;
  /**
   * Set for cards played in a response window whose definition is flagged
   * `targetsRespondedCard` (Nope-Gnome): the stack index of the entry they
   * were played in response to.
   */
  respondsToStackIndex?: number;
}

export type TimedEffectKind = 'greatWall' | 'lostInMaize';

/** "Until your next turn" effects; expire at the start of the caster's turn. */
export interface TimedEffect {
  kind: TimedEffectKind;
  caster: PlayerId;
  /** greatWall: the walled garden's space. */
  pos?: Pos;
}

// ---------------------------------------------------------------------------
// Decisions (interrupt model)
// ---------------------------------------------------------------------------

export type HomeHarvestChoice = 'wish' | 'gnome';

// ---------------------------------------------------------------------------
// Phased card targeting
// ---------------------------------------------------------------------------

/**
 * One concrete, serializable target option for a single targeting step. The
 * engine offers these one step at a time (`getPendingDecisionOptions`) and the
 * player/AI answers with a `selectTarget` action carrying exactly one of them.
 * As targets accumulate they fold into a `CardTargets` payload (the same shape
 * a card's `validate` / `resolve` already consume).
 */
export type CardTarget =
  | { kind: 'unit'; unitId: UnitId }
  | { kind: 'space'; pos: Pos }
  | { kind: 'player'; playerId: PlayerId }
  | { kind: 'card'; cardId: CardId }
  | { kind: 'gardenType'; gardenType: PlantableGardenType };

export type TargetKind = CardTarget['kind'];

export type PendingDecision =
  | { kind: 'rollOff'; player: PlayerId }
  | { kind: 'chooseHarvest'; player: PlayerId; options: HarvestSource[] }
  | { kind: 'homeHarvest'; player: PlayerId; options: HomeHarvestChoice[] }
  | { kind: 'mushroomClones'; player: PlayerId; pos: Pos; max: number }
  | {
      kind: 'slide';
      player: PlayerId;
      unitId: UnitId;
      from: Pos;
      options: Pos[];
      /** true ⇒ entry effect (may be declined); false ⇒ mandatory harvest slide. */
      optional: boolean;
      context: 'entry' | 'harvest';
      /**
       * Relocations this unit has already taken in the current chain (this one
       * is hop number `hops + 1`). Bounds entry-effect chains — see
       * MAX_ENTRY_EFFECT_HOPS in gardens.ts.
       */
      hops: number;
    }
  | {
      kind: 'tunnel';
      player: PlayerId;
      unitId: UnitId;
      from: Pos;
      options: Pos[];
      optional: boolean;
      context: 'entry' | 'harvest';
      /** See the `slide` decision's `hops`. */
      hops: number;
    }
  | {
      kind: 'fightRespond';
      player: PlayerId;
      fightId: number;
      /** Sudden-magic cards this player could legally play right now. */
      playableCards: CardId[];
    }
  | {
      /** Response window: `player` may play Sudden Magic (e.g. Nope-Gnome)
       *  in response to the card at `stackIndex` before it resolves. */
      kind: 'cardResponse';
      player: PlayerId;
      respondingToCard: CardId;
      respondingToPlayer: PlayerId;
      stackIndex: number;
      playableCards: CardId[];
    }
  | { kind: 'discard'; player: PlayerId; mustDiscard: number }
  | { kind: 'snailify'; player: PlayerId }
  | {
      /** Magic Drain curse: choose one of your gnomes to sacrifice. */
      kind: 'sacrificeGnome';
      player: PlayerId;
      options: UnitId[];
    }
  | {
      /**
       * Move your snail 1 space. Two flavors, told apart by `context`:
       *  - `snailmaggedon`: the curse's optional bonus move during the current
       *    Harvest Phase (declineEffect passes),
       *  - `retreat`: the MANDATORY rout after the snail loses a fight — it
       *    must slither to an adjacent empty space and cannot be declined.
       */
      kind: 'snailMove';
      player: PlayerId;
      unitId: UnitId;
      from: Pos;
      options: Pos[];
      context: 'snailmaggedon' | 'retreat';
    }
  | {
      /**
       * Phased card targeting: `player` is midway through aiming `cardId`, one
       * target step at a time. The card is NOT yet removed from hand — it is
       * only committed (and re-validated) once the final step completes, so a
       * cancelled or invalidated targeting leaves the game exactly as it was.
       * The current step's legal options come from `getPendingDecisionOptions`
       * (they are recomputed from live state, never stored, so they cannot go
       * stale); `selected` holds the picks made in earlier steps.
       */
      kind: 'cardTargeting';
      player: PlayerId;
      cardId: CardId;
      /** Targets chosen so far, folded into the eventual CardTargets payload. */
      selected: CardTargets;
      /** Zero-based index of the step now awaiting a pick. */
      stepIndex: number;
      /** Total steps in this card's flow (for "1 of 2" UI). */
      stepCount: number;
      /** Kind of target the current step wants (for card-agnostic rendering). */
      targetKind: TargetKind;
      /** Human-readable prompt for the current step. */
      prompt: string;
      /**
       * The response window this play began inside, if any. Present ⇒ the play
       * resolves via that window's rules on completion (and restoring it is how
       * cancellation backs out); absent ⇒ a normal Action-Phase play.
       */
      restore?:
        | Extract<PendingDecision, { kind: 'cardResponse' }>
        | Extract<PendingDecision, { kind: 'fightRespond' }>;
    };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CardTargets {
  units?: UnitId[];
  spaces?: Pos[];
  players?: PlayerId[];
  /** Cards chosen from a zone (Another Gnomes Treasure: from the discard). */
  cards?: CardId[];
  /** Garden type choice (Wild Growth). */
  gardenType?: PlantableGardenType;
}

export type Action =
  // --- decision answers -----------------------------------------------------
  | { type: 'rollOff'; player: PlayerId }
  | { type: 'chooseHarvest'; player: PlayerId; sourceKey: string }
  | { type: 'homeHarvest'; player: PlayerId; take: HomeHarvestChoice }
  | { type: 'mushroomClones'; player: PlayerId; count: number }
  | { type: 'slide'; player: PlayerId; to: Pos }
  | { type: 'tunnel'; player: PlayerId; to: Pos }
  | { type: 'declineEffect'; player: PlayerId }
  | { type: 'respondPass'; player: PlayerId }
  | { type: 'respondPlayCard'; player: PlayerId; cardId: CardId; targets?: CardTargets }
  | { type: 'discardCard'; player: PlayerId; cardId: CardId }
  | { type: 'snailify'; player: PlayerId; accept: boolean }
  | { type: 'sacrificeGnome'; player: PlayerId; unitId: UnitId }
  | { type: 'snailMove'; player: PlayerId; to: Pos }
  // --- phased card targeting (answers a 'cardTargeting' decision) --------------
  | { type: 'selectTarget'; player: PlayerId; target: CardTarget }
  | { type: 'cancelTargeting'; player: PlayerId }
  // --- action-phase actions ---------------------------------------------------
  | { type: 'move'; player: PlayerId; unitId: UnitId; to: Pos }
  | { type: 'plant'; player: PlayerId; pos: Pos; gardenType: PlantableGardenType }
  | { type: 'upgrade'; player: PlayerId; pos: Pos }
  | { type: 'drawCard'; player: PlayerId }
  | { type: 'playCard'; player: PlayerId; cardId: CardId; targets?: CardTargets }
  | { type: 'endTurn'; player: PlayerId }
  // --- out-of-band (not a game move; never enumerated as a legal action) -------
  | { type: 'quickChat'; player: PlayerId; phraseId: QuickChatId };

export type ActionType = Action['type'];

// ---------------------------------------------------------------------------
// Events (append-only log; useful for UI animation & tests)
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'rollOffRolled'; player: PlayerId; roll: number }
  | { type: 'rollOffTie'; players: PlayerId[] }
  | { type: 'turnOrderDetermined'; first: PlayerId }
  | { type: 'turnStarted'; player: PlayerId; turnNumber: number }
  | { type: 'harvestPhaseStarted'; player: PlayerId; sources: string[] }
  | { type: 'actionPhaseStarted'; player: PlayerId }
  | { type: 'harvestSkipped'; sourceKey: string; reason: string }
  | { type: 'homeHarvested'; player: PlayerId; took: 'wish' | 'gnome' | 'nothing' }
  | { type: 'dandelionHarvested'; player: PlayerId; pos: Pos; gnomes: number }
  | { type: 'mushroomHarvested'; player: PlayerId; pos: Pos; cloned: number }
  | { type: 'maizeHarvested'; player: PlayerId; pos: Pos; roll: number; doubled: boolean }
  | { type: 'wishesGained'; player: PlayerId; requested: number; gained: number; lost: number }
  | { type: 'wishesSpent'; player: PlayerId; amount: number; reason: string }
  | { type: 'gnomeSpawned'; player: PlayerId; unitId: UnitId; pos: Pos }
  | { type: 'unitMoved'; player: PlayerId; unitId: UnitId; unitKind: UnitKind; from: Pos; to: Pos }
  | { type: 'unitSlid'; player: PlayerId; unitId: UnitId; unitKind: UnitKind; from: Pos; to: Pos; context: 'entry' | 'harvest' }
  | { type: 'unitTunneled'; player: PlayerId; unitId: UnitId; unitKind: UnitKind; from: Pos; to: Pos; context: 'entry' | 'harvest' }
  | { type: 'entryEffectDeclined'; player: PlayerId; unitId: UnitId; unitKind: UnitKind; pos: Pos }
  | { type: 'entryChainCapped'; player: PlayerId; unitId: UnitId; unitKind: UnitKind; pos: Pos; hops: number }
  | { type: 'quickChatSaid'; player: PlayerId; phraseId: QuickChatId }
  | { type: 'gardenPlanted'; player: PlayerId; pos: Pos; gardenType: PlantableGardenType }
  | { type: 'gardenUpgraded'; player: PlayerId; pos: Pos; gardenType: PlantableGardenType }
  | { type: 'gardenDestroyed'; pos: Pos; gardenType: GardenType; cause: 'snail' | 'card' | 'elimination' }
  | { type: 'maizeExitPaid'; player: PlayerId; pos: Pos; cost: number }
  | { type: 'cardDrawn'; player: PlayerId; cardId: CardId }
  | { type: 'cardDiscarded'; player: PlayerId; cardId: CardId }
  | { type: 'cardPlayed'; player: PlayerId; cardId: CardId }
  | { type: 'cardResolved'; player: PlayerId; cardId: CardId }
  | { type: 'cardCancelled'; player: PlayerId; cardId: CardId }
  | { type: 'cardFizzled'; player: PlayerId; cardId: CardId; reason: string }
  | { type: 'cardStolen'; from: PlayerId; to: PlayerId; cardId: CardId }
  | { type: 'curseRevealed'; player: PlayerId; cardId: CardId }
  | { type: 'deckReshuffled'; curseAdded: CardId | null }
  | { type: 'rollModified'; player: PlayerId; raw: number; modifier: number; result: number }
  | { type: 'destructionPrevented'; player: PlayerId; unitId: UnitId; unitKind: UnitKind }
  | { type: 'gnomesMarried'; unitA: UnitId; unitB: UnitId }
  | { type: 'unitTeleported'; player: PlayerId; unitId: UnitId; unitKind: UnitKind; from: Pos; to: Pos; cardId: CardId }
  | { type: 'spacesSwapped'; a: Pos; b: Pos }
  | { type: 'timedEffectStarted'; kind: TimedEffectKind; player: PlayerId; pos: Pos | null }
  | { type: 'timedEffectExpired'; kind: TimedEffectKind; player: PlayerId }
  | { type: 'fightStarted'; fightId: number; pos: Pos; sides: [FightSide, FightSide]; cause: FightCause }
  | { type: 'fightRoundStarted'; fightId: number; round: number }
  | {
      type: 'fightRolled';
      fightId: number;
      round: number;
      /**
       * The two sides' rolls. A roll belongs to the SIDE (a seat, with that
       * seat's Snake Eyes / 4 Leaf Clover modifiers applied), never to a unit.
       */
      rolls: [number, number];
      tie: boolean;
      /**
       * The unit each side stands to lose if it loses this round — NOT a
       * combatant that rolled. `null` for a flytrap side (it is stunned, never
       * destroyed) and for a side whose only critters are snails. Always a
       * gnome when non-null. See `casualtyCandidate` in fights.ts.
       */
      casualtyCandidates: [UnitId | null, UnitId | null];
    }
  | { type: 'unitDestroyed'; player: PlayerId; unitId: UnitId; unitKind: UnitKind; pos: Pos; cause: string }
  | { type: 'flytrapStunned'; pos: Pos; untilEndOfTurnOf: PlayerId }
  | { type: 'snailSurvivedLoss'; player: PlayerId; pos: Pos }
  | { type: 'snailRetreatBlocked'; player: PlayerId; pos: Pos }
  | { type: 'fightEnded'; fightId: number; pos: Pos }
  | { type: 'playerEliminated'; player: PlayerId; reason: EliminationReason }
  | { type: 'playerSnailified'; player: PlayerId; pos: Pos }
  | { type: 'snailifyDeclined'; player: PlayerId }
  | { type: 'turnEnded'; player: PlayerId }
  | {
      type: 'gameFinished';
      /** The sole winning seat, or null when a TEAM of more than one won. */
      winner: PlayerId | null;
      /** The winning team, or null for a draw. Set whenever anyone won. */
      winningTeam: number | null;
      /** Every surviving seat on the winning team, in seat order. */
      winners: PlayerId[];
    };

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export type GameStatus = 'rolloff' | 'playing' | 'finished';

export interface GameState {
  schemaVersion: 1;
  config: GameConfig;
  /** Seed the game was created with (informational). */
  seed: number;
  /** Current mulberry32 RNG state. ALL randomness flows through this. */
  rngState: number;
  status: GameStatus;
  rolloff: RolloffState | null;
  players: PlayerState[];
  /** Gardens by "x,y" PosKey. */
  gardens: Record<PosKey, Garden>;
  /** Units by UnitId. */
  units: Record<UnitId, Unit>;
  /** Draw pile (top = last element). Card ids reference cards.ts definitions. */
  deck: CardId[];
  discard: CardId[];
  /** Curse card ids not yet shuffled into the deck. */
  cursePool: CardId[];
  /** Curses revealed so far; permanently in effect. */
  activeCurses: CardId[];
  turn: TurnState | null;
  harvest: HarvestState | null;
  fight: FightState | null;
  fightQueue: QueuedFight[];
  /** Whimsy cards played but not yet resolved (LIFO). */
  cardStack: CardStackEntry[];
  /** Players still owed a response window to the top of the card stack. */
  responseQueue: PlayerId[];
  /** Pending "next dice roll" modifiers per seat (Snake Eyes / 4 Leaf Clover). */
  rollModifiers: number[];
  /** Gnomebody Dies shields: next gnome destructions this turn are prevented. */
  preventionShields: number;
  /** Gnomio & Juliet marriages: destroying one destroys the partner. */
  marriages: Array<[UnitId, UnitId]>;
  /** Great Wall Of Whimsy / Lost In The Maize ("until your next turn"). */
  timedEffects: TimedEffect[];
  eliminationQueue: PendingElimination[];
  /** Force the active player's turn to end as soon as interrupts settle. */
  turnMustEnd: boolean;
  pendingDecision: PendingDecision | null;
  /**
   * The sole winning seat, or null. Null does NOT mean "no winner" now that
   * teams exist — a 2v2 win has two winners and leaves this null with
   * `winningTeam` set. Use `winningSeats(state)` for "who won"; this field is
   * kept because in a free-for-all (every seat its own team) it still means
   * exactly what it always did.
   */
  winner: PlayerId | null;
  /** The winning team, or null while the game runs and for a draw. */
  winningTeam: number | null;
  nextUnitId: number;
  nextFightId: number;
  /**
   * Rolling window of the most recent events (engine trims to the last 1000
   * after each action so long games stay cheap to clone). Use `eventCount`
   * to diff "events added by an action" across states.
   */
  events: GameEvent[];
  /** Total events ever emitted (monotonic; never trimmed). */
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EngineErrorCode =
  | 'ILLEGAL_ACTION' // the action is not legal in the current state
  | 'BAD_ARGUMENT' // malformed payload (unknown ids, out-of-range values)
  | 'BAD_CONFIG' // invalid createGame options
  | 'INTERNAL'; // engine invariant violated (bug)

/** All engine rejections are thrown as EngineError with a clear message. */
export class EngineError extends Error {
  code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
