# Phase 2 — Google sign-in (implementation spec, for review)

**Status: draft for review, 2026-09-29. Nothing here is implemented.** Phase 1
is complete: `0001_identity.sql` is applied to staging and production, and is
now production history.

This is the document to review before Google sign-in is built. It turns
ACCOUNTS.md §9 (authentication and sessions), §10 (guests and accounts) and
the Phase 2 entries in §17 and §18 into a change list. It also records what
the checks done while writing it found, where they change the plan.

Related: [ACCOUNTS.md](ACCOUNTS.md) (architecture and decisions),
[ACCOUNTS_SPEC_PHASE_1.md](ACCOUNTS_SPEC_PHASE_1.md) (the schema this builds
on), [DEPLOYMENT.md](DEPLOYMENT.md).

## 0. What this spec changes in the approved plan

Five points differ from ACCOUNTS.md. Each was found by checking the plan
against the code or a running browser (§12), not by preference. They are
listed first so review can start with them.

| # | ACCOUNTS.md says | This spec does instead | Why |
|---|---|---|---|
| A1 | At sign-in, delete "any session id the browser already presented" (§9.4) | Record the old session's hash at `/start`, and revoke it at the callback | When Google starts the navigation back to the callback, the browser does not send a `SameSite=Strict` cookie with it. The callback cannot see the old session. `/start` can (§12, check 4). |
| A2 | (not stated) | The page learns it is signed in from a `signin=ok` marker plus `GET /api/me`, never from the page load itself | The first page load after sign-in does not carry the new session cookie either. The page's own `fetch` does (§12, check 4). |
| A3 | Phase 2 exit: "a signed-in player's seat shows the badge"; account seats get server-set names (§10 rule 4) | Phase 2 attributes seats internally but shows **no badge and no server-set name**. Both ship in Phase 3. | Usernames arrive in Phase 3. In Phase 2 an account seat still has a name the client typed, and a badge next to it would vouch for nothing. **Decision D1.** |
| A4 | An `Origin` allowlist (§9.5), from an `ALLOWED_ORIGINS` var (§15) | `Origin` must equal the request's own origin | This blocks the cross-site WebSocket hijacking in R6 without a list to keep in step with every host and port (§7.2). **Decision D5.** |
| A5 | The first Phase 2 PR picks the test mechanism for P2-2 (§9.5) | `@cloudflare/vitest-pool-workers` 0.22.0 | It was tried against this repo and works (§12, checks 1–2). **Decision D4.** |

## 1. Scope

**Phase 2 lands:**

- a router with per-route access levels, and central enforcement of
  `status = 'active'` (P2-1);
- the `Origin` check on every non-GET `/api/*` request and every WebSocket
  upgrade;
- Google sign-in by redirect (OpenID Connect, authorization code + PKCE,
  scope `openid`), sessions, logout, and `GET /api/me`;
- a local-only fake identity provider, so tests and local development never
  call Google;
- the WebSocket identity handoff: the Worker tells the room which account a
  socket belongs to, and the room keeps at most one attributed seat per
  account;
- the sign-in link and a small account strip on the home screen;
- tests through the real Workers runtime and local D1 (P2-2).

**Phase 2 does not land:** usernames, profiles, the lobby badge, server-set
seat names (Phase 3), saved gnomes (Phase 4), stats (Phase 5), friends
(Phase 6), presence (Phase 7), "sign out everywhere", export or deletion
(Phase 8).

### 1.1 Migrations: none

**Phase 2 adds no migration.** Everything it stores fits the three tables
`0001_identity.sql` already created:

- the sign-in transaction lives in an encrypted cookie, not a table
  (decision D3);
- rate limits are Cloudflare bindings;
- room attribution lives in the room's own Durable Object storage, never in
  D1.

`LATEST_MIGRATION` stays `0001_identity.sql`, so `/api/health` keeps
answering 200 across the Phase 2 deploys.

**`0001_identity.sql` is production history.** It is never edited again; a
unit test already pins its SHA-256. If review finds that Phase 2 needs a
schema change after all, it goes in a new file, `0002_<name>.sql`. Numbers
follow the order migrations are applied, so the Phase 1 spec's draft
"`0002_profiles.sql`" would then take the next free number. Only the draft's
file name changes, not its contents.

## 2. Decisions for review

Each has a recommendation. Nothing in the PR list assumes a different answer
without saying so.

**D1. No lobby badge or server-set name until Phase 3.** *(Recommended.)*
Phase 2 builds and tests the whole handoff (§8), but `SeatInfo` does not
change, so nothing about accounts is visible at the table. Phase 3 then adds
`SeatInfo.account` and the server-set username together.

- *Alternative:* bring the username picker, and its migration, forward into
  Phase 2. That doubles the phase and puts the username rules' point of no
  return before the first sign-in has ever run in production.

