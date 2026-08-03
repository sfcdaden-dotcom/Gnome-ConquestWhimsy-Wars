# Multiplayer — rooms, identity, and what the server refuses

Private friend rooms, 2 or 4 seats in any mix of humans and server-run CPU,
realtime with reconnect. One Cloudflare Durable Object per room.

- Redaction and the sealed deck: [ENGINE_API.md](ENGINE_API.md)
  ("Hidden information & per-seat views")
- Known limits and what is deliberately deferred: [TECH_DEBT.md](TECH_DEBT.md)

## Shape

```
src/net/protocol.ts    the wire messages (client ⇄ room), and nothing else
src/net/room.ts        ALL of the server's behaviour — no Cloudflare imports
src/net/commitment.ts  commit–reveal for the deck secret
src/worker/index.ts    Worker entry: /api/rooms/*, everything else → assets
src/worker/room-do.ts  the Durable Object: sockets, storage, alarms, randomness
src/ui/useNetGame.ts   the client socket, as a GameSession GameScreen can render
src/ui/netClient.ts    URLs, reconnect tokens, backoff, framing (no React)
src/ui/OnlineScreen.tsx  host-or-join menu, the lobby, and the networked game
```

The split matters. `Room` takes everything platform-shaped through a
`RoomHost` interface, so the rules of the room are driven directly in
`room.test.ts` — seats, spoofed actions, reconnect, hibernation, a full
CPU-vs-CPU game — with no Worker, no sockets and no network. `room-do.ts` is
glue thin enough to read in one sitting. This is the same separation the engine
and the UI already have, for the same reason.

## Endpoints

| | |
|---|---|
| `POST /api/rooms` | → `{ code }`, a fresh 6-character room code |
| `GET /api/rooms/:code` | the room's public snapshot |
| `GET /api/rooms/:code/ws` | WebSocket upgrade into the room |
| anything else | the SPA bundle, exactly as before |

There is no room list and no lobby: knowing the code is what gets you in.
Codes are CSPRNG draws over a 28-character alphabet with no vowels and no
`0/O/1/I/L` — ~29 bits, which is not a password, but a room holds nothing but
a board and lasts one game.

## What the room refuses

**An action for a seat you do not hold.** Actions carry a `player` field
because the engine needs one, so the room checks it against the seat the
*connection* holds before the engine is ever asked. A client sending
`{ player: 1 }` from seat 0 gets `NOT_YOUR_SEAT` and changes nothing. This is
the anti-cheat surface in one line; everything else a client can send is either
a lobby setting the host owns or an action `applyAction` validates against the
rules anyway.

**An illegal action** comes back to its sender as an error and is not
broadcast. The state does not move.

**A lobby command from a non-host**, and **any lobby change once the game has
started**.

**A start with an empty human seat** — the error names the seat, so the host can
either wait or switch it to a CPU rather than guessing. Since every seat starts
human, this is what a solo host hits: fill the other seats with people or with
bots, deliberately.

**More than it will serve.** See below.

## Seats

**Every seat in a fresh room starts human.** A room exists so that people can
sit in it; the host turns the seats nobody is coming for into CPUs. The
opposite default — the host human, the rest bots — meant a friend arriving with
the code found the table already full and became a spectator, which is the one
thing they cannot undo themselves.

Seats are therefore reconsidered, not decided once:

- **A spectator is seated the moment a seat opens** — the host turns a CPU seat
  human, opens the table from 2 to 4, or a lobby seat is abandoned. Earliest
  arrival first. `welcome` is re-sent to that connection, which is how a client
  learns its seat changed.
- **A lobby seat whose player left is claimable again.** Nothing is invested
  before the deal, and one person opening and closing a tab must not lock a
  seat the host is waiting on.
- **A seat dropped from mid-game is not.** There the token holds it against all
  comers until its player reconnects (see below).
- **The lobby follows whoever is still here.** If the host leaves before the
  deal, the room hands the settings and the start button to another player
  rather than freezing. A host who is present but seatless — having turned
  their own seat into a CPU — keeps it.

## Identity and reconnect

