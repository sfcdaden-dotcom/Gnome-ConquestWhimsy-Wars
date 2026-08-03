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

- **The seed is still a secret worth protecting — server side (Milestone 11).**
  Per-seat redaction (`view.ts`) and deck sealing (`sealHiddenState`) landed
  2026-07-29 and closed the broadcast and layout leaks. One hole is left, and
  it belongs to the room server rather than the engine: **who picks the seed.**
  Today the client passes it to `createGame`, and the setup screen even lets a
  player type one. A client that knows the seed knows the deck order and every
  future die roll, redaction or no redaction. The room server must generate the
  secret (`crypto.getRandomValues`) and never send it, and the multiplayer
  setup UI must not offer a seed field at all.

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
  | Full AI game: `chooseAiAction` | 0.90 ms/action (244 actions) |
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

- **Quick chat is single-device only so far.** The engine half is
  multiplayer-ready (a `quickChat` action relays and replays like any other),
  but the UI speaks for exactly one seat — the revealed human — so in hot-seat
  play you can only chat as whoever is holding the device. The CPU mutters a
  rhetorical `musings` line when it sits on a playable Whimsy Card, off a
  (seed, turn, seat) hash rather than RNG so `chooseAiAction` stays
  deterministic (`src/engine/ai/chatter.ts`). That is its whole personality; it
  never reacts to fights, losses or wins. Decide when real multiplayer lands:
  per-connection sender identity, and whether the CPU's chatter should react to
  events (which needs a trigger table, and a rule that it still says nothing
  informative).

- **Board size > 7 UI.** Tokens/emoji scale via container-query units × `--n`
  (2026-07-16), so 9×9+ renders proportionally — but it has only been eyeballed
  at 7×7; do a visual pass on 9×9/11×11 before exposing board size in the setup
  UI.

- **`GameLog` keys.** Log lines key by window index; with the 1000-event
  rolling window, React keys shift after trim. Cosmetic (append-mostly), fix
  when touching the log UI.

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