**D2. Production launches dark.** *(Recommended.)* An `ACCOUNTS_ENABLED`
variable is `"true"` for local runs and staging, and `"false"` for
production until Phase 3. While it is off:

- the `/api/auth/*` routes and `/api/me` answer 404;
- the client build omits the sign-in link;
- everything else in Phase 2 (router, `Origin` checks, stripping of the
  internal identity header) still ships to production, since it hardens what
  is there.

Turning it on in production also needs the privacy policy, the published
OAuth consent screen, and the R12 copy changes ("no accounts, no cookies").

- *Alternative:* launch sign-in in production in Phase 2. Players could then
  sign in, get nothing for it, and create account rows before a privacy
  policy exists.

**D3. The sign-in transaction lives in an encrypted cookie.** *(Recommended.)*
The transaction is state, nonce, PKCE verifier, return path and prior session
hash. It is sealed with `jose`'s `EncryptJWT` (`dir` + `A256GCM`) under
`OAUTH_COOKIE_KEY`: authenticated encryption, not hand-rolled crypto. This
keeps Phase 2 migration-free. It also means an unauthenticated caller
hitting `/start` costs no database write.

- *Alternative:* an `oauth_transactions` table. That needs a migration, a
  write per `/start` from anyone, and a purge job.
- *Accepted cost:* two sign-ins started in two tabs at once share one
  transaction cookie. The first to finish wins; the other lands on
  "sign-in expired, try again".

**D4. P2-2's mechanism is `@cloudflare/vitest-pool-workers`.**
*(Recommended; checked, §12.)* Version 0.22.0 runs as a second vitest project
over this repo's `wrangler.jsonc`, inside the real Workers runtime, with real
local D1. Its peer range is vitest `^4.1.0`; the repo has 4.1.10.

- *Cost:* it depends on its own wrangler (4.124.0) and a miniflare alpha
  (`5.20260815.0-alpha`), so the dev tree holds two wranglers. It is a dev
  dependency only, pinned exactly, and reviewed with `npm audit` in PR 2-A.
- *Alternative:* Playwright API tests against `vite preview`. They are
  slower, cannot swap bindings per test, and would still need the pool for
  the room handoff's unit-level cases.

**D5. The `Origin` rule is "same as the request's own origin".** *(Recommended.)*
§7.2 has the full rule. It needs no list per host or port, and it matches
what the check defends against: a page on another origin (or a sibling
subdomain) opening a socket or sending a POST that carries the victim's
cookie.

- *Alternative:* the `ALLOWED_ORIGINS` list from ACCOUNTS.md §15. It has the
  same effect but is one more value to keep correct per environment.

**D6. The session cookie persists for its 90-day absolute lifetime.**
*(Recommended.)* `Max-Age` is set to the absolute limit, so a session
survives a browser restart. The 30-day sliding limit is enforced in D1.

- *Alternative:* a browser-session cookie. It ends when the browser quits,
  which makes decision 12's 30-day sliding lifetime meaningless in practice.

## 3. Configuration and secrets

| Name | Kind | Production | Staging | Local (`.dev.vars`) |
|---|---|---|---|---|
| `ACCOUNTS_ENABLED` | var | `"false"` (D2) | `"true"` | `"true"` |
| `PUBLIC_ORIGIN` | var | the production origin | the staging origin | `http://localhost:4173` |
| `GOOGLE_CLIENT_ID` | var (public) | production OAuth client | staging OAuth client | optional: a localhost client |
| `GOOGLE_CLIENT_SECRET` | secret | `wrangler secret put` | `… --env staging` | optional |
| `OAUTH_COOKIE_KEY` | secret: 32 random bytes, base64url | `wrangler secret put` | `… --env staging` | any 32-byte value |
| `FAKE_IDP` | local only | **never set** | **never set** | `"true"` for e2e and offline dev |

- **`PUBLIC_ORIGIN`** is used only to build the `redirect_uri`, which Google
  requires to match exactly. It is never taken from the request.
- **Missing configuration fails closed, per route.** If `ACCOUNTS_ENABLED` is
  on but a Google value or the cookie key is missing, the auth routes answer
  503 ("sign-in is unavailable"). Guest play and rooms are unaffected. The
  Worker never refuses to boot over it.
- **Getting local values into e2e.** CI has no `.dev.vars`. PR 2-A picks and
  verifies how the Playwright `webServer` supplies `FAKE_IDP` and a test
  cookie key. Candidates:
  - wrangler's `CLOUDFLARE_INCLUDE_PROCESS_ENV`, which must be confirmed to
    reach `vite preview`;
  - a git-ignored `.dev.vars` that the `webServer` command writes when none
    exists.

  Either way, nothing is ever passed with `--env` (Phase 1 rule).