The room assigns a seat and issues a private `token`. The token is the seat:
present it again after a refresh, a dropped tunnel or a hibernated room, and
you get your seat and your hand back. It appears only in your own `welcome`,
never in anything broadcast.

A dropped connection does **not** free its seat mid-game. One token holds one
live connection: a second one takes over rather than sitting beside itself.

A seat the host flipped to CPU while its player was away is not theirs to take
back mid-game; they return as a spectator instead of fighting the AI for
control — and are seated again automatically if another seat opens.

**The room is the page's address.** `?room=CODE` opens straight into that room,
so a reload keeps the table and the code can be sent as a link. Keeping the
code in component state alone meant the one thing a waiting host actually does
— reload, to see whether anyone has arrived — dropped them on the home screen
with nothing but a six-character code to retype.

**A token is per tab, not per browser.** One token holds one live connection,
so tokens in `localStorage` had two tabs of one browser fighting over a single
seat: the second evicted the first, the room still saw one player, and the
start button never lit. The live token lives in `sessionStorage` (per tab,
survives a reload) with a heartbeat claim in `localStorage` beside it, so a
closed tab's seat can be reclaimed but a live tab's cannot be taken. Two tabs
are two people at the table — which is how anyone tries a room out alone.

**The host badge is a loan.** If the host drops, the lobby goes to whoever is
still there so the room is never frozen; the founder takes it back the moment
they return. Otherwise a host's refresh moved the start button to the guest
permanently and both ends waited for each other.

## The secret

The room draws the map seed and the deck secret. **No client is ever offered a
seed field** — a player who knows the seed knows the deck order and every die
roll for the rest of the game.

`commitment` (SHA-256 of the secret and a nonce) is published the moment play
starts. The secret arrives once, in `revealed`, after the last move — with the
full `MatchRecord`. Verify it with `verifySeal` against the commitment you were
given at the start, and `replayMatch` the record: the seal proves the deck was
fixed in advance, the replay proves it was the deck that got dealt.

## State, out

Every connection receives `viewFor(state, itsSeat)` — redacted per seat, in the
room, before the bytes leave. Hands, the draw pile, `rngState` and `seed` are
gone from the wire, not hidden by the client afterwards. Spectators get the
`null` view: no hands at all.

## CPU seats

`chooseAiAction` runs in the room, on the same state, through the same
`applyAction` path a human action takes — so a CPU seat fills a table that
could not otherwise start. Turns are scheduled on a Durable Object alarm rather
than run inline, so humans can follow the board and a chain of CPU turns cannot
hold a message handler open. It is also the machinery a disconnected human seat
will borrow in P2.

## Persistence

The room stores the **record** — `config + seed + seal + actions` — not the
state. Replaying it rebuilds the state exactly (that is the engine's oldest
contract), it stays small enough to write on every action, and it is the same
artifact the game is verified and replayed from when it ends. Action lists are
chunked because a Durable Object storage value is capped at 128 KiB.

On wake, `Room.open` replays the record and every live socket is re-introduced
through the same `hello` path a reconnect uses, carrying the token stored in
its attachment.

## Running it

```bash
npm run build && npx wrangler dev    # the real Worker + DO locally
npm test                             # room rules, no network involved
npm run test:e2e                     # includes two browsers in a live room
```

`vite preview` runs the Cloudflare plugin's miniflare, so `e2e/online.spec.ts`
drives a real Durable Object — host a room in one browser context, join from
another, and watch one player's action land on the other's screen.

## The client

`GameScreen` renders a `GameSession` (see `useGame.ts`) and does not know
whether it came from `useGame` (local) or `useNetGame` (a room). Three fields
carry the difference:

- **`humanSeats`** — the seats THIS DEVICE controls. Locally that is every
  human seat (hot-seat); online it is only yours. `GameScreen` gates
  interactivity on it, which is what makes a remote human's turn exactly as
  untouchable as a CPU's.
- **`dispatch`** — locally it applies the action and returns whether it was
  legal. Online it *sends* and returns true: the room is authoritative, so the
  truth arrives afterwards as a new state or an error toast. Nothing is
  applied client-side, ever.
- **`revealedSeat` / `needsPass`** — the pass-the-device interstitial. Online
  they pin to your seat and `false`; there is no device to pass.

