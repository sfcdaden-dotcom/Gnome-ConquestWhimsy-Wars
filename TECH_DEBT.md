# Technical Debt Backlog

Two sections, and the split is the point:

- **[Active debt](#active-debt)** — work that is still owed. Prioritized:
  **P1** fix next session(s) · **P2** fix within the milestone it blocks ·
  **P3** opportunistic. If it is in this section, the code still has the
  problem.
- **[Resolved](#resolved)** — an append-only record of debt that has been paid
  off, newest first. Nothing here is actionable. It is kept because the
  *reasoning* is load-bearing: several entries record an approach that was
  tried and measured and found wanting, and re-adding one of those is a
  regression, not an improvement.

When an item is fixed, move it to Resolved with its date — don't strike it
through in place. A backlog where most of the text is crossed out hides the
handful of things anyone actually needs to do.

---

## Active debt

### P1

*(none — see [Resolved](#resolved))*

### P2

- **The deck is hidden from inspection, not cryptographically (Milestone 11).**
  Mulberry32's state is 32 bits. Dice rolls are public events, so enough
  observed rolls narrow `rngState` to a searchable set — 2^32 candidate states
  is a cheap sweep — and recovering it hands over the rest of the deck.
  Redaction, sealing and commit–reveal are all unaffected (each solves a
  different problem, and commit–reveal's soundness rests on the nonce, not on
  the RNG width), but none of them make the deck withstand a *determined*
  opponent rather than a curious one. The fix, when it matters: stop deriving
  the deck from the game RNG at all — have the host shuffle it from CSPRNG
  bytes and store the resulting order, leaving `rngState` to the dice, where
  prediction buys far less. Deferred deliberately: it changes what a replay
  needs to carry (the deck order, not just a secret), so it wants doing
  alongside the room's persistence format rather than before it.

  Also unresolved: the hand panel renders `HIDDEN_CARD_ID` as its literal
  string. Nothing shows another seat's hand today, so it is unreachable —
  give it a face-down card back when the multiplayer UI lands.

- **Stall vectors that rules cannot close (host responsibility, Milestone 11).**
  Audited 2026-07-29 alongside the entry-chain cap. Two remain, and both are the
  same shape: legal actions that change nothing.
  1. **A client that simply never acts.** No rule can fix this.
  2. **State-neutral spins.** `playCard` (opens `cardTargeting`) →
     `cancelTargeting` → repeat is free and unbounded by design — the card never
     leaves the hand, which is exactly what makes cancel safe. Same for
     re-selecting units in the UI.

  The answer to both is a shot clock, so the engine ships the *policy* half of
  one: `getTimeoutAction` / `applyTimeout` / `isOnTheClock` (`timeout.ts`,
  covered by `timeout.test.ts`, including a full game where one seat never acts).
  **Closed 2026-07-30** for online play: the room runs the clock (60s per
  action, plus a 5-minute budget per uninterrupted stretch of control that
  nothing the seat does restarts — that second deadline is what closes vector 2,
  since restarting on every action is exactly what a state-neutral spin
  achieves). See MULTIPLAYER.md, "The shot clock". Everything else in the Action
  Phase is already bounded — one move per unit per turn, and Wishes/cards gate
  the rest.

  The **repeat-offender policy** landed the same day: three consecutive
  timeouts and the room gives the seat to a CPU for the rest of the game, so a
  griefer cannot make the table spend a minute a turn on them indefinitely.
  Playing one legal action clears the count; chat and rejected actions do not.
  The player keeps their place in the room as a spectator. Local hot-seat games
  run no clock at all, deliberately: there is nobody to grief but yourself.

- **Board size above 7×7 has never had a visual pass (Milestone 5).** The
  tokens and art scale via container-query units × `--n` (2026-07-16), so 9×9+
  renders proportionally in principle, and `e2e/advanced-settings.spec.ts`
  proves a 9×9 board reaches the preview and the game with 81 cells. What has
  not happened is anyone *looking* at it: the panel, log, chat and action-bar
  layout around a board that wide, and whether a 13×13 cell's garden icon and
  unit token are still legible at the size the clamps leave them.

  Recorded at P3 until 2026-08-25 as "do a visual pass before exposing board
  size in the setup UI". That precondition has now been passed rather than
  met — the advanced setup panel (2026-08-25) offers 5/7/9/11/13 — so this is
  P2: it is shipped-and-unverified rather than a gate on unshipped work.

### P3

- **Rate limiting has two ends and nothing in between (Milestone 11).** Shipped
  2026-08-03: per-IP limits at the Worker's door and per-connection/per-room
  token buckets inside (see MULTIPLAYER.md, "Rate limiting"). What is left is
  the middle. A caller spread across many source addresses gets a fresh per-IP
  budget per address and can hold many rooms at their individual ceilings —
  each room bounded, the total not. Nothing in `Room` can see that, because a
  Durable Object's whole value here is that it knows only about itself. The
  answer is Cloudflare-shaped (WAF rules, Turnstile in front of `POST
  /api/rooms`) rather than room-shaped, and it is P3 because the cost of the
  attack it enables is idle Durable Objects, which Cloudflare bills by use and
  evicts when idle.

  Two smaller residuals, both deliberate. **A flooder inside a room can degrade
  that room**: the shared ceiling is what bounds total work, and a shared
  ceiling is by definition spendable by anyone in it. A room is a private table
  you gave a code to, so the blast radius is your own guests. And **buckets are
  in memory**, so a room that hibernates forgives whatever a flooder had spent
  — which requires the flooder to have stopped for long enough to let the room
  hibernate. `MAX_CONNECTIONS` is the part that does not depend on remembering
  anything.

- **Enumeration cost: measured 2026-07-30, deliberately not yet optimized.**
  The open question was whether legal-action and card-target feasibility work is
  repeated unnecessarily. It is — twice — but both are small, so this is
  recorded rather than acted on. `src/engine/perf.test.ts` is the harness; run
  `npx vitest run src/engine/perf.test.ts` and read the printed table. Figures
  below are from a 7×7 board, 5 gnomes, a hand holding all 18 targeted cards:

  | Measurement | Value |
  |---|---|
  | `getLegalActionIntents` | **0.39 ms** (49 actions) |
  | … same call with an empty hand | 0.02 ms |
  | … so card-target feasibility is | **95% of the call** |
  | `enumerateCompleteCardActions` (analysis path) | 13.9 ms (1336 actions) — **~36× the intent call** |
  | `firstCompleteTargets`, summed over all 18 targeted cards | 0.24 ms (worst: `pocket-shovel` 0.065 ms) |
  | One phased step's options (Plot Twist, first space) | 0.002 ms @7×7 · 0.007 ms @15×15 |
  | Full AI game: `chooseAiAction` | 1.7 ms/action (324 actions) — the objective layer's one BFS per action, plus the economy terms' per-candidate garden lookups |
  | … of which `getLegalActionIntents` | **6%** (`applyAction`'s clone+settle is 0.65 ms/action — the real cost) |

  The two duplications, both bounded:
  1. **The UI enumerates twice per render.** `GameScreen` memoizes `legal` for
     the acting seat and `handPlayable` for the revealed seat; on a local human's
     turn those are the *same seat over identical state*. Cost: **0.22 ms per
     render**, against a ~16 ms frame budget. Merging the two memos is easy and
     safe, but it buys ~1% of a frame.
  2. **The CPU can re-walk one card's flow.** Enumeration feasibility-checks each
     targeted hand card (`whyCannotPlayNow` → `firstCompleteTargets`); if the CPU
     then picks a card whose planner declined to target it, `completeTargets`
     walks that one flow again. Measured at **≤1 extra walk per action** — the
     planners cover everything they select — i.e. ≤0.065 ms worst case.

  Conclusion: no optimization is justified on these numbers, and any future one
  must show a before/after from this harness. If a change *is* made, the obvious
  target is a per-(state, player) memo of card feasibility, since that is 95% of
  an enumeration — but note the memo has to key on the whole state to stay
  correct, which is likely to cost more than the 0.39 ms it saves.

- **Browser tests cover the happy path only.** `e2e/gameplay.spec.ts` drives
  setup → roll-off → harvest → move → plant → fight → response window → end
  turn on a fixed seed. Not covered: 4-player games, CPU seats, the snail
  path, elimination/end-game overlays, the preset editor, and mobile layout.

- **AI holds some situational cards.** Mostly closed for Hard (2026-07-22):
  `planCardPlay` (`src/engine/ai/cardPlans.ts`) has board-state-aware heuristics
  for 5 of the 6 — wall an approach, sabotage an occupied economy garden, free
  tunnels near our own gnomes, marry two of the same opponent's gnomes for a
  future bonus kill, trap an enemy on Maize. Easy/Normal still hold them
  deliberately (the `isHard` gate).

  **Plot Twist is held by every difficulty** (regressed to "held" 2026-07-28).
  Its Hard planner swapped one of our gnomes into an enemy home holding a lone
  defender, on the premise that the swap "relocates the defender away with no
  Entry trigger" for a free capture. That premise was wrong: a garden and the
  critters standing on it move TOGETHER and the two spaces' contents cross
  rather than merge, so the defender arrives at the other space still on its own
  home while our gnome lands on the square the home just vacated. Home occupancy
  is invariant under a swap — the card cannot capture anything, and the planner
  was spending it to shuffle the enemy's home one space. Planner removed; the
  invariant is pinned by a Plot Twist test in `cards.test.ts`. To plan the card
  again, score what a swap can actually do (repositioning a garden and its
  occupants as a unit).

- **`scoreDestination` distorts when a friendly gnome shares a square with an
  enemy.** Such co-location can't arise in real play (entry always triggers a
  fight), but the BFS distance field marks the shared square unreachable, so
  any move off it scores ≈+200. Only bites hand-crafted test states; noted so
  future AI tests avoid placing a friendly gnome onto an enemy without a fight.

- **The CPU's plan store is advisory, and its "same game?" guard is a
  heuristic.** The objective layer (`src/engine/ai/objectives.ts`) keeps a
  posture and a stack of objectives per seat so the CPU pursues one intention
  across turns. That plan deliberately does NOT live in `GameState` — the state
  is cloned per action, encoded, sealed and shipped per seat, and no rule
  depends on what the CPU wants — so it lives in an `AiMemory` the caller owns
  (`Room` holds one, `useGame` holds one). Consequences, all accepted:
  · a room woken from hibernation, or rebuilt by replaying its record, has CPU
    seats that have forgotten their intentions and pick new ones next turn;
  · the module-level store behind the one-argument `chooseAiAction(state)`
    decides "is this the same game still running?" from `seed` plus a monotonic
    `eventCount` and turn number. Two DIFFERENT games with the SAME seed alive
    in one process will thrash that guard and get correct but forgetful play.
    Tests that pin exact CPU actions should pass their own `createAiMemory()`
    (`aiFingerprint.test.ts` does).
  If the AI ever needs a plan that survives a replay, the honest fix is to
  derive it from the state rather than to smuggle it into the wire format.

- **The objective library is deliberately three goals wide.** `CAPTURE_GARDEN`,
  `DEFEND_HOME`, `ATTACK_ENEMY_HOME`, and one interrupt (defend a threatened
  Home). The scaffolding for more is in place and cheap to extend — a new goal
  is an entry in `ObjectiveKind`, a proposal in `proposeObjectives`, a lifetime
  in `objectiveStatus`, and a bias in `objectiveScoring.ts` — but nothing was
  added on spec. The same is true of the two half-built extension points:
  `CARD_AFFINITY` only rates the cards with an obvious directional use (every
  other card keeps its existing `planCardPlay` score untouched), and
  `personalityFor` maps a seat's `difficulty` onto one of three personalities
  because seats have no named-personality field yet. Giving a seat its own
  weights is a change to `personalityFor` and nothing else.

- **Two turtle-breaker ramps now, not one.** `defenseDecay` / `offensePush`
  (`ai/util.ts`) exist for the same reason as `desperation`: without them the
  objective layer re-created the stalemate the tactical heuristics already had
  to solve, one level up — two CPUs each adopting `DEFEND_HOME` because the
  other is loitering three spaces away, forever (measured: 1800+ turns).
  Three ramps over the same clock is one too many. They should be folded into a
  single "how long has nobody won" signal the next time this area is touched.

- **A 4-player snail endgame can still run forever.** Two seats snailed, the
  rest with no gnomes left: the snails decline every relocation (nothing
  improves), nobody can be eliminated, and the game never ends. Reproduces on
  ~2 of 72 seeded AI games both before and after the objective layer (the
  affected seeds move, the rate does not), so it is an engine liveness hole
  rather than an AI one — `getTimeoutAction` closes a stalled SEAT, not a
  stalled GAME. Needs a rule (a turn cap, or scoring the position), which is
  why it was left alone here.

- **Quick chat is single-device only so far.** The engine half is
  multiplayer-ready (a `quickChat` action relays and replays like any other),
  but the UI speaks for exactly one seat — the revealed human — so in hot-seat
  play you can only chat as whoever is holding the device. Decide when real
  multiplayer lands: per-connection sender identity.

- **The CPU's chatter deliberately leaks its plan now.** It used to say only
  rhetorical `musings`, chosen so a chatty CPU gave nothing away. It now
  announces the objective it has adopted from the `schemes` group, because the
  objective layer is otherwise invisible — the plan lives in a store beside the
  state, and a plan nobody can read does not make an opponent more legible. The
  trade was made on purpose and is reversible in one place (`ai/chatter.ts`):
  a CPU that telegraphs "I'm coming for you" gives a human something to respond
  to, which is worth more here than inscrutability. Two consequences worth
  knowing: a strong human can play against the announcements, and the CPU
  cannot bluff (humans have the same lines and can). Still off a
  (seed, turn, seat) hash rather than RNG, so `chooseAiAction` stays
  deterministic. It reacts to its own plans only — never to fights, losses or
  wins; that would need a trigger table.

- **The postures' economic policy is a designer's choice, not a solved one.**
  EXPAND plants and takes gnomes; DEFEND draws and takes Wishes; a gnome already
  harvesting stays put while dug in unless an enemy is literally in the Home.
  That contrast was specified, then tuned until the measurements matched it
  (EXPAND plants ~3x as often and takes the body ~7x as often; DEFEND draws ~6x
  as often). Nobody has checked whether it WINS more — only that it does what it
  says. The garden-holding half is the weakest of the three: A/B'd, it moves the
  share of gnomes standing on resource gardens while defending from ~34% to
  ~38%, because it is competing with a Home that genuinely needs bodies.
  Raising the weights further bought no more occupancy, so the binding
  constraint is the defence, not the number.

- **Announcements are throttled by feel, not by evidence.** `SCHEME_COOLDOWN_TURNS`
  = 4, kind-changes speak through it, and the result is ~5% of all actions being
  chat (about one line every other turn per seat, measured over 72 games).
  That number came from reading transcripts, not from anyone playing. If it
  turns out to be grating in a real game, the knob is one constant.

- **Vitest smoke duration.** ~11 full AI games per run (the invariant validator
  and the AI fingerprints added two more). Fine now — the whole suite is ~22 s;
  if it creeps, split into a `test:full` tier and keep 3 games in the default
  run.

- **schemaVersion policy.** Still `1`; define bump/migration rules before
  save/load (Milestone 7) ships.

- **Pocket Shovel's *complete* enumeration is O(area²).** Residual from the
  phased-targeting fix. That is the true size of its legal set (any two empty
  spaces), not a narrowing failure, and it is off every hot path — only the
  analysis helper `enumerateCompleteCardActions` pays it. A three-space card
  would compound it; if one is ever added, cap or lazily page the analysis
  helper rather than the normal phased path.

---

## Resolved

Newest first. Kept for the reasoning, not as a to-do list.

### 2026-08-25 — Quality-of-life pass

- **`GameLog` keys.** Log lines keyed by their index in the rolling window, so
  every key meant a different line after the engine trimmed. Fixed while
  touching the log UI, as the entry anticipated: `logLines`
  (`src/ui/gameLog.ts`) tags each event with its match-wide ordinal, derived
  from `eventCount` — which is never trimmed — and the component renders that
  as the key. Unit-tested in `gameLog.test.ts`, including an event keeping its
  key across a window slide.

  Found and fixed alongside it, in the same component: the log auto-scrolled to
  the bottom on every new event, which yanked the view away from anyone who had
  scrolled back to re-read a fight. It now follows the tail only while the
  reader is already at the tail (`isPinnedToBottom`).

### 2026-08-25 — Backlog audit

- **The seed is still a secret worth protecting — server side (Milestone 11).**
  Carried as P2 after the 2026-07-29 redaction and sealing work, on the grounds
  that the client still picked the seed and the setup screen offered a field
  for it. Both halves were in fact closed by the room work of the same day, and
  the entry simply outlived them. `Room.start` (`src/net/room.ts`) draws the map
  seed from `host.randomBytes(4)` and the deck secret from `createSeal()`
  itself, publishing only the commitment at start and the secret at game end;
  the online screen offers no seed field and says so in copy ("The room picks
  the map and shuffles the deck itself"). The seed field that does exist lives
  in the local advanced setup panel, where full information is the point — a
  hot-seat table has no hidden state to protect from itself.

  What remains of the original concern is a *separate* item, still open under
  [Active debt](#active-debt) at P2: the deck is hidden from inspection, not cryptographically, because mulberry32's
  state is 32 bits. That one is unaffected by who picks the seed.

### 2026-07-30 — Engine/UI structural refactor

- **`ai.ts` had grown to 1281 lines.** Split into a package with one
  responsibility per file — `src/engine/ai/{index,scoring,cardPlans,decisions,
  chatter,util}.ts`, dependencies running one way (`index → {decisions,
  cardPlans, chatter} → scoring → util`). Behavior-preserving by construction
  *and* by test: `aiFingerprint.test.ts` pins the exact action sequence (an
  FNV-1a digest over canonical action keys, plus action count and winner) of
  seeded games at every difficulty, so any change in what the CPU plays fails
  the suite.
- **`GameScreen.tsx` owned too much interaction routing.** The rules — what a
  board click means, what lights up, when a unit selection dies — moved to pure
  functions in `src/ui/interaction.ts` (`resolveCellClick`, `computeHighlights`,
  `selectionStillValid`, `boardOptionAt`, `unitAffordances`, `bannerText`),
  tested directly in `interaction.test.ts` without rendering React. The
  component is now an adapter: assemble the context, dispatch what the rules
  return. A test asserts that highlights and clicks agree on every cell of a
  real state, which is the class of bug the extraction exists to make catchable.
- **No reusable invariant validator.** `checkInvariants` / `invariantsHold` /
  `assertInvariants` (`invariants.ts`) now report structural violations as a
  list — `{code, where, message}` — instead of throwing on the first one. The
  checks were previously an ad-hoc local helper inside `engine.test.ts`, which
  meant a multiplayer host or an error path had no way to run them. Covered both
  ways: full AI games validate cleanly after *every* action, and each invariant
  is provoked with a hand-broken state so a check that stops working is caught.
  The engine never calls it on the hot path — callers decide.
- **The two legal-action APIs were easy to confuse.** The exhaustive expansion
  moved out of `legalActions.ts` into its own module, `actionExpansion.ts`, so
  the expensive path can't be reached by autocompleting past the cheap one.
  `legalActions.ts` is now the intent API only; the new file's header carries
  the side-by-side comparison of cost and callers.
- **Enumerated actions had no identity but their array index.** `actionId.ts`
  adds `actionKey` / `intentKey` — deterministic, content-addressed strings that
  are stable across enumeration order, object key order and JSON round-trips.
  Order *inside* a target payload stays significant (an `ordered: true` step
  means `[a,b]` and `[b,a]` are different plays); `canonicalTargets` gives the
  order-insensitive form for hand-built unordered payloads. Enumerations are
  pinned key-unique across a whole AI game.

### 2026-07-29 — Multiplayer hardening

- **Optional entry-effect chains were unbounded (engine side).**
  Tunnel→tunnel hops could chain indefinitely if a player kept accepting (each
  hop is one action, so the engine never hung — but the turn never ended and no
  opponent could ever act). `MAX_ENTRY_EFFECT_HOPS` (3) now caps one arrival
  chain: `handleEntry` takes the chain's `hops` count, each `slide`/`tunnel`
  decision carries it, and the effect stops being offered at the cap
  (`entryChainCapped` event). Two adjacent Slippery Gardens were the same loop
  and are covered by the same cap. Mandatory harvest relocations are never
  blocked — they open a fresh chain and count as its first hop. **[RULING]**
  recorded in RULES.md ("Gnomes"); rationale and the surrounding termination
  argument in ENGINE_API.md ("Termination & anti-stall").

  The AI-side history: its "decline non-improving hops" guard (since
  2026-07-16) had a hole — a chained hop re-scores against `primaryTarget`
  recomputed from the mover's new position, so the target could flip between two
  tunnels and rate the return hop as "improving" too (an A→B→A ping-pong;
  surfaced 2026-07-24 when a balance change shifted a smoke-test seed into that
  state). Fixed 2026-07-24 by gating each declinable hop on strict progress
  toward a chain-STABLE anchor (the enemy home nearest our own base) — a
  monotone, bounded potential, so the chain always terminates (see `planHop` in
  `src/engine/ai/decisions.ts`). That heuristic still stands; the cap is the hard
  floor beneath it, so no policy — human or learned — can stall a game this way.

- **The `random` preset's layout was seed-derived and visible.** Fixed by
  `sealHiddenState` (`setup.ts`). The board itself narrowed the seed: an
  attacker generates layouts for candidate seeds until one matches what is on
  screen, and the deck falls out with it. Measured at ~0.4 ms per layout, a full
  2^32 sweep is ~480 core-hours — cheap, and a *reusable* precomputation rather
  than a per-game cost, so keeping the seed secret was never going to be enough
  on its own. A host now calls `sealHiddenState(createGame(options, mapSeed),
  secret)` once at creation: it replaces `rngState` with a CSPRNG secret and
  reshuffles the deck under it, leaving the layout untouched. `seed` is
  thereafter only the MAP seed — it reproduces the board and nothing else, and
  is safe to publish — while the deck and the dice follow from the secret alone.

  Consequence for replay (Milestone 8) and `MatchRecord` (`selfplay.ts`):
  `config + seed + actions` no longer reconstructs a sealed game. Resolved the
  same day — `MatchRecord` grew an optional `seal` (schema **2**) and
  `replayMatch` applies it, so a finished game replays exactly and the record is
  where the secret gets revealed.

- **Commit–reveal shipped** (`src/net/commitment.ts`). Sealing the deck means
  players must trust the host not to stack it; publishing `commitment` =
  SHA-256(secret, nonce) at room creation and the secret at game end removes
  that trust without leaking anything mid-game. `verifySeal` + `replayMatch`
  together prove the deck was fixed in advance *and* was the one dealt. The
  128-bit nonce is load-bearing: a bare `sha256(secret)` over a 32-bit secret is
  exhaustible in minutes, which would turn the commitment itself into a mid-game
  deck leak.

### 2026-07-23 — Targeting and AI positioning

- **Target enumeration was generate-and-filter, so it was quadratic for
  two-space cards**, with a hard `MAX_TARGET_COMBINATIONS` ceiling at 15×15.
  Fixed by phased targeting. Cards no longer expand every complete `CardTargets`
  payload up front: a targeted play opens a `cardTargeting` decision and the
  engine offers one step's options at a time (`getPendingDecisionOptions`),
  narrowed by the earlier picks. Listing options is now proportional to the
  current step, not the product of every slot — measured **0.012 ms** to list
  Plot Twist's 49 first-space options on 7×7 and **0.014 ms** for its 225 on
  15×15 (which the old enumerator refused entirely), then ~0.005 ms for the ≤4
  second-step neighbours. The full cartesian expansion survives only as the
  off-hot-path analysis helper `enumerateCompleteCardActions` (phased, so still
  bounded by real branching — no ceiling). Full-game AI throughput improved
  (4.39 → 3.07 ms/action) because the AI's target-completion fallback walks the
  flow greedily instead of enumerating. The card is not removed from hand until
  targeting completes, so cancelling / invalidation never duplicates, loses or
  double-charges a card. See `targeting.ts`, `targeting.test.ts`, and the two
  Playwright cases.

- **Proactive Hard pincer / 4p spread — tried and removed.** A Hard-only bias
  assigning each attacker a different face of the target home (and, in 4p, a
  different enemy home) was implemented, then dropped after measurement: on an
  open board the shortest face is identical for every attacker, so a bias weak
  enough not to hurt was inert (`distinctFacesEver=1` across full games) and one
  strong enough to fire only forces tempo-losing detours against an undefended
  home (the gambler's-ruin fight math is face-independent). The behaviour the
  rule wanted — a push one wall can't stop — already emerges: `distanceField`
  treats a walled/occupied face as impassable and re-routes the force around it,
  and anti-balling keeps them off one square. If revisited, make the split
  *reactive* to an actual blocker, not proactive, and prove it moves the win
  rate before re-adding branching.

### 2026-07-22 — Legality, response routing, rules audit

- **Human players couldn't plant after moving a gnome.** The engine always
  allowed it (`canPlantAt` never checked `movedOnTurn`), but `GameScreen.tsx`'s
  board-click routing only let you re-select a unit that still had a legal
  *move* — a gnome that had already moved dropped out of that list, so its Plant
  button became permanently unreachable for the rest of the turn. Fixed by also
  treating "has a legal plant at this space" as selectable, alongside "has a
  legal move". (Now pinned by `selection.test.ts` and `interaction.test.ts`.)

- **AI fight-respond enumeration could suggest unplayable-without-targets
  cards.** `getLegalActions` returns only complete, executable actions: targeted
  card plays are expanded into one action per valid `CardTargets` payload,
  enumerated generically from each card's target flow + `validate`. The cheap
  untargeted form is `getLegalActionIntents`; the AI plans on intents and passes
  whatever it picks through `completeTargets`, so it is structurally incapable
  of emitting a half-built action. Covered by `legalActions.test.ts`, including a
  whole-game test that dispatches every enumerated action at every state.

  **Follow-up, fixed 2026-07-28:** that whole-game test covered `getLegalActions`
  (the complete expansion) only, and the gap it missed was in the *intent* API.
  `getLegalActionIntents` gated targeted plays on the card's cheap `hasAnyPlay`
  hint, which can pass while the card's targeting FLOW has no completable path —
  so the intent list could offer a `playCard` that threw ILLEGAL_ACTION on
  dispatch (Hidden Passage / Gust Of Wind / Slippery Trail / Gnome Place Like
  Home on a gnome whose owner cannot pay its Maize exit; Pocket Shovel with one
  empty space left). The UI showed such a card as an enabled hand button that
  errored on click, and the Milestone-13 sample extractor treats the intent list
  as its action mask. Playability now also walks the flow greedily
  (`firstCompleteTargets`, in `cards.ts` so the check doesn't invert the
  `targeting → cards` dependency). A whole-game test now dispatches every
  *intent* at every state too.

- **`respondOnly` cards other than Nope-Gnome were untested territory.** The
  `cardId === 'nope-gnome'` special case is gone; `handleCardResponsePlay` now
  consults the card definition's `targetsRespondedCard` flag and records
  `respondsToStackIndex` on the stack entry (renamed from `nopeTarget`). A second
  counter-card needs only the two flags. `responseRouting.test.ts` registers
  fixture cards (via the test-only `__registerTestCard` seam) and proves the
  generic path, including that a `respondOnly` card *without* the counter flag
  gets no stack index.

- **Rules audit — remaining open questions.** Ruled (bulk audit done 2026-07-16
  while writing the per-card tests; the maize-roll divergence it found is fixed):
  Center Star wish-cap overflow keeps Wishes above 6 until spent (no trim) —
  designer confirmed the lenient reading is correct, no code change. Ritual
  timing (Action Phase only) — designer confirmed correct as implemented;
  CARDS.md's "any phase" wording already matches in practice since the Harvest
  Phase never idles.

- **AI desperation tuning (Hard).** Hard's fight-commitment in
  `scoreDestination` is a real win-probability calculation (gambler's-ruin on the
  stack-fight rounds — see the function's comment) with a bounded late-game push,
  replacing the flat threshold. Normal/Easy deliberately keep the original ad hoc
  ramp (Normal = no regression from before difficulty tiers existed; Easy drops
  the ramp entirely — see the AI difficulty doc comment at the top of
  `src/engine/ai/index.ts`).

### 2026-07-17

- **AI played no cards.** The AI now draws, plays (via `planCardPlay` with
  per-card deterministic target pickers, each checked against the card's own
  `validate`), responds (`planFightRespond` / `planCardResponse`) and discards by
  static keep-value. Six situational cards are still deliberately held — see
  "AI holds some situational cards" in Active debt.
