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
either wait or switch it to a CPU rather than guessing.

## Identity and reconnect

The room assigns a seat and issues a private `token`. The token is the seat:
present it again after a refresh, a dropped tunnel or a hibernated room, and
you get your seat and your hand back. It appears in exactly one message —
your own `welcome` — and never in anything broadcast.

A dropped connection does **not** free its seat. One token holds one live
connection: a second one takes over rather than sitting beside itself.

A seat the host flipped to CPU while its player was away is not theirs to take
back mid-game; they return as a spectator instead of fighting the AI for
control.

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
```

## Not built yet

- **The client.** `useGame` is the seam: a `useNetGame` with the same return
  shape leaves `GameScreen` untouched, `revealedSeat`/`needsPass` collapse to
  "my seat", and quick chat finally speaks as *you* rather than whoever holds
  the device.
- **The shot clock** (P2). The engine has shipped the policy half since
  2026-07-29 (`getTimeoutAction` / `applyTimeout` / `isOnTheClock`); the room
  needs the timer, which is the alarm the CPU driver already uses, plus a
  grace/warning UX and a repeat-offender policy.
- **Rate limiting.** A client can currently send as fast as it likes; illegal
  actions are cheap to reject but not free.
