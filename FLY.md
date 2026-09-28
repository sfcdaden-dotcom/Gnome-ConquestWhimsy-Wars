# The Fly

An experimental CPU opponent: pick **Fly** as a CPU seat's difficulty (local
setup or online room). It plays on top of the regular CPU — every legal action
keeps its tactical score — and adds drives, incentives, risk rules, a read of
its opponents and a post-game learning review.

It started as the stand-in for a simulated fruit fly brain: `flyDrives()` in
`src/engine/ai/fly.ts` is the seam where a connectome simulation would supply
the drives. The FlyWire connectome data and the Python whole-brain simulator
live in the separate `Gnome-ConquestWhimsy-Wars-FlyBrain` repository; nothing
here depends on them.

## Benchmark

200 games per matchup (seeds 1–200, sides alternating), learning off:

| Matchup | Fly | CPU | Draws |
|---|---|---|---|
| Fly vs Normal | 87 | 113 | 0 |
| Fly vs Hard | 90 | 109 | 1 |
| Normal vs Normal (baseline) | 93 | 107 | 0 |

Run-to-run noise at 200 games is about ±7 wins. In 4-player games (two Fly
seats, Easy, Hard, 80 games) it wins about 22% per seat, Easy 31%, Hard 25%.

## How it decides

| File | What it does |
|---|---|
| `src/engine/ai/fly.ts` | Drives, incentive pulls, the fight brake, the Home watch rules, Maize awareness, and the post-game review |
| `src/engine/ai/flyIntent.ts` | Reads where each enemy gnome is heading, and keeps a per-opponent habit profile |
| `src/engine/ai/flyReach.ts` | Every square each enemy gnome could reach on its next turn by any legal route |
| `src/engine/ai/trainedFlyBrain.ts` | The learned brain every fly starts from (generated) |
| `src/engine/ai/tunedFlyParams.ts` | Win-rate-tuned setting overrides (generated) |

**Drives** (read off the board each decision): hunger (thin economy),
aggression (force ratio against the strongest enemy), fear (how scarce
reinforcements are), alarm (enemy gnomes near a garden it holds).

**Incentives**: a small pull toward each kind of action — territory 1.5,
planting 1.25, harvest 1, cards 0.6, drawing 0.3, fighting 0.75, advancing on
the enemy Home 1.5, defending 3 (`FLY_PRIORITY`) — scaled by the drives. They
are kept small on purpose: they tip close calls between sound actions. At
twice these values the fly neglected its attack and lost 3:1.

**Risk brake** (applied after the tactical vetoes, `FLY_FIGHT_ODDS`): one
fight a turn at fair odds is fine; a second needs about 62%, a third about
85%. Every bar rises as reinforcements run out, falls a little for a stronger
force, and falls when the fight defends a threatened garden.

**Garden-threat alarm** (`FLY_THREAT`): `alarmAt` enemy gnomes within
`radius` of an economy garden it holds rings the alarm. It then prefers
killing those raiders or reinforcing the garden, accepts worse odds for that
fight, and such kills pay extra. Worth about 19 wins in 200 against Normal.

**Reading intentions** (`FLY_INTENT`): at the start of each of its turns the
fly snapshots enemy gnome positions and guesses, from recent movement, whether
each gnome is heading for its Home, one of its gardens, back to its own Home,
or the center. It reinforces assets before raiders arrive, intercepts gnomes
coming for them, and pushes on an enemy Home left undefended. Each opponent's
revealed habits (only gnomes that actually moved toward a target count) are
kept for the rest of the browser tab and tilt later guesses.

**Home watch**: from the reach map — walks, harvest slides (a Glacier's
2-space line included), tunnel hops and entry chains up to the 3-relocation
cap — the fly counts the enemy gnomes that could land on its Home next turn.
While those outnumber its defenders it will not walk a defender off, pulls
gnomes home, takes a gnome from the Home harvest (it spawns on the Home), and
treats any gnome that can reach its Home as its top target. Cards are not
modelled.

**Maize awareness**: it will not walk into Maize it cannot pay to leave, and
counts the toll as a cost otherwise.

## Learning

During a match the brain is frozen; the fly logs each choice and each reward
that followed (`FLY_REWARDS`). When the game ends, the review credits every
choice with the result plus the later rewards, discounted per turn
(`FLY_REVIEW`), and play leans toward what beat its average.

Learning is on in local games and online rooms, and the brain carries across
the games in one tab or room; a reload starts again from `trainedFlyBrain.ts`.
Nothing is written to the device.

Caveat: learning has not yet made the fly stronger against the CPUs. A fly
that never learns wins 86 of 200 against Normal; a 1000-game review-trained
brain wins 67. The shipped brain is therefore blank. Per-choice credit is
confounded — choices made from winning positions look good whether or not
they caused the win.

## Tools

```bash
npm run train:fly   # self-play the brain; FLY_TRAIN_GAMES (default 1000)
npm run tune:fly    # hill-climb the settings by win rate (scripts/tune-fly.mjs)
```

The tuner reached 90 of 200 on its own pool against the defaults' 78, but on
the held-out benchmark the tuned settings won 83 against Normal and 83 against
Hard versus the defaults' 85 and 84: selection noise from adopting the best of
four noisy scores each round. No tuned settings are applied; re-checking each
adopted candidate on fresh games would fix the tuner.
