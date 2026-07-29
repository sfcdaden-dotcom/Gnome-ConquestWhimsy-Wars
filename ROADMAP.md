# Whimsy Wars — Roadmap

Status legend: ✅ done · 🔶 in progress · ⬜ not started

| # | Milestone | Status | Notes |
|---|-----------|--------|-------|
| 1 | **Engine stability** | ✅ | Strict TS, zero warnings; full games run headless; settle loop covers card stack, fights, eliminations, harvests; all 12 decision kinds routable; seeded AI-vs-AI suite green (2026-07-16). 2026-07-22: `engine.ts` split by responsibility (actions/turns/settle/elimination/legalActions); `getLegalActions` now returns only complete, executable actions (targets included) with `getLegalActionIntents` + `getTargetOptions` as the cheap two-stage path; response routing driven by card metadata instead of card ids; settle guard cut 100,000 → 1,000 with a full state diagnostic on overrun |
| 2 | Complete gameplay implementation | ✅ | Rules audit done 2026-07-16 (found & fixed: maize harvest roll now uses the owner's roll, so Snake Eyes/Clover apply). Two open designer questions logged in TECH_DEBT.md |
| 3 | Complete card system | ✅ | All 23 cards + 5 curses implemented, resolvable, and covered by per-card tests (validate/resolve/fizzle, 36 tests in cards.test.ts, 2026-07-16) |
| 4 | AI competency | 🔶 | Card play landed 2026-07-17: the AI now draws (when wish-rich with hand room), plays economy/removal/reinforcement/finisher cards through `planCardPlay` (deterministic target pickers validated against each card's own `validate`), responds in fight windows (Gnomebody-Dies shield vs flytraps, Clover/Snake-Eyes in home-stakes/late fights), Nope-Gnomes lethal cards (Rocket/Mushroom-Cloud on our gnomes), and discards its lowest-value card. Difficulty levels landed 2026-07-22: per-seat Easy/Normal/Hard dropdown in Setup; Easy never plays response-window cards and ignores the late-game push; Hard replaces the flat fight-commitment heuristic with a genuine win-probability calculation and plays the 6 previously-held situational cards. Also 2026-07-22: the AI now plants Maize and Tunnel Gardens (previously only Dandelion/Mushroom/Flytrap). 2026-07-23 — positioning fixes: (a) anti-balling — friendly gnomes stacking onto one square is now penalized (spread ~1–2/space, a 3rd only when it buys a fight), so the force fans out toward a target instead of marching as a single ball; (b) economy gardens are built as one home-cluster capped by near-home count (occupancy-independent) instead of replanting each time a holder wandered off — this ends the trail of abandoned Mushroom Gardens, and gnomes now settle onto the cluster to harvest it and dig in to defend it when an enemy closes in. Measured off-home stacks fell to ≤2 and games still terminate. 2026-07-23 — Hard positional rules of thumb: (a) "don't wall yourself in" — Hard no longer plants maize/flytrap by its own home; instead it drops them opportunistically on an enemy's attack lane (a porch square facing us) as a Wish-tax (maize) or forced-detour wall (flytrap, only when the planting gnome can vacate the same turn so its own trap doesn't bite it), see `scoreForwardDeterrent`; (b) "multiple lanes without abandoning the start" — a proactive pincer/spread bias was tried and removed as inert/tempo-negative (see TECH_DEBT.md); the unstoppable-by-one-wall push it wanted already emerges from obstacle-aware routing + anti-balling, while the home-garrison + economy-hold keep a defender back. Remaining: difficulty-aware fight-*response* windows (Hard currently reuses Normal's), Hard tactics beyond fight commitment (e.g. baiting, feints) |
| 5 | UI polish | 🔶 | Layout rebalanced 2026-07-16: board fits its slot (column width + dvh clamp + 580px cap) instead of dominating; stable action-bar footer; container-query token scaling (any board size); calmer borders/shadows; stacked-mode overlap fixed. 2026-07-28 — **gnome names**: each gnome has a deterministic name ("Bramblewick the Bold") derived from `(seed, unitId)` in `src/ui/gnomeNames.ts` — no RNG consumed, no `Unit` field, and it still resolves for units already destroyed. Two problems it fixes: (a) a stack of gnomes could only be picked apart by clicking the cell repeatedly with no feedback about which one you held — the action bar now names the selection and offers a chip per gnome (short first names, full name in `title`/`aria`, promoted to full names if a stack shares one), both the chips and the click-cycle reading one ordered list from `src/ui/selection.ts`; (b) the log said "Red loses a unit" — it now names the gnome that died, and each `fightRolled` line names the units at risk on both sides. Board tokens stay unlabelled deliberately (no permanent name clutter). Remaining: animations, mobile layout pass, visual identity beyond emoji |
| 6 | Audio/visual polish | ⬜ | |
| 7 | Save/load games | ⬜ | Engine is already serializable; needs schemaVersion migration policy + UI |
| 8 | Replay support | ⬜ | Record action log alongside seed; replay = re-apply (determinism already tested) |
| 9 | Statistics | ⬜ | Per-player aggregates from event stream |
| 10 | Accessibility | ⬜ | Keyboard-only play, screen-reader labels (board cells already have aria-labels), color-blind palettes |
| 11 | Multiplayer-ready architecture | ⬜ | Server-authoritative applyAction relay; state is plain data by contract. 2026-07-29 — **anti-stall groundwork** (a griefing client must not be able to keep a turn open forever): entry-effect chains capped at `MAX_ENTRY_EFFECT_HOPS` = 3, killing the tunnel↔tunnel / slippery↔slippery ping-pong ([RULING] in RULES.md), plus a deterministic shot-clock policy in the engine (`getTimeoutAction` / `applyTimeout` / `isOnTheClock`) so a host can close any stalled seat. Remaining for this milestone: the server-side timer itself and the repeat-offender policy (see TECH_DEBT.md "Stall vectors that rules cannot close"). 2026-07-29 — **quick chat**: `quickChat` action + `quickChatSaid` event carrying a phrase id from a fixed catalogue (`quickchat.ts`), never free text; 4 per player per turn, refilled each turn and at game end; sendable out of turn and after the game ends ("gg"); never enumerated as a legal action. UI: a collapsible **chat window** (right of the board on desktop, below it on mobile) with Chat / Game log tabs sharing one panel — unread-chat badge on the tab — and a composer at its foot that opens a **radial menu** of the six categories, each opening a list of its phrases (a list, not a second ring: the lines are sentences). Plus bubbles over the board with a mute toggle; muting is cosmetic, the transcript keeps every line. Same day: the CPU mutters too — holding a playable Whimsy Card without playing it sometimes spends one quickchat from the rhetorical `musings` group (hashed from seed/turn/seat, so determinism holds), and those musings are on every human's menu as well. 2026-07-29 — **design settled** (private friend rooms with server-run CPU seats to fill a table, realtime + reconnect, Cloudflare Durable Objects — one DO per room, matching the existing Workers deploy) and **P0 shipped: per-seat redaction** (`view.ts`). `GameState` is a full-information object — hands, deck order, and `rngState`, from which every future draw and roll is computable — so broadcasting it leaves no hidden information at all. `viewFor(state, seat)` builds the `PlayerView` one seat may see, on the same info-set boundary `encode.ts` already pins (own hand in full, other hidden zones as counts), preserving counts structurally via `HIDDEN_CARD_ID` so `deck.length` / hand sizes keep working. Also redacts the private half of the pending decision (response windows' `playableCards`, another seat's in-progress `cardTargeting` — the card is still in hand until the last target is picked) and the card identities in `cardDrawn` / `cardStolen` / `deckReshuffled`. A view is structurally a `GameState` so rendering takes it unchanged, but `applyAction` rejects one (zeroed `rngState` would diverge silently). Gnome names moved off `state.seed` onto a truncated `nameSalt` via `nameSaltOf`. 20 tests, stated differentially: states differing only in hidden content produce identical foreign views. Same day, **the seed becomes a secret**: `createGame` derives layout, deck and dice from one seed, and the layout is drawn on the board — so the seed was searchable (~0.4 ms per layout ⇒ ~480 core-hours for the full 2^32 space, a reusable precomputation rather than a per-game cost), and hiding it would not have helped. `sealHiddenState(createGame(options, mapSeed), secret)` replaces `rngState` with a CSPRNG secret and reshuffles the deck under it, leaving the layout untouched: `seed` is thereafter only the MAP seed (safe to publish — it reproduces the board and nothing else) while the deck and dice follow from the secret alone. Sealed games still replay deterministically per `(seed, secret)`, so `MatchRecord` gained an optional `seal` (schema **2**) that `replayMatch` applies — a sealed game does not replay from `config + seed` alone. Same day, **commit–reveal** (`src/net/commitment.ts`, the first file of the multiplayer protocol layer): sealing the deck means trusting the host not to stack it, so the host publishes `commitment` = SHA-256(secret, nonce) at room creation and the secret at game END — `verifySeal` + `replayMatch` then prove the deck was fixed in advance and was the one dealt, with nothing leaked while the game is live. The 128-bit nonce is load-bearing (a bare `sha256(secret)` over a 32-bit secret is exhaustible in minutes, which would make the commitment itself a mid-game deck leak). Known limit, logged: mulberry32's 32-bit state means the deck is hidden from inspection, not cryptographically — public dice rolls narrow `rngState` to a searchable set. Remaining: P1 the room DO (WS relay, seat↔connection identity, server-authoritative `applyAction`, server-generated secret and no seed field in multiplayer setup), P2 the shot clock on DO alarms + reconnect tokens, P3 4p/mixed CPU + per-connection chat identity, P4 match-record persistence and repeat-offender policy |
| 12 | Release candidate | 🔶 | Public-release prep done 2026-07-16 (v1.0.0-rc.1): build-time CSP, security headers, error boundary, host-agnostic relative base, deps audit clean, DEPLOYMENT.md. 2026-07-22: GitHub Actions CI (`.github/workflows/ci.yml`) runs `npm ci` → lint → test → build plus the Playwright browser suite on every push and PR. License chosen 2026-07-24 (proprietary, all rights reserved). Remaining human steps: git init/push, host account + first deploy (see DEPLOYMENT.md checklist) |
| 13 | Learned CPU (self-play RL) | 🔶 | Stretch goal beyond the heuristic AI (M4): a CPU that discovers strategy from self-play instead of hand-coded rules. Phase 0 done 2026-07-24 (PR #3): the deterministic self-play match recorder (`src/engine/selfplay.ts`) emits `config + seed + full action list + result` records that `replayMatch` reconstructs exactly — the training-data substrate. Plan is a model-free self-play **PPO** policy (not AlphaZero: the game is imperfect-info + stochastic, which breaks vanilla MCTS; PPO gives single-forward-pass inference that ships to the browser). Sequenced as independently-shippable phases — see the **Milestone 13** section below. Phase 1 done 2026-07-24: observation/option encoders (`encode.ts`) + `replayMatch`-based sample extractor (`samples.ts`), pure TS, info-set boundary pinned by tests. Remaining: behavior-cloning de-risk (P2), self-play PPO (P3), ship as a "Learned" difficulty (P4) |
| 14 | Garden upgrades & per-player supply | ✅ | Design finalized with the designer 2026-07-28: 2-Wish upgrade action, tile-sticky (capturable) upgrades per garden type, per-player tile supply (4/type) replacing the shared bank, wild preset tiles. Spec: RULES.md ("Garden Upgrades" + per-garden **Upgraded** entries); rationale + implementation map: GARDEN_UPGRADES.md. Implemented same day: engine (`upgrade` action, upgraded harvest/entry effects, Snapping Maw d6+1, per-player supplies with return-to-planter), cards (Wild Growth / Pocket Shovel draw from the card player's supply), encoders (ENCODING_SCHEMA 2: upgraded plane + per-seat supply scalars), AI (upgrade heuristic on the home economy cluster), UI (upgrade button, ⭐ badge, per-player tile panel, log lines). 238 unit + 10 e2e tests green; `upgrades.test.ts` covers the action, all six upgraded forms, capture-the-upgrade and supply-return rules. Balance watch-points (incl. an observed 2p tempo speed-up) tracked in GARDEN_UPGRADES.md. 2026-07-28 (rework): Elder Mushroom no longer raises the clone cap (back to 2) — instead it grants **+1 to the controller's gnome board limit while controlled** (`gnomeBoardCap` in `helpers.ts`, mirroring `wishCap`; rationale in GARDEN_UPGRADES.md) |

## Current focus

**Milestone 12 (partial) — public release prep**: engineering side done
2026-07-16; awaiting the human checklist in DEPLOYMENT.md (git, host
account — license chosen 2026-07-24). In parallel, **Milestone 4 — AI competency** is in progress:
the card-play work item is done (2026-07-17), and 2026-07-22 landed AI
difficulty (Easy/Normal/Hard, per-seat dropdown in Setup), a genuine
win-probability fight-commitment calculation for Hard (replacing the flat
desperation-ramp heuristic for that tier), Hard playing the 6 previously-held
situational cards, and wider AI garden variety (Maize + Tunnel, not just
Dandelion/Mushroom/Flytrap). Verified by dedicated `ai.ts` policy tests plus
Normal and Hard AI-vs-AI smoke suites (games still terminate for both).
Remaining Milestone 4 work: difficulty-aware fight-*response* windows (Hard
currently reuses Normal's Gnomebody-Dies/Clover/Snake-Eyes logic unchanged),
and further Hard-tier tactics beyond fight commitment.

## Milestone 13 — Learned CPU (self-play reinforcement learning)

A stretch goal beyond the heuristic AI (Milestone 4): a CPU that *discovers*
strategy from playing itself, rather than following hand-coded rules. Post-1.0
and research-flavored, so it is sequenced as independently-shippable phases,
each gated on a concrete result — never all-or-nothing.

### Design choices

- **Algorithm — model-free self-play PPO (actor-critic), not AlphaZero.** The
  game is imperfect-information (hidden hands and deck) and stochastic (dice),
  which breaks vanilla perfect-information MCTS. PPO conditions on the acting
  seat's *information set* and learns expected outcome under uncertainty, and
  its inference is a single forward pass — cheap, low-latency, and small enough
  to ship to the browser. (Information-Set MCTS / tree search is held in reserve
  if strength plateaus.)
- **Policy — a decision-point policy over the engine's own legal options.** No
  giant flat action space: at every state where `getPlayerToAct` returns a seat,
  the net scores the currently-legal set from `getLegalActionIntents` /
  `getPendingDecisionOptions` (the mask *is* the engine's legality). Targeted
  cards resolve step-by-step through the existing phased-targeting decisions, so
  target combinations are never enumerated. Output is the same `Action` contract
  as `chooseAiAction`, making the learned policy a drop-in.
- **Runtime — TensorFlow.js in-repo for v0.** The engine is directly callable in
  the training loop (no serialization boundary) and the trained model is already
  JS for the browser. Graduate to TS-selfplay → PyTorch → ONNX
  (`onnxruntime-web`) only if throughput demands it. Never a second Python engine
  — determinism is a core contract that two engines would risk.
- **Encoding (fix 7×7 for v0)** — spatial planes (own / per-enemy gnomes,
  garden-type one-hots, flytrap active/stunned, center star, home ownership) plus
  scalars (wishes + cap, reserves / reinforcements, my hand as card-type counts
  and opponents' hands as counts only = the info-set boundary, deck/discard
  sizes, active curses, turn, phase, pending-decision kind, roll modifiers,
  shields).
- **Reward** — terminal +1 / −1 / 0 per seat (optionally shaped by margin or
  survival), Monte-Carlo return with a value baseline. Self-play against a
  rotating **opponent pool** of past checkpoints (prevents strategy collapse).
  **Eval gate: win-rate vs the heuristic Hard.**

### Phases

- **Phase 0 — ✅ match recorder (2026-07-24, PR #3).** `playSelfPlayGame` /
  `simulateSelfPlay` / `replayMatch` / NDJSON in `src/engine/selfplay.ts`;
  deterministic `config + seed + actions + result` records.
- **Phase 1 — ✅ encoders + sample extractor (2026-07-24).** Pure TS, no ML
  deps. `src/engine/encode.ts`: `encodeObservation(state, seat)` — the acting
  seat's information set as 26 board planes + a scalar block (per-relative-seat
  stats, own hand as card-type counts, opponents' hands as sizes only,
  deck/discard as counts only — hidden info provably never leaks, pinned by
  tests) — and `encodeOption(state, seat, action)` — each legal intent as a
  fixed 81-value vector, so the engine's legality is the action mask.
  `src/engine/samples.ts`: `extractSamples(record)` replays a MatchRecord and
  emits `{ seat, obs, legalOptions, chosenIndex, reward }` per decision point
  in the SAME option space the policy will act in: one-shot targeted card
  plays (how the heuristic AI records them) are decomposed into an intent pick
  plus per-step `selectTarget` picks on a discarded scratch branch, so the
  real replay never drifts from `replayMatch`. `ENCODING_SCHEMA` versions the
  layout. 26 new tests (encode.test.ts, samples.test.ts).
- **Phase 2 — ⬜ behavior cloning.** Train a net to imitate `chooseAiAction`.
  Success = it mostly matches the heuristic and plays legal games end-to-end —
  de-risks the whole encode → net → decode → play pipeline and warm-starts PPO.
- **Phase 3 — ⬜ self-play PPO** from the BC-initialized net, with the opponent
  pool and the Hard-win-rate eval gate.
- **Phase 4 — ⬜ ship.** Lazy-loaded weights (static asset),
  `chooseNeuralAction(state, model)` mirroring `chooseAiAction`, exposed as a new
  "Learned" / "Expert" difficulty (heuristic stays as fallback and for
  Easy/Normal). Check bundle size + per-move latency.
