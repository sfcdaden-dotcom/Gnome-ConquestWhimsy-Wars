# Whimsy Wars — Canonical Rules Spec (v1)

This is the single source of truth for the digital implementation. It combines the
official rulebook with clarifications from the game's designer (the user). Where the
rulebook was ambiguous, the designer's ruling is marked **[RULING]**.

## Game settings (defaults, configurable at setup)

| Setting | Default |
|---|---|
| Board size | 7×7 |
| Starting Wishes | 3 |
| Wish limit | 3 |
| Gnome limit on board (per player) | 8 |
| Total reinforcements (per player) | 16 |
| Hand limit | 7 cards |
| Garden tiles per type (per player) | 4 |
| Players | 2 or 4 (each seat human or CPU) |
| Center Star | ON (toggleable) |

## Definitions

- **Space**: a single square. **Adjacent**: orthogonal only (no diagonals).
- **Critter**: anything that can fight — Gnomes, Immortal Snails, Flytrap Gardens.
- **Unit**: a critter controlled by a player — Gnomes and Immortal Snails (NOT flytraps).
- **Controlled space**: occupied only by units of a single player.
- **Contested space**: contains critters of different players.
- **Reserve**: units not on the board but still spawnable.
- **Enemy**: any critter not controlled by you.

## Setup

1. Each player gets a Home Garden, gnome supply, and 3 Wishes.
2. Home Gardens placed equidistant (digital version uses named layout presets —
   None/Few/Orchard/Fortress/Gauntlet/Many, see `gardenPresets.ts` — mirroring
   and extending the rulebook diagrams).
3. **[RULING]** Players start with **0 gnomes on the board**; you bootstrap via
   Home Garden harvest.
4. The 5 Curse Cards are shuffled into the Whimsy deck from the start.
5. Turn order: each player rolls d6, highest goes first (reroll ties), then clockwise.
6. **Center Star** (if enabled): the center space is marked. While a player
   **occupies** the center space, their wish limit is +1 (i.e. 4). This is a marker
   on the space, not a garden — the space is otherwise normal (can be planted on).

## Turn structure

Each turn has two phases, in order.

### 1. Harvest Phase

- **[RULING] Harvests are MANDATORY, not optional.** Every garden that qualifies
  activates. Effects with "up to N" or "your choice" still let the owner choose the
  specifics, but the harvest itself cannot be skipped. Resource rewards that would
  exceed a limit (wish cap, gnome limits) are discarded/lost.
- Your **Home Garden** always produces: your choice of **1 Wish or 1 Gnome**, even
  if unoccupied. **[RULING]** A spawned gnome is placed on the Home Garden space and
  counts against the 8-on-board and 16-total limits. If at either limit, gnome cannot
  be chosen (take the wish, or if at wish cap too, the reward is lost).
- Every **other garden you control** activates its harvest effect. A garden is under
  your control when a gnome you control occupies it.
- A garden only activates when **Active**: (a) the turn it was planted has ended,
  (b) one or more of the active player's gnomes occupy it, (c) no unresolved fights
  on the space. (Home Garden is the exception — it produces even when unoccupied.)
- The active player resolves their harvests in any order they choose.

### 2. Action Phase

Available actions, any number, any order:

- **Move a unit** to an adjacent space. Each unit may move at most 1 space per turn.
  Movement granted by cards or gardens (slides, tunnels) does NOT consume the unit's
  movement action.
- **Plant a garden**: when a gnome you control occupies an empty space (no garden,
  no enemies), pay 1 Wish and place any garden type from **your own supply**
  (4 tiles of each type per player; never a second Home Garden).
- **Upgrade a garden**: when a gnome you control occupies a non-Home garden you
  control (no enemy critters on the space), pay **2 Wishes** to flip it to its
  upgraded form. See **Garden Upgrades**.
- **Draw a Whimsy Card**: pay 1 Wish. Draw as many as you can afford. Hand limit 7 —
  if exceeded, discard down to 7 immediately.
