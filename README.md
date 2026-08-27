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

To replace a picture, overwrite the file — the filenames are the whole
contract, and `src/ui/artAssets.ts` is the one place that maps them to game
types (edit it to change a name or use another format Vite handles: SVG, WebP,
JPEG).

```
src/assets/art/
  garden-home.png       garden-maize.png      unit-gnome.png
  garden-dandelion.png  garden-slippery.png   unit-snail.png
  garden-mushroom.png   garden-tunnel.png
  garden-flytrap.png
```

What the art has to survive: square and transparent, 128–256px (they render at
14–24px in a board cell, ~40px in a token — anything fiddly turns to mush at
that size; non-square is allowed but letterboxes, since the CSS uses
`object-fit: contain`). **Unit art** sits on a disc filled with its seat's
colour, so it needs a light outline or halo to stay legible on any of them.
**Garden art** appears at two very different scales: tucked into a cell's
top-left corner during play, and filling the whole cell in the setup preview
and the preset editor.

Two players who pick the same colour are **teammates** (see the Teams section
in RULES.md) — the palette is the team, so the board says who is with whom
without a legend. That makes `appearance.palette` the one cosmetic field with a
rules consequence, which is why `createGame` groups the palettes into
`PlayerState.team` once at setup and no rule ever reads a palette again.

### Gnome parts

A player's gnome is not one of those files. It is composited from five layers —
weapon, body, beard, cap, accessory — recoloured at runtime to that player's
team palette, so one set of art serves every team.

**Adding a part is adding a file.** Drop a PNG into the folder for its layer and
re-run the generator; the id, the label, the engine's catalogue and the
picker's buttons are all derived from the filename.

```
src/assets/art/parts/
  base/       gnome.png                        the head every layer hangs off
  cap/        pointy.png bulbous.png wide.png tall.png droopy.png
  beard/      pointy.png wild.png bushy.png braided.png stubble.png
  weapon/     shovel.png pitchfork.png staff.png axe.png broom.png
  accessory/  monocle.png pipe.png lantern.png flower.png glasses.png

npm run art             # folders -> src/engine/partCatalog.ts + src/ui/appearance/spriteData.ts
npm run art:preview     # renders art-preview.png: every part, on a gnome, recoloured
npm run art:preview -- cap teal      # one layer, one palette
```

`art-preview.png` is the fast way to check a new drawing: it composites each
part onto a full gnome in a team's colours, because a cap on its own tells you
nothing about whether it collides with the beard.

#### What to draw

Square, transparent where empty, ideally **256×256**. Any square size works —
the image is sampled onto the 32×32 grid every part shares, so the layers line
up by construction — but a clean multiple of 32 keeps pixel edges exact.

**Colour decides what recolours**, and this is the whole authoring contract:

| You draw | It becomes |
| --- | --- |
| Grey (r ≈ g ≈ b) | The team's colour, at that lightness. Dark greys → the team's dark shades, light greys → its light ones. |
| Any other colour | Exactly that colour, on every team. This is how skin and eyes survive recolouring. |

Two conventions are load-bearing rather than stylistic — ignore them and the
part will look wrong at the ~20px a board token actually gets:

- **Beards use the dark half of the range, caps the light half.** That contrast
  is what keeps a gnome's two big masses apart when it is tiny.
- **Everything is drawn in one shared frame**: head at x 8–23 / y 8–25 of the
  32×32 grid, caps above it, beards hanging below y19, weapons down the right
  margin. Nothing is positioned at runtime.

Filenames become ids and labels: `wide-brim.png` → id `wide-brim`, label "Wide
Brim". A numeric prefix orders the picker and is stripped from the id
(`01-pointy.png` → `pointy`), so renumbering the menu never invalidates a saved
game. Ids are stored in match records and sent over the wire, so **deleting a
part breaks replays of games that used it** — rename freely before release,
not after.

#### Why the art is compiled rather than loaded

A gnome is recoloured to its team's palette at runtime, and an `<img>` cannot be
palette-swapped — CSS filters do hue rotation, not a per-step colour map. So
`npm run art` converts each PNG into one SVG path per colour, and
`gnomeImage.ts` fills those paths with a team's ramp and memoises the result as
a single data URI per distinct look. The generated files are checked in, so a
normal build is still a plain `tsc && vite build`.

The starter art was drawn as ASCII in `scripts/art/sprites.mjs` and exported to
the folders by `node scripts/art/export-starter.mjs`. That script is kept for
provenance only — the folders are the source of truth, and re-running it
overwrites them, discarding hand edits.

#### Adding a whole new layer

Rarer, and the one case that needs a code change: add an entry to `LAYERS` in
`scripts/art/layers.mjs` (id, folder, label, draw order, whether it may be
empty), create the folder, and run `npm run art`. The appearance type, the
validator, the random-look derivation and the picker row all follow from the
generated catalogue.

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
              components); the local (useGame) and networked (useNetGame)
              sessions behind one GameSession shape
src/assets/   the game's picture assets (see Art above)
e2e/          Playwright browser tests (play the real app through the DOM)
RULES.md      tabletop rules (with [RULING] clarifications)
CARDS.md      the 23 Whimsy cards + 5 Curses
ENGINE_API.md engine contracts, settle-loop priorities, decision model
```
