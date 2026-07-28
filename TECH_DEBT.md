# Technical Debt Backlog

Prioritized: **P1** fix next session(s) · **P2** fix within the milestone it
blocks · **P3** opportunistic.

## P1

- ~~**Human players couldn't plant after moving a gnome.**~~ **FIXED
  2026-07-22.** The engine always allowed it (`canPlantAt` never checked
  `movedOnTurn`), but `GameScreen.tsx`'s board-click routing only let you
  re-select a unit that still had a legal *move* — a gnome that had already
  moved dropped out of that list, so its Plant button became permanently
  unreachable for the rest of the turn. Fixed by also treating "has a legal
  plant at this space" as selectable, alongside "has a legal move".
- ~~**AI plays no cards.**~~ **DONE 2026-07-17.** `ai.ts` now draws, plays
  (via `planCardPlay` with per-card deterministic target pickers, each checked
  against the card's own `validate`), responds (`planFightRespond` /
  `planCardResponse`) and discards by static keep-value. Six situational cards
  are still deliberately held (see P3 "AI holds some situational cards").

## P2

- ~~**AI fight-respond enumeration can suggest unplayable-without-targets
  cards.**~~ **FIXED 2026-07-22.** `getLegalActions` now returns only complete,
  executable actions: targeted card plays are expanded into one action per
  valid `CardTargets` payload, enumerated generically from each card's
  `targetSpec` + `validate` (`legalActions.ts`). The cheap untargeted form
  moved to `getLegalActionIntents`, with `getTargetOptions(state, intent)`
  supplying payloads; the AI plans on intents and passes whatever it picks
  through `completeTargets`, so it is now structurally incapable of emitting a
  half-built action. Covered by `legalActions.test.ts`, including a whole-game
  test that dispatches every enumerated action at every state.

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
  (`firstCompleteTargets`, moved into `cards.ts` so the check doesn't invert the
  `targeting → cards` dependency). A whole-game test now dispatches every
  *intent* at every state too.
- ~~**`respondOnly` cards other than Nope-Gnome are untested territory.**~~
  **FIXED 2026-07-22.** The `cardId === 'nope-gnome'` special case is gone;
  `handleCardResponsePlay` now consults the card definition's
  `targetsRespondedCard` flag and records `respondsToStackIndex` on the stack
  entry (renamed from `nopeTarget`). A second counter-card needs only the two
  flags. `responseRouting.test.ts` registers fixture cards (via the test-only
  `__registerTestCard` seam) and proves the generic path, including that a
  `respondOnly` card *without* the counter flag gets no stack index.
- ~~**Rules audit — remaining open questions.**~~ **RULED 2026-07-22** (bulk
  audit done 2026-07-16 while writing the per-card tests; the maize-roll
  divergence it found is fixed): Center Star wish-cap overflow keeps Wishes
  above 6 until spent (no trim) — designer confirmed the lenient reading is
  correct, no code change. Ritual timing (Action Phase only) — designer
  confirmed correct as implemented; CARDS.md's "any phase" wording already
  matches in practice since the Harvest Phase never idles.
- ~~**AI desperation tuning.**~~ **DONE 2026-07-22 for Hard.** Hard's
  fight-commitment in `scoreDestination` is now a real win-probability
  calculation (gambler's-ruin on the stack-fight rounds — see the function's
  comment) with a bounded late-game push, replacing the flat threshold.
  Normal/Easy deliberately keep the original ad hoc ramp (Normal = no
  regression from before difficulty tiers existed; Easy drops the ramp
  entirely — see the AI difficulty doc comment at the top of `ai.ts`).

## P3

- ~~**Target enumeration is generate-and-filter, so it is quadratic for
  two-space cards**, with a hard `MAX_TARGET_COMBINATIONS` ceiling at 15×15.~~
  **FIXED 2026-07-23** by phased targeting. Cards no longer expand every
  complete `CardTargets` payload up front: a targeted play opens a
  `cardTargeting` decision and the engine offers one step's options at a time
  (`getPendingDecisionOptions`), narrowed by the earlier picks. Listing options
  is now proportional to the current step, not the product of every slot —
  measured **0.012 ms** to list Plot Twist's 49 first-space options on 7×7 and
  **0.014 ms** for its 225 on 15×15 (which the old enumerator refused
  entirely), then ~0.005 ms for the ≤4 second-step neighbours. The full
  cartesian expansion survives only as the off-hot-path analysis helper
  `enumerateCompleteCardActions` (phased, so still bounded by real branching —
  no ceiling). Full-game AI throughput improved (4.39 → 3.07 ms/action) because
  the AI's target-completion fallback walks the flow greedily instead of
  enumerating. The card is not removed from hand until targeting completes, so
  cancelling / invalidation never duplicates, loses or double-charges a card.
  See `targeting.ts`, `targeting.test.ts`, and the two Playwright cases.

  Residual: Pocket Shovel's *complete* enumeration (the analysis helper) is
  still O(area²) — but that is the true size of its legal set (any two empty
  spaces), not a narrowing failure, and it is off every hot path. A three-space
  card would compound it; if one is ever added, cap or lazily page the analysis
  helper rather than the normal phased path.