## 4. Routes

Every `/api/*` route is declared once, in `src/worker/router.ts`, with a
method, a path, an access level and an optional rate-limit binding. The table
below is the whole Phase 2 surface. Existing routes keep their behaviour
exactly; they only move into the table.

| Method | Path | Access | Limit | Notes |
|---|---|---|---|---|
| POST | `/api/rooms` | public | `ROOM_CREATE_LIMIT` | unchanged; now `Origin`-checked |
| GET | `/api/rooms/:code` | public | `ROOM_JOIN_LIMIT` | unchanged; the internal identity header is stripped |
| GET | `/api/rooms/:code/ws` | public, identity optional | `ROOM_JOIN_LIMIT` | `Origin`-checked; attributes an **active** account only (§8) |
| GET | `/api/health` | public | `HEALTH_LIMIT` | unchanged |
| GET | `/api/auth/google/start` | public | `AUTH_LIMIT` | 404 while `ACCOUNTS_ENABLED` is off |
| GET | `/api/auth/google/callback` | public | `AUTH_LIMIT` | 404 while off |
| POST | `/api/auth/logout` | self-exit | `AUTH_LIMIT` | 404 while off |
| GET | `/api/me` | self-exit | `ME_LIMIT` | 404 while off |
| GET | `/api/auth/fake/authorize` | public | `AUTH_LIMIT` | 404 unless the fake IdP is enabled (§10) |

Access levels (ACCOUNTS.md §9.5):

- **public:** any caller. Routes marked "identity optional" still resolve a
  session when a cookie is present, but never refuse over it.
- **user:** an active account only. A guest gets 401 `SIGNED_OUT`; a
  suspended or deleting account gets 403 `ACCOUNT_UNAVAILABLE`. **Phase 2
  has no `user` routes.** The level exists and is tested (§11) so that
  Phase 3's routes are covered the day they are added.
- **self-exit:** an active account, or a suspended or deleting one. A guest
  gets 401. The allowlist is exactly `POST /api/auth/logout` and
  `GET /api/me`, and a test pins that.

New rate-limit bindings, per IP (`CF-Connecting-IP`, as today), each with its
own namespace id per environment:

- `AUTH_LIMIT`: 20 a minute. A sign-in is two requests, so this allows ten a
  minute from one address.
- `ME_LIMIT`: 60 a minute. `/api/me` reads D1 whenever it is called.

## 5. The sign-in flow

### 5.1 `GET /api/auth/google/start?return=<path>`

1. **The return path.** `safeReturnPath(raw)` accepts a string of at most 512
   characters that:
   - starts with `/`;
   - does not start with `//` or `/\`;
   - still resolves to `PUBLIC_ORIGIN` when parsed against it.

   It keeps the path and query, drops any fragment and any existing `signin`
   parameter, and turns anything else into `/`. This is the open-redirect
   defence.
2. **The browser's current session (A1).** A same-site navigation from the
   game carries the `Strict` session cookie. If there is one, its SHA-256 is
   recorded, whether or not the session is still valid.
3. **Fresh randomness.** Mint a 32-byte `state`, a 32-byte `nonce` and a
   PKCE verifier (43 characters of base64url). The challenge is
   `BASE64URL(SHA-256(verifier))`.
4. **The transaction cookie (D3).** Seal
   `{ state, nonce, verifier, returnPath, priorSessionHash, provider, exp: now + 10 min }`
   into `__Host-gw_oauth=<JWE>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`.
   It has to be `Lax`, because the callback arrives as a cross-site top-level
   GET.
5. **Redirect.** `302` to `https://accounts.google.com/o/oauth2/v2/auth` with:
   - `response_type=code`, `client_id`, and
     `redirect_uri=${PUBLIC_ORIGIN}/api/auth/google/callback`;
   - `scope=openid`, and nothing else (decision 1);
   - `state`, `nonce`, `code_challenge`, and `code_challenge_method=S256`;
   - `prompt=select_account`, so a shared computer can pick an account.

   There is no `access_type=offline`: no refresh token is requested, and
   nothing Google returns besides the ID token is kept.

Google's three endpoints (authorization, token, JWKS) are constants in
`src/worker/auth/google.ts`, pinned by a test. The discovery document is not
fetched at runtime, which is one less network dependency on the sign-in
path.

### 5.2 `GET /api/auth/google/callback?code&state` (or `?error`)

The transaction cookie is cleared on **every** outcome, success or failure,
so a transaction is single-use. Each step either continues or ends with a
`302` to `<returnPath>?signin=<outcome>`, or to `/?signin=<outcome>` when
there is no readable transaction.

1. **Google reported an error**, for example `access_denied` when the person
   cancels. The outcome is `cancelled`.
