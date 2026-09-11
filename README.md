# 🧙 Whimsy Wars 🌼

A digital version of the Whimsy Wars tabletop game: harvest gardens, hoard
Wishes, and gnome your enemies into the compost. 2 or 4 players (any mix of
human hot-seat and CPU, with Easy/Normal/Hard difficulty per seat) on an N×N
garden board — start from one of three rolled-fresh symmetrical modes
(**Fresh**: homes only; **Bare Essentials**: a Mushroom and a Dandelion beside
every home; **True Random**: a full map), draw your own layout in the editor,
or pick one of the fixed classic layouts. An **advanced panel** on the setup
screen opens the rest of the game's shape: board size, the economies (starting
wishes, wish cap, gnome board limit, reinforcements), the per-card deck
counts, and a fixed seed. Play **local** (hot-seat and CPU on one device) or
**online** in a private room: host, share the six-character code, and fill any
empty seats with CPU. Online tables run a **shot clock** (a minute per action)
so one closed laptop cannot freeze the game. Table talk runs on **quick
chat**: a fixed phrase menu, never free text, budgeted per turn.

- **Rules:** [RULES.md](RULES.md) · **Cards:** [CARDS.md](CARDS.md)
- **Engine API & architecture:** [ENGINE_API.md](ENGINE_API.md)
- **Multiplayer (rooms, identity, anti-cheat):** [MULTIPLAYER.md](MULTIPLAYER.md)
- **Deploying / hosting:** [DEPLOYMENT.md](DEPLOYMENT.md)
- **Roadmap:** [ROADMAP.md](ROADMAP.md) · **Known debt:** [TECH_DEBT.md](TECH_DEBT.md)

## Getting started

```bash
npm install
npm run dev        # play at the printed localhost URL
npm test           # vitest: unit + seeded AI-vs-AI simulation suite
npm run lint       # oxlint
npm run build      # tsc -b (strict) && vite build

npx playwright install chromium   # once, for the browser tests
npm run test:e2e   # playwright: builds, serves and plays the app in a browser
```

CI (`.github/workflows/ci.yml`) runs all of the above from a clean `npm ci` on
every push and pull request.

## Art

Gardens and units are hand-drawn images in `src/assets/art/`, not emoji, so the
board looks the same on every platform. `src/ui/art.tsx` shows them as
`<GardenIcon>` and `<UnitIcon>`; sizing is left to the stylesheet, because an
icon is a board fixture in one place and a word in a sentence in another.

```
src/assets/art/
  Gardens/                    unit-gnome.png      (the stock gnome; a
    garden-home.png             unit-snail.png     placeholder while a custom
    garden-dandelion.png                           one composites, and what
    garden-mushroom.png                            shows where no seat owns
    garden-flytrap.png                             the gnome on screen)
    garden-maize.png
    garden-slippery.png
    garden-tunnel.png
  Gnome Assets/               one folder per layer — see below
```

To replace a garden or the stock gnome, overwrite the file: the filenames are
the whole contract, and `src/ui/artAssets.ts` is the one place that maps them to
game types (edit it to change a name or use another format Vite handles: SVG,
WebP, JPEG).

**Garden art** must be square and transparent, 128–256px, and read at two very
different scales: tucked into a cell's top-left corner during play, and filling
the whole cell in the setup preview and the preset editor. Non-square is allowed
but letterboxes, since the CSS uses `object-fit: contain`.

### Custom gnomes

A gnome on the board is not one drawing but seven, composited and recoloured at
runtime from the player's choices in the character creator (the modal behind
each seat's gnome on the setup screen). `src/ui/gnomeLook.ts` holds the model
and the palette, `src/ui/gnomeArt.ts` the catalogue and the canvas work, and
`src/ui/GnomeCreator.tsx` the creator itself.

```
src/assets/art/Gnome Assets/
  Torso/  Faces/  Shoes/  Beards/  Hair/  Hats/  Accessories/
```

The catalogue is the folder tree: the folder is the layer, the filename is the
variant, and adding a hat is dropping a PNG into `Hats/` — no code change. The
paint order is back to front `torso → face → shoes → beard → hair → cap →
accessory`, and **hair and beard are the only optional layers**. A layer with
one drawing (Shoes, today) is drawn on every gnome and never offered as a
choice; it rejoins the carousel as soon as it has a second.