- Play Whimsy Cards (Ritual Magic: own turn only; Sudden Magic: anytime, including
  other players' turns — this is a free action, not costing anything).

The turn ends when all your units have used their movement or you choose to pass.

## Gnomes

- Move 1 orthogonal space per turn (own movement).
- Entering a garden with an entry effect lets you **choose** to activate the entry
  effect, if: the garden wasn't planted this turn, and it contains no enemies.
  (Flytrap entry is NOT optional — see Flytrap.)
- Per-player limits: max 8 on board, 16 total ever spawned. When all 16 have been
  spawned and destroyed, that player is out of reinforcements and is eliminated.

## Fights

A fight starts **immediately** when a unit shares a space with an enemy critter, and
must fully resolve before anything else happens.

The 3 R's, in order:
1. **Respond** — players may play Whimsy cards to influence the fight.
2. **Roll** — both sides roll a d6.
3. **Resolve** — higher roll wins; the losing gnome is destroyed. Ties reroll
   (unless a curse says otherwise).

- **[RULING] Stack fights**: if multiple gnomes are on each side, fights resolve as
  repeated 1v1 rounds (full Respond → Roll → Resolve each round) until only one
  side's critters remain on the space. Each round destroys one losing gnome.
- Snail fight exception: see Immortal Snail.
- Flytrap fight exception: see Flytrap Garden.

## Elimination & the Immortal Snail

You are eliminated when either:
- **[RULING]** After all fights on the space resolve, an enemy unit (gnome or snail)
  solely occupies your Home Garden, OR
- You run out of reinforcements (16th gnome destroyed) — note: having 0 gnomes on
  board with reserves remaining is NOT elimination (you can respawn via Home harvest).

An eliminated player has lost, but may choose to continue as an **Immortal Snail**:
1. Discard all their Wishes and Whimsy Cards.
2. Remove their Home Garden and all their gnomes from the board.
3. Place their Snail where the Home Garden was.

Snail rules:
- Moves up to 1 space on its turn. It can fight.
- Any garden occupied by the Snail is **destroyed at the end of the Snail's turn**
  (returned to supply). This includes Home Gardens (which also means: a Snail
  occupying your Home Garden eliminates you, since the Snail is an enemy).
- If the Snail **loses** a fight it is not destroyed; its turn ends immediately and
  no gnomes/gardens are destroyed. If it **wins**, the losing gnome is destroyed
  as normal.
- A Snail cannot win the game. The game ends when only one non-snail player remains;
  that player wins.

## Gardens

Planting cost: always 1 Wish. Plant only on an empty space (no garden, no enemies)
occupied by your gnome, during your Action Phase.

**[RULING] Per-player supply.** Each player has their own supply of **4 tiles per
plantable type** — there is no shared bank. You always plant from your own supply,
and cards that plant gardens (Wild Growth, Pocket Shovel) draw from the card
player's supply. Every planted garden remembers its original planter.

A garden is removed ("destroyed") only by card effects or the Snail. A destroyed
garden returns to its **original planter's** supply as a basic (un-upgraded)
tile — regardless of who controlled or upgraded it since. **[RULING]** Gardens
pre-placed by a setup preset are **wild tiles**: they come from no player's
supply, count against nobody's 4, and are removed from the game permanently when
destroyed.

### Garden Upgrades

Any non-Home garden can be upgraded once to a stronger form — see each garden's
**Upgraded** entry below.

- **Cost & timing**: 2 Wishes, during your Action Phase, while a gnome you
  control occupies the garden and no enemy critters are on the space. You may
  upgrade a garden you didn't plant (including one you captured), and you may
  upgrade a garden the turn it was planted (it still becomes Active on the
  normal schedule).
- **[RULING] Upgrades belong to the tile, not the player.** Whoever controls the
  garden gets the upgraded effect — capturing an upgraded garden captures the
  upgrade. (Flytraps stay neutral: upgrading one strengthens it against
  everyone, including its upgrader.)
- One upgrade level only, and upgrades cannot be undone. If the garden is
  destroyed the upgrade is lost — the tile returns to its planter's supply as a
  basic tile (or leaves the game, if wild).

### Home Garden (economy)
- Harvest: owner chooses 1 Wish or 1 Gnome, even if unoccupied.
- Max 1 per player, never plantable. Enemy sole occupation = owner eliminated.
- Cannot be upgraded.

### Dandelion Garden (economy)
- Harvest: up to 2 occupying gnomes harvest 1 Wish each (i.e. +1 Wish if 1 gnome,
  +2 Wishes if 2+ gnomes, subject to wish cap; excess lost).
- **Upgraded — Golden Dandelion**: harvest unchanged; additionally, **while you
  control this garden your wish limit is +1**. Stacks with the Center Star and
  with other Golden Dandelions. (Balance watch-point: stacking — revisit after
  playtesting.)

### Mushroom Garden (economy)
- Harvest: clone up to 2 occupying gnomes (owner picks how many, capped by board/
  reserve limits). New gnomes spawn on this mushroom garden.
- **[RULING]** Spawned gnomes may move normally during the Action Phase of the turn
  they spawn (they do not get an extra harvest-phase move).
- **Upgraded — Elder Mushroom**: harvest clones up to **3** occupying gnomes
  (same board/reserve caps).

### Flytrap Garden (defense)
- **[RULING]** The Flytrap is a neutral hazard critter: once **Active** (planted on
  a previous turn), it fights ANY gnome that enters the space or harvests/occupies
  it during that player's Harvest Phase — including its planter's gnomes.
- On Entry: a fight starts immediately between the entering gnome and the flytrap
  (not optional).
- On Harvest (mandatory, since harvests are mandatory): the flytrap attacks each
  unit occupying it — a fight per occupying gnome.
- Fight mechanics vs flytrap: gnome's owner may Respond with cards; the flytrap's
  d6 is rolled by the system. If the gnome loses, it is destroyed. If the gnome
  wins, the flytrap is NOT destroyed — it is **stunned until the end of that
  player's turn** (no further fights triggered by it this turn).
- The flytrap cannot be destroyed by fighting; only by cards or the Snail.
- A space with a flytrap contains an enemy critter for everyone: it blocks planting
  (space isn't empty anyway), blocks entry effects, and blocks harvest of... itself
  (its "harvest" is the attack).
- **Upgraded — Snapping Maw**: the flytrap adds **+1 to its d6** in every fight —
  against all players, including its upgrader. Everything else is unchanged
  (winning still stuns it; it still can't be destroyed by fighting).

### Maize Garden (defense)
- On Exit: the exiting unit's owner pays 1 Wish. **[RULING]** If they cannot pay,
  the unit cannot exit. Applies to any player's units, any form of movement.
- On Harvest: the harvesting owner rolls a d6; if result < 4, the exit cost of this
  maize garden doubles (1→2) until the end of that player's turn.
  (Designer notes this harvest effect is provisional; keep implementation isolated.)
- **Upgraded — Thorn Maize**: base exit cost is **2 Wishes**. The harvest
  doubling applies to the upgraded cost (2→4) until end of turn.

### Slippery Garden (mobility)
- On Entry (optional): slide to an adjacent space (orthogonal).
- On Harvest (mandatory activation, slide itself is the player's choice of
  destination — may include diagonal spaces): slide to any adjacent or diagonal space.
- Slides do not consume the unit's movement action. Slides can trigger the entered
  space's entry effects/fights as normal entry.
- **Upgraded — Glacier**:
  - On Entry (optional): slide to an adjacent **or diagonal** space.
  - On Harvest (mandatory activation, destination is the player's choice):
    either slide **exactly 2 spaces orthogonally in a straight line**, or slide
    **1 space diagonally**. The straight slide passes *through* the middle
    space: it must not be blocked (e.g. Great Wall), but nothing on it triggers —
    no fights, no entry effects; you whoosh past enemies. Only the destination
    is a normal Entry. Directions without a legal full 2-line simply aren't
    offered; if no option is legal the harvest is skipped.

### Tunnel Garden (mobility)
- On Entry (optional): move to any other tunnel garden on the board.
- On Harvest: move to any other tunnel garden, OR to any garden occupied by one of
  your own gnomes.
- Tunnel moves don't consume movement actions; arriving is an Entry (triggers
  effects/fights).
- **Upgraded — Grand Burrow**: the *entry* effect offers the full harvest
  destination list (any other tunnel garden, OR any garden occupied by one of
  your own gnomes).

## Whimsy Cards

- Draw: pay 1 Wish during your Action Phase. Hand limit 7 (discard down immediately).
- **Sudden Magic**: playable at any time, including other players' turns.
- **Ritual Magic**: playable only during your own turn.
- Played cards go to a shared discard pile.
- **Curses**: all 5 Curse Cards are shuffled into the deck at the start, so any
  draw can turn one up. Drawing a Curse: reveal, resolve immediately; it affects
  ALL players and stays in effect for the rest of the game. When the shared deck
  empties, shuffle the discard into a new deck.
- **CARD LIST: see CARDS.md** (the designer's official list plus implementation
  rulings). The card system is data-driven: definitions + effect handlers live in
  `src/engine/cards.ts`.

## Win condition

Last non-snail player remaining wins. (Snails may still be on the board when the
game ends.)
