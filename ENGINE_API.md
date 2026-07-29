# Whimsy Wars — Engine API

The engine (`src/engine`, import via the `src/engine/index.ts` barrel only) is a
**pure, deterministic, serializable state machine**. The UI, the AI and the tests
all sit on the same three functions:

```ts
createGame(options, seed)  → GameState   // validated; throws EngineError('BAD_CONFIG')
getLegalActions(state[, player]) → Action[]
applyAction(state, action) → GameState   // never mutates its input; throws EngineError
```

Support queries: `getPlayerToAct`, `isGameOver`, plus the read-only helpers
re-exported from `helpers.ts` (`posKey`, `unitsAt`, `wishCap`, …) and the card
lookups from `cards.ts` (`getCardDef`, …). The heuristic CPU lives behind
`chooseAiAction(state)` and uses only this public API.

## Module layout

Import from the `src/engine/index.ts` barrel only — the split below is an
implementation detail and may move again.

| File | Responsibility |
|---|---|
| `engine.ts` | public façade: `applyAction`, `isGameOver`, re-exports |
| `actions.ts` | action dispatch + Action-Phase handlers (move/plant/upgrade/draw/play) |
| `turns.ts` | roll-off, turn start/end, movement legality, `getPlayerToAct` |
| `settle.ts` | the auto-advance loop and its convergence diagnostics |
| `elimination.ts` | eliminations, snailify, win detection |
| `legalActions.ts` | legal-action intents + complete-action analysis expansion |
| `targeting.ts` | phased card targeting: the `cardTargeting` transaction, step options, enumeration |
| `gardens.ts` | harvests, planting, entry effects |
| `fights.ts` | fight resolution (Respond → Roll → Resolve) |
| `cards.ts` | card framework, definitions, the card stack |
| `view.ts` | per-seat redaction: `GameState` → `PlayerView` (multiplayer) |
| `helpers.ts` | shared queries and draft mutators |
| `setup.ts` / `gardenPresets.ts` / `randomLayout.ts` / `rng.ts` / `types.ts` | creation, layouts, procedural map generation, RNG, types |

Dependencies run one way through the top layer — `engine → {actions, settle,
legalActions} → {targeting, turns} → elimination → {gardens, cards, fights} →
helpers` — so the split introduces no cycles. `targeting.ts` calls the low-level
commit helpers in `cards.ts` / `fights.ts` but is never imported back by them. The rules layer keeps its pre-existing mutual
imports (`cards ↔ fights`, `cards → gardens → fights`): a card can queue a
fight and a fight can play a card, which is inherent to the rules rather than
an artifact of the file layout.

## Core contracts

1. **Purity / immutability.** `applyAction` deep-clones, mutates the clone
   ("the draft"), and returns it. Illegal actions throw `EngineError` with a
   human-readable message and leave the input untouched.
2. **Determinism.** All randomness flows through the mulberry32 state stored in
   `GameState.rngState` (see `rng.ts`). Same seed + same action sequence ⇒
   identical states, always. The AI is also deterministic, so seeded AI-vs-AI
   games replay identically (this is what the smoke tests rely on).
3. **Serializability.** `GameState` is plain JSON-safe data — no functions, no
   class instances, no `Map`/`Set`. Snapshot, diff, persist and replay freely.
   This is also the multiplayer story: a server can own the state and relay
   actions; clients render from the same data.
4. **The interrupt model.** The state is always either (a) idle in the active
   player's Action Phase or (b) waiting on exactly one typed
   `state.pendingDecision` from one player. Nothing else ever blocks.

## The settle loop

After dispatching an action, `applyAction` "settles" — it auto-advances
everything that needs no human input and stops at the next decision or
Action-Phase idle. **Priority order matters** (`settle.ts`):

1. `finished` → done.
2. `pendingDecision` → stop and wait.
3. **Card stack** (`progressCardStack`) — a card played inside any interrupt
   (e.g. a fight Respond window) fully resolves, including its own response
   windows, before the interrupted thing continues.