2. **Open the transaction cookie.** It must be present, decrypt and
   authenticate under `OAUTH_COOKIE_KEY`, and not be past its `exp`. Its
   `state` must equal the query's `state`. Otherwise the outcome is
   `expired`. This is the login-CSRF defence.
3. **Exchange the code.** `POST https://oauth2.googleapis.com/token`
   (form-encoded) with `code`, `client_id`, `client_secret`, `redirect_uri`,
   `grant_type=authorization_code` and `code_verifier`, under a 10-second
   timeout. Any non-200 response, timeout, or missing `id_token` gives
   `failed`. The response body is never logged. Everything else in the
   response (the access token included) is discarded unread.
4. **Verify the ID token** with `jose` (decision 14):
   - `jwtVerify(idToken, googleJwks, { algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: GOOGLE_CLIENT_ID, clockTolerance: 60 })`.
     This checks the signature against Google's keys, plus `iss`, `aud`,
     `exp` and `nbf`.
   - `iat` must be present.
   - `nonce` must equal the transaction's nonce.
   - If `azp` is present, it must equal `GOOGLE_CLIENT_ID`.
   - `sub` must be a string of 1 to 255 characters (the schema checks this
     too).

   Any failure gives `failed`. The only claim read is `sub`.

   `googleJwks` is `createRemoteJWKSet(new URL(JWKS_URL))`, held at module
   scope so each isolate caches Google's keys. `jose` refetches when a token
   names an unknown `kid`, which covers key rotation.
5. **Upsert the account.** `upsertGoogleUser(db, sub, now)`, the Phase 1
   batch, unchanged.
