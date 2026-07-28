# Garden Upgrades & Per-Player Supply — Design + Implementation Notes

Design finalized with the designer on 2026-07-28; implemented the same day
(see ROADMAP.md milestone 14 for the delivery summary — the implementation map
below doubles as a guide to where everything lives). The rules themselves live in
**RULES.md** (settings table, Action Phase, "Garden Upgrades", and the
per-garden **Upgraded** entries) — that stays the single source of truth. This
document records the *why* behind the rulings and maps the work onto the
codebase for the implementation phase.

## Feature summary

1. **Upgrade action**: 2 Wishes, Action Phase, gnome-you-control on a non-Home
   garden you control (no enemies on the space). One level. Upgradable the turn
   it was planted; upgradable even if you didn't plant it.
2. **Tile-sticky upgrades**: the upgrade belongs to the tile. Capture the
   garden, capture the upgrade. Flytraps stay neutral (an upgraded flytrap is
   stronger against its upgrader too).
3. **Per-player supply**: 4 tiles per plantable type per player, replacing the
   shared bank of 8. Gardens remember their planter; destruction returns a
   *basic* tile to the planter. Preset gardens are **wild**: from nobody's
   supply, gone forever when destroyed.
4. Upgraded forms: Golden Dandelion (+1 wish cap while controlled), Elder
   Mushroom (+2 gnome board limit while controlled; harvest unchanged —
   reworked 2026-07-28, see below), Snapping Maw (flytrap d6 +1), Thorn Maize
   (exit toll 2, doubles to 4), Glacier (diagonal entry slide; harvest =
   exactly-2 orthogonal straight slide through the middle space, or 1
   diagonal), Grand Burrow (entry gets the harvest destination list). No Home
   upgrade.

## Design rationale

- **Why capturable (tile-sticky)?** Non-home gardens have no owner in the
  engine — control is pure occupancy (`beginHarvestPhase`). Keeping that model
  makes upgraded gardens *map objectives*: an investment you must garrison and
  an asset worth taking. It also makes the Snail scarier (it destroys
  investments, refunding only a basic tile) and gives garden-destruction cards
  real targets. Implementation cost is near zero because control already works
  this way.
- **Why cost 2?** Wish cap is 3 (4 on Center Star) and planting costs 1.
  Upgrade-at-2 is "plant plus one extra home-harvest turn of saving" — a real
  investment that doesn't force cap-sitting. Plant+upgrade in one turn costs 3,
  which is self-limiting.
- **Why Golden Dandelion raises the cap instead of output?** With a cap of 3,
  extra wish *income* mostly evaporates (excess is discarded). Raising the cap
  mirrors the Center Star rule shape players already know and makes it a
  genuine economy engine. Stacking (multiple Golden Dandelions + Center Star)
  is allowed for now — flagged as a balance watch-point.
- **Elder Mushroom rework (2026-07-28)**: originally "clone up to 3". Reworked
  at the designer's request to **+2 to your gnome board limit while you
  control it** (stacking, tile-sticky like every upgrade), with the harvest
  clone cap staying at 2. Rationale: the clone-cap bump compounded the
  already-observed mushroom-economy tempo spike (see the balance note below),
  while a board-limit raise is the same "raise the cap, not the income" shape
  as the Golden Dandelion — it only pays off when the 8-gnome limit actually
  pinches, and it self-neutralizes when the garden is lost (gnomes already on
  the board survive; you just can't spawn more while over the limit — the
  same over-cap behavior as wishes when a Golden Dandelion falls).
  Implemented as `gnomeBoardCap` in `helpers.ts`, mirroring `wishCap`;
  everything that spawns gnomes (home harvest, mushroom clones, Seeing
  Double) flows through `canSpawnGnome` and picks it up automatically.
- **Why per-player supply?** Gardens become personal assets. Note the
  deliberate side effect: 2p totals per type stay 8 (4+4), 4p grows 8 → 16, and
  the shared-bank *supply-denial* strategy disappears. Accepted by the designer.
- **Glacier middle space**: slid *through*, so a wall blocks the line, but
  nothing on it triggers — letting a gnome slide past a blocking enemy is the
  upgrade's signature trick. Only the destination is a normal Entry.

## Rulings that will surprise implementers