4. **Live fight** (`progressFight`) — Respond → Roll → Resolve rounds.
5. **Elimination queue** — may surface a `snailify` decision.
6. **Queued fights** — revalidated, then promoted to the live fight.
7. Roll-off → wait; forced turn end (`turnMustEnd`) → end the turn.
8. Harvest Phase (`continueHarvest`) — built lazily at first entry, so a
   turn-start Magic Drain sacrifice resolves *before* harvests.
9. Otherwise: Action Phase, waiting for the active player.

Every branch must make progress, so the loop terminates. `MAX_SETTLE_STEPS`
(1,000) is a bug net, not a rules mechanism: real play settles in single-digit
steps (measured max **6** across 48 complete AI games — Easy/Normal/Hard × 8
seeds × 2- and 4-player). Overrunning it throws
`EngineError('INTERNAL')` carrying a one-line state snapshot — status, phase,
current player, pending decision kind + player, whether a fight is live, card
stack / response queue / fight queue / elimination queue depths, harvest
progress, `turnMustEnd` and the step count — so the stalled branch is
identifiable from the message alone.

## Termination & anti-stall (multiplayer)

The settle loop only guarantees that *one* action converges. A turn is a
different question: what stops a player from taking legal actions forever, or
from taking none at all? Three layers answer it.

**1. Bounded actions (rules).** Every Action-Phase action is either
self-limiting (`move` — one per unit per turn) or paid for out of a finite
resource (`plant`, `upgrade`, `drawCard` cost Wishes; `playCard` costs a card).

**2. Capped entry-effect chains (rules).** Mobility entry effects re-trigger on
arrival, so tunnel→tunnel (or two adjacent Slippery Gardens) is a loop a client
could ride forever — every hop is a legal action, so the engine never hangs, but
the turn never ends either. `MAX_ENTRY_EFFECT_HOPS` (3, `gardens.ts`) bounds it:
`handleEntry(draft, unitId, hops)` stops offering the effect once the chain hits
the cap, and each `slide` / `tunnel` decision carries the `hops` it is answering
so the count survives across actions without extra state. A fresh arrival
(normal move, card placement) starts at 0; a mandatory harvest activation opens
a fresh chain and counts as its first relocation. Reaching the cap logs
`entryChainCapped`. Mandatory harvest relocations are never blocked by it.

**3. Shot clock (host).** A client that simply stops sending actions — or spins
on state-neutral ones like `playCard` → `cancelTargeting` → `playCard` — cannot
be answered by rules, and the engine deliberately holds no wall clock. The host
decides when a seat has run out of time and calls:

```ts
getTimeoutAction(state) → Action | null   // the default answer for whoever must act
applyTimeout(state) → GameState           // apply it until control leaves that seat
isOnTheClock(state, player) → boolean
```

`getTimeoutAction` picks the most passive legal option — `declineEffect`,
then `respondPass`, `cancelTargeting`, `endTurn`, otherwise the first action of
the engine's own deterministic enumeration (the first harvest source,
`mushroomClones: 0`, the first forced move under Antsy Pants…). It never plays a
card. `applyTimeout` repeats that until somebody else is on the clock, so one
call closes a whole stalled turn including the moves Antsy Pants forces before
`endTurn` becomes legal. It is pure, like `applyAction`, and identical on every
host — a timed-out game replays deterministically.

## Quick chat (out-of-band action)

`{ type: 'quickChat', player, phraseId }` says one of the fixed phrases in
`quickchat.ts`. There is no free-text field anywhere in the action — a phrase
id that is not in `QUICK_CHAT_PHRASES` is simply an illegal action, so a host
never has to moderate strings, and clients cannot smuggle text through chat.

It is the one action that is **not a game move**:

- it is never returned by `getLegalActionIntents` / `getLegalActions` (the AI
  and the learned-policy option space stay exactly as they were), and
  `extractSamples` replays it without emitting a training sample;
