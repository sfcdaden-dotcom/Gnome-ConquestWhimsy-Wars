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

That rules out PNGs: recolouring means mapping a five-step greyscale ramp onto
a team's five-step colour ramp, and an `<img>` cannot be palette-swapped (CSS
filters do hue rotation, not a per-step colour map). So the parts are authored
as ASCII on a 32×32 grid in `scripts/art/sprites.mjs`, one character per pixel,
and compiled to SVG path data:

```
npm run art        # scripts/art/sprites.mjs -> src/ui/appearance/spriteData.ts
```

The generated file is checked in, so a normal build never runs the generator.
`src/ui/appearance/gnomeImage.ts` fills those paths with a palette and memoises
the result as one data URI per distinct look.

Drawing a part: `0`–`4` are the recolourable ramp, darkest to lightest, and
`K/S/s/h/e/w` are fixed colours that survive recolouring (skin, eyes). Two
conventions are load-bearing rather than stylistic — **beards use the dark half
of the ramp (0–2) and caps the light half (2–4)**, which is what keeps a
gnome's two big masses apart at 20px, and every layer is drawn in the same
frame, so parts line up by construction rather than by runtime positioning.
Adding a part means adding its sprite, its id in `src/engine/appearance.ts`,
and its label in `src/ui/appearance/CharacterPicker.tsx`.

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
