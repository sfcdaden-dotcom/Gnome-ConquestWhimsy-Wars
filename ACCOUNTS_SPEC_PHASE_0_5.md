# Phase 0.5 — Multiplayer hardening (implementation spec)

**Status: implemented 2026-09-29** (approved the same day), as six commits
titled "Room hardening 1/6" through "6/6". Where the build differs from the
text below, [the last section](#as-built-deviations-from-this-spec) says how
and why.

Part of the accounts plan ([ACCOUNTS.md](ACCOUNTS.md), §14 findings R1–R4,
R9, R10). The work is deliberately **independent of accounts**: no D1, no
cookies, no auth code, no new bindings, and no dependency on anything in
Phase 1. Every change below is useful even if accounts never ship.

## Goals and non-goals

Goals:

- Malformed input can never crash the room or partly mutate it.
- Anything a client sends that the room stores or rebroadcasts is bounded in
  shape and size.
- Names cannot carry control, bidi or invisible characters.
- The host's lobby settings are checked against the values that exist.
- A guest's online gnome survives a page reload.

Non-goals:

- No change to game rules, the engine, seat or host semantics, or the rate
  limits.
- No `PROTOCOL_VERSION` bump. Honest clients already send well-formed
  messages, so tightening validation changes nothing they can observe.
  Current clients must keep working against the hardened room, and the
  existing e2e suite proves that.

## Change list

There are six small PRs. Each leaves `npm run lint`, `npm test`,
`npm run build` and `npm run test:e2e` green. The order matters only where
noted.

### PR 0.5-1 — Structural look validator (pure)

**New:** `src/net/lookSchema.ts` (+ `lookSchema.test.ts`)

`validateLookWire(value: unknown): GnomeLookWire | null`

Rules:

- The value must be a plain object with **exactly** the `GnomeLookWire` keys
  (`torso, face, shoes, beard, hair, cap, accessory, garment, hair_color,
  skin`). Any missing or extra key rejects it.
- `torso`, `face`, `shoes`, `cap`, `accessory`: strings matching
  `^[a-z0-9-]{1,40}$`. The pattern is the shape `variantId()` in
  `gnomeArt.ts` already produces from filenames.
- `beard`, `hair`: the same pattern, or `null`.
- `garment`, `hair_color`, `skin`: integers in `0..63`.

Design notes:

- **Structural, not catalogue-based.** The room must not need a redeploy when
  somebody draws a hat (MULTIPLAYER.md). Receiving clients keep running
  `sanitizeLook` to map unknown-but-well-formed ids to defaults.
- It lives in `src/net/`, not `src/ui/`, because `gnomeLook.ts` imports
  `meta.ts`, which pulls in the engine and UI modules. The server bundle
  should not carry those just to count palette entries. `0..63` is a
  deliberately loose bound: today's palettes have 5, 6 and 8 entries.
- A size bound follows from the shape: at most 7 × 40 characters plus three
  small integers, so no separate byte cap is needed.
- Returns a **fresh object** containing only the validated keys. The room
  never stores the caller's object.

Tests:

- `defaultLook()` and 50 `randomLook()` draws validate. The client's own
  output must always pass.
- Rejected: a missing key, an extra key, a wrong type, an over-long id, an id
  with uppercase or spaces, a negative, fractional or oversized index, arrays,
  `null`, strings, and nested objects.
- A 200 KB id is rejected (the audit's probe case).

### PR 0.5-2 — Name sanitiser (pure)

**New:** `src/net/names.ts` (+ `names.test.ts`)

`sanitizeSeatName(value: unknown): string | null`

Pipeline:

1. Reject anything that is not a string: return `null`.
2. NFKC-normalise.
3. Remove every character in these Unicode categories: `Cc` (control,
   including NUL), `Cf` (format: bidi embeddings and overrides
   U+202A–U+202E, isolates U+2066–U+2069, zero-width U+200B–U+200D, U+FEFF,
   soft hyphen), `Co` (private use), `Cn` (unassigned), and the line and
   paragraph separators U+2028 and U+2029.
4. Collapse runs of whitespace to one space, then trim.
5. Truncate to 24 **code points**. The existing `slice(0, 24)` counts UTF-16
   units and can split a surrogate pair into a lone surrogate.
6. If the result is empty, return `null`. The caller keeps the seat's
   existing name.

Deliberately **not** done here: lookalike folding or ASCII restriction. Guest
names stay free-text in any script, as today. The ASCII-only and
confusable rules belong to account **usernames** (Phase 3). Impersonation of
a registered name is handled there by the verified-seat badge, not by
restricting guests.

Tests: the probe's `'‮eman\u0000 Adа'` loses the override and the NUL
but keeps the Cyrillic letter. Other cases: emoji survive; a surrogate pair is
never split at 24; whitespace-only returns `null`; a non-string returns
`null`.

### PR 0.5-3 — Validate every client message at the boundary

**Changed:** `src/net/protocol.ts`, `src/worker/room-do.ts`, `src/net/room.ts`

`parseClientMessage(raw)` currently checks only `t`. It becomes a full
validator returning `ClientMessage | { error: RoomErrorCode; message: string }`.
It still never throws. Per message:

| Message | Field | Rule | On failure |
|---|---|---|---|
| `hello` | `protocol` | Integer | `PROTOCOL` |
| | `token` | Optional; `^[0-9a-f]{32}$`, the shape `mintToken` produces | `PROTOCOL` |
| | `hostKey` | Optional; `^[0-9a-f]{32}$` | `PROTOCOL` |
| | `name` | Optional; string ≤ 256 UTF-16 units before sanitising | `PROTOCOL` |
| | `look` | Optional; `validateLookWire` must pass | Dropped (see note) |
| | `spectate` | Optional; boolean | `PROTOCOL` |
| `configure` | `playerCount` | Optional; `2` or `4` | `BAD_CONFIG` |
| | `boardSize` | Optional; integer (range still checked by the room) | `BAD_CONFIG` |
| | `gardenPreset` | Optional; string ≤ 64 (existence checked by the room, PR 0.5-4) | `BAD_CONFIG` |
| | `seats` | Optional; array of ≤ 4 objects | `BAD_CONFIG` |
| | `seats[].index` | Integer `0..3` | `BAD_CONFIG` |
| | `seats[].controller` | Optional; `'human'` or `'cpu'` | `BAD_CONFIG` |
| | `seats[].difficulty` | Optional; `'easy'`, `'normal'` or `'hard'` | `BAD_CONFIG` |
| | `seats[].name` | Optional; string ≤ 256 | `BAD_CONFIG` |
| | `seats[].look` | Optional; `validateLookWire` | `BAD_CONFIG` |
| `action` | `action` | Object with string `type` and integer `player`. The engine validates the rest, as today. | `PROTOCOL` |
| `start`, `takeOverRoom`, `ping` | — | No other fields read | — |

Notes:

- **Unknown extra fields** on any message are ignored and never copied. The
  validator builds a fresh message object.
- **A bad `hello.look` is dropped, not fatal.** The player still sits down,
  with no look (the board draws a stand-in). Rejecting the whole `hello`
  would lock a player out of the room over a cosmetic.
- **The room sanitises names** (`sanitizeSeatName`) in `hello` and
  `applySeatConfig`, replacing both `slice(0, 24)` calls. A `null` result
  keeps the seat's current name.
- `room-do.ts` sends the error frame for a validation failure. The frame is
  charged like any other message, so rate limiting still applies to
  malformed floods. Metering stays in `Room`: `webSocketMessage` asks the room
  to meter the connection before replying, using a small new
  `Room.reject(connId, conn, code, message)` that runs `admit()`, then sends.
- **Defence in depth:** `webSocketMessage` wraps `room.hello` /
  `room.handle` in a try/catch. A non-`RoomError` exception is logged once
  (without message contents), answered with `PROTOCOL`, and the socket stays
  open. The ordering bug the audit found (a token minted and a seat assigned
  before the throw) cannot recur. Validation now happens before `Room` sees
  the message, and `hello` is reordered so the name and look are computed
  **before** any `this.data` mutation.

Tests:

- `protocol.test.ts` (new) checks each row above: accepted, rejected with the
  right code, and extra fields stripped.
- New cases in `room.test.ts` drive the boundary the way the DO does
  (`parseClientMessage`, then `room.hello` / `room.handle`):
  - `name: 123` returns `PROTOCOL`, with **no** token minted, no seat
    changed and no save.
  - A 200 KB look is dropped and the seat has no look.
  - An extra-key look is dropped.
  - A bidi name is stored stripped.
  - The flood tests still pass with malformed messages counted against the
    budget.

### PR 0.5-4 — Lobby configuration against allowed values

**Changed:** `src/net/room.ts` (`configure`, `applySeatConfig`)

- `controller` and `difficulty` are guaranteed by PR 0.5-3's types. The room
  additionally refuses a configuration that would leave a seat whose
  `controller` is neither value. This guards rooms persisted before this
  change.
- `gardenPreset` must satisfy `findGardenPreset(id) !== undefined`, which
  covers `GARDEN_PRESETS`: built-in plus file-backed. Otherwise `BAD_CONFIG`.
  This matches what the lobby's select offers (`MODE_PRESETS` +
  `CLASSIC_PRESETS`).
- A preset with a `minBoardSize` above the room's `boardSize` is refused at
  **configure** time with a clear message, instead of failing later at
  `start()`.
- `configure` validates the **whole** message before applying any of it. A
  message with one bad seat changes nothing. Today, seats before the bad one
  are applied and then the error is thrown.

Tests: an unknown preset gets `BAD_CONFIG` with the state unchanged. A bad
seat in position 2 of 3 leaves seats 1 and 3 untouched. An existing
legitimate `configure` round-trip is unchanged.

### PR 0.5-5 — The guest's gnome survives a reload

**Changed:** `src/ui/netClient.ts`, `src/ui/OnlineScreen.tsx`

- New `LOOK_KEY = 'ww:look'` beside `NAME_KEY`. `OnlineScreen` initialises
  `look` from `sanitizeLook(JSON.parse(localStorage[LOOK_KEY]))`, falling
  back to `defaultLook()` on anything unreadable, and writes it on save.
- It lives in `localStorage` for the same reason the name does. It is a
  preference shared across rooms and tabs, not a credential.
- Scope: the online gnome only. The local setup screen's four-seat looks stay
  per-session. "Play again" already preserves them, and persisting four
  seats' worth of setup is a different feature.
- Once accounts exist (Phase 4), a signed-in player's saved look takes
  precedence. This key remains the guest's store.

Tests:

- Unit: a corrupt or partial stored value falls back field-by-field
  (`sanitizeLook` semantics).
- e2e (`online.spec.ts`): choose a cap in the online creator, host a room,
  reload the page. The lobby seat and, after starting, the board show that
  cap. Assert it the way `gnome-creator.spec.ts` does.

### PR 0.5-6 — Worker route tests

**New:** `src/worker/index.test.ts`

The Worker entry has no unit tests (R10), and Phase 2 will put auth routing
there. The tests pin today's behaviour first:

- `POST /api/rooms`: returns `{ code, hostKey }`, and `429` when the
  create-limiter says no.
- `GET /api/rooms/abc234` is normalised to `ABC234` and forwarded with
  `?code=`. A wrong-length code returns `404` without touching the limiter.
- **`/api/rooms/ABC234/host-key` (any method) is not forwarded to the DO.** It
  returns `404`. This is the property that keeps host keys unmintable from
  outside.
- Unknown `/api/*` paths return `404` JSON. Anything else goes to `ASSETS`.

Approach: call the default export's `fetch(request, env)` directly in vitest
with a fake `env`. `ROOMS` records the requests it is handed; `ASSETS` and
the rate limiters are fakes. `Request` and `Response` are Node 22 globals.
This needs no new test runner, which matches how `room.test.ts` drives
`Room`.

## Documentation

- MULTIPLAYER.md: replace "the room stores the look verbatim … never
  interprets one" with the structural rule (ids and indices checked for
  shape, not against the catalogue). Note name sanitising.