6. **Refuse non-active accounts.** If the status is not `active`, no session
   is created and the outcome is `unavailable` (P2-1: "sign-in applies it
   too").
7. **Rotate the session.** Mint 32 random bytes as the new session token
   (base64url, 43 characters). Then run `rotateSession(db, userId, newHash, priorSessionHash, now)`
   (§6.3): one batch that deletes the prior session, if any, and creates the
   new one.
8. **Respond.** `Set-Cookie: __Host-gw_session=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=7776000`
   (90 days, D6). The outcome is `ok`.

Every response from these routes carries `Cache-Control: no-store`. The
callback URL contains the authorization code; the final redirect drops it
from the address bar, and the site-wide `Referrer-Policy: no-referrer`
already keeps it out of any referrer.

### 5.3 Outcomes

| `signin=` | Meaning | What the player sees |
|---|---|---|
| `ok` | Signed in | The account strip updates |
| `cancelled` | They backed out at Google | Nothing alarming ("Sign-in cancelled") |
| `expired` | No or stale transaction, or `state` mismatch | "That sign-in expired. Try again." |
| `failed` | Exchange or verification failed | "Sign-in didn't work. Try again." |
| `unavailable` | The account is suspended or being deleted | "This account is unavailable." |

These five values are the whole vocabulary. The client ignores any other
value. None of them says why verification failed.

**Logging.** Auth code logs one outcome word per attempt, and nothing else.
Cookies, codes, tokens, `sub` and user ids are never logged (Phase 1 §4,
Worker logs).

## 6. Sessions

### 6.1 The cookie

`__Host-gw_session`: 43 characters of base64url, carrying 256 random bits.
D1 stores only `hex(SHA-256(token))` in `sessions.id_hash`, which the Phase 1
schema requires to be 64 lowercase hex characters. The `__Host-` prefix
forbids a `Domain` attribute, so a sibling subdomain can neither read nor
plant the cookie. The cookie is never visible to page script, and never in
Web Storage (R7).

### 6.2 `authenticate(request, env, ctx)`

This lives in `src/worker/auth/session.ts`, which is the **only** module
that reads the session cookie; a source-scan test enforces that. It never
throws on guests.

| Cookie | Result | D1 |
|---|---|---|
| absent | `{ kind: 'guest' }` | **no read**: a guest costs nothing |
| malformed (not 43 base64url characters) | guest | no read |
| unknown or expired | guest; the response also clears the cookie | one read |
| valid, `active` | `{ kind: 'user', user: ActiveUser }`; `touchSession` runs in `ctx.waitUntil` (at most one write a day) | one read |
| valid, `suspended` or `deleting` | `{ kind: 'unavailable', status }` | one read |

`ActiveUser` is a branded type that only `authenticate` can construct, and
only for `active` (ACCOUNTS.md §9.5). A `user`-level handler receives one, so
it cannot be written against a non-active account.

### 6.3 Repository addition (code, not schema)

Added to `src/worker/db/sessions.ts`:

```ts
// One batch: delete the browser's previous session, if any, then create the
// new one. The prior session is deleted by hash alone, whoever it belonged
// to. The browser proved it held that cookie at /start, and it is about to be
// overwritten either way.
rotateSession(db, userId, newHash, priorHash: string | null, now): Promise<void>
```

The existing `createSession`, `resolveSession`, `touchSession`,
`revokeSession` and `purgeExpiredSessions` are used unchanged.

### 6.4 Logout: `POST /api/auth/logout`

The route is self-exit and `Origin`-checked, and takes no body. It revokes
the row (`revokeSession`) and answers `204` with the cookie expired. Seats
held by seat tokens are untouched, because the token is the seat
(ACCOUNTS.md §9.4). A room attribution made during the lobby lasts until
that socket next says hello (§8.2).

### 6.5 `GET /api/me`

| Caller | Status | Body |
|---|---|---|
| guest | 401 | `{ "error": "SIGNED_OUT" }` |
| active | 200 | `{ "status": "active" }` |
| suspended or deleting | 200 | `{ "status": "suspended" }` or `{ "status": "deleting" }` |

The body is built by an explicit DTO mapper in `src/net/apiTypes.ts`, and a
snapshot test pins its key set. **The user id is never sent**: the `users`
row is private (Phase 1 §3). Phase 3 extends this DTO with `needsUsername`
and `username`.

### 6.6 Purging expired sessions

A daily Cron Trigger (`scheduled` handler, `17 3 * * *` UTC, in both
environments) runs `purgeExpiredSessions`. Expired sessions already resolve
as guests; the purge only keeps the table small.

## 7. Router and request rules

### 7.1 Order of checks, for every `/api/*` request

1. Match the route table. Unknown paths answer 404 JSON, as today.
2. The `Origin` check (§7.2), where the route needs one.
3. The route's rate limit, if it declares one.
4. `authenticate`, only for routes that are not public, or that are marked
   identity optional.
5. The access level (§4). A refusal here happens before any handler runs.
6. Body rules. Phase 2 has no route that takes a body. The machinery (JSON
   only, a size cap, schema validation before the handler) lands in PR 2-B
   with its tests, ready for Phase 3.
7. The handler.

### 7.2 The `Origin` rule (D5)

`requestOrigin` is `new URL(request.url).origin`: the origin the browser
actually connected to.

- **Non-GET/HEAD `/api/*` requests:** `Origin` must be present and equal
  `requestOrigin`, or the answer is `403 { "error": "BAD_ORIGIN" }`. Modern
  browsers send `Origin` on every same-origin POST, including the game's own
  `fetch('/api/rooms', { method: 'POST' })`.
- **WebSocket upgrades:**
  - if `Origin` is present and not equal to `requestOrigin`, the answer is
    403;
  - if it is absent (a non-browser client), the upgrade proceeds but is
    **never attributed**. A client that sends no `Origin` is not a browser
    being ridden, and it carries only its own cookie, so it is simply
    treated as a guest.
- **GET routes** are not `Origin`-checked. They change nothing, and a
  cross-origin page cannot read their responses: no CORS headers are ever
  sent.

## 8. The WebSocket identity handoff

### 8.1 Worker → Durable Object

Every request the Worker forwards to a room first **deletes** any
client-supplied `x-gw-account` header, on the snapshot GET and the upgrade
alike. Then, only for an upgrade whose `Origin` passed and whose
`authenticate` result is an active user, it sets
`x-gw-account: <userId>`. The Durable Object is reachable only through the
Worker's stub, so the header can be trusted there and nowhere else.

In `room-do.ts`:

- `fetch` reads the header at accept time and stores it in the socket
  attachment:
  `{ connId, token, spectate?, account?: { userId } }`.
  It survives hibernation exactly as the seat token does.
- `webSocketMessage` passes it as the trusted third argument:
  `room.hello(conn, parsed, at.account)`.
- `reattachSockets` replays it the same way.
- **`ClientMessage` never gains a user id.** `parseClientMessage` builds
  every message field by field (Phase 0.5, extended to actions in PR #60), so
  a `userId` field sent by a client is simply dropped.

### 8.2 In the room (`src/net/room.ts`)

`hello(conn, message, account?: { userId: string })`.
`PersistedRoom` gains `accounts?: Record<token, userId>`. It is optional, so
rooms stored before this change load unchanged.

1. **Attribution comes only from the third argument.**
2. **One attributed token per account per room.** If another token in this
   room already holds the `userId`, this token plays unattributed, as a guest
   (decision 7).
3. **Attribution can change only in the lobby.** In the lobby:
   - a hello with an account attributes the token;
   - a hello without one clears the token's attribution (the player signed
     out);
   - a hello with a different account re-attributes it.

   From `start()` on, `accounts` is frozen. That is ACCOUNTS.md §10 rule 2,
   so Phase 5 only has to snapshot it.
4. **Board views** (`spectate: true`) are never attributed. A TV is not a
   player.
5. **`accounts` never leaves the room.** It is not in `RoomSnapshot`,
   `SeatInfo`, `GameConfig`, `MatchRecord` or any `ServerMessage` (R5, R8).
   A test captures every frame the room sends through a full game and
   asserts that no user id appears in any of them.
6. **`close()` wipes `accounts` together with `tokens`.**

Under D1 nothing in the room reads `accounts` yet. Phase 3 reads it to set
the username and the badge; Phase 5 reads it to attribute stats.

**Accepted limitation:** a socket keeps the attribution it connected with.
If an account is suspended mid-game, its open socket stays attributed until
it next reconnects, when it becomes a guest. Phase 8's "sign out everywhere"
closes this gap for revocation.

`PROTOCOL_VERSION` does not change: nothing on the wire changes in Phase 2.

## 9. Client

Phase 2's client changes are all behind `ACCOUNTS_UI`, a build-time flag. It
is on for local runs, e2e and staging builds, and off for production (D2).

- **`src/ui/account/apiClient.ts` and `useAccount.ts`**, plus a context
  provider.
  - On load, the app calls `GET /api/me` only if
    `localStorage['ww:signed-in']` is set, or the URL carries `signin=`.
  - A 200 sets the hint; a 401 clears it.
  - The `signin` parameter is removed with `history.replaceState`, and its
    outcome is shown once, as a toast.
  - A guest who has never signed in makes **zero** requests, as today
    (ACCOUNTS.md §10 rule 6).
- **The home screen's account strip:**
  - signed out: "Sign in with Google", a plain
    `<a href="/api/auth/google/start?return=…">` with a self-hosted "G" mark
    (the CSP is unchanged);
  - signed in: "Signed in with Google · Sign out";
  - unavailable: "This account is unavailable · Sign out".
- **Signing in from a lobby.** The return path is the current `?room=CODE`.
  The seat token is in `sessionStorage`, which survives a same-tab
  navigation, so the player comes back to the same seat.
- **The online screen does not change in Phase 2** (D1). The name field
  stays.
- **No change** to `public/_headers`, the build-time CSP, or COOP. A
  top-level navigation to Google is not governed by `connect-src`, and
  `form-action 'none'` is untouched, because sign-in is a link, not a form.

## 10. The fake identity provider

It stands in for Google in tests and in offline local development. It
replaces **only** Google's three endpoints and Google's keys. `state`,
`nonce`, PKCE, the transaction cookie, the upsert, sessions and cookies all
run the real code.

- **Enabled only when both** `FAKE_IDP === "true"` **and** the request's
  hostname is loopback (`localhost`, `127.0.0.1` or `[::1]`). Otherwise
  `/api/auth/fake/*` answers 404, and `/start` uses Google.
- **Fails closed on misconfiguration.** If `FAKE_IDP` is set but
  `PUBLIC_ORIGIN` is not loopback, the auth routes answer 503.
- **A test pins that `FAKE_IDP` is absent from every environment in
  `wrangler.jsonc`**, and that the gate refuses a non-loopback host.

How it works:

- **Authorization.** `/start` redirects to the fake authorization page,
  **served on the other loopback host**: `127.0.0.1` when the app runs on
  `localhost`. That makes it a different *site*. The page has one "Continue
  as test gnome" link per test subject. **The test clicks it**, so the
  callback is a navigation started by another site, which is exactly the
  cookie behaviour Google's real flow produces (A1, A2).
  - A fake provider built from plain redirects would hide that behaviour.
    Check 5 in §12 shows it: with redirects alone, the callback *did*
    receive the `Strict` cookie.
- **Token exchange and keys.** Handled in-process: no network. The fake
  signs its ID tokens with an RS256 key generated once per isolate, and
  verification uses that key's JWKS. Test subjects look like `fake-<n>`.
  The page can also produce the bad cases (wrong `aud`, wrong `iss`, wrong
  `nonce`, expired, bad signature), for the rejection tests in §11.

## 11. Testing

Three layers:

- **node:** the existing vitest run. It stays the fast inner loop.
- **workers:** the new pool (D4), run as `npm run test:workers` and as a CI
  step, inside the real runtime with real local D1.
- **e2e:** Playwright.

Every row of ACCOUNTS.md §18 "Phase 2" appears below.

| Requirement | Layer | PR |
|---|---|---|
| Phase 1's repository suites also pass against real local D1: the fidelity re-check P2-2 asks for | workers | 2-A |
| **P2-1:** every route has a declared access level; the self-exit list is exactly logout + `/api/me`; a synthetic `user` route answers 401 to a guest and 403 to suspended and deleting accounts (a walk over the real table covers Phase 3's routes automatically) | node + workers | 2-B |
| A foreign `Origin` is refused on POST and on the WS upgrade; a missing `Origin` on an upgrade is allowed, unattributed | workers | 2-B |
| A client-supplied `x-gw-account` header is removed on both forwarded paths | workers | 2-B |
| No module other than `session.ts` reads the session cookie (source scan) | node | 2-C |
| An expired or unknown session is a guest, and its cookie is cleared; a guest request with no cookie reads no D1 | workers | 2-C |
| Logout revokes: the same cookie is a guest afterwards | workers | 2-C |
| `/api/me` DTO key sets (snapshot) | node | 2-C |
| The purge removes only expired rows when the cron fires | workers | 2-C |
| `ACCOUNTS_ENABLED` off: every auth route and `/api/me` answers 404 | workers | 2-C |
| Invalid, expired, wrong-`aud`, wrong-`iss`, wrong-`nonce`, bad-signature and wrong-`azp` ID tokens are rejected | workers | 2-D |
| A mismatched `state`, a missing transaction cookie, and a tampered one each give `expired` | workers | 2-D |
| A non-relative `return` becomes `/`, including `//evil`, `/\evil`, `https://evil`, and an over-long value | node | 2-D |
| Concurrent callbacks for one `sub` make one user | workers | 2-D (Phase 1's 252-interleaving proof stands; this runs two real batches on D1) |
| Session rotation: the prior session recorded at `/start` stops working after sign-in | workers | 2-D |
| A suspended or deleting account completing sign-in gets no session | workers | 2-D |
| The fake IdP refuses non-loopback hosts, and `FAKE_IDP` is absent from `wrangler.jsonc` | node + workers | 2-D |
| Room: a user id can come only from the transport | node | 2-E |
| Room: two tabs of one account give one attributed token | node | 2-E |
| Room: attribution survives hibernation (attachment replay) | node | 2-E |
| Room: attribution is frozen from `start()` | node | 2-E |
| Room: board views are never attributed | node | 2-E |
| Room: no user id appears in any frame of a full game | node | 2-E |
| A non-active account's socket is unattributed | workers | 2-E |
| Sign in and out through the UI with the fake IdP; the page learns it through `/api/me` (A2) | e2e | 2-F |
| Signing in from a lobby returns to the same seat | e2e | 2-F |
| **Every existing online e2e passes unchanged as a guest** | e2e | every PR |
| A guest who never signed in makes no `/api/me` request during local play | e2e | 2-F |
| `jose` is not in the client bundle (post-build check) | CI | 2-A |

**"An account seat's name cannot be overridden by `hello`"** (ACCOUNTS.md §18
row 2) moves to Phase 3 with server-set names, under D1.

Google itself is never called from any test.

## 12. Checks done while writing this spec (2026-09-29)

All of these ran in a throwaway git worktree, deleted afterwards. Nothing
from them is in the repo.

| # | What | Result |
|---|---|---|
| 1 | `@cloudflare/vitest-pool-workers@0.22.0` under vitest 4.1.10, pointed at the repo's `wrangler.jsonc` and `migrations/`, calling `src/worker/index.ts` directly | Ran inside the Workers runtime. `GET /api/health` answered **503**, then **200** after `applyD1Migrations`. An `auth_identities` insert for a missing user failed with **`FOREIGN KEY constraint failed`**: real D1, with foreign keys enforced. |
| 2 | `jose@6.2.12` in the same runtime: sign an RS256 ID token, verify it through a local JWKS | Verified, with `sub` read back. The wrong `aud` was **rejected**; the same `kid` signed by a different key was **rejected**. `jose` 6.2.12 has zero dependencies (MIT). |
| 3 | Chromium through Playwright, over `http://localhost`: set `__Host-gw_session` (`Strict`) and `__Host-gw_oauth` (`Lax`), both `Secure` | Both were stored and sent back on the next page load and on the page's `fetch`. `__Host-` and `Secure` cookies work on plain-HTTP localhost, so e2e needs no TLS. |
| 4 | Cross-site sign-in shape: the game on `localhost` → `/login` sets an old `Strict` session and the `Lax` transaction cookie → a page on `127.0.0.1` (another site), **where the user clicks** → `/callback` sets the new session → `/landing` | The **callback received only the `Lax` cookie**, not the old session (A1). The **landing document received no session cookie**; the page's `fetch('/api/me')` did send the new one (A2). |
| 5 | The same, but with the other site answering a plain `302` instead of a page | The callback **did** receive the old `Strict` cookie. A fake IdP made of redirects would hide what check 4 found, hence §10. |

Limits of these checks:

- They used this container's Chromium (build 1194). CI's Playwright ships
  its own, newer build, and PR 2-F's e2e re-establishes checks 3 and 4
  there.
- Firefox and Safari were not tried. The design does not depend on either
  outcome of check 4. The prior session is recorded at `/start` whatever
  the callback receives. The page asks `/api/me` whatever its own load
  carried.

## 13. Change list (small PRs)

Each PR leaves `main` shippable. All existing unit and e2e tests stay green.
No PR adds a migration.

**PR 2-A — Test harness and dependencies (P2-2).**
- `@cloudflare/vitest-pool-workers@0.22.0` (dev, exact pin), a
  `vitest.workers.config.ts`, `npm run test:workers`, and a CI step.
- Phase 1's identity and session suites also run on real local D1.
- `jose@6.2.12` (runtime, exact pin, Worker only), plus the post-build check
  that it is absent from `dist/client`.
- `npm audit` and a dependency review recorded in the PR.
- Decide and verify how e2e gets local-only values (§3).

No behaviour change.

**PR 2-B — Router, `Origin`, access levels.**
- `src/worker/router.ts` and `http.ts`. The existing routes move into the
  table unchanged.
- The `Origin` rule (§7.2).
- The header strip on forwarding to rooms (§8.1).
- The P2-1 machinery and its route-table tests.
- `Auth` types, with `authenticate` stubbed to always answer "guest" until
  2-C.

Safe to deploy to production. For real browsers, nothing changes.

**PR 2-C — Sessions, `/api/me`, logout.**
- `src/worker/auth/session.ts`, `rotateSession`, the `/api/me` DTO, logout,
  and the purge cron.
- The config typing and fail-closed rules (§3), the `ACCOUNTS_ENABLED` gate,
  and the new rate-limit bindings.
- `wrangler.jsonc` vars per environment, and `.dev.vars.example` updated
  (names only).

**PR 2-D — The Google flow and the fake IdP.**
- `src/worker/auth/google.ts` (start, callback, verification) and
  `transaction.ts` (the sealed cookie).
- `src/worker/auth/fakeIdp.ts`.
- Every §11 row marked 2-D.

**PR 2-E — The room handoff.**
- `room-do.ts` (attachment, `hello` with the third argument, replay) and
  `room.ts` (`accounts`, the rules in §8.2).
- No wire change.

**PR 2-F — UI, e2e and docs.**
- The account client, the home strip, toasts, and the `ACCOUNTS_UI` flag.
- The e2e sign-in, sign-out and lobby return tests.
- `DEPLOYMENT.md`: Google Cloud setup, secrets per environment, the
  dark-launch rule, how to turn it on.
- `MULTIPLAYER.md`: the identity handoff.
- The privacy copy (R12) and the online screen's "no accounts" line are
  **not** changed here. They change with the production switch-on (D2).

## 14. Human prerequisites

**Needed before PR 2-D can be tried on staging:**

- A Google Cloud project, with the OAuth consent screen in **Testing**
  status and the testers added as test users. A published consent screen,
  with its privacy policy URL, is needed only for production switch-on.
- A **staging** Web OAuth client, with the authorised redirect URI
  `https://<staging-host>/api/auth/google/callback`. Optionally also
  `http://localhost:8787/api/auth/google/callback`, for real-Google local
  runs.
- The staging origin, so `PUBLIC_ORIGIN` and the client id can be pinned in
  `env.staging` in `wrangler.jsonc`.
- These two commands:

  ```sh
  wrangler secret put GOOGLE_CLIENT_SECRET --env staging
  wrangler secret put OAUTH_COOKIE_KEY --env staging
  ```

  For the cookie key, generate 32 random bytes, base64url-encoded.

**Needed before production switch-on (after Phase 3):**

- a production OAuth client;
- the production secrets;
- the privacy policy;
- the published consent screen;
- `ACCOUNTS_ENABLED` set to `"true"`.

Nothing here needs a remote database command. Phase 2 migrates nothing.

## 15. Exit criteria

- `npm test`, `npm run test:workers`, lint, `tsc -b`, the build and all
  Playwright tests pass in CI. Every pre-existing online e2e passes
  unchanged, as a guest.
- **Staging:**
  - a real Google account signs in and out;
  - `/api/me` answers `{"status":"active"}` while signed in and 401
    afterwards;
  - `/api/health` answers 200.
- **Production:**
  - deployed with `ACCOUNTS_ENABLED="false"`;
  - `/api/auth/google/start` and `/api/me` answer 404;
  - rooms, local play and the board view behave exactly as before;
  - `/api/health` answers 200 with `0001_identity.sql` still the latest
    migration.
- No migration was added, and `0001_identity.sql` is byte-identical to what
  production ran.
- ACCOUNTS.md, this spec, DEPLOYMENT.md and MULTIPLAYER.md describe what was
  built.