- any seat may send one at any time — out of turn, while another player's
  decision is open, even after `status === 'finished'` (the one exception to
  `applyAction`'s game-over guard, so "gg" still lands);
- it changes nothing but the event log (`quickChatSaid`) and the sender's
  remaining allowance.

Spam is bounded the same way everything else is: `QUICK_CHAT_PER_TURN` (4) per
player, refilled for everyone at the start of every turn and once more when the
game ends. `quickChatsLeft(state, player)` is the same number the UI disables
its button on.

`chooseAiAction` uses it too: when the CPU could play a Whimsy Card this Action
Phase and picks something else, it sometimes says one line from the `musings`
group first (`QUICK_CHAT_MUSINGS` — rhetorical gnome questions that describe
nothing about the board, so a chatty CPU leaks no information), then takes its
real action on the next call. The coin flip and the phrase are hashed from
(seed, turn, seat), so the AI stays deterministic, and the engine's own
`quickChatsThisTurn` counter is what stops it repeating within a turn.

## Hidden information & per-seat views (multiplayer)

`GameState` is a **full-information** object, and deliberately so: on one
device the holder sees everything anyway, and the tests, the AI and the
encoders all want the whole truth. Over a network that is the entire game
given away. Raw state carries every hand, the deck order, and `rngState` —
from which every future draw and every future die roll is computable.

`view.ts` is the boundary:

```ts
viewFor(state, seat) → PlayerView   // what `seat` may see; seat = null ⇒ spectator
isPlayerView(state) → boolean
nameSaltOf(state) → number          // cosmetic salt: seed locally, nameSalt over the wire
```

The rule is the one `encode.ts` already pins for the learned CPU: **your own
hand in full; every other hidden zone as counts only.** Counts are preserved
*structurally* — a hidden card is present in the array as `HIDDEN_CARD_ID` —
so `deck.length`, `hand.length` and "how many cards does Red hold" keep
working while the identities are gone.

| Redacted | Public, deliberately |
|---|---|
| `rngState`, `seed` | hand SIZES, deck/discard COUNTS |
| `deck`, `cursePool` contents | the discard pile itself (face up) |
| every other seat's `hand` | the card stack (a played card is announced) |
| `fightRespond` / `cardResponse` `playableCards` of other seats — emptied, not just hidden, because the count is itself information | active curses, timed effects, the whole board |
| another seat's in-progress `cardTargeting` (`cardId` **and** `prompt`, which names the card) — the card is still in hand until the last target is picked, and `cancelTargeting` puts it back | `cardPlayed` / `cardResolved` / `cardCancelled` / `cardFizzled` / `cardDiscarded` / `curseRevealed` events |
| `cardDrawn.cardId` (except the drawer), `cardStolen.cardId` (except the two parties), `deckReshuffled.curseAdded` | everything else in the event log |

Two consequences worth knowing:

- **A `PlayerView` is structurally a `GameState`**, so rendering code takes it
  unchanged — but it is *not* a legal engine input. `rngState` is zeroed and
  the hidden zones are placeholders, so applying actions to one would silently
  diverge from the authoritative game rather than fail. `applyAction` rejects
  a view outright (`EngineError('INTERNAL')`).
- **Gnome names can no longer read `seed`.** They are derived from
  `(seed, unitId)`, and the seed with `config` regenerates the whole deck, so
  a view carries `nameSalt` — a *truncated* (16-bit) hash instead. Truncation
  is the point: `normalizeSeed` is a bijection on uint32, so the untruncated
  hash would be an invertible copy of the seed. UI name code calls
  `nameSaltOf(state)`, which is the seed for local play and the salt for a
  view.

### Sealing the deck

Redaction stops the state from being *broadcast*, but `createGame` derives the
layout, the deck and the dice from one seed — and the layout is then drawn on
the board. That makes the seed searchable: generate layouts for candidate
seeds until one matches, and the deck falls out with it (~0.4 ms per layout, so
a full 2^32 sweep is ~480 core-hours — a reusable precomputation, not a
per-game cost). Keeping the seed secret does not fix it; the board is the leak.

```ts
const secret = crypto.getRandomValues(new Uint32Array(1))[0];
let state = sealHiddenState(createGame(options, mapSeed), secret);
```

`sealHiddenState` replaces `rngState` with the secret and reshuffles the deck
under it, leaving the layout alone. Afterwards the two are cleanly split:
`state.seed` is only the MAP seed (it reproduces the board and nothing else, so
a host may publish it), while the deck order and every future die roll follow
from the `secret`, which never leaves the host. Pure, and deterministic per
`(seed, secret)` — but note that a sealed game no longer replays from
`config + seed + actions` alone, so `MatchRecord` needs the secret too.

Still a server's job: generating that secret from a CSPRNG, and not offering a
seed field in the multiplayer setup UI at all. See TECH_DEBT.md.

### Commit–reveal: proving the host didn't stack the deck

Sealing the deck behind a host secret trades one problem for another — players
can no longer read the deck, and now have to take the host's word that it was
random. `src/net/commitment.ts` removes the need for that word:

1. **Room creation** — the host draws a `GameSeal` (`createSeal()`) and
   publishes only `commitment`, the SHA-256 of `(secret, nonce)`. It is now
   bound: changing the deck breaks the hash.
2. **During the game** — the commitment says nothing usable.
3. **Game over** — the host publishes `secret` and `nonce`. `verifySeal` checks
   them against the commitment from step 1, and `replayMatch` re-runs the whole
   game from `config + seed + seal + actions` to show the deck that was played
   is the deck the host was bound to. The seal proves the deck was fixed in
   advance; the replay proves it was the one that got dealt.

`MatchRecord` gained an optional `seal` for exactly this (schema **2**): a
sealed game does *not* replay from `config + seed` alone — same board, wrong
deck, divergence at the first draw.

The nonce is load-bearing. `rngState` is 32 bits, so `sha256(secret)` on its
own would be exhaustible in minutes: an opponent given the commitment at game
start could recover the secret and read the deck. The 128-bit nonce puts the
pre-image out of reach.

**What this does not claim.** Mulberry32's state is 32 bits, so the deck is
hidden from inspection, not hidden cryptographically: dice rolls are public
events, and enough of them narrow `rngState` to a searchable set — recovering
the deck for the rest of the game. Commit–reveal is unaffected (it is about
host honesty, and the nonce is what makes it sound), but if the deck must
withstand a determined opponent rather than a curious one, the fix is to stop
deriving it from a 32-bit stream — shuffle it server-side from CSPRNG bytes and
store the order. Logged in TECH_DEBT.md.

## Turn structure

- `startTurn`: expire the player's own "until your next turn" effects
  (Great Wall Of Whimsy, Lost In The Maize), then Magic Drain check
  (0 Wishes + owns a gnome ⇒ `sacrificeGnome` decision), then the Harvest
  Phase (skipped entirely for Snail seats).
- **Harvest Phase**: every qualifying source snapshotted at phase start;
  owner picks resolution order (`chooseHarvest`) when more than one remains;
  sources are revalidated when resolved; gardens entered mid-harvest do not
  harvest this turn.
- **Action Phase**: any number of `move` (each unit 1 orthogonal space per
  turn), `plant` (from the actor's own tile supply), `upgrade` (2 Wishes,
  flips a controlled non-Home garden to its upgraded form — see RULES.md
  "Garden Upgrades"), `drawCard`, `playCard`; then `endTurn`.

## Decisions (`PendingDecision.kind` → answering `Action.type`)

| Decision | Answer(s) |
|---|---|
| `rollOff` | `rollOff` |
| `chooseHarvest` | `chooseHarvest` |
| `homeHarvest` | `homeHarvest` |
| `mushroomClones` | `mushroomClones` |
| `slide` / `tunnel` | `slide` / `tunnel`, `declineEffect` when optional (carries `hops`, capped by `MAX_ENTRY_EFFECT_HOPS`) |
| `fightRespond` | `respondPass`, `respondPlayCard` |
| `cardResponse` | `respondPass`, `respondPlayCard` (incl. Nope-Gnome) |
| `cardTargeting` | `selectTarget` (one of `getPendingDecisionOptions`), `cancelTargeting` |
| `discard` | `discardCard` |
| `snailify` | `snailify` |
| `sacrificeGnome` (Magic Drain) | `sacrificeGnome` |
| `snailMove` (Snailmaggedon) | `snailMove`, `declineEffect` |

### The legal-action contract (phased targeting)

**Primary API — `getLegalActionIntents(state[, player]) → Action[]`.** Every
legal move for the player who must act, with card plays left **untargeted**
(one `playCard` / `respondPlayCard` intent per playable card, no `targets`).
Cheap: no combinatorial work. This is what the UI and the AI use.

Everything it returns is **dispatchable**: applying any entry never throws. For
a targeted card that means its targeting flow has a completable path, not just
that its cheap `hasAnyPlay` hint passed — the two can disagree (a gnome whose
owner cannot pay its Maize exit satisfies "you have a gnome" but is filtered out
of Hidden Passage's first step), and the enumerator resolves that disagreement
in favour of the flow. Callers may therefore use the intent list directly as an
action mask: to render a hand card as enabled, to drive a UI respond window, or
as the legal-option set a learned policy scores.

Targets are chosen **one step at a time**, not built by the caller. Dispatching
a targeted play without `targets` opens a `cardTargeting` decision; the engine
then offers the legal options for the current step only:

```ts
getPendingDecisionOptions(state) → CardTarget[]   // options for the CURRENT step
applyAction(state, { type: 'selectTarget', player, target })   // pick one
applyAction(state, { type: 'cancelTargeting', player })        // back out
```

Each step's options are recomputed from live state (never stored on the
decision, so they can't go stale across a save/load), and later steps are
narrowed by earlier picks: after choosing Plot Twist's first space, the second
step offers only that space's orthogonal neighbours (≤4), not every board-wide
pairing. On the last step the card's own `validate` re-runs on the complete
payload before the card is committed. So the cost of listing options is
proportional to the current decision step, not the product of every slot.

A play that already carries a full `targets` payload is committed in one shot
(re-validated, then played) — this is the path the AI and direct callers use,
so supplying targets up front still works exactly as before.

**Analysis helper — `getLegalActions` / `enumerateCompleteCardActions`.** The
same actions but with every targeted card expanded into complete, immediately
executable actions (one per valid `CardTargets` payload). This is the
**expensive** path — it walks each card's whole targeting flow — and is used
only by tests and offline analysis, never by the UI or the normal AI loop.
Because expansion is phased (each step yields only its own legal options,
narrowed by earlier picks), it is proportional to a card's real branching
(Plot Twist: 2·n·(n-1) adjacent pairs) rather than C(n², k), so there is **no
global combination ceiling** — the old `MAX_TARGET_COMBINATIONS` is gone.

Targeting is card-agnostic in the engine and UI: candidates come from each
card's `targetFlow` steps (see below), and adding a card needs no change to the
enumerator, the action router, or the targeting UI. A step may set
`ordered: true` when pick order is meaningful (Instigation: the first gnome is
the attacker) so the analysis helper emits both orders; otherwise it emits one
canonical order per unordered combination (no reversed duplicates).

**Transaction model.** Playing a card is free, and the card is **not removed
from hand until targeting completes successfully** — so cancelling, or a target
becoming invalid mid-flow, leaves the game exactly as it was (no duplication,
no loss, no double-charge). While a `cardTargeting` decision is open, normal
turn actions and starting another card are blocked, like any other pending
decision. Cancellation is always available and restores whatever preceded the
play (a response window, or the idle Action Phase).

## Cards

Data-driven in `cards.ts`: 23 Whimsy cards × 2 copies + 5 Curses (all shuffled
into the deck from the start, revealed face-up on draw, permanently active). A targeted
card declares a `targetFlow(state, player) → TargetStep[]` — the ordered steps
the engine walks during phased targeting (each step's `getOptions` computes its
legal options from the state and the earlier picks). Once targeting completes
(or a full payload is supplied up front), playing the card moves it hand →
discard and pushes a stack entry; every other `playing` player gets a response
window (auto-passed with nothing playable); the stack resolves LIFO; targets
are validated at completion (throw) and again at resolution (fizzle: logged, no
effect).

Timing: **Sudden** — any time no decision is pending, plus inside Respond
windows; **Ritual** — only the owner's Action Phase. A card flagged
`respondOnly` (Nope-Gnome today) is playable **only** inside `cardResponse`
windows, and never inside fight Respond windows.

Response routing is driven entirely by the card definition, never by card id:

| Flag on `WhimsyCardDef` | Meaning |
|---|---|
| `respondOnly` | playable only inside a `cardResponse` window |
| `targetsRespondedCard` | the router records the responded-to stack index on the stack entry as `respondsToStackIndex`, which the card's `resolve` reads |

Adding a second counter-card therefore needs only these two flags — no change
to the action router (`actions.ts`) or to `cards.ts`'s window handling. See
`responseRouting.test.ts`, which registers a fixture counter-card and proves
the path end to end.

## Rules interpretations ([RULING] decisions the code encodes)

- A garden is **Active** once the global turn it was planted on has ended
  (`gardenIsActive`), matching RULES.md.
- A Maize Garden planted this turn does not tax exits yet (`maizeExitCost`).
- The maize harvest roll is the harvesting OWNER's roll (RULES.md): Snake
  Eyes / 4 Leaf Clover modifiers apply and are consumed. Only the flytrap's
  fight die is a system roll.
- Tunnel *harvest* destinations include "any garden occupied by your own
  gnome", which includes the tunnel itself — choosing it means staying put.
- Movement legality (`moveDestinations` in turns.ts) is the single source of
  truth shared by `doMove`, `getLegalActions` and the Antsy Pants check:
  orthogonal, on-board, not Great-Walled, exit not locked by Lost In The
  Maize, maize exit cost payable.
- Flytraps are never destroyed by fights — stunned until the end of the
  winner's turn. The Immortal Snail is never destroyed; losing a fight on its
  own turn ends that turn (skipping its garden-destruction step), and its
  end-of-turn garden destruction only fires when no enemy units share its
  space (defenders who survived fighting it keep the garden safe).
- Home-capture elimination is checked after all fights on the space resolve.

## Events

`GameState.events` logs every observable state change (`GameEvent`) — the UI
renders its game log and fight playback from it, and tests assert on it. It is
a **rolling window of the most recent 1000 events** (trimmed after each action
so long simulations stay O(actions) instead of O(actions²)); the monotonic
`GameState.eventCount` counts events ever emitted, so consumers diff "events
added by this action" as `next.events.slice(next.events.length -
(next.eventCount - prev.eventCount))`. Add new event kinds as mechanics land,
and give them `describeEvent` text in `src/ui/meta.ts`.

**Events are historical records, so they carry their own identity facts.** An
event is rendered long after the state it describes — a gnome that moved on turn
3 is gone from `state.units` by the time you scroll back to its line. Every event
referencing a unit therefore carries the whole `{ unitId, player, unitKind }`
triple (`unitMoved`, `unitSlid`, `unitTunneled`, `unitTeleported`,
`entryEffectDeclined`, `destructionPrevented`, `unitDestroyed`), and consumers
must label a unit from the event rather than looking it up in current state. The
two exemptions state their kind in the event name: `gnomeSpawned` and
`gnomesMarried`. Follow the same rule for new event kinds.

`fightRolled` additionally carries `casualtyCandidates: [UnitId | null, UnitId |
null]` — the unit each side stands to LOSE that round, parallel to `rolls`. It is
not a combatant: a roll belongs to the **side** (a seat, with that seat's Snake
Eyes / 4 Leaf Clover modifiers), so no unit ever rolls against another. `null`
means the side risks no gnome — a flytrap, which is only ever stunned. The engine
picks the losing side's victim with the same `casualtyCandidate` rule at the same
point in resolution it always has; the event just reports it too.

`UnitId` is contractually `u<n>` with `n` a positive integer allocated
sequentially from `nextUnitId` across all unit kinds. The ordinal is a stable
per-game identity that `src/ui/gnomeNames.ts` indexes to derive gnome names, so
`engine.test.ts` asserts the format at every creation site — change the format
and that generator needs another stable ordinal first.

## Errors

All rejections are `EngineError { code }`: `ILLEGAL_ACTION` (not legal now),
`BAD_ARGUMENT` (malformed payload), `BAD_CONFIG` (createGame), `INTERNAL`
(engine invariant broken — always a bug; the settle loop, exhaustiveness
guards and `internal()` calls use it).

## Testing

`src/engine/engine.test.ts` (vitest, `npm test`): config validation,
determinism, serializability, fights, the card stack (incl. Nope-Gnome),
timed-effect expiry, all curse behaviors, and seeded AI-vs-AI full games with
structural invariant checks. Because `GameState` is plain data, tests may
hand-craft scenarios by mutating a cloned state — keep that contract intact.