- Destroyed gardens return to the **original planter** (new `plantedBy` field),
  never to the destroyer/controller, always as a basic tile.
- **Wild Growth** and **Pocket Shovel** plant from the **card player's** supply
  (they currently mutate the shared `supply`); their "supply empty" validation
  messages become per-player.
- Presets no longer consume supply at setup (`setup.ts` currently decrements it
  and errors on exhaustion). Preset size is no longer supply-bound — keep only
  board-fit validation. `gardenPresets.ts`'s "8 per type" comment is obsolete.
- Upgrading is legal on an Inactive (just-planted) garden; Activeness gates
  harvest, not upgrading.
- Snapping Maw's +1 applies to the *system-rolled* flytrap d6 (fight resolution
  in `fights.ts`), not to player rolls; ties (e.g. 5+1 vs 6) still reroll.

## Implementation map

| Area | Change |
|---|---|
| `types.ts` | `Garden` gains `upgraded?: true` and `plantedBy?: PlayerId` (absent = wild/preset). Supply moves per-player (e.g. onto `PlayerState` or `supplies: Record<PlayerId, …>`). Config gains `tilesPerType` (default 4). New action + event types (`upgradeGarden` / `gardenUpgraded`). |
| `setup.ts` | Init per-player supplies; presets become wild (no supply decrement, drop the exhaustion `badConfig`). |
| `actions.ts` | `plant` uses the actor's supply and stamps `plantedBy`; new `upgrade` action (cost 2, control checks, non-home, not already upgraded). |
| `legalActions.ts` | Plant intents read own supply; new upgrade intents. |
| `gardens.ts` | Harvest switch branches on `upgraded` (dandelion unchanged, mushroom clone cap stays 2 with board room read from `gnomeBoardCap`, maize doubling on base 2, glacier move options, grand-burrow entry options in `handleEntry`). Glacier straight-slide needs a new decision option shape (destination + implied middle-space wall check). |
| `helpers.ts` | `destroyGarden`: return basic tile to `plantedBy`'s supply or drop wild tiles. `wishCap`: count controlled Golden Dandelions. `gnomeBoardCap`: +2 per controlled Elder Mushroom, read by `canSpawnGnome`. `maizeExitCost`: read `upgraded`. |
| `fights.ts` | Flytrap side rolls d6+1 when the garden is upgraded. |
| `cards.ts` | Wild Growth / Pocket Shovel switch to the player's supply; planted tiles get `plantedBy`. |
| `encode.ts` | Schema bump: `upgraded` board plane, per-relative-seat supply scalars replacing the shared block (`SUPPLY_PER_TYPE` semantics change), optional planter planes. All public info — no info-set concerns. |
| `samples.ts` / `selfplay.ts` | Follow the schema bump; replay determinism unaffected (new action is deterministic). |
| `ai.ts` | Teach the heuristic to upgrade (value per type), to weigh capturing enemy upgraded gardens, and to read its own supply. |
| UI | Upgrade button in the action bar, upgraded badge on `Board.tsx` tiles, per-player supply display, log lines for `gardenUpgraded`. |
| Tests | Per-type upgraded-harvest tests, glacier slide legality (walls in middle, slide-past-enemy, board edges), supply return-to-planter, wild-tile destruction, capture-the-upgrade scenario, cards-from-own-supply. |
| Docs | RULES.md done; CARDS.md notes for Wild Growth / Pocket Shovel; ROADMAP milestone 14. |

## Balance watch-points (revisit after playtesting)

- Golden Dandelion cap-stacking (cap 5+ is reachable with garrisons).
- Glacier sliding past blockers — check it doesn't trivialize flytrap/maize
  defenses.
- 4-player tile abundance (16/type total) — board may get crowded on 7×7.
- **Observed after implementation (2026-07-28)**: 2-player Hard AI-vs-AI games
  now end around turn 11 by home capture, noticeably faster than before —
  upgraded mushroom economies build armies quickly, and the AI sinks its
  wishes into planting + upgrading instead of drawing cards (default-config
  self-play seeds 1–40 contained zero card plays). Games stay coherent and
  terminate, and the AI card-play machinery still works when wishes are
  plentiful (the ML sample-extractor test now uses a wish-rich config for
  exactly this reason) — but the pace and the card economy's role are real
  design shifts to evaluate in playtesting.