Presentation effects (fight playback, chat bubbles, toasts) live in
`sessionFx.ts` so both hooks share one implementation and cannot drift.

**Reconnect** is automatic: the socket re-dials with backoff and presents the
stored token, so a refresh, a dead tunnel or a hibernated room all put you back
in your seat. The one close it does not retry is the server's "seat taken over"
(code 4000) — another tab has the seat, and re-dialing would trade it back and
forth forever.

**Verification is automatic too.** When the room reveals its seal, the client
checks it against the commitment it was given at the start and says so. Players
should not have to run a hash by hand to know the deck was straight.

## The shot clock

A room cannot rely on everyone at the table continuing to play. Someone closes
a laptop mid-turn; someone's train goes into a tunnel and never comes out;
someone decides that a game they are losing is a game nobody should get to
finish. The engine holds no wall clock and never times anything out by itself
(`getTimeoutAction` / `applyTimeout` / `isOnTheClock` are the *policy* — the
default answer for every state the engine can be waiting in), so deciding that
a seat has stopped playing is the room's job.

Two deadlines run at once, both on the seat that must act right now, and
whichever lands first ends its turn:

| | | Restarts on |
|---|---|---|
| **Per action** | `SHOT_CLOCK_MS` = 60s | every action that seat takes |
| **Per stretch of control** | `CONTROL_BUDGET_MS` = 5 min | control passing to somebody else |

The per-action clock is the one players feel, and it is deliberately generous:
it is a budget per *action*, not per turn, so a turn with eight moves in it
gets eight minutes if it wants them. Nobody is ever hurried for thinking; it
only bites a seat that has stopped playing altogether.

The control budget exists because the per-action clock cannot close the stall
it was built for. Some actions are state-neutral by design — `playCard` →
`cancelTargeting` leaves the card in hand and the game exactly as it was (see
TECH_DEBT.md, "Stall vectors that rules cannot close") — so a seat that spins
that loop once a minute would restart its clock forever. Nothing a seat does
moves the control budget; only genuinely handing over does. Quick chat gets the
same treatment for the same reason: it restarts neither, or "hmm 🤔" every
fifty seconds would be an unlimited stall.

When the clock runs out the room applies `getTimeoutAction` — the most passive
legal option, never a card play — one action at a time until control leaves the
seat, so a timed-out turn lands in the record like any other and the game still
replays and verifies exactly. Everyone gets a `timedOut` frame naming the seat.

Both timers share the DO's single alarm: whichever is due runs, and anything
still pending is re-armed. The deadlines are persisted with the room, so a room
that hibernates mid-turn wakes owing the time it owed rather than handing the
stalling seat a fresh minute. Clients see the live clock on every `state` frame
(`{ seat, deadline, now }`, where `now` is the *server's* wall clock, so a
device whose clock is minutes off still counts down the right number of
seconds) and render it as a countdown in the top bar.

### When somebody does not come back

Playing every one of somebody's turns for them, one timeout at a time, is a bad
game for everyone else: the table spends a minute per turn watching a clock run
down to reach the move a CPU would have made instantly. So after
`TAKEOVER_AFTER_TIMEOUTS` = 3 **consecutive** timeouts the room stops waiting.
The seat becomes a CPU seat (`TAKEOVER_DIFFICULTY` = easy) for the rest of the
game, and everyone gets a `seatTakenOver` frame.

Three, rather than one, because a single timeout is usually a phone call or a
tunnel and the conversion is not reversible mid-game. The count is cleared by
*playing* — one legal action and the seat is theirs again, no matter how close
it came. Chat does not clear it, and neither does an action the engine or the
room rejects; otherwise sending nonsense would be a way to hold a seat you had
stopped playing from.

**The player is not thrown out of the room.** They lose the seat and come back
as a spectator, watching the game out. That fell out of a rule the room already
had: `hello` refuses to hand back a seat that has become a CPU mid-game, so a
returning player and the AI never fight over one seat.

Seats taken over this way are flagged `takenOver` in the room snapshot, which is
how a client tells them apart from CPU seats the host set up in the lobby. It is
also the only way a client *can* tell: `state.players[].controller` is fixed
when the game is created, and editing it afterwards would stop the match record
replaying. So the takeover travels beside the state, never inside it.