- **Browser tests cover the happy path only.** `e2e/gameplay.spec.ts` drives
  setup → roll-off → harvest → move → plant → fight → response window → end
  turn on a fixed seed. Not covered: 4-player games, CPU seats, the snail
  path, elimination/end-game overlays, the preset editor, and mobile layout.

- **AI holds some situational cards.** **MOSTLY DONE 2026-07-22 for Hard.**
  `planCardPlay` has board-state-aware heuristics for 5 of the 6 (wall an
  approach, sabotage an occupied economy garden, free tunnels near our own
  gnomes, marry two of the same opponent's gnomes for a future bonus kill, trap
  an enemy on Maize). Easy/Normal still hold them deliberately — see the
  `isHard` gate in `ai.ts`.

  **Plot Twist is held by every difficulty again (2026-07-28).** Its Hard
  planner swapped one of our gnomes into an enemy home holding a lone defender,
  on the premise that the swap "relocates the defender away with no Entry
  trigger" for a free capture. That premise was wrong: a garden and the critters
  standing on it move TOGETHER and the two spaces' contents cross rather than
  merge, so the defender arrives at the other space still on its own home while
  our gnome lands on the square the home just vacated. Home occupancy is
  invariant under a swap — the card cannot capture anything, and the planner was
  spending it to shuffle the enemy's home one space. Planner removed; the
  invariant is now pinned by a Plot Twist test in `cards.test.ts`. To plan the
  card again, score what a swap can actually do (repositioning a garden and its
  occupants as a unit).
- **`scoreDestination` distorts when a friendly gnome shares a square with an
  enemy.** Such co-location can't arise in real play (entry always triggers a
  fight), but the BFS distance field marks the shared square unreachable, so
  any move off it scores ≈+200. Only bites hand-crafted test states; noted so
  future AI tests avoid placing a friendly gnome onto an enemy without a fight.
- **Proactive Hard pincer / 4p spread — tried and removed 2026-07-23.** A
  Hard-only bias assigning each attacker a different face of the target home
  (and, in 4p, a different enemy home) was implemented, then dropped after
  measurement: on an open board the shortest face is identical for every
  attacker, so a bias weak enough not to hurt was inert (`distinctFacesEver=1`
  across full games) and one strong enough to fire only forces tempo-losing
  detours against an undefended home (the gambler's-ruin fight math is
  face-independent). The behaviour the rule wanted — a push one wall can't stop
  — already emerges: `distanceField` treats a walled/occupied face as
  impassable and re-routes the force around it, and anti-balling keeps them off
  one square. If revisited, make the split *reactive* to an actual blocker, not
  proactive, and prove it moves the win rate before re-adding branching.

- **Board size > 7 UI.** Tokens/emoji now scale via container-query units ×
  `--n` (2026-07-16), so 9×9+ renders proportionally — but it has only been
  eyeballed at 7×7; do a visual pass on 9×9/11×11 before exposing board size
  in the setup UI.
- **`GameLog` keys.** Log lines key by window index; with the 1000-event
  rolling window, React keys shift after trim. Cosmetic (append-mostly), fix
  when touching the log UI.
- **Vitest smoke duration.** ~9 full AI games per run. Fine now; if it creeps,
  split into a `test:full` tier and keep 3 games in the default run.
- **schemaVersion policy.** Still `1`; define bump/migration rules before
  save/load (Milestone 7) ships.
- **Optional entry-effect chains are unbounded (engine side).** Tunnel→tunnel
  hops can chain indefinitely if a player keeps accepting (each hop is one
  action, so the engine never hangs). The **AI** no longer loops here: its
  "decline non-improving hops" guard (since 2026-07-16) had a hole — a chained
  hop re-scores against `primaryTarget` recomputed from the mover's new
  position, so the target could flip between two tunnels and rate the return
  hop as "improving" too (an A→B→A ping-pong; surfaced 2026-07-24 when a
  balance change shifted a smoke-test seed into that state). Fixed 2026-07-24
  by gating each declinable hop on strict progress toward a chain-STABLE anchor
  (the enemy home nearest our own base) — a monotone, bounded potential, so the
  chain always terminates (see the `slide`/`tunnel`/`snailMove` case in
  `ai.ts`). Still open for multiplayer (Milestone 11): an engine-level [RULING]
  cap so a griefing *human* client can't stall a game.