- TECH_DEBT.md: add a Resolved entry citing the audit.

## Exit criteria

- Every audit probe case is now a regression test and passes.
- The existing 2,874 unit tests and the Playwright suite pass unchanged,
  apart from any test that encoded the old verbatim-look behaviour, which is
  updated deliberately.
- No new dependencies, bindings, env vars or protocol version.

## As built: deviations from this spec

1. **Actions are canonicalised too** (PR 3). An `action` object was appended
   to the stored record exactly as sent, and later broadcast in `revealed`.
   The engine ignores unknown keys, so junk was persisted exactly as looks
   were. Actions now keep only top-level keys that exist in the engine's
   `Action` union, checked at compile time in both directions so a new action
   field cannot be silently dropped. They are also capped at 2 KB serialised.
2. **Malformed credentials are dropped, not refused** (PR 3). A `token` or
   `hostKey` that is a string but not 32 lowercase hex characters is treated
   as absent, not rejected with `PROTOCOL`. It cannot be a credential the room
   issued, so it means exactly what an unknown one means. Refusing it could
   strand a client with a corrupted stored token on "connecting" forever. A
   credential of the wrong *type* is still refused.
3. **Legacy seat values are normalised on open, not refused** (PR 4). A room
   persisted before the checks, with a nonsense `controller` or
   `difficulty`, is settled to `cpu` / `normal` when loaded. Refusing its
   host's later edits instead would lock them out of their own lobby.
4. **The reload e2e check lives inside an existing test** (PR 5). The suite
   already opens exactly as many rooms per minute as the local per-IP create
   limit allows, and an extra test made the last one fail with a 429. It
   passes against the Phase 0.5 code and fails with the fix reverted. The
   underlying suite fragility is logged in TECH_DEBT.md (P3).
5. **`Room.reject` does the metering** for boundary refusals and for
   unexpected exceptions caught in the Durable Object, as the spec suggested.
   Exceptions are logged with the message type and error name only, never
   message contents.

Verification at the end of Phase 0.5: 2,936 unit tests (62 new), lint,
`tsc -b` and the production build are clean, and all 76 Playwright tests pass
against the real Worker and Durable Object in miniflare.
