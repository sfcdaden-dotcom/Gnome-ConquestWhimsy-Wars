# Accounts, profiles & social — architecture audit and proposal

**Status: architecture approved 2026-09-29. Phase 0.5 implemented. Phase 1
complete: `0001_identity.sql` is applied to staging and production and is now
production history, so every later schema change is a new migration file.
Phase 2 is specified for review ([ACCOUNTS_SPEC_PHASE_2.md](ACCOUNTS_SPEC_PHASE_2.md))
and not started.** It audits the repository as of `43ffa51` and describes how
persistent player accounts will be added without destabilising what already
works. The product owner's decisions are recorded in
[§19](#19-decisions-approved-2026-09-29). They take precedence over anything
earlier in this document that reads as a proposal.

This work was begun in the `Gnome-ConquestWhimsy-Wars-FlyBrain` repository
and moved here, to the repository Cloudflare deploys, on 2026-09-29. It was
replayed without conflicts onto the Fly CPU seat (PRs #56 and #57). One fix was
needed: the room's difficulty checks now come from `AI_DIFFICULTIES`, which is
tied to the engine's `AiDifficulty` type so 'fly' cannot be refused.

Detailed specs, one per phase so far:

- [ACCOUNTS_SPEC_PHASE_0_5.md](ACCOUNTS_SPEC_PHASE_0_5.md): multiplayer
  hardening, independent of accounts.
- [ACCOUNTS_SPEC_PHASE_1.md](ACCOUNTS_SPEC_PHASE_1.md): the persistence
  foundation and the full proposed D1 schema.
- [ACCOUNTS_SPEC_PHASE_2.md](ACCOUNTS_SPEC_PHASE_2.md): Google sign-in,
  **for review before implementation**. Its §0 lists where it departs from
  §9, §10 and §17 below, and why.

Phase 2 does not start until its spec is approved.

The codebase and its docs call the game **Whimsy Wars** (the Worker is named
`gnomeconquest`); this document uses **Gnome Wars**, as the brief does.

Related: [MULTIPLAYER.md](MULTIPLAYER.md) (rooms, identity, anti-cheat),
[DEPLOYMENT.md](DEPLOYMENT.md), [ENGINE_API.md](ENGINE_API.md),
[TECH_DEBT.md](TECH_DEBT.md).

---

## Summary

The existing architecture is already layered almost exactly the way the brief
asks for, and the account system should slot in as a new layer instead of
rewriting any existing one:

```text
src/engine      pure, deterministic; knows seats (0..3) and display names only   ← UNCHANGED
     ↓
src/net/room.ts the match layer: seats, tokens, authority, clock  (platform-free)  ← gains a trusted, optional user_id per seat
     ↓
src/worker      Cloudflare glue: routes, Durable Objects                          ← gains /api/auth, /api/me, … and a D1 binding
     ↓
NEW  Player platform: accounts, profiles, customization, stats, friends, blocks  (D1)
NEW  Presence & invites: one Durable Object per signed-in user                    (UserHub)
```

Recommendations in one breath:

- **Storage:** Cloudflare **D1** for durable relational data. Presence lives in
  Durable Objects and never touches D1.
- **Sign-in:** Google **OpenID Connect authorization-code flow with PKCE, run
  server-side by the Worker** (a top-level redirect). This avoids loading
  Google's script, relaxing the CSP, or handling a JWT in the browser. Scope:
  `openid` only.
- **Sessions:** an opaque, random, `HttpOnly; Secure; SameSite=Strict`
  `__Host-` cookie whose SHA-256 hash is stored in D1. The session can be
  revoked, and it survives the existing strict CSP.
- **Identity into rooms:** the Worker authenticates the WebSocket upgrade and
  hands the room a verified `user_id` **beside** the `hello` message, never
  inside it. The seat token stays what it is today: the seat credential.
  Guests are unaffected.
- **Statistics:** the room already owns the complete, authoritative
  `MatchRecord`. At game over it replays that record once, derives
  per-seat facts from engine events, and writes them to D1 idempotently. It
  keys the write on a match id it minted when play started.
- **Engine:** zero changes required for Phases 1–8.

The audit also found four existing issues worth fixing whatever happens with
accounts (details in [§14](#14-security--privacy-risks-found-in-the-existing-architecture)).
Three were confirmed with a throwaway probe against `Room`:

1. A non-string `name` in `hello` throws a raw `TypeError` out of `Room.hello`.
2. `look` is stored and rebroadcast **verbatim**. A 200 KB payload with extra
   keys was accepted and sent back out in every snapshot.
3. Names are only length-capped. Control characters, bidi overrides and
   homoglyphs pass through.
4. From reading the code: reloading the page inside an online room resets
   your gnome to the default mid-game.

---

## 1. The existing architecture

### Layers and modules

| Layer | Where | What it is |
|---|---|---|
| Engine | `src/engine/` | Pure, deterministic, JSON-serialisable state machine: `createGame(options, seed)`, `getLegalActions`, `applyAction`. All randomness flows through `state.rngState`. The CPU (`chooseAiAction`) uses only the public API. `viewFor(state, seat)` redacts per seat. `replayMatch(record)` rebuilds any game from `config + seed + seal + actions`. |
| Match / multiplayer | `src/net/` | `protocol.ts` (the wire), `room.ts` (all server behaviour, **no Cloudflare imports**, everything platform-shaped arrives through `RoomHost`), `commitment.ts` (commit–reveal of the deck secret), `ratelimit.ts` (token buckets). |
| Server glue | `src/worker/` | `index.ts` is the Worker entry, routing `/api/rooms*` and handing everything else to static assets. `room-do.ts` is the Durable Object: sockets, storage, alarms, randomness. It is deliberately thin. |
| Client sessions | `src/ui/useGame.ts`, `useNetGame.ts`, `sessionFx.ts` | Both hooks return the same `GameSession`, so `GameScreen` does not know whether a game is local or online. |
| Client net plumbing | `src/ui/netClient.ts` | URL building, `?room=` addressing, seat-token/host-key storage, backoff. React-free and unit-tested. |
| Screens | `src/App.tsx` + `src/ui/*Screen.tsx` | **No router library.** `App.tsx` is a `useState` screen machine (`home / local / online / rules`). The only addresses are query parameters: `?room=CODE`, `&view=board` (TV board view), `?ui=preview` (dev-only lab). |
| Cosmetics | `src/ui/gnomeLook.ts`, `gnomeArt.ts`, `GnomeCreator.tsx`, `gnomeLooks.ts` | The character creator. Looks are **outside the engine by design** and reach components through `GnomeLooksContext`. |
| Tests | `src/**/*.test.ts` (vitest), `e2e/*.spec.ts` (Playwright) | Baseline on this branch: **41 files, 2,874 unit tests, all passing**. `oxlint` and `tsc -b` are clean. `e2e/online.spec.ts` drives a real Durable Object through miniflare (`vite preview`). |
| CI | `.github/workflows/ci.yml` | `npm ci` → lint → test → build, plus the Playwright suite. **CI does not deploy**; deploys are manual (`npm run deploy`). |

`flybrain/` (Python, fruit-fly connectome) is an unconnected experiment. It is
not built, bundled or deployed, and it is irrelevant here.

### What is client-side and what is server-authoritative

| System | Runs in | Authority |
|---|---|---|
| Local hot-seat / CPU games | Browser | Client, by design. It makes **zero network requests** (DEPLOYMENT.md), and that property is worth keeping for guests. |
| Online game state, legality, turn order | Room DO | **Server.** Clients receive only `viewFor(state, seat)`. |
| Seat assignment, seat tokens, host binding | Room DO | **Server.** |
| Map seed, deck secret, commit–reveal | Room DO | **Server.** No client ever sees or chooses a seed. |
| Shot clock, timeouts, seat takeover, CPU seats | Room DO | **Server.** |
| Rate limits | Worker (per IP) + Room (per connection/room) | **Server.** |
| Lobby configuration | Host's client requests it; the room applies it | Server gate (host-only). Field *values* are only partly validated (§14). |
| Seat **names** | Client-asserted on every `hello` | Not authoritative. The room slices them to 24 chars and nothing else. |
| Seat **looks** (gnome) | Client-asserted on every `hello` | Not authoritative. Stored verbatim, validated by each *receiving* client (`sanitizeLook`). |
| Player name | `localStorage['ww:name']` | Client only. |
| Online gnome look | React state only | Client only, and **not persisted at all**. |
| Custom board presets | Files (import/export) | Client only, deliberately never `localStorage`. |

---

## 2. How online player identity works today

There is **no identity that outlives a room**. That was the right call without
accounts, and it is why accounts can be added beside the room instead of
replacing anything inside it.

| Identifier | Minted by | Scope and lifetime | Stored where |
|---|---|---|---|
| Seat index (`PlayerId`) | Engine, at `createGame` | One game | `GameState`, `MatchRecord` |
| **Seat token** (128-bit hex) | Room, on first `hello` | One room, **one tab** | Server: `PersistedRoom.tokens` (token → seat). Client: `sessionStorage['ww:room:CODE:token']` plus a heartbeat claim in `localStorage` |
| Host key (128-bit hex) | Room, via `POST /api/rooms` | One room, until bound or spent | `localStorage['ww:room:CODE:hostkey']` |
| Connection id | DO, per socket | One socket | Socket attachment |
| Tab id | Client, `crypto.randomUUID()` | One tab | `sessionStorage['ww:tab']` |
| Display name | Player types it | Global to the browser | `localStorage['ww:name']`, then sent on every `hello` |

How it behaves:

- **The token is the seat.** Presenting it again restores seat and hand after a
  refresh, a tunnel drop or DO hibernation. It is never broadcast.
- **One token, one live connection.** A second socket presenting the same token
  takes the seat over, and the old one is closed with 4000. Tokens are per tab
  on purpose: two tabs of one browser are two players.
- **Names and looks are assertions.** The room stores whatever the client
  says, for whatever seat it has.
- **Nothing survives.** A room is reaped 10 minutes after its last connection
  leaves, and its tombstone wipes `tokens`, `config`, `seed`, `seal` and
  `actions`. The same human in two rooms is two unrelated tokens.

None of these identifiers is suitable as a persistent identity, and none of
them should become one. A persistent `user_id` should sit **beside** the seat
token, not replace it.

## 3. How rooms and lobbies identify players

- Each live socket is a `ConnState { conn, token, seat, spectating }`.
- The room checks every action with `action.player === c.seat`. That one
  comparison is the entire anti-cheat line (`Room.act`).
- A spectator has `seat: null`. A board view (`spectate: true`) is never
  seated, never becomes host, and never takes a room over.
- Seats are reconsidered, not decided once. `seatSpectators()` seats waiting
  people when a seat opens, earliest arrival first. A lobby seat whose player
  left is claimable again. A seat dropped mid-game is held by its token.
- The host is a **token** (`hostToken`), not a seat. It is bound once via the
  host key. It changes only through the explicit, announced `takeOverRoom`
  after a 60-second grace window.
- What everyone sees is `SeatInfo { index, name, controller, difficulty,
  connected, takenOver, look? }`. That is the `room` frame, and it is also
  what the unauthenticated `GET /api/rooms/:code` returns to anyone who knows
  the code.
- Facts that must not enter the engine travel beside the state. `takenOver`
  is the precedent: `state.players[].controller` is fixed at `createGame`, and
  editing it would stop the record replaying. **`user_id` must follow the same
  rule.**

## 4. Backend and server infrastructure that already exists

- **One Cloudflare Worker** (`wrangler.jsonc`, `name: gnomeconquest`,
  `compatibility_date: 2026-07-23`, `nodejs_compat`, observability on).
  - `POST /api/rooms` mints a room code and host key. It is rate-limited at
    10 per minute per IP (`ROOM_CREATE_LIMIT`).
  - `GET /api/rooms/:code` returns the public snapshot.
    `GET /api/rooms/:code/ws` upgrades to a WebSocket. Both are rate-limited
    at 60 per minute per IP (`ROOM_JOIN_LIMIT`), because addressing a DO is
    what creates it.
  - Everything else goes to the `ASSETS` binding with SPA fallback.
  - Routing is a hand-written regex (`ROOM_PATH`). `WorkerEnv` is a
    hand-declared interface. The internal `/host-key` route is protected only
    by the fact that the public regex cannot reach it.
- **One Durable Object class**, `RoomDurableObject`. It is SQLite-backed
  (`new_sqlite_classes`) but used through the key-value storage API, with
  hibernatable WebSockets and a single alarm multiplexed across CPU pacing,
  the shot clock, host grace and reaping. Its constructor ignores `env`, so it
  has no bindings today.
- **No** environment variables, secrets, D1, KV, R2, Queues, or staging
  environment. `worker-configuration.d.ts` is generated (`npm run cf-typegen`)
  and committed.
- `.gitignore` already excludes `.dev.vars*` and `.env*` and whitelists
  `.dev.vars.example`. The secret-handling convention is in place but unused.

## 5. Persistence infrastructure that already exists

- **Room DO storage.** It holds the room *record*, not the state: a `meta`
  value plus action chunks of 200. That record is also the artifact the game
  is verified and replayed from. It is ephemeral (reaped after 10 minutes
  empty, tombstone purged after 24 hours).
- **Browser storage.** `localStorage` holds `ww:name`,
  `ww:room:*:hostkey`, `ww:room:*:claim` and `ww:room:recent`.
  `sessionStorage` holds `ww:room:*:token` and `ww:tab`.
- **Nothing durable about a player exists anywhere.** There is no database of
  any kind.

## 6. Where authentication should integrate

At three seams, all of them already present in the code:

1. **The Worker's `fetch` (HTTP front door).** The new `/api/auth/*`, `/api/me`
   and platform routes live here. This is where a session cookie is turned
   into `{ userId }` and every authorization decision is made.
2. **The WebSocket upgrade (`/api/rooms/:code/ws`).** The Worker already sits
   between the browser and the Room DO on this path. It resolves the session
   from the cookie the browser sends with the upgrade. It checks the `Origin`
   header. It forwards `{ userId, username }` to the DO in an internal header,
   after **deleting any client-supplied copy of that header**. The DO stores
   the identity in the socket attachment, exactly as it stores the seat token
   today, so it survives hibernation. It then passes the identity into
   `Room.hello(conn, message, account)` as a trusted third argument. **The
   `ClientMessage` type never gains a user id**, so no client can assert one.
3. **Room game-over.** `Room.apply` already detects the finishing transition
   (`justFinished` → `reveal()`). A new optional `RoomHost.recordMatch(summary)`
   hook is called there. The host implementation in `room-do.ts` writes to D1.
   `room.ts` stays Cloudflare-free and testable with the existing fake host.

What does **not** change: the engine, `ClientMessage`, seat-token semantics,
host binding, local play and the board view.

## 7. Recommended database and storage

**Recommendation: Cloudflare D1** for all durable platform data. Presence and
realtime delivery go in a **per-user Durable Object** (§13).

Why D1 fits this codebase specifically:

- **The platform is already there.** D1 is one more binding in
  `wrangler.jsonc`, deployed by the same `npm run deploy`, with no new vendor,
  credentials or network hop. The Room DO can reach it through `env`.
- **It is SQLite.** The DOs already run on SQLite, and the data is
  relational (friendships, usernames, match participants). Invariants such as
  "no duplicate friendship" or "one pending request per pair" become
  `PRIMARY KEY`, `UNIQUE` and `CHECK` constraints instead of application
  hopes.
- **Atomic batches.** `db.batch([...])` runs as one transaction and rolls
  back on failure.
- **Local parity.** miniflare runs D1 locally, so `vite preview`, and
  therefore `e2e/online.spec.ts`, keeps exercising the real stack.
- **Recovery.** D1 has point-in-time restore (Time Travel).

The constraint that shapes the design: **D1 has no interactive transactions**
(no `BEGIN`, read, decide, write across round-trips). Every invariant must
therefore be enforced either by a constraint or by a *conditional* statement
inside one batch. Examples: `INSERT … WHERE NOT EXISTS (block)`,
`INSERT … ON CONFLICT DO NOTHING`. Batches are serialised against each other,
so a conditional insert inside one is race-free. §8 is written to this rule.

Rejected alternatives:

| Option | Why not |
|---|---|
| Workers KV | Eventually consistent, with no uniqueness. Two people could claim the same username. |
| One global SQLite Durable Object as "the database" | A single-threaded worldwide bottleneck, with no migrations CLI and no Time Travel. |
| Per-user DOs holding all of a user's data | Cross-user queries (usernames, friendships) need a shared index anyway. That index is D1. |
| External Postgres (Neon, Supabase + Hyperdrive) | A second vendor, a secret, and a network hop, and nothing here needs Postgres. |
| R2 | Not now. Consider it only if full replays are stored later (§12). |

## 8. Proposed data model

Principles: an internal random `user_id` (`crypto.randomUUID()`) is the only
identity key. Authentication identity, private account data, the public
profile, gameplay data and social relationships each live in their own
table(s), so an API can never "accidentally" serialise one while returning
another. Every table references `users(id)` with an explicit deletion
behaviour.

The table-by-table schema (columns, constraints, indexes, foreign-key
actions, and deletion behaviour) is maintained in
[ACCOUNTS_SPEC_PHASE_1.md §3](ACCOUNTS_SPEC_PHASE_1.md#3-the-schema). It is
split into migrations applied by the phase that needs them, and it
supersedes the sketch that was here. The tables are:

| Area | Tables | Migration / phase |
|---|---|---|
| Identity | `users`, `auth_identities` (no email), `sessions` | 0001 / Phase 1 |
| Public profile | `profiles`, `username_holds`, `username_rules`, `username_removals` | 0002 / Phase 3 |
| Customization | `customizations` | 0003 / Phase 4 |
| Gameplay | `matches`, `match_players` | 0004 / Phase 5 |
| Social | `friendships`, `friend_requests`, `blocks` | 0005 / Phase 6 |
| Privacy | `privacy_settings` | 0006 / Phase 7 |

Deliberately **absent**: email addresses (decision 1), real names,
birthdays (decision 2), location, avatars as images, a Google display name or
picture, a bio, a free-text display name separate from the username
(decision 3), and any messaging tables.

**Invites are not in D1.** They are ephemeral, short-lived and useless once the
room closes, so they live in the recipient's UserHub DO (§13).

### 8.1 Usernames (decision 4)

- **One public identifier:** the username, displayed with the case the
  player chose. There is no separate display name. `user_id` is the identity,
  and nothing depends on the username.
- **ASCII only** (`A–Z a–z 0–9 _`, 3–20 characters). Input is NFKC-normalised
  and trimmed, then validated. The database re-checks the character set in a
  `CHECK`, so a regression in application code cannot store a non-ASCII name.
- **Case-insensitive uniqueness:** `username_key = lower(username)`, with a
  `UNIQUE` constraint. **No lookalike/confusable folding in v1** (confirmed
  2026-09-29). Impersonation is a moderation matter: forced rename, and the
  removed name added to `username_rules`.
- **Changes:** at most once every 30 days. A name given up stays **reserved to
  its previous owner for 90 days** (`username_holds`). They can take it back,
  and nobody else can claim it.
- **Reserved and offensive names are data, not code** (`username_rules`:
  exact or contains, category system / offensive / removed). The migration
  seeds the system/admin terms. An operator can update the offensive list
  without a code change or redeploy. There is no attempt to catch every
  offensive name automatically.
- **Administrative removal** without touching identity: a removed name sets
  `profiles.username_state = 'removed'` and clears the name columns. The
  account keeps its `user_id`, friends, stats and history. It is shown with a
  generic placeholder and must choose a new name before using public or
  social features. The removed name goes into `username_rules` so it cannot
  simply be re-registered. A minimal `username_removals` row records it for
  later review. There is no reporting platform in this project.
- **First sign-in suggests names** from the pools `src/ui/gnomeNames.ts`
  already has (`FIRST_NAMES`, for example "Mossbottom27"). There is no Google
  name to suggest, because none is requested.
- **Stability:** friendships, stats, matches and ownership key on `user_id`,
  so a rename touches one `profiles` row. That is a Phase 3 test.
- **Enumeration:** usernames are public by design, so a rate-limited
  availability check leaks nothing new. Whether a given Google account is
  registered has no oracle, because Google is the only way in.

### 8.2 Customization: the real shape, not an invented one

The persisted look must be **exactly `GnomeLookWire`** (`src/net/protocol.ts`),
because that is what the creator produces and what the room already carries:

```text
torso, face, shoes, cap, accessory   variant ids (strings), derived from asset filenames
beard, hair                          variant id or null (the only optional layers)
garment                              index into GARMENT_VARIANTS: a *variation* of the seat's colour
hair_color                           index into HAIR_COLORS
skin                                 index into SKIN_TONES
```

There are **no `primary_color` or `secondary_color` fields**, and there must
not be. The garment's hue comes from whichever seat the player sits in (the
clothes are the ownership signal on the board, per `gnomeLook.ts`). A player
picks only which variant of that colour to wear. A persisted look therefore
renders correctly in any seat, which is exactly what an account-wide look
needs.

Server-side validation is **structural, not catalogue-based**: exact key set,
ids matching `^[a-z0-9-]{1,40}$` (or null where optional), integer indices in
a small bounded range. Clients keep sanitising with `sanitizeLook`. This
preserves the existing design rule that "adding a hat is dropping a PNG, with
no server redeploy", because an unknown but well-formed id degrades gracefully
on render. The same validator closes the verbatim-`look` hole in the room
(§14, R2).

---

## 9. Authentication and session architecture

### 9.1 Recommended flow: server-side OpenID Connect, authorization code + PKCE

```text
Browser                         Worker                                  Google
  │ click "Sign in with Google"   │                                        │
  │ GET /api/auth/google/start ──▶│ state, nonce, PKCE verifier            │
  │                               │ → signed, HttpOnly, 10-minute cookie   │
  │◀── 302 accounts.google.com/o/oauth2/v2/auth?response_type=code         │
  │        &scope=openid&state&nonce&code_challenge(S256)&redirect_uri ──▶ │
  │                                             user picks an account      │
  │ GET /api/auth/google/callback?code&state ◀──────────────────── 302 ────│
  │ ─────────────────────────────▶│ state == cookie?                       │
  │                               │ POST oauth2.googleapis.com/token ─────▶│
  │                               │   (code, client_secret, verifier)      │
  │                               │◀──────────────────────── id_token ─────│
  │                               │ verify: RS256 signature against        │
  │                               │   Google's JWKS, iss, aud, exp, nonce  │
  │                               │ upsert user by (google, sub): atomic   │
  │                               │ new session id → Set-Cookie            │
  │◀── 302 back to the validated return path (e.g. ?room=ABC234)           │
```

This is Google's documented OpenID Connect server flow. It uses no deprecated
library (the deprecated one is the old `platform.js` / `gapi.auth2` Sign-In
library).

Why this, and not the Google Identity Services (GIS) button, fits this codebase:

- **The CSP stays intact.** The production policy is `default-src 'none';
  script-src 'self'; connect-src 'self'` with no external origins, which
  DEPLOYMENT.md lists as a security feature. The GIS button needs
  `script-src https://accounts.google.com/gsi/client`,
  `frame-src https://accounts.google.com/gsi/` and
  `connect-src https://accounts.google.com/gsi/`. A redirect needs none of
  them: a top-level navigation is not governed by CSP.
- **COOP stays intact.** `public/_headers` sets
  `Cross-Origin-Opener-Policy: same-origin`. GIS popup mode needs
  `same-origin-allow-popups`.
- **Guests make zero third-party requests.** GIS loads Google's script on
  every page view, including for guests who never sign in. That would break
  the "single-device play makes zero network requests" property for everyone.
- **No token in JavaScript.** GIS hands an ID-token JWT to page script. Here
  the ID token never leaves the Worker, and the browser only ever holds an
  `HttpOnly` cookie that XSS cannot read.
- **The Worker is already same-origin and already on the path.** The server
  side exists; this adds three routes.

The cost is a full-page navigation. That is acceptable because the app
already keeps everything that matters in the URL (`?room=`) and in
`sessionStorage` (the seat token survives a same-tab navigation). A player who
signs in from a lobby comes back to the same seat. The sign-in button is a
plain link styled to Google's branding guidelines, with the "G" mark
self-hosted so the CSP still holds.

### 9.2 Verification details

- **Scope `openid` only** (decision 1). It returns `sub` and nothing else
  about the person: no email, no name, no picture. `sub` is the only thing
  stored about the Google identity.
- **Checks on the ID token:** `iss ∈ {https://accounts.google.com,
  accounts.google.com}`, `aud == GOOGLE_CLIENT_ID`, `exp` in the future (with
  small skew), and `nonce` equal to the one in the transaction cookie. Also
  verify the RS256 signature against Google's JWKS, cached per the response's
  cache headers. The token did arrive over TLS straight from Google's token
  endpoint, but verification is cheap and removes any reliance on that path.
- **Login CSRF** is prevented by `state` bound to a signed, `HttpOnly`,
  `SameSite=Lax` cookie. `Lax` is needed because the callback is a cross-site
  top-level GET. **Code interception** is prevented by PKCE (S256). **Open
  redirects** are prevented by accepting only a same-origin relative return
  path. Anything else becomes `/`.
- **JWT library:** `jose` (decision 14), subject to confirming the pinned
  version runs on the Workers runtime and passes `npm audit` and a
  dependency review in Phase 2. Cryptographic verification is not hand-rolled.

### 9.3 Atomic, idempotent account creation

A double-clicked callback, or two tabs racing, must not create two users.
Since D1 has no interactive transactions, it is one batch:

```sql
INSERT INTO users (id, created_at, updated_at, last_login_at)
  SELECT ?1, ?2, ?2, ?2
  WHERE NOT EXISTS (SELECT 1 FROM auth_identities WHERE provider = 'google' AND subject = ?3);
INSERT INTO auth_identities (provider, subject, user_id, created_at)
  SELECT 'google', ?3, ?1, ?2 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)
  ON CONFLICT (provider, subject) DO NOTHING;
SELECT user_id FROM auth_identities WHERE provider = 'google' AND subject = ?3;
```

The last statement returns the one true `user_id`. Batches are serialised, so
the `NOT EXISTS` guard cannot interleave with another batch.

### 9.4 Sessions

- **Cookie:** `__Host-gw_session=<256-bit random, base64url>; Path=/; Secure;
  HttpOnly; SameSite=Strict`. The `__Host-` prefix forbids a `Domain`
  attribute, so a sibling subdomain cannot plant or read it. `Strict` works for
  this SPA: the only request that goes out without the cookie is the initial
  document load after following an external link, and the document is the
  same static bundle for everyone. Every subsequent `fetch` and WebSocket
  upgrade from the page is same-site and carries it.
- **Storage:** D1 holds `SHA-256(cookie)`. A database leak yields no usable
  sessions.
- **Opaque, not a JWT**, because logout, "sign out everywhere", suspension and
  account deletion all need server-side revocation. A signed stateless cookie
  cannot be revoked. The cost is one indexed D1 read per HTTP request and
  **one per WebSocket connection**, not per message.
- **Lifetime** (decision 12): 30 days sliding inactivity, 90 days absolute.
  `last_seen_at` is written at most once a day.
- **Fixation:** a fresh id is minted at every sign-in, and any session id the
  browser already presented is deleted.
- **Logout:** `POST /api/auth/logout` deletes the row and expires the cookie.
  Seats held by seat tokens are untouched, because identity at the table is
  the token (§10).

### 9.5 Middleware: two questions, asked separately

```ts
// src/worker/auth/session.ts
authenticate(request, env): Promise<Auth>   // Who is this? Never throws on guests.
//   Auth = { kind: 'guest' }
//        | { kind: 'user'; user: ActiveUser }                        // status === 'active'
//        | { kind: 'unavailable'; userId: string; status: 'suspended' | 'deleting' }

// The router, once, from each route's declared access level:
//   access: 'public'    → any Auth
//   access: 'user'      → 'user' only; guest → 401; unavailable → 403 ACCOUNT_UNAVAILABLE
//   access: 'self-exit' → 'user' or 'unavailable' (the short allowlist below)

// in each handler: Are they allowed? Checked against the database, never the UI.
if (profile.user_id !== user.id) return forbidden();
```

**Phase 2 requirement P2-1: account status is enforced centrally (recorded
2026-09-29).** Every authenticated HTTP request is checked for
`users.status = 'active'` in **one place**, the router, from the status
`resolveSession` returns with the session. That happens **before** any
handler runs. Endpoints never check `suspended` or `deleting` themselves,
and cannot forget to.

- **The type system carries it.** Handlers for `'user'` routes receive an
  `ActiveUser`, a type only `authenticate` can construct, when the status is
  `active`. A handler that needs a user cannot be written against a
  non-active one.
- **Access is declared per route, in the route table.** There is no
  per-handler opt-in. The only routes reachable by a non-active account are
  a fixed `'self-exit'` allowlist: `POST /api/auth/logout`, and a `GET
  /api/me` that returns the account status and nothing else, so the client
  can say why. Whether a suspended account may still **export or delete**
  its data is a policy decision to settle in Phase 8. If yes, those two
  routes join the allowlist, still declared centrally.
- **WebSocket upgrades apply the same rule.** A non-active account's socket
  is treated as a guest: no `user_id` is attributed and no social socket is
  opened.
- **Sign-in applies it too.** A `suspended` or `deleting` account completing
  Google sign-in gets no session.
- **A test enforces it.** It walks the route table and asserts that every
  route not in the allowlist answers 403 for a `suspended` user and a
  `deleting` user, and 401 for a guest. A new route added without a
  declaration fails the build.

Cross-cutting rules applied at the router:

- **`Origin` allowlist on every non-GET `/api/*` request and on every
  WebSocket upgrade.** The WebSocket check matters specifically. Browsers
  send cookies with WebSocket handshakes, and `SameSite` only covers
  cross-*site*, not cross-*origin*. Without an `Origin` check, a page on a
  sibling origin could open a socket that rides the victim's session
  (cross-site WebSocket hijacking). Today this is harmless because a socket
  carries no ambient credential. It stops being harmless the day the upgrade
  reads a cookie.
- **JSON bodies only** (`content-type: application/json`), size-capped and
  schema-validated before any handler logic runs.
- **Explicit DTOs.** Every response is built field by field from a
  `PublicProfile`, `MeResponse`, etc. type. A database row is never
  serialised.

**Phase 2 requirement P2-2: authentication is tested through the real
Worker environment (recorded 2026-09-29).** Phase 1's repository and
constraint tests run on `testDb` (Node's `node:sqlite`, same migrations).
That is accepted for Phase 1, and stays as the fast inner loop.
Authentication must additionally be tested through the real Workers runtime
and real (local) D1: session cookies, the WebSocket-upgrade identity handoff,
central status enforcement (P2-1), and the `Origin` checks.

- The first Phase 2 PR reviews and picks the mechanism:
  `@cloudflare/vitest-pool-workers`, whose support for this repo's vitest 4
  must be confirmed; or requests against `vite preview` / `wrangler dev`
  from the test runner; or Playwright API tests. The `testDb` adapter's
  fidelity to D1 is re-checked in the same review.
- Google itself is never called from tests. A local-only fake identity
  provider stands in, enabled only by a local flag **and** a localhost host,
  with a test that it refuses otherwise.

---

## 10. How guests and accounts coexist

**Nothing that works today requires signing in afterwards.** Accounts only add.

| | Guest | Signed in |
|---|---|---|
| Local hot-seat / CPU | ✅ unchanged, zero network | ✅ same, plus the saved gnome pre-fills seat 1 (read-only) |
| Online rooms: host, join, TV board view | ✅ unchanged | ✅ unchanged mechanics; seat shown with a verified badge |
| Gnome creator | ✅ per session (plus the reload fix, §14 R4) | ✅ saved to the account |
| Username / profile page | — | ✅ |
| Stats, match history | — | ✅ from games with at least one account seat |
| Friends, invites, presence | — | ✅ |

Rules at the table:

1. **Attribution comes from the transport, never the message.** The room links
   a seat token to a `user_id` only when the Worker says the socket carried a
   valid session.
2. **Attribution is frozen at `start()`.** `start()` snapshots
   token → `user_id` into the room record as `seatAccounts[]`, just as
   `createGame` freezes names and controllers into `GameConfig`. Signing in or
   out mid-game changes nothing about that game.
3. **At most one attributed seat per user per room.** Two tabs of one browser
   share one cookie. The existing "two tabs are two players" behaviour is kept,
   and the second seat simply plays as a guest (§19).
4. **An account seat's name is the username, set by the server.** The client's
   `name` is ignored for it. Guest seats keep free-text names, sanitised
   (§14 R3), and the UI marks them as guests. A guest can type
   "MushroomKing42", but only the real one carries the badge.
5. **`SeatInfo` gains only `account?: true`.** It never gains a `user_id`,
   because the snapshot is public to anyone with the room code (§14 R5). The
   username is already in `name`, which is all an "Add friend" button needs.
6. **Guests never open the social socket and never call `/api/me`.** After
   sign-in the app sets a non-sensitive `localStorage['ww:signed-in']` hint,
   and only browsers carrying it fetch `/api/me` on load. A guest who has
   never signed in keeps making zero requests during local play.

Protocol impact: the new `SeatInfo.account` field is optional and additive, so
`PROTOCOL_VERSION` need not change for attribution. Bump it only if a release
changes message meaning. Every bump forces open tabs into the "reload" screen.

---

## 11. Profiles and customization in the UI

Stay inside the existing screen machine. There is no router library to add,
and adding one would cut across `App.tsx`'s deliberate URL handling.

- **Addressing.** `/player/MushroomKing42` is the canonical, user-facing
  profile URL (decision 16). How that works without changing `base`, and what
  first-class routes would take later, is in §11.1.
- **Screens.** `Screen` grows from `home | local | online | rules` to include
  `profile | friends | customize`. The home card gets the brief's layout:
  PLAY (Local, Online, vs CPU) above an account strip. Signed out, the strip
  is "Sign in with Google: save your profile, stats, friends and gnome".
  Signed in, it is the player's gnome portrait and username.
- **First sign-in** lands on a username picker with gnome-name suggestions. No
  profile exists until a username is chosen (`GET /api/me` returns
  `needsUsername: true`).
- **Customize** hosts the existing `GnomeCreator` as a screen. Because the
  garment is seat-relative, it previews the look in **all four seat colours**
  side by side, so the player sees what they will look like wherever they sit.
- **Online menu.** Signed in, the name field becomes the read-only username
  and the gnome chip loads the saved look. Everything else is unchanged.
- **Lobby.** Account seats get a small verified leaf badge. Friends get an
  "Invite" affordance (Phase 7).
- **Profile page.** `GnomePortrait`, username, member-since, and headline
  stats, split into Human multiplayer and VS CPU. `GnomePortrait` needs a
  `seatId` for the garment hue, and the profile uses seat 1's presentation
  (decision 10). There is no new colour field.
- **Quick Play** (decision 8) starts a VS CPU game immediately with the
  default setup. It is a shortcut into the existing local path, not
  matchmaking.
- **Tone.** Game-y copy, gnome art everywhere, no settings-page greys. Account
  management (privacy toggle, data export, sign out, delete) sits in one
  plain-spoken section of the profile, not an enterprise console.

### 11.1 Clean profile URLs and the relative base (decision 16)

**1. What depends on relative, subpath hosting today.** `vite.config.ts` sets
`base: './'`. A production build confirms what that does:

- `index.html` loads its script, stylesheet, favicons and manifest as `./…`,
  relative to the **document's** URL.
- `manifest.webmanifest` uses `start_url` and `scope` of `./`.
- Assets referenced from code resolve against `import.meta.url` (for example
  `new URL('poof-blob-….png', import.meta.url)`), and CSS `url()`s resolve
  against the stylesheet. Neither depends on the page's address.

The only reason for the relative base is static hosting under a subpath
(GitHub Pages `/repo/`), and those deploys serve **local play only**. Online
play already assumes the site root: `fetch('/api/rooms')`, the socket URL
`/api/rooms/…/ws`, and the Worker's routes are all root-absolute. Every
account feature needs the Worker, so it lives on the root deploy by
necessity. Local dev (`vite`) and `vite preview` also serve at the root.

**2. Can clean URLs coexist with it? Yes, on the Worker deploy, without
touching `base`.** Serving `index.html` directly at `/player/X` would break,
because `./assets/…` would resolve to `/player/assets/…`. A `<base href="/">`
cannot rescue it either, because the CSP says `base-uri 'none'`. So:

1. The Worker answers `GET /player/:name` with a 302 to `/?player=:name`.
   This is the one place the query form appears.
2. The app loads at the root, so every relative reference resolves correctly.
   It reads `?player=`, opens the profile, and immediately calls
   `history.replaceState` to put `/player/:name` back in the address bar.
3. Profile links the app renders or copies are always `/player/:name`. A
   reload or a shared link re-enters through step 1.

The app records its root path once, at startup, before any `replaceState`.
Leaving the profile screen restores that root path. That matters because
`roomHref` and `boardViewHref` build invite links from `location.pathname`,
and an invite must never come out as `/player/X?room=…`. Back and forward get
a small `popstate` handler in `App.tsx`. There is no routing library.

Static subpath hosts are unaffected. They have no Worker, so they have no
profiles, and nothing they do today changes.

**3. Is the redirect an implementation detail?** Yes. `/player/:name` is the
canonical URL, the one players see, copy and share. `?player=` is internal
compatibility plumbing, never generated for display or sharing. The Worker
also sends `X-Robots-Tag: noindex` on `/player/*`. Given the child-safety
posture, profiles should not be search-indexed unless that is decided
otherwise.

**4. What first-class routes (`/player/:username`, `/friends`, `/customize`,
`/settings`, `/match/:id`) would eventually take.** It is one contained
change, done after accounts:

- **Build.** Either give up subpath hosting and set `base: '/'`, or produce
  two builds from one config: root-absolute for the Worker deploy, relative
  for static hosts. The dual build is a few lines in `vite.config.ts` keyed on
  an env var, and the CSP is unaffected either way. The manifest's
  `start_url` and `scope` follow the base.
- **Worker.** Nothing new is needed.
  `not_found_handling: "single-page-application"` already serves
  `index.html` for unknown paths, and with an absolute base, assets resolve
  from any depth. The 302s are kept for a while as compatibility redirects,
  then removed.
- **App.** `App.tsx`'s `useState` screen machine becomes a small path
  matcher (`pathname → Screen`) plus `pushState` / `popstate`. `?room=` and
  `?view=board` keep working unchanged. Six routes do not justify a routing
  library.
- **`/match/:id`** also needs a product decision on who may view a match.
  `matches.id` is a random UUID, so ids are not guessable, but visibility is
  still a policy question.

Until then, `/friends`, `/customize` and `/settings` are screens reached in
the app. If shareable links to them are wanted sooner, the Worker's 302
mechanism can map a short allowlist of clean paths to `?screen=…` the same
way.

## 12. Statistics from authoritative matches

### Where

In the room, at the moment it already recognises the game is over
(`Room.apply`, `justFinished`). The room holds the only complete record:
`config`, `seed`, `seal`, `actions`, plus the frozen `seatAccounts[]` and a
`startedAt` it will now store. **No client submits anything.** A client
cannot send `wins += 1000`, because there is no endpoint that accepts a
result.

### How

A pure function, `src/net/matchSummary.ts`, computes
`summarizeMatch(record, seatKinds) → MatchSummary`. It replays the record once
through the public engine API, diffs `eventCount` after each action to collect
exactly the events that action emitted, and reads the final `PlayerState`s.
`engine/samples.ts` (`extractSamples`) already replays records this way, so
this is the established pattern.

Replay is necessary, not a stylistic choice: `GameState.events` is a
**rolling 1,000-event window**. Reading only the final state's events would
silently undercount long games.

### What the engine reliably produces

| Statistic | Source | Reliable? |
|---|---|---|
| Games played, wins, losses, draws | `state.winner`, `MatchResult.reason` | ✅ |
| vs CPU / vs humans / with guests | `seatKinds` | ✅ |
| Gnomes lost | `PlayerState.gnomesLost` | ✅ |
| Gnomes spawned | `PlayerState.gnomesSpawned` | ✅ |
| Gardens planted, by type ("favourite garden") | `gardenPlanted` events (a move, or cards) | ✅ |
| Gardens upgraded | `gardenUpgraded` | ✅ |
| Wishes spent | Σ `wishesSpent.amount` | ✅ |
| Whimsy cards played | `cardPlayed` | ✅ |
| How you were eliminated | `playerEliminated.reason` | ✅ |
| Turns, match length | `turn.number`; room wall clock (`startedAt` → finish) | ✅ |
| **Gnomes defeated (kills)** | `unitDestroyed.player` is the **owner of the destroyed unit**. There is no killer field. Fight kills can be inferred from the `fightStarted`…`fightEnded` bracket, but card kills (Rocket, Mushroom Cloud) and marriage cascades cannot be attributed. | ❌ Defer |
| **Homes captured** | `playerEliminated` names only the **victim** | ❌ Defer |

Kills and captures should wait for an engine change that adds explicit
attribution (for example `unitDestroyed.by`). That would be a separate,
reviewed engine PR, checked against the replay and fingerprint tests.

### Idempotency and failure

- `start()` mints `matchId` and persists it. The write at game over is one D1
  batch: `INSERT INTO matches … ON CONFLICT(id) DO NOTHING` plus
  `INSERT INTO match_players … ON CONFLICT DO NOTHING`. A retry is a no-op.
- **Stats are computed on read** (`SUM`/`COUNT` over
  `match_players WHERE user_id = ?`, indexed). With no counters there is no
  double-increment, and deleting a user's rows is the whole story. They can
  be materialised later with an insert trigger if volume ever warrants it; a
  trigger fires only on rows actually inserted, so exactly-once is preserved.
- If D1 is unavailable, the room persists `matchReport: 'pending'`, retries on
  its existing alarm with backoff, and **the reaper waits** for the report or
  gives up after N attempts and logs. Otherwise a room reaped 10 minutes after
  everyone leaves could lose the record.
- A user deleted between start and finish: rows insert with `user_id = NULL`
  (`INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM users …)`), so a foreign-key
  failure cannot wedge the retry loop.
- **Only matches with at least one account seat are persisted.** Guest-only
  games leave no trace, as today.
- **Guest names are never persisted.** History shows "a guest" or "CPU
  (hard)". Other accounts are resolved to their *current* username at read
  time; a deleted account shows as "a deleted gnome".
- **A seat taken over by the shot clock** is recorded with `taken_over = 1`,
  and its result is a loss even if the CPU wins (decision 6). The database
  enforces the pairing with a `CHECK`.
- **Categories** (decision 6): every match is `human` (two or more seats
  played by people, account or guest) or `cpu` (one person against CPUs).
  Statistics are always reported per category. Games involving guests count,
  provided they completed normally.

**Farming caveat.** Rooms are private and anyone can open a second tab as a
guest, so wins against guests or one's own second account are inherently
farmable. "Authoritative" guarantees the game was really played, not that the
opponent was independent. That is acceptable with no leaderboards or ranking,
which are out of scope, and it is why vs-CPU and vs-human records should be
shown separately.

**Full replays are not stored in v1.** A record is config plus every action,
which is tens to hundreds of KB, and its `config.players[].name` contains
whatever names people typed. If replays or post-match review become a
feature, store records in R2 with names stripped. Names do not affect the
engine's RNG, so replay determinism is preserved (to be proven by a test at
the time).

---

## 13. Friends, presence and invitations on the existing multiplayer system

### Friends and blocks (D1, REST)

Every rule is enforced in SQL, one batch per operation:

- **Request A → B.** Refused if A = B, if either has blocked the other, if they
  are already friends, or if A has hit the outgoing-pending cap (proposed 50).
  Storage is canonical, `(min(A, B), max(A, B))`, so **at most one pending
  request per pair exists by primary key**. If B already has a pending
  request to A, A's request **accepts** it in the same batch. Two requests
  crossing in flight therefore end as one friendship, never as two opposing
  requests.
- **Accept** is a single conditional batch: insert the friendship
  `WHERE EXISTS (request addressed to me) AND NOT EXISTS (block either way)`,
  then delete the request. A block that lands first wins cleanly.
- **Decline, cancel, remove:** delete the row where the caller is the right
  party. The `WHERE` clause includes the caller's id, which is the IDOR
  defence.
- **Block:** in one batch, insert the block, delete any friendship and pending
  request for the pair, and tell the blocker's UserHub to drop pending invites
  in both directions.
- **Privacy of blocks:** a blocked user's request or invite gets the same
  response as a successful one and is silently dropped. Nothing ever returns
  "you are blocked".

### Presence (Durable Objects, no D1 writes)

One **`UserHub` Durable Object per signed-in user**, addressed by
`idFromName(user_id)`. It mirrors the Room pattern exactly:
`src/net/hub.ts` is the platform-free core with a `HubHost` interface, and
`src/worker/hub-do.ts` is thin glue. That makes it testable in vitest with a
fake host, the way `room.test.ts` tests rooms.

- **Social socket.** Each signed-in tab or device opens
  `/api/me/ws` (authenticated at upgrade, `Origin`-checked). The hub holds all
  of that user's sockets, with hibernation, so **multiple tabs and devices**
  are just a set.
- **Room activity.** A new optional `RoomHost.reportActivity(userId,
  'lobby' | 'game' | null)` is called when an attributed seat connects,
  disconnects, the game starts, or the room closes. `room-do.ts` forwards it
  to that user's hub. Hubs key activity by room code with a TTL (proposed 15
  minutes, refreshed on every re-`hello`), so a room that dies without
  reporting cannot leave a user stuck "In Game".
- **Derived state:** `presence_visible = 0` → Offline to everyone. Otherwise
  In Game (any room reports `game`) > In Lobby > Online (any social socket) >
  Offline. A closed browser, a lost connection or a stale tab resolves through
  WebSocket close events, auto-response pings, and the TTL.
- **Fan-out.** When derived state changes, the hub notifies each friend's hub
  (friend list read from D1 once, then kept current by friend-change events).
  A friend's hub pushes only to connected sockets. A friend cap (proposed 200)
  bounds the fan-out.
- **What presence never reveals:** the room code, co-players, or when you were
  last online. Friends only. A blocked user is not a friend, so they see
  nothing.

### Invitations (through the existing lobby, not beside it)

- `POST /api/invites { to: username }` succeeds only if the sender currently
  holds an attributed seat in a live room (their hub knows the room from
  `reportActivity`), the recipient is a friend, and neither has blocked the
  other. It is rate-limited per sender, deduplicated to one pending invite per
  (from, to), and expires when the room leaves the lobby or after 10 minutes.
- It is delivered to the recipient's hub, which pushes it to their social
  sockets or holds it until one connects.
- **Join** navigates to `?room=CODE`. From there it is exactly the path an
  invite link takes today: the lobby, `hello`, `claimSeat`. **No second
  multiplayer system is involved.** Decline deletes the invite at the hub.
- An invite tells the recipient the room code. That is the room's existing
  trust model (whoever has the code can sit down); it does not change it.

**Blocking and rooms** (decision 9): v1 blocks govern friend requests,
invitations, presence and any future account-based social interaction. They
do not keep someone out of a room whose code they have, and no host-kick is
built for it. The architecture leaves that door open. `blocks` is a generic
user-to-user table with no feature-specific columns, and rooms already learn
each seat's verified `user_id` at the upgrade. A later "enforce blocks at
private-room admission" rule is therefore a check in `Room.hello` plus a
`RoomHost` lookup, with no schema change. If matchmaking ever exists, blocks
should exclude pairings.

---

## 14. Security & privacy risks found in the existing architecture

| # | Finding | Evidence | Severity now | With accounts |
|---|---|---|---|---|
| R1 | **Client message fields are type-unchecked.** `parseClientMessage` checks only `t`. A `hello` with `name: 123` throws a raw `TypeError` out of `Room.hello`, which `room-do.ts` calls with no try/catch. By then a token has been minted and a seat assigned in memory. `configure` has the same shape, host only. | Confirmed by probe | Low–medium (robustness, log noise) | Must fix first: new code will copy the pattern. |
| R2 | **`look` is stored and rebroadcast verbatim**, with no shape or size limit. It lands in the room record, which is rewritten on every save, and in every `room` frame to every connection. A 200 KB look with extra keys was accepted. | Confirmed by probe | Medium (storage and broadcast amplification by any seated player) | The same validator (§8.2) guards the account API. |
| R3 | **Names are only length-capped.** Control characters, NUL, RTL overrides and Cyrillic lookalikes pass through. React escapes the output, so there is **no XSS**, but lobby and log spoofing is possible. | Confirmed by probe | Low | Becomes impersonation of registered usernames. Fixed by §10 rule 4 plus sanitising guest names. |
| R4 | **Online look is not persisted.** `OnlineScreen` keeps it in `useState(defaultLook)`. After a page reload inside a room, `hello` sends the default look and overwrites the seat's gnome mid-game. MULTIPLAYER.md's "a reconnect restores the character" holds for socket re-dials, not page reloads. | Code reading | Low (bug) | Fixed for accounts by Phase 4; fixable now for guests. |
| R5 | **`GET /api/rooms/:code` is public.** It returns the full snapshot, including names and looks, to anyone who knows a ~29-bit code, without connecting. This is by design today. | Code reading | Low | Anything added to `SeatInfo` is public. Never add `user_id`, email or presence there. |
| R6 | **No `Origin` check** on the WebSocket upgrade or `POST /api/rooms`. | Code reading | None today (no ambient credentials) | **Cross-site WebSocket hijacking** once cookies exist. Must ship with Phase 2. |
| R7 | **Bearer credentials in Web Storage**: seat token (`sessionStorage`) and host key (`localStorage`). They are readable by any script on the origin. The strict CSP is what makes that acceptable. | Code reading | Low | Keep the session **out** of Web Storage (`HttpOnly` cookie), and keep the CSP strict. This is another reason for the redirect flow over GIS. |
| R8 | **`revealed` broadcasts the full `MatchRecord`**, including `config.players[].name`, to every connection including spectators. | Code reading | Low | Never put a `user_id` into `GameConfig`. Keep identity beside the record. |
| R9 | **Host-supplied `controller`, `difficulty` and `gardenPreset` aren't enum-checked.** `createGame` passes `controller`/`difficulty` through. A host can set a nonsense controller, which the room treats as a CPU. | Code reading | Low (host griefing their own room) | Same validation pass as R1. |
| R10 | **The Worker and DO have no unit tests.** `/host-key` is protected only by the public regex not matching it, and nothing pins that. | No test references either file | Low | Auth routing and the identity header will live there. Worker-level tests become mandatory (§18). |
| R11 | **Only per-IP rate limits exist at the door.** | `wrangler.jsonc` | Low | Social writes need **per-user** limits (a rate-limit binding keyed by `user_id`) plus database caps. |
| R12 | **The docs promise "no cookies, no accounts, no data collection."** | DEPLOYMENT.md, `vite.config.ts` comment, online menu copy ("no accounts") | — | These statements become false and must be updated together with a privacy policy. This document makes no legal-compliance claims. |

R1–R4 and R9 can be fixed now, independently of accounts. The Phase 0.5 PR in
§17 does this.

---

## 15. Existing files likely to change

| File | Change | Phase |
|---|---|---|
| `wrangler.jsonc` | `d1_databases` binding, `USER_HUBS` DO binding and migration tag, new rate-limit bindings, `vars` (`GOOGLE_CLIENT_ID`, `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`), optional `env.staging` | 1, 2, 7 |
| `worker-configuration.d.ts` | Regenerated with `npm run cf-typegen` | 1+ |
| `src/worker/index.ts` | Delegates to a router; adds the `Origin` check; authenticates the WS upgrade and forwards identity (stripping client copies) | 2 |
| `src/worker/room-do.ts` | Accepts `env`; stores `account` in the socket attachment; implements `recordMatch` and `reportActivity` | 2, 5, 7 |
| `src/net/room.ts` | `hello(conn, msg, account?)`; `accounts` map; one-seat-per-user rule; server-set names for account seats; `startedAt`, `matchId`, frozen `seatAccounts[]`; `recordMatch` at finish; report retry; wipe accounts in `close()` | 0.5, 2, 5, 7 |
| `src/net/protocol.ts` | Field validation in `parseClientMessage`; `SeatInfo.account?: true` | 0.5, 2 |
| `src/App.tsx` | New screens; `?player=` addressing; account context provider | 2, 3 |
| `src/ui/HomeScreen.tsx` | PLAY / account strip | 2 |
| `src/ui/OnlineScreen.tsx` | Username in place of the name field when signed in; saved look; verified badges; invite affordance; persist the guest look (R4) | 0.5, 3, 4, 7 |
| `src/ui/useNetGame.ts` | No identity change needed (the cookie rides the upgrade); handle the new invite-related toasts | 7 |
| `src/ui/SetupScreen.tsx` | Seat 1 defaults to the saved look when signed in | 4 |
| `src/ui/netClient.ts` | `ww:signed-in` hint helpers | 2 |
| `public/_headers`, `vite.config.ts` | CSP stays as is (redirect flow); comments updated | 2 |
| `DEPLOYMENT.md`, `MULTIPLAYER.md`, `README.md`, `TECH_DEBT.md`, `ROADMAP.md` | Posture, setup (Google Cloud project, secrets, D1 migrations), identity section | each phase |
| `playwright.config.ts` | `webServer` applies local D1 migrations before `vite preview` | 1 |
| `.github/workflows/ci.yml` | No deploy; possibly a migrations lint step | 1 |

**Not touched:** anything in `src/engine/`.

## 16. New modules and services likely to be required

```text
migrations/                       D1 migrations (wrangler's default dir): 0001_accounts.sql, …
.dev.vars.example                 GOOGLE_CLIENT_SECRET=…, OAUTH_COOKIE_KEY=… (placeholders only)

src/platform/                     pure, platform-free, unit-tested (like src/net/room.ts)
  usernames.ts                    normalise, validate, reserved/deny lists
  lookSchema.ts                   structural GnomeLookWire validation (shared by room + API)
  apiTypes.ts                     DTOs shared by client and Worker: PublicProfile, MeResponse, …

src/worker/
  router.ts                       tiny method + path router (no framework; matches house style)
  http.ts                         json(), errors, body parsing, Origin check
  auth/google.ts                  start/callback, token exchange, ID-token verification
  auth/session.ts                 authenticate / requireUser, cookie helpers, rotation
  db/                             one repository per area: users, profiles, customization,
                                  matches, friends, blocks. Every SQL statement lives here.
  api/                            handlers: me, profiles, customization, stats, friends, blocks,
                                  invites, account (export/delete)
  hub-do.ts                       UserHub Durable Object glue

src/net/
  matchSummary.ts                 replay a MatchRecord → per-seat stats (pure)
  hub.ts, hubProtocol.ts          presence and invite core + social-socket wire format

src/ui/account/
  apiClient.ts                    fetch wrapper (same-origin credentials, JSON, error mapping)
  AccountContext.tsx, useAccount.ts
  UsernamePicker.tsx, ProfileScreen.tsx, CustomizeScreen.tsx, FriendsScreen.tsx
  useSocialSocket.ts              presence + invites (Phase 7)

test support:
  src/worker/db/testDb.ts         a D1-shaped adapter over Node's built-in node:sqlite that runs the
                                  real migrations, so SQL constraints are tested inside the existing
                                  vitest run with no new runner and no native dependency
```

## 17. Migration plan: small, reviewable phases

Each phase is one or more PRs that leave `main` shippable, with all existing
unit and e2e tests green. Nothing user-visible appears until Phase 2.

**Phase 0.5: Room input hardening. No accounts.** Detailed in
[ACCOUNTS_SPEC_PHASE_0_5.md](ACCOUNTS_SPEC_PHASE_0_5.md).
Validate every `ClientMessage` field's type and bounds. Add the structural
`look` validator (`src/platform/lookSchema.ts`) and apply it to `hello` and
`configure`. Sanitise names (NFKC, strip control and bidi characters, trim).
Enum-check `controller`, `difficulty` and `gardenPreset`. Persist the guest's
online look beside `ww:name` (R4). Add Worker-level tests for the existing
routes, including that `/host-key` is unreachable publicly.

**Phase 1: Persistence foundation.** Detailed, with the schema for review,
in [ACCOUNTS_SPEC_PHASE_1.md](ACCOUNTS_SPEC_PHASE_1.md). Phase 1 applies only
migration `0001_identity.sql`.
1. D1 binding, `migrations/0001_accounts.sql` (the §8 tables), `cf-typegen`,
   `.dev.vars.example`, env-var plumbing and a typed `Env`.
2. The `node:sqlite` test adapter plus repository layer and constraint tests.
3. `playwright.config.ts` applies local migrations. DEPLOYMENT.md gets the
   migrate-then-deploy order, expand/contract discipline, and staging.
Exit: `npm test`, lint, build and e2e are green. No routes exist yet.

**Phase 2: Authentication.** Carries requirements P2-1 (central `active`
status enforcement) and P2-2 (tests through the real Worker environment),
§9.5.
1. `router.ts`, `http.ts`, `Origin` allowlist, JSON body limits.
2. Google start/callback, ID-token verification, atomic user upsert, sessions,
   logout, `GET /api/me`. Includes a local-only fake identity provider for
   e2e, enabled only by a `.dev.vars` flag **and** only when the request host
   is `localhost`, with a test that it refuses otherwise.
3. The WS-upgrade identity handoff: attachment, `Room.hello(…, account)`,
   `SeatInfo.account`, server-set names, one attributed seat per user.
4. UI: sign-in link, account strip, `ww:signed-in` hint.
Exit: guests behave byte-for-byte as before (existing e2e unchanged); a
signed-in player's seat shows the badge.

**Phase 3: Profiles.**
Username picker and rules, `username_holds`, rename with cooldown, public
`GET /api/profiles/:username` (explicit DTO), `?player=` screen, and the Worker
302 from `/player/:name`.

**Phase 4: Persistent customization.**
`GET/PUT /api/me/customization`, the Customize screen (four-colour preview),
the online menu and setup screen reading the saved look.

**Phase 5: Match records & statistics.**
`matchSummary.ts`; `startedAt`, `matchId` and `seatAccounts[]` in the room;
`RoomHost.recordMatch`; the idempotent batch; alarm retry with a reaper guard;
`GET /api/profiles/:username/stats` and `/matches` (paged).

**Phase 6: Friends & blocking.**
The §13 SQL operations with per-user rate limits and caps, the Friends
screen, and "Add friend" on verified lobby seats and profiles.

**Phase 7: Presence & invitations.**
`UserHub` (`hub.ts` + `hub-do.ts`), `/api/me/ws`, `RoomHost.reportActivity`,
the invite endpoint, and the invite toast with Join/Decline routing into
`?room=`.

**Phase 8: Privacy & account controls.**
Presence toggle; `GET /api/me/export` (JSON of account, profile, look,
friends by username, blocks, own matches); `DELETE /api/me`, per the table
below; "sign out everywhere".

The authoritative table-by-table account-deletion behaviour is
[ACCOUNTS_SPEC_PHASE_1.md §4](ACCOUNTS_SPEC_PHASE_1.md#4-what-deletion-does-table-by-table).
It classifies every record as **deleted**, **anonymised**, or **needs a
policy decision**, and marks what affects other users or historical matches.
In short:

- identity, sessions, profile, customization, privacy settings and social
  rows are deleted;
- the user's `match_players` rows are anonymised (`user_id` NULL), so other
  players' histories stay intact;
- no identifier is retained for bans without explicit approval (decision 11).

**Phase 9: Hardening.**
Security review against the brief's security requirements (sessions, CSRF,
XSS, IDOR, injection, rate limiting, spam, enumeration, replay, fixation,
stolen sessions, malformed requests), abuse-case tests
(request and invite spam, enumeration), load checks on hub fan-out, and a
multiplayer regression pass.

## 18. Testing requirements per phase

Existing suites (2,874 unit tests, 5 Playwright specs) must stay green in
every phase. That is the bar for "done".

| Phase | Must add |
|---|---|
| 0.5 | Probe cases become real tests. A non-string `name` gets a `PROTOCOL` error with no state change. An oversized or extra-key `look` is refused or stripped. Bidi and control characters are stripped. Bad `controller`/`difficulty` gets `BAD_CONFIG`. A reload keeps the guest's gnome (e2e). Worker route tests: `/host-key` is unreachable from outside. |
| 1 | Migrations apply cleanly from empty. Constraint tests: duplicate `username_key` (case-insensitive) is rejected; `friendships` rejects `user_a >= user_b`; `friend_requests` allows one row per pair; `blocks` rejects self; the partial unique index gives one seat per user per match; foreign-key cascade and `SET NULL` behave as specified (and D1 enforces foreign keys; verify, do not assume). |
| 2 | P2-1: every non-allowlisted route answers 403 for `suspended` and `deleting` accounts and 401 for guests (a route-table walk, so new routes are covered automatically); a non-active account's WebSocket gets no attribution; sign-in issues no session to a non-active account. P2-2: the authentication tests run through the real Workers runtime and local D1, not only `testDb`. Invalid, expired, wrong-`aud`, wrong-`iss`, wrong-`nonce` and bad-signature ID tokens are rejected. Mismatched `state` is rejected. A non-relative `return` becomes `/`. Concurrent callbacks for one `sub` make one user. Session rotation at login. Logout revokes. An expired session is a guest. Guests get 401 on every protected route. A foreign `Origin` is refused on POST and WS upgrade. A client-supplied identity header is ignored. Room: a `user_id` can only come from the transport; two tabs of one user give one attributed seat; an account seat's name cannot be overridden by `hello`. Every existing online e2e passes as a guest. The fake identity provider refuses non-localhost hosts. |
| 3 | User A cannot edit B's profile (403, not 404-probing). Case-insensitive collisions are rejected; lookalikes are not (by decision). Reserved and denylisted names are rejected. Rename cooldown holds. A released name is held. **Renaming does not break friendships, stats or matches.** The public profile DTO contains exactly its whitelisted keys (snapshot test). |
| 4 | A cannot modify B's customization. Malformed looks are rejected. A saved look round-trips and renders in all four seats. Unknown but well-formed ids degrade gracefully. |
| 5 | `summarizeMatch` totals over seeded self-play match the ground truth, including games longer than the 1,000-event window. **A completed match cannot award stats twice** (report called 3 times gives one match). The report survives a D1 outage and a hibernation. Taken-over seats are recorded as such. Guest names never reach D1. A user deleted mid-game does not wedge the retry. Stripping names leaves the replay identical. |
| 6 | No self-friending. No duplicate requests. Crossing requests become one friendship. Requesting an existing friend is refused. **Blocked users cannot send requests or invites, and get the same response as success.** Block removes the friendship and pending requests atomically. Caller-scoped deletes refuse other users' rows (IDOR). Rate limits and caps apply. |
| 7 | Hub core with a fake host: multi-tab, multi-device, close without goodbye, TTL expiry, hidden presence reads as offline, a blocked user sees nothing. Invites only from a seated sender to a friend; dedupe; expiry at start or 10 minutes. Join lands in the lobby through the existing path (e2e, two browsers). |
| 8 | Export contains only the caller's data and no other user's private fields. **Deleting an account does not corrupt historical matches**: the other players' histories are intact and show a deleted gnome. Deleted sessions stop working immediately. Re-sign-in creates a new account. |
| 9 | Authorization matrix over every endpoint × {guest, owner, other user, blocked user}. Fuzzed malformed bodies. Enumeration probes. Full multiplayer regression. |

---

## 19. Decisions (approved 2026-09-29)

Recorded as given by the product owner. Where a decision changed the
proposal, the relevant section above has been updated.

**Product**

1. **Email:** not collected or stored. Google's `sub` links the Google
   identity to the internal account. Scope `openid` only.
2. **Age:** no birthdates and no age verification in this project.
   Child-safety and age questions are flagged for legal/product review (see
   below) rather than solved by collecting more data.
3. **Public identity:** one unique username. No separate display name.
   `user_id` is the permanent identity and never depends on the username.
4. **Usernames:**
   - ASCII only, with case-insensitive uniqueness.
   - A change at most every 30 days. Old names are reserved to their previous
     owner for 90 days.
   - A reserved list for system and admin terms.
   - The offensive list is data, updatable without code changes, and there is
     no attempt at exhaustive automatic filtering.
   - Schema and API support later review and forced renames without touching
     identity. A removed name leaves the account in a safe placeholder state
     until a new name is chosen.
   - No reporting platform in this project.
   - No lookalike/confusable uniqueness in v1 (confirmed 2026-09-29).
   - Profiles are served with `X-Robots-Tag: noindex` (confirmed
     2026-09-29).
5. **Presence:** visible to friends by default, with a simple toggle to hide
   it. Hidden presence reads as offline to others.
6. **Statistics:**
   - Separated at least into Human multiplayer and VS CPU.
   - Games with guests count if authoritative and completed normally.
   - A seat taken over by a CPU is a loss for that player whatever the
     outcome, and the takeover is recorded separately.
   - No statistic that cannot be derived reliably.
7. **Multiple tabs, one account:** allowed. Extra seats play as unattributed
   guests. One match never attributes more than one seat to the same account.
8. **Quick Play:** starts a VS CPU game immediately with default settings. No
   matchmaking in this project.
9. **Blocking:** prevents friend requests, invitations, presence visibility
   and future account-based social interactions. A room code may still admit
   a blocked user in v1, and no host-kick is built for this. Nothing may
   preclude enforcing blocks at room admission later.
10. **Profile gnome:** seat 1 / default presentation. No new colour field.
11. **Deletion and retention:** no assumed retention for bans or moderation.
    No indefinite hashed Google identifier without explicit approval. The
    schema keeps deletion and anonymisation policy changeable, and every
    record is classified (Phase 1 spec §4).
12. **Sessions:** 30-day sliding inactivity, 90-day absolute, always
    revocable. Logout and deletion invalidate sessions.

**Technical**

13. **Sign-in:** redirect-based OpenID Connect. No GIS button and no One Tap.
    The security-header posture is preserved.
14. **ID-token verification:** `jose`, subject to Workers compatibility and
    dependency/security review. Nothing hand-rolled.
15. **Storage:** D1 for persistent account, social and game data. A per-user
    Durable Object for ephemeral presence and coordination. Presence is never
    persisted.
16. **Profile URLs:** `/player/:name` is canonical and user-facing. The
    Worker 302 to `?player=` is an internal compatibility mechanism. `base`
    is not changed and no routing library is added (§11.1).
17. **Environments:** a separate staging Worker, D1 database, OAuth client and
    secrets. Production data is never used casually for development or
    automated testing, and local development keeps working.

**Sequencing**

- **Phase 0.5** (multiplayer hardening, no account infrastructure) comes
  first ([spec](ACCOUNTS_SPEC_PHASE_0_5.md)).
- **Phase 1** follows, but only after its schema
  ([spec](ACCOUNTS_SPEC_PHASE_1.md)) has been reviewed.
- **Phase 2** (authentication) waits for explicit approval. It carries
  requirements **P2-1** (central enforcement of `status = 'active'`) and
  **P2-2** (authentication tested through the real Worker and D1
  environment), both in §9.5.

### Still open: policy items for legal/product review

- Positioning towards children, and whether any age screen is ever needed
  (decision 2 defers this).
- Whether a deleted account's username gets a quarantine. Today it becomes
  claimable immediately (Phase 1 spec §4).
- Whether `username_removals` rows are kept after the account is deleted.
- Whether per-seat counts in a deleted user's anonymised match rows are
  zeroed or kept.
- Whether blocks should survive a blocked user re-registering (this would
  need a retained identifier; see decision 11).
- Worker log content and retention.
- Who may view a match once `/match/:id` exists.

### Human setup steps (cannot be done from the repo)

- **Before Phase 1:** `wrangler d1 create gnomeconquest` and
  `wrangler d1 create gnomeconquest-staging`.
- **Before Phase 2:**
  - Google Cloud project and OAuth consent screen (app name, support
    contact, **privacy policy URL**, homepage).
  - Separate production and staging Web OAuth clients, with authorised
    redirect URIs for production, staging and `localhost`.
  - `wrangler secret put GOOGLE_CLIENT_SECRET` and `OAUTH_COOKIE_KEY`, per
    environment.
- A privacy policy that matches what is actually collected. This document
  describes technical controls only and does not claim compliance with COPPA,
  GDPR, CCPA, TDPSA or any other regime.
