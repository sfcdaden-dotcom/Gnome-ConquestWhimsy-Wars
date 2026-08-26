# Whimsy Wars → Godot

A plan for rebuilding Whimsy Wars as a native, shippable game in Godot 4 —
without rewriting the rules, and without losing the test suite that makes them
trustworthy.

## The thesis

This is a **port of the presentation layer and a translation of the engine**,
not a ground-up rewrite. Two properties of the existing codebase make that
possible, and both were designed in deliberately (see `ENGINE_API.md`):

**1. The engine already narrates the game.** `GameEvent` in
`src/engine/types.ts` has **53 variants** — `fightRoundStarted`,
`unitDestroyed`, `flytrapStunned`, `curseRevealed`, `snailSurvivedLoss`,
`gnomesMarried`, `spacesSwapped`, `mushroomClones` — and the type is commented
*"append-only log; useful for UI animation & tests."* The web UI consumes that
stream to print a text log and run four CSS keyframes. In Godot the same stream
is an animation script: every event is a cue for a beat of presentation. The
polish you want is not something to invent — it is 53 handlers against an
interface that already exists.

**2. There is already a conformance-corpus generator.** `src/engine/selfplay.ts`
exports `simulateSelfPlay(options, seeds) → MatchRecord[]`, `toNdjson()`, and
`replayMatch(record)`, where a `MatchRecord` is exactly `(config, seed,
actions[])`. That turns "did the port stay faithful?" from a judgement call into
a diff: generate thousands of matches from the TypeScript engine, replay each in
C#, compare. No other part of this project de-risks the port as much.

## Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Presentation — Godot 4 scenes, Control + Node2D              │
│  Board, units, cards, panels, camera, audio, VFX              │
│  Consumes: GameState (render) + GameEvent[] (perform)         │
│  Produces: Action                                             │
└──────────────────────────────────────────────────────────────┘
                    ▲ state + events   │ actions
                    │                  ▼