## Rate limiting

Nothing a flood can send makes the room do something *wrong* — the seat check
and the engine see to that — but wrong was never the worry. Every message costs
a parse, most cost an `applyAction`, and every message that lands costs a
storage write plus one separately-redacted send **per connection in the room**.
A message in is N messages out, so an unmetered sender is an amplifier.

The budgets are token buckets (`src/net/ratelimit.ts`): `capacity` answers "how
much at once" and `refillPerSecond` answers "how much forever". A fixed window
cannot answer both — play is bursty (a card with three targets is three actions
in a second and a half) and a window sized for the burst permits that burst
*continuously*.

Four limits, on three scopes.

**Per connection** — 60 tokens, refilling at 10/s. Messages are priced by what
they ask for rather than counted flat: `ping` 1, `action` 2, `configure` 4,
`start` and `hello` 10. So one client sustains 5 actions a second forever and
30 back to back, which no human hand reaches and no script can exceed.

**Per room** — 240 tokens at 40/s, across every connection in it. This is the
one that actually bounds the work, because a determined client can always open
more sockets: per-connection limits multiply by the number of connections and
only a shared ceiling does not. Four seats at full tilt come to ~20 tokens a
second, so honest play has a factor of two of headroom.

The trade-off is deliberate: a flooder inside a room can degrade that room. A
room is a private table you shared a code with, so the blast radius is your own
guests — and the alternative to a shared ceiling is not "nobody is affected", it
is unbounded work.

**Connections per room** — 24 (`ROOM_FULL`, close code 4003). Broadcast is
O(connections), so this is the multiplier on every action in the game. Anyone
presenting a token the room already knows is exempt: coming back to your seat
must not depend on how many spectators arrived while you were gone, and the
exemption grants nothing, since one token still holds exactly one live
connection.

**Per IP, at the door** (`wrangler.jsonc`, Cloudflare rate-limit bindings) —
10/min on `POST /api/rooms` and 60/min on everything under `/api/rooms/:code`.
The room can only meter a client once there is a connection, and both endpoints
are reachable without one. The second is the load-bearing one: *addressing* a
Durable Object is what brings it into existence, so a caller walking the code
space creates a fresh object per request, and no per-room cap can help when
every request is a different room. The bindings are optional in the Worker's
env type — a local runtime that lacks them runs unlimited rather than not
running.

### Being refused

One `RATE_LIMITED` error per episode, not one per dropped message: answering a
flood message-for-message is the same amplification the limit exists to stop.
The warning is re-armed by the next message that gets through.

A connection that keeps sending after being told to stop is hung up on after 60
of its own messages have been dropped (close code 4001) — past that point the
parse is the only cost left and closing is the only way to stop paying it. Only
a connection's **own** bucket counts toward this; messages dropped because the
*room's* ceiling was empty are somebody else's doing, and disconnecting the
bystanders of a flood would hand any flooder the room. The real client re-dials
after 4001, but only on a long backoff.

`hello` is charged to the connection and **not** to the room. Arrivals are
bounded by a harder mechanism — a fresh connection's bucket always covers its
first `hello`, and there can only be 24 connections — and charging them to the
shared ceiling would make every legitimate mass reconnect look exactly like an
attack: the whole room re-introduces itself in one burst when the Durable
Object wakes from hibernation, and answering that with "try later" would break
the reconnect the design exists to support.

Buckets are in memory and never persisted. A write per message would cost more
than the messages being defended against, and the failure mode of losing them —
a room evicted from memory forgives what a flooder had spent — requires the
flooder to have stopped sending long enough for the room to hibernate, i.e. to
have stopped being a flooder. The connection cap is the part that does not
depend on remembering anything.

## Not built yet

- **Cross-room limits.** The per-IP limiter at the door and the per-room
  ceilings inside are the two ends; there is nothing in between, so a caller
  spread across many IPs can hold many rooms at their individual ceilings. That
  is a Cloudflare-shaped problem (WAF, Turnstile) rather than a room-shaped one.
