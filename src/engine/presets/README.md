# Built-in garden presets, as files

Every `*.json` in this directory is registered as a built-in garden preset at
build time (`gardenPresets.ts` globs the folder). Adding one is a copy, not a
code change.

## The workflow

1. Run the game, go to setup, and pick **Preset: Custom** — or select any
   existing preset and press **✏️ Edit** to start from it.
2. Paint the layout. Home Gardens are movable: click one to pick it up, then
   click an empty space to drop it.
3. Give it a **Name** (required to save) and a one-line **Blurb**, then press
   **💾 Save & export**. The browser downloads
   `<name-slug>.whimsy-preset.json`.
4. Drop that file in this directory and rebuild. It appears in the preset menu
   for everyone.

## What the filename means

The preset's **id** is the filename minus `.json` and minus the
`.whimsy-preset` the editor adds — `midfield.whimsy-preset.json` registers as
`midfield`. That id is what `GameConfig.gardenPreset` stores, what replays
reference, and what multiplayer sends over the wire, so **renaming a file
renames the preset**: existing saves that reference the old id stop resolving.
Ids must also not collide with the hand-written presets in `gardenPresets.ts`
(`random`, `none`, `few`, `orchard`, `fortress`, `gauntlet`, `many`).

## Limits of the format

A file is plain data — positions and types for **one** board size. That covers
any fixed layout, including one that moves the homes, which is the whole point.
What it cannot express is a layout that *scales* with board size N or rolls
from the game seed; those stay hand-written in `gardenPresets.ts`. A file
authored for 7×7 still plays on a larger board — its `minBoardSize` is the size
it was drawn at, and the layout simply sits in the low corner.

A malformed file fails the build with the filename in the message, rather than
quietly vanishing from the menu. `presetFile.test.ts` and
`gardenPresets.test.ts` cover the rules; `invariants.test.ts` plays every
registered preset through the engine's structural checks.

## Multiplayer

Built-in presets travel as an id, not a layout, so both clients must be on the
same build to agree on what `midfield` means. A preset a player imports at
runtime instead travels as an explicit `customGardens`/`customHomes` layout and
needs no shared build.