What a layer has to survive:

- **48×64, transparent, and already in position.** Every layer shares one
  canvas, so nothing is offset at render time — a hat has to sit where a hat
  goes. Tokens are ~14–25px on the board, so anything fiddly turns to mush.
- **Flat colour, no anti-aliasing.** The recolour swaps pixels by exact value;
  a blended edge pixel is not in the table and stays the colour it was drawn.
- **Drawn in the filler palette**, because that is what gets swapped:

  | Filler | Becomes |
  | --- | --- |
  | `#37474f` `#3d2f3d` `#424242` | the garment ramp's darkest shade |
  | `#616161` `#757575` `#78909c` | its medium-dark shade |
  | `#90a4ae` | its medium shade |
  | `#e0e0e0` | the hair colour — on the **hair, beard and face** layers only (`HAIR_TINTED_LAYERS`). The face is in that set for its eyebrows, the only `#e0e0e0` it has; a cap's polka dots are a different white and stay white |
  | `#e5aa7a` and its shadows | the skin tone |

  Everything else is left exactly as drawn: the brown shoes and tool shafts,
  the gold belt buckle, the orb's glass, the white cap dots, the black eyes.
  Those are the only high-contrast pixels left at token size. `ART_COLORS` in
  `src/ui/gnomeLook.test.ts` lists every colour the drawings actually use, and
  the tests fail if a new layer introduces one nothing recolours.

**The clothes are the ownership signal.** Board tokens used to sit on a disc
filled with the seat's colour; a custom gnome replaces the disc, so the garment
ramp is derived from the seat's own colour and a player picks only which
*variation* of it to wear. Two red gnomes may differ; a red gnome and a blue one
never look alike. Hair and skin are unrestricted, since neither carries that
signal. The snail keeps its disc — there is one snail drawing and nothing else
marks its owner.

Looks are cosmetic and never enter the engine: no `PlayerState.look`, nothing in
encode/decode, nothing in a recorded match. They reach the screen through
`GnomeLooksContext`, filled from the setup screen locally and from the room
snapshot online, and they last for the session rather than being saved. Online
they ride alongside the seat's name (`GnomeLookWire` in `src/net/protocol.ts`)
and every arriving look goes through `sanitizeLook` before anything is drawn.

## Architecture in one paragraph

`src/engine` is a pure, deterministic, JSON-serializable state machine —
`createGame(options, seed)`, `getLegalActions(state)`, `applyAction(state,
action)` — with all randomness seeded through the state itself (same seed +
same actions ⇒ identical games, always). `src/ui` is a React layer that never
recomputes rules: it renders `GameState`, matches clicks against the engine's
enumerated legal actions, and replays the engine's event log for the game log
and fight animations. The CPU opponent (`chooseAiAction`) uses only the public
engine API; it picks a strategic objective, keeps it across turns, and scores
the engine's own legal actions against it. This separation is deliberate: the engine is the future
multiplayer server core, and the test suite drives it through thousands of
actions without any UI.

## Project layout

```
src/engine/   types, RNG, setup, garden presets (presets/*.json ship as
              built-ins — draw one in the editor and drop it in); the
              reducer split by
              responsibility (engine facade, actions, turns, settle,
              elimination, legalActions, targeting), gardens, fights,
              cards (data-driven), per-seat redaction (view), AI, tests
src/net/      multiplayer: wire protocol, the room's rules, commit–reveal
src/worker/   Cloudflare Worker entry + the room Durable Object
src/ui/       App shell + screen router, home screen, rules viewer, setup
              screen (difficulty + preset picker + advanced settings), online
              menu/lobby, game screen, board, panels, decision panel, quick
              chat, preset editor, error boundary, meta text, art (icon
              components), the gnome character creator (gnomeLook model +
              palette, gnomeArt catalogue + canvas recolour, GnomeCreator);
              the local (useGame) and networked (useNetGame) sessions behind
              one GameSession shape
src/assets/   the game's picture assets (see Art above)
e2e/          Playwright browser tests (play the real app through the DOM)
RULES.md      tabletop rules (with [RULING] clarifications)
CARDS.md      the 23 Whimsy cards + 5 Curses
ENGINE_API.md engine contracts, settle-loop priorities, decision model
```