┌──────────────────────────────────────────────────────────────┐
│  WhimsyWars.Core — pure C# class library, zero Godot types    │
│  Port of src/engine: createGame / getLegalActions /           │
│  applyAction, RNG, cards, gardens, fights, AI, view, timeout  │
│  Testable headless under `dotnet test`                        │
└──────────────────────────────────────────────────────────────┘
                    ▲ authoritative state
                    │ WebSocket, existing JSON protocol
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker + Durable Object — UNCHANGED               │
│  src/net/protocol.ts, room.ts, commit–reveal anti-cheat       │
└──────────────────────────────────────────────────────────────┘
```

The hard boundary is that **`WhimsyWars.Core` must not reference `Godot.*`**.
That is what keeps it unit-testable outside the editor, keeps it usable as a
future server core, and keeps the differential harness honest.

## Language: C#, not GDScript

The engine is 700 lines of discriminated-union types, a LIFO card resolver with
response windows and re-validation, an objective-scoring AI, and a fixed-layout
feature encoder. That code wants a real type system; in GDScript `types.ts`
dissolves into untyped dictionaries and you find out at runtime.

Use C# for `WhimsyWars.Core`. Presentation can be either — GDScript is pleasant
for scene glue and hot-reloads faster, and mixing is supported. A reasonable
split is C# for Core, GDScript for scene scripts, C# for anything that touches
the network protocol.

**The cost, stated plainly:** Godot's .NET builds do not target the web. Porting
to C# means giving up the browser build, so `whimsywars.example` stops being the
way people play. That is a real loss for a party game shared by link, and it is
the main thing to be sure about before starting. It is also the correct trade if
the destination is a store listing rather than a URL.

## Phases

Each phase has an exit criterion. Do not start the next one until it is met.

### Phase 0 — Freeze the contract
Write `docs/ENGINE_CONTRACT.md` fixing the wire shapes: `GameState`, `Action`,
`GameEvent`, `GameConfig`, `MatchRecord`. These are already stable
(`schemaVersion: 1`, `MATCH_RECORD_SCHEMA = 2`) — this just makes them
explicit so two implementations can be checked against one document.

Add a TS script that emits the corpus:
`simulateSelfPlay(config, 5000) → toNdjson() → corpus/*.ndjson`, plus, for each
record, the final state and the full event log as canonical JSON.

**Exit:** a committed corpus of ≥5,000 matches across board sizes, seat counts,
and every garden preset, with expected final states and event streams.

### Phase 1 — Core: types, RNG, setup
Port `types.ts`, `rng.ts`, `helpers.ts`, `setup.ts`, `gardenPresets.ts`,
`randomLayout.ts`. Unions become C# records with a discriminator, or a sealed
hierarchy with pattern matching.

**Exit:** `createGame(config, seed)` in C# produces a state byte-identical (by
canonical JSON) to the TS engine for every seed in the corpus.

### Phase 2 — Core: the reducer
Port `engine.ts`, `actions.ts`, `turns.ts`, `settle.ts`, `gardens.ts`,
`fights.ts`, `elimination.ts`, `legalActions.ts`, `targeting.ts`,
`actionExpansion.ts`, `invariants.ts`.

**Exit:** every corpus match replays in C# to an identical final state **and an
identical event stream**. `checkInvariants` passes at every step. This is the
single most important gate in the project.

### Phase 3 — Core: cards
Port `cards.ts` — 28 definitions, ~1,266 lines. Do this last among the rules
because it depends on every mutator in `helpers.ts` and `gardens.ts`.

Consider making effects data-driven during the port rather than after: most
cards reduce to a small vocabulary of primitives, and only stack-touching cards
(Nope-Gnome, the response-window logic) need bespoke code. If you do, keep the
differential harness green through every step — that is what makes the
refactor safe here and risky in the TS codebase.

**Exit:** corpus green with cards enabled (it already is, but the corpus should
be regenerated with card-heavy configs).

### Phase 4 — Core: AI
Port `ai/` — objectives, scoring, cardPlans, memory, personality, chatter.
The AI is deterministic given state and memory, so it is inside the diff.

**Exit:** `chooseAiAction` returns the same action as the TS AI for every
decision point in the corpus. Any divergence here is almost always an
iteration-order bug (see Hazards).

### Phase 5 — Presentation
Build the Godot game. Board, units, cards, panels, camera, audio, VFX. This is
where the project stops being a translation and starts being the thing you
actually want.

**Exit:** local hot-seat and CPU play at parity with the web app, plus the
event-driven presentation layer below.

### Phase 6 — Online
Point Godot at the existing Worker over `WebSocketPeer`, speaking the current
JSON protocol. `src/net/protocol.ts` and `room.ts` describe it; the Durable
Object stays as-is and keeps running the TS engine as the authority.

**Exit:** a Godot client and a browser client can share a room. (If you retire
the web client, this is still the cheapest correctness check you will ever get —
keep it working long enough to use it.)

## The differential harness

This is the linchpin. Build it in Phase 0 and run it in CI from then on.

```
TS side (once per corpus regeneration)
  simulateSelfPlay(config, seeds)  →  MatchRecord[]
  for each record: replayMatch()   →  final GameState + GameEvent[]
  write NDJSON: { record, finalStateHash, finalState, events }

C# side (every commit)
  for each record:
    state = Core.CreateGame(record.Config, record.Seed)
    if (record.Seal is not null) state = Core.SealHiddenState(state, secret)
    foreach (var action in record.Actions) state = Core.ApplyAction(state, action)
    assert Canonical(state) == expected.finalState
    assert events == expected.events           // order and payload
```

Two details that matter:

- **Compare the event stream, not just the final state.** Two engines can agree
  on where the game ended and disagree about how — and "how" is exactly what the
  presentation layer consumes.
- **Canonical JSON.** Sort object keys, fix number formatting (JS numbers are
  IEEE doubles; use `double` and round-trip formatting in C#, never `float`),
  and normalise `-0`. Otherwise the harness reports differences that aren't.

When the harness fails, it names the first divergent action. That is a
half-hour bug. Without it, the same bug is a week of playing both games
side-by-side wondering why the dice disagree.

## Determinism hazards

The engine's whole contract is *same seed + same actions ⇒ identical game*.
These are the specific ways a C# port breaks it.

**1. mulberry32 must be bit-exact.** `rng.ts` uses `Math.imul` and `>>> 0` —
uint32 multiply and wrap. In C# that is `unchecked` arithmetic on `uint`. Port
the algorithm literally; do not substitute `System.Random`, `RandomNumberGenerator`,
or Godot's `RandomNumberGenerator` anywhere, including in tests.

**2. `shuffled()` must make the same RNG calls in the same order.** Same
Fisher–Yates direction, same bound computation. An equivalent-but-different
shuffle produces a legal game that is not *this* game.

**3. Dictionary iteration order — the one that will actually bite you.**
`GameState.gardens` is `Record<PosKey, Garden>` keyed by `"x,y"`, and the rules
and AI iterate it directly:

```
src/engine/gardens.ts:204,222        Object.entries(state.gardens)
src/engine/ai/scoring.ts:306,331,341,355
src/engine/ai/cardPlans.ts:220,242,383
src/engine/ai/objectives.ts:417
```

JavaScript iterates non-integer string keys in **insertion order**. C#
`Dictionary<K,V>` makes **no order guarantee**. Any of those loops that picks a
first match, accumulates in order, or breaks a tie will silently diverge.

Note that `gardens.ts:280` already does `Object.keys(draft.gardens).sort()` —
someone hit this once and fixed it locally. The port needs it fixed globally:
use an insertion-ordered dictionary in Core and preserve the TS insertion order
in `createGame`, or sort keys at every iteration site and change the TS engine
to match. Pick one and enforce it in review.

**4. Immutability.** The TS reducer returns new state; C# will invite you to
mutate in place. Either port the immutable style or make the draft/commit
boundary explicit and copy at the seams — but never let a caller hold a
reference to state that a later `ApplyAction` mutates. The corpus catches this,
but usually a hundred matches after the actual mistake.

**5. Doubles, not floats.** `rngNext` returns a float in [0,1) derived from a
uint32. Use `double` throughout. A `float` somewhere in scoring will diverge the
AI long before it diverges the rules.

## What Godot actually buys: the event-driven polish layer

This is the payoff, and the reason the port is worth doing. Each engine event
becomes a presentation beat. A sampling:

| Event | Presentation |
|---|---|
| `turnStarted` | seat-colour banner sweep, camera settles on that player's territory |
| `fightStarted` | camera push-in, board desaturates outside the contested cell |
| `fightRoundStarted` | physical dice tumble and land, not a number appearing |
| `unitDestroyed` | hit-stop, dust puff, gnome cap tumbles off |
| `flytrapStunned` | vine snap, unit wobbles and freezes |
| `snailSurvivedLoss` | shell-retreat squash, a beat of held breath |
| `cardPlayed` | card lifts from hand and slots onto a visible stack |
| `cardCancelled` | Nope-Gnome slams down, the countered card crumples |
| `cardFizzled` | card greys and drops, small sad chime |
| `curseRevealed` | colour drains, low brass sting, card flips centre-screen |
| `mushroomClones` | spore burst, clones pop in on a stagger |
| `unitTunneled` | burrow down with a dirt puff, surface elsewhere |
| `unitSlid` | slippery-tile skid with a motion trail |
| `gnomesMarried` | ribbon drawn between the two units, held for the game |
| `spacesSwapped` | the two units arc past each other |
| `wishesGained` | wishes fly to the counter, counter ticks up |
| `gardenUpgraded` | the plant visibly grows |
| `deckReshuffled` | the discard gathers and shuffles |
| `playerEliminated` | that seat's colour drains from every tile it held |

None of this requires a rules change. All of it is currently a line of text in
the game log.

Practical notes: the settle loop can emit many events per action, so the
presentation layer needs an **event queue with per-type durations** and a
"skip/fast-forward" control — otherwise a long card chain locks the player out
for ten seconds. Build that queue in Phase 5 before building any individual
animation; it is the part that everything else hangs off.

## What does not get ported

- `src/ui/**` — all of it. React, CSS, the DOM interaction model.
- `e2e/**` — Playwright specs are browser-bound; replace with Godot integration
  tests driving the same scenarios.
- `src/worker/**` — stays running as-is on Cloudflare.
- `index.html`, Vite, Wrangler client config, `oxlint` — replaced by the .NET
  and Godot toolchains.

Keep the TypeScript engine alive and in CI for as long as the differential
harness runs, which in practice means forever. It is cheap to keep and it is
your oracle.

## New work the port does not include

Godot makes the game feel like a product; it does not make it *be* one. These
are additive and mostly server-side, and none of them are cheaper or dearer in
Godot than they are today:

- Persistence — resumable games, which for this engine is storing
  `(config, seed, actions[])` and replaying. Cheapest feature you will ever ship.
- Identity and accounts, friends, invites.
- Matchmaking beyond six-character room codes.
- Onboarding and tutorial.
- Telemetry, crash reporting, drop-off analytics.
- Store presence: listing, screenshots, trailer, pricing, age ratings.

## Risks

| Risk | Mitigation |
|---|---|
| Port stalls in Phase 2/3 with a half-translated engine | Phases gated on a green corpus; never more than one subsystem un-diffed |
| Iteration-order divergence surfaces late, in the AI | Fix the dictionary-order question in Phase 1, before any rules code |
| Losing the web build costs the casual audience | Decide before Phase 0; consider keeping the web app published and frozen |
| Two rule implementations drift | The TS engine is the oracle, not a second product; rules changes land in TS first, then port under a green corpus |
| Presentation scope balloons | Event queue first, then animate events in gameplay-frequency order — `unitMoved` before `gnomesMarried` |

## Rough shape of the effort

Solo and part-time, with the corpus doing the verification:

- Phase 0 — days
- Phases 1–4 (engine, ~5,900 code lines plus ~1,700 of AI) — the bulk; weeks to
  a few months, and largely mechanical once the harness is green
- Phase 5 (presentation) — open-ended by design; this is the part you are doing
  the port *for*, and it is where the time should go
- Phase 6 — days, because the protocol and server already exist

The engine phases are predictable work with an objective definition of done.
That is unusual and worth exploiting: they are the phases to grind through
quickly so the time lands where it shows.
