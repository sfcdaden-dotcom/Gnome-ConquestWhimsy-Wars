# Phase 2 — Google sign-in (implementation spec, for review)

**Status: revision 4 (2026-09-29). Revision 2 was approved. PR 2-A (test
harness and dependencies, with `0002_users_id_check.sql`) is done: merged
2026-09-30 as #62 and deployed, with 0002 applied to staging and production
and verified on both. Production `/api/health` answers 200. PR 2-B
(router, `Origin` rule, access levels) is done: merged 2026-10-01 as #64 and
deployed. In production, `/api/health` answers 200 and a real multiplayer
game was played through. Branch previews now get their own bindings (#65;
DEPLOYMENT.md, "Branch previews"). PRs 2-C to 2-F each need their own
approval.** Phase 1 is complete:
`0001_identity.sql` is applied to staging and production, and is now
production history.

**Revision 4 corrects this spec's claim that Phase 2 needs no migration.**
PR 2-A's first run of the repository tests on real D1 found that
`0001_identity.sql`'s `users.id` CHECK cannot be evaluated by D1 at all, so
no `users` row can ever be inserted. Phase 2 therefore needs one corrective
migration, `0002_users_id_check.sql`, which ships in the same PR as the
harness that found it (§1.1, §12 checks 8 and 9).

**Revision 2** answers the first review. Each change is marked where it
lands:

| # | Review point | Resolution |
|---|---|---|
| R1 | Token expiry was checked only if present, and time units were unstated | `exp`, `iat` and the other claims are **required**; `exp` is bounded above; units are stated (§5.2 step 4, §5.5) |
| R2 | "Single-use transaction" was overstated: clearing a cookie stops no copy already in flight | What actually prevents duplicates is stated, a backstop is added that needs no table, and replay is tested (§5.4) |
| R3 | "Frozen at start" and "reconnects as a guest" conflicted | Split into **live authentication** (per connection, Phase 2) and **frozen match attribution** (Phase 5); the room persists nothing about accounts (§8) |
| R4 | A suspension landing between the status check and the session insert still got a session | Session creation is guarded by the current status in the same batch, and the cookie follows that batch's answer (§6.3) |

**Revision 3** records the second review's notes for the later PRs:

| # | Review note | Resolution |
|---|---|---|
| N1 | "Earliest-arrived connection" must stay deterministic when sockets are rebuilt after hibernation | The order is the numeric connection id, which is kept in each socket's attachment. Making it trustworthy needs a fix to an existing bug the check turned up: ids can repeat after an eviction (§8.2 rule 3). Plus a regression test that a wake does not change which connection counts. |
| N2 | Stale socket authentication must be resolved before Phase 3 shows or grants anything through it | Now an explicit entry condition for Phase 3 (§8.3) |
| N3 | The one-hour `exp` ceiling was an unsubstantiated assumption about Google | It is replaced by a 24-hour **sanity bound** that assumes nothing about Google's lifetime and still refuses a milliseconds `exp`. Required claims and timestamp validation are unchanged (§5.2 step 4). |

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
| A3 | Phase 2 exit: "a signed-in player's seat shows the badge"; account seats get server-set names (§10 rule 4) | Phase 2 tracks which connections are signed in, but shows **no badge and no server-set name**. Both ship in Phase 3. | Usernames arrive in Phase 3. In Phase 2 an account seat still has a name the client typed, and a badge next to it would vouch for nothing. **Decision D1.** |
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
  connection is signed in as, and the room counts at most one live connection
  per account;
- the sign-in link and a small account strip on the home screen;
- tests through the real Workers runtime and local D1 (P2-2).

**Phase 2 does not land:** usernames, profiles, the lobby badge, server-set
seat names (Phase 3), saved gnomes (Phase 4), stats (Phase 5), friends
(Phase 6), presence (Phase 7), "sign out everywhere", export or deletion
(Phase 8).

### 1.1 Migrations: one corrective migration, and nothing else (revision 4)

**Revisions 1 to 3 of this spec said Phase 2 adds no migration. That was
wrong.** Phase 2 needs `0002_users_id_check.sql`: a fix to 0001, not a
feature.

- **The defect.** `0001_identity.sql` checks `users.id` with one `GLOB`
  pattern 251 bytes long. D1 refuses any `LIKE` or `GLOB` pattern longer
  than 50 bytes ("LIKE or GLOB pattern too complex"). So on D1 that CHECK
  fails for every row, and **no `users` row can ever be inserted**. That
  includes the sign-in batch, which could never have created an account.
- **Why it was not caught.** Phase 1 tested the UUID validation, including
  "10,000 real `crypto.randomUUID()` values accepted", **on Node's SQLite
  (`node:sqlite`), not on D1.** Node's SQLite accepts the long pattern. The
  Phase 1 check on miniflare's D1 created the tables and inserted into a
  probe table, but never inserted into `users`.
- **How it was found.** PR 2-A ran the identity and session suites on real
  local D1 for the first time: 18 of them failed with the pattern error.
  That is the fidelity check P2-2 exists for.
- **No harm yet.** No route writes `users`, and D1 could not have accepted a
  row if one had. The identity tables are empty in every environment.
- **The fix.** 0001 is production history and is not edited.
  `0002_users_id_check.sql`:
  1. **refuses to run** if `users`, `auth_identities` or `sessions` holds any
     row (`CHECK constraint failed: identity_rows = 0`), before changing
     anything;
  2. rebuilds `users` with 0001's columns and CHECKs exactly, except the id
     CHECK. The new one is built from `length`, `substr`, `replace` and one
     13-byte `GLOB`, and accepts exactly the strings 0001's pattern
     described.
- **Its tests run on real local D1.** They show that under 0001 every real
  id is refused, and that under 0002:
  - 1,000 real ids are accepted and 13 malformed shapes refused;
  - on 1,500 one-edit near misses, D1 agrees with the UUID-v4 regex exactly;
  - the other constraints, the foreign keys and the cascade are unchanged;
  - the guard rolls the whole migration back when a row is present.
- **Deploy order.** `LATEST_MIGRATION` becomes `0002_users_id_check.sql`, so
  `/api/health` answers 503 on any database without it. 0002 is applied to
  staging, then production, **before** the code that expects it is deployed
  (DEPLOYMENT.md, "migrate first"). Applying it first is safe: nothing in the
  deployed code reads or writes `users`. **Done:** applied to staging and
  production and verified on both; production `/api/health` answers 200 on
  the deployed code.
- **Numbering.** The Phase 1 spec's draft migrations each move up one number
  (`0002_profiles.sql` becomes `0003`, and so on), as the numbering rule
  below provides. Their contents do not change.

Everything else Phase 2 stores fits the three tables `0001_identity.sql`
created, as 0002 corrects them:

- the sign-in transaction lives in an encrypted cookie, not a table
  (decision D3);
- rate limits are Cloudflare bindings;
- live authentication lives only in each socket's attachment. Phase 2
  writes nothing about accounts to room storage or to D1 (§8).

**`0001_identity.sql` is production history.** It is never edited again; a
unit test pins its SHA-256, and 0002's too. Every later schema change is a
new file. Numbers follow the order migrations are applied, so a draft takes
the next free number when its phase ships.

**New rule, from this defect: a migration is tested on real D1 before it is
applied anywhere.** `npm run test:workers` runs the migrations and the
repository suites on local D1, and a test on both engines fails if any
`LIKE` or `GLOB` pattern in the resulting schema exceeds 50 bytes.

## 2. Decisions for review

Each has a recommendation. Nothing in the PR list assumes a different answer
without saying so.

**D1. No lobby badge or server-set name until Phase 3.** *(Recommended.)*
Phase 2 builds and tests the live half of the handoff (§8), but `SeatInfo`
does not change, so nothing about accounts is visible at the table. Phase 3 then adds
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
The transaction is state, nonce, PKCE verifier, return path, prior session
hash, and the session token it will issue (§5.4). It is sealed with `jose`'s
`EncryptJWT` (`dir` + `A256GCM`) under `OAUTH_COOKIE_KEY`: authenticated
encryption, not hand-rolled crypto. This keeps the sign-in transaction out of
the database, so an unauthenticated caller hitting `/start` costs no
database write.

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

**D7. Real Google sign-in is off in branch previews (open design item,
recorded 2026-10-01).**

- **The problem.** Google requires the `redirect_uri` to match a registered
  URI exactly. Every branch preview has its own host
  (`<branch>-gnomeconquest-staging.<subdomain>.workers.dev`, plus one per
  deployment), so the set of hosts is unbounded and not known in advance.
  Previews also share one `env.staging.previews` block across all branches,
  so it cannot hold a per-branch `PUBLIC_ORIGIN`.
- **For now:**
  - Branch previews run with `ACCOUNTS_ENABLED="false"` in
    `env.staging.previews.vars`, so the auth routes and `/api/me` answer 404
    there, as in production (D2).
  - Previews get no Google client id and no Google secret.
  - `FAKE_IDP` is never set on any deployed Worker. The fake IdP also refuses
    any non-loopback host (§10).
  - Real sign-in is tested on staging's own host and locally.
- **Not designed yet.** Sign-in on previews would need a deliberate design,
  for example a callback on the staging host that hands the session back to
  the preview. Nothing in Phase 2 depends on it, and none of it is assumed.
- **Effect on 2-C.** 2-C adds its vars to `env.staging.previews.vars` too.
  `src/worker/previewConfig.test.ts` requires previews to declare every
  binding and var staging declares, by name. Where a preview's value must
  differ from staging's (`ACCOUNTS_ENABLED`), 2-C declares the preview value
  explicitly rather than leaving the var out.

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
- **Branch previews** inherit none of these. They get only what
  `env.staging.previews` declares, and run with accounts off (D7).
- **Missing configuration fails closed, per route.** If `ACCOUNTS_ENABLED` is
  on but a Google value or the cookie key is missing, the auth routes answer
  503 ("sign-in is unavailable"). Guest play and rooms are unaffected. The
  Worker never refuses to boot over it.
- **Getting local values into e2e (decided and checked in PR 2-A; §12,
  check 9).** CI has no `.dev.vars`. The Playwright `webServer` sets
  `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, with `FAKE_IDP` and a test cookie
  key, on the `vite preview` command **only**. The wiring lands in 2-C, with
  the first value anything reads.
  - **Never on a build.** With the flag set, `npm run build` writes the whole
    process environment into `dist/gnomeconquest/.dev.vars`: in CI, every
    variable the job has. `src/worker/localConfig.test.ts` fails if a
    script, the Playwright web server or a workflow ever sets the flag on a
    build or deploy.
  - **`.dev.vars` is copied into the build too.** `npm run build` copies a
    developer's `.dev.vars` into `dist/gnomeconquest/.dev.vars`. Both paths
    are git-ignored and `wrangler deploy` does not upload the file, but
    `dist/` must never be published anywhere else.
  - Nothing is ever passed with `--env` (Phase 1 rule).

## 4. Routes

Every `/api/*` route is declared once, in `src/worker/router.ts`, with a
method, a path, an access level and an optional rate-limit binding. The table
below is the whole Phase 2 surface. Existing routes keep their behaviour
exactly; they only move into the table.

| Method | Path | Access | Limit | Notes |
|---|---|---|---|---|
| POST | `/api/rooms` | public | `ROOM_CREATE_LIMIT` | unchanged; now `Origin`-checked |
| GET | `/api/rooms/:code` | public | `ROOM_JOIN_LIMIT` | unchanged; the internal identity header is stripped |
| GET | `/api/rooms/:code/ws` | public, identity optional | `ROOM_JOIN_LIMIT` | `Origin`-checked; authenticates an **active** account only (§8) |
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
3. **Fresh randomness.** Mint a 32-byte `state`, a 32-byte `nonce`, a PKCE
   verifier (43 characters of base64url) and **the session token this
   transaction will issue** (32 bytes, base64url; §5.4). The challenge is
   `BASE64URL(SHA-256(verifier))`.
4. **The transaction cookie (D3).** Seal
   `{ state, nonce, verifier, sessionToken, returnPath, priorSessionHash, provider }`
   with a JWT `exp` of now + 600 seconds, into
   `__Host-gw_oauth=<JWE>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`.
   The session token is never sent anywhere else until step 8 of the
   callback, and only its hash is ever stored.
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

The transaction cookie is cleared on every outcome, success or failure. That
is hygiene, **not** single-use: clearing a cookie does nothing to a copy
already attached to another request in flight. What stops a transaction
producing more than one session is in §5.4. Each step either continues or
ends with a `302` to `<returnPath>?signin=<outcome>`, or to
`/?signin=<outcome>` when there is no readable transaction.

1. **Google reported an error**, for example `access_denied` when the person
   cancels. The outcome is `cancelled`.
2. **Open the transaction cookie.** It must be present, decrypt and
   authenticate under `OAUTH_COOKIE_KEY`, and carry an `exp` (required) that
   has not passed. Its `state` must equal the query's `state`. Otherwise the
   outcome is `expired`. This is the login-CSRF defence.
3. **Exchange the code.** `POST https://oauth2.googleapis.com/token`
   (form-encoded) with `code`, `client_id`, `client_secret`, `redirect_uri`,
   `grant_type=authorization_code` and `code_verifier`, under a 10-second
   timeout. Any non-200 response, timeout, or missing `id_token` gives
   `failed`. The response body is never logged. Everything else in the
   response (the access token included) is discarded unread.
4. **Verify the ID token** with `jose` (decision 14):
   - `jwtVerify(idToken, googleJwks, { algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: GOOGLE_CLIENT_ID, requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'], maxTokenAge: '10m', clockTolerance: 60 })`.
     This checks the signature against Google's keys, and `iss`, `aud`,
     `exp`, `iat` and `nbf`.
   - **The claims are required, not merely checked if present.** Without
     `requiredClaims`, `jose` checks `exp` only when a token has one, and a
     token with no `exp` verifies (§12, check 6). A timestamp that is not a
     number is refused by `jose` itself.
   - **`exp` is bounded above, as a sanity check (revision 3, N3):**
     `exp - iat` must be at most 86,400 seconds (24 hours).
     - This is not a claim about how long Google's ID tokens last. It is set
       far above any lifetime a real token would carry, so that no change on
       Google's side can trip it.
     - Its job is catching unit errors. `jose` alone accepts an `exp`
       written in milliseconds, because it reads as a date thousands of
       years away (§12, check 6). Such an `exp` exceeds `iat` by about 1.7
       trillion seconds, so any sane ceiling refuses it.
     - `maxTokenAge` does the same job for a stale `iat`.
     - PR 2-D records the `exp - iat` of a real staging sign-in in its
       description, as a check on the bound, not as a basis for it.
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
6. **Refuse non-active accounts.** If the status the upsert returned is not
   `active`, no session is created and the outcome is `unavailable` (P2-1:
   "sign-in applies it too"). This is the early answer, not the guarantee:
   the account could be suspended between this step and the next, which is
   why step 7 checks again.
7. **Create the session, guarded.** Run
   `issueSession(db, userId, hash(sessionToken), priorSessionHash, now)`
   (§6.3), using the session token sealed in the transaction. It is one
   batch that deletes the prior session, inserts the new one **only if the
   account is `active` at that moment**, and reads back whether the session
   now exists. If it does not, no cookie is set and the outcome is
   `unavailable`.
8. **Respond.** Only when step 7 confirmed the session:
   `Set-Cookie: __Host-gw_session=<sessionToken>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=7776000`
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

### 5.4 Replay and duplicate callbacks (revision 2, R2)

The case to handle: the same callback, with the same transaction cookie,
arriving twice. That can be a double-click, a browser retry, two tabs
restoring the same page, or someone replaying a captured request. The
requirement is **at most one session per transaction**, whatever the timing.
Two things provide it, and neither needs a table.

1. **The authorization code is single-use at Google.** RFC 6749 §4.1.2
   requires it, and Google's token endpoint answers `invalid_grant` to a
   code that has already been redeemed. PKCE binds the code to the verifier,
   which exists only inside this transaction's encrypted cookie. So a
   replayed callback normally fails at step 3 and creates nothing.
2. **The backstop, which does not depend on Google:** the session token is
   minted at `/start` and sealed in the transaction (§5.1). Every callback
   that carries one transaction therefore computes the **same** `id_hash`.
   `sessions.id_hash` is the primary key, and the insert is
   `ON CONFLICT (id_hash) DO NOTHING`. Two callbacks for one transaction,
   concurrent or one after the other, can produce one row at most. Both set
   the same cookie value.

What this does not claim:

- **The transaction cookie is not revoked by being cleared.** A copy
  captured together with a fresh callback URL is still valid for its 10
  minutes. Replaying it gets past our checks, and then fails at Google
  (point 1).
- **Point 2 has one residual case.** If a session is logged out within the
  same 10 minutes, and the provider also redeemed the code a second time,
  a replay could re-create that one session. Point 1 rules this out for
  Google. The replay would also need the `HttpOnly` transaction cookie,
  which only the browser that started the sign-in holds.

Tests (§11):

- **Replay against a strict provider.** The fake IdP redeems each code once,
  as Google does. A second, identical callback gives `failed`, and there is
  one `sessions` row.
- **Replay against a lenient provider.** The fake IdP's lenient mode accepts
  a code twice, standing in for a provider that does not enforce it. Two
  concurrent callbacks, and then two sequential ones, each leave exactly one
  `sessions` row for the transaction, and every response carries the same
  cookie value.

### 5.5 Time units (revision 2, R1)

- **JWT claims are in seconds.** `exp`, `iat` and `nbf` are NumericDate
  values (RFC 7519 §2), for Google's ID tokens and for our own transaction
  cookie alike. `jose` compares them in seconds. The only place auth code
  touches one directly is the `exp - iat` bound in §5.2, which is in
  seconds.
- **Everything else is in milliseconds.** That covers the database
  (`created_at`, `idle_expires_at` and the rest, per Phase 1 §2), the
  repository functions' `now`, and `Date.now()`.
- **Cookie `Max-Age` is in seconds**, per HTTP. `7776000` is 90 days.
- **One converter crosses the line.** Conversion happens only in
  `src/worker/auth/time.ts` (`toJwtSeconds(ms)`, `fromJwtSeconds(s)`), and a
  source scan fails if `/ 1000` or `* 1000` appears elsewhere under
  `src/worker/auth/`.

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

### 6.3 Repository addition: guarded session creation (code, not schema; revision 2, R4)

Added to `src/worker/db/sessions.ts`:

```ts
// True only if, when the batch finished, the session exists for this user and
// the user is active. The callback sets a cookie only on true.
issueSession(db, userId, newHash, priorHash: string | null, now): Promise<boolean>
```

It is one `db.batch([...])`:

```sql
-- I1: the browser's previous session goes, whoever it belonged to. The
--     browser proved it held that cookie at /start, and it is about to be
--     overwritten either way.
DELETE FROM sessions WHERE ?prior IS NOT NULL AND id_hash = ?prior AND id_hash <> ?new;
-- I2: the new session, only while the account is active. ON CONFLICT is the
--     replay backstop of §5.4: one transaction, one row.
INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
  SELECT ?new, ?user, ?now, ?now, ?now + ?idle, ?now + ?absolute
  WHERE EXISTS (SELECT 1 FROM users WHERE id = ?user AND status = 'active')
  ON CONFLICT (id_hash) DO NOTHING;
-- I3: the answer. Whether I2 inserted or a concurrent twin did, a row
--     is returned only if the session exists for this user AND the user is
--     active now.
SELECT 1 AS ok FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id_hash = ?new AND s.user_id = ?user AND u.status = 'active';
```

**Why this closes the race.** D1 runs each batch as one transaction and
serialises batches against each other (Phase 1 §5.2.1, layer 1). Any change
of status, suspension or deletion, is a batch too. So either:

- the status change lands **before** `issueSession`: I2 inserts nothing,
  I3 returns nothing, and **no cookie is set**; or
- it lands **after**: the session exists, but the status-change batch must
  delete that user's sessions itself.

That second case sets a requirement on later phases, recorded here so they
cannot miss it: **every statement that moves `users.status` away from
`active` runs in the same batch as `DELETE FROM sessions WHERE user_id = ?`.**
It is the same rule as Phase 1 §4 step 1 for deletion. P2-1's central check
still refuses a non-active account's session on every request regardless, so
the rule bounds cleanup, not access.

The existing `createSession` stays for tests and is not used by the callback.
`resolveSession`, `touchSession`, `revokeSession` and `purgeExpiredSessions`
are used unchanged.

**Tests (§11):**

- **Repository, on real D1.** Suspend the user, then call `issueSession`:
  it returns false, and there is no row.
- **Callback, the exact sequence.** The upsert reports `active`, the account
  is suspended, and only then does session creation run. The response has
  outcome `unavailable`, **no `Set-Cookie` for `__Host-gw_session`**, and no
  `sessions` row exists.

  To make that sequence testable, the callback handler takes its repository
  functions as a parameter, as `Room` takes `RoomHost`. The test wraps
  `upsertGoogleUser` so that it suspends the account after returning.
- The same two tests are repeated for `deleting`.

The existing `createSession`, `resolveSession`, `touchSession`,
`revokeSession` and `purgeExpiredSessions` are used unchanged.

### 6.4 Logout: `POST /api/auth/logout`

The route is self-exit and `Origin`-checked, and takes no body. It revokes
the row (`revokeSession`) and answers `204` with the cookie expired. Seats
held by seat tokens are untouched, because the token is the seat
(ACCOUNTS.md §9.4). An already-open room socket keeps the authentication it
connected with until it closes; the next socket is a guest (§8.3).

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
    **always a guest**. A client that sends no `Origin` is not a browser
    being ridden, and it carries only its own cookie, so it is simply
    treated as a guest.
- **GET routes** are not `Origin`-checked. They change nothing, and a
  cross-origin page cannot read their responses: no CORS headers are ever
  sent.

## 8. The WebSocket identity handoff (revised, R3)

Two different things were described as one "attribution" in revision 1. They
have different lifetimes and different jobs, and must never be derived from
each other:

| | **Live authentication** | **Frozen match attribution** |
|---|---|---|
| Answers | Is this connection signed in, right now, as which account? | Which account started the match in this seat? |
| Established | At each WebSocket upgrade, by the Worker, from that request's cookie | Once, at `start()`, from the live authentication of each seat's connection |
| Lives | In that socket's attachment, for that socket's lifetime | In the room record, for the room's lifetime |
| Changed by sign-out, suspension, reconnection | Yes: the next socket re-authenticates, and a revoked account becomes a guest | **Never**: it is history, not permission |
| Used for | Display and permissions (Phase 3 badge and name; Phase 7 invites) | Stats only (Phase 5) |
| Built in | **Phase 2** | **Phase 5** (ACCOUNTS.md §17), not in this phase |

A suspended player who reconnects mid-game is therefore, at the same time,
unauthenticated (their new socket is a guest) and still recorded as having
started the match in their seat. Both are true, and nothing conflicts.

### 8.1 Worker → Durable Object

Every request the Worker forwards to a room first **deletes** any
client-supplied `x-gw-account` header, on the snapshot GET and the upgrade
alike. Then, only for an upgrade whose `Origin` passed and whose
`authenticate` result is an active user, it sets
`x-gw-account: <userId>`. The Durable Object is reachable only through the
Worker's stub, so the header can be trusted there and nowhere else.

In `room-do.ts`:

- `fetch` reads the header **at accept time**, and stores it in that
  socket's attachment: `{ connId, token, spectate?, account?: { userId } }`.
  This is the only place live authentication is ever written.
- `webSocketMessage` passes it as the trusted third argument:
  `room.hello(conn, parsed, at.account)`.
- **Hibernation restores nothing.** After a wake, `reattachSockets` replays
  each surviving socket's own attachment. It is the same connection, with the
  same handshake, so no authentication is renewed, gained or borrowed:
  - a socket that was a guest at its upgrade stays a guest;
  - a socket that closed took its attachment with it;
  - a reconnect is a new socket, which gets a new attachment from its own
    upgrade and its own cookie.
- **`ClientMessage` never gains a user id.** `parseClientMessage` builds
  every message field by field (Phase 0.5, extended to actions in PR #60), so
  a `userId` field sent by a client is simply dropped.

### 8.2 In the room (`src/net/room.ts`): live authentication only

`hello(conn, message, account?: { userId: string })`. The account is kept
on the connection's in-memory `ConnState`, and nowhere else.

1. **It comes only from the third argument.**
2. **It is never persisted.** `PersistedRoom` does not change in Phase 2.
   Nothing about accounts is written to room storage, and nothing in
   storage can ever restore it.
3. **At most one live connection counts per account (decision 7).** For each
   account, the connection that counts is the earliest-arrived open
   connection that holds a seat and is not a board view. Every other
   connection of that account plays as a guest.
   - This is computed from the open connections whenever it is needed, not
     stored.
   - When the counting connection closes, or gives up its seat, the next
     one counts.
   - **"Earliest-arrived" means the lowest numeric connection id** (revision
     3, N1). The id is allocated at the upgrade and kept in the socket's
     attachment. The order is never taken from `Map` insertion order or
     from `ctx.getWebSockets()`. After a wake, both follow whatever order
     re-attachment happened in, and nothing promises that is arrival order.
   - **Prerequisite, an existing bug found by this check:**
     `RoomDurableObject.fetch` allocates the new socket's id *before*
     `roomFor()` has re-attached the surviving sockets and advanced
     `nextConnId`. So after an eviction, a new connection can be given an id
     a hibernated socket still holds. The room keys connections by that id,
     so the newcomer's `hello` replaces the other socket's state:
     - that player stops receiving frames;
     - their messages are checked against the newcomer's seat.

     This is wrong today, accounts or not. The fix is to allocate the id
     after `roomFor()`, and it ships ahead of PR 2-E (it is not part of
     2-A), with a regression test. **Fixed (2026-10-02)** in its own PR,
     after it surfaced in production as each player's lobby showing the
     other's seat as empty until a reconnect.
     `src/worker/room-do.workers.test.ts` reproduces that, and covers the
     id rule.
   - **Regression test:** with two connections of one account, hibernate
     and wake the room (rebuild it from storage and re-attach its sockets
     in a shuffled order). The same connection, and so the same seat, still
     counts. A new connection arriving after the wake gets an id above every
     surviving one.
4. **Board views** (`spectate: true`) never count. A TV is not a player.
5. **It never leaves the room.** It is not in `RoomSnapshot`, `SeatInfo`,
   `GameConfig`, `MatchRecord` or any `ServerMessage` (R5, R8). A test
   captures every frame the room sends through a full game and asserts that
   no user id appears in any of them.

Under D1, nothing reads live authentication yet in Phase 2: there is no
badge, no server-set name and no stats. Phase 3 reads it for the badge and
the username.

### 8.3 How stale live authentication can be

A socket's live authentication reflects its own upgrade. A logout,
suspension or session expiry that happens while the socket is open is seen
when that socket closes and its successor upgrades, not before.

- **In Phase 2 this has no effect.** Live authentication grants and shows
  nothing yet (D1).
- **Entry condition for Phase 3 (revision 3, N2):** Phase 3 must not add
  the badge, server-set names, or anything else shown or allowed through
  live authentication until this staleness is bounded and tested. The same
  holds for every later phase (Phase 7's invites). Two candidate
  mechanisms, to be chosen in that phase:
  - keep the session hash in the attachment, and re-resolve it on wake and
    on a timer;
  - have revocation close that account's room sockets.

### 8.4 Frozen match attribution (Phase 5, specified here only for the boundary)

When Phase 5 builds it:

- at `start()`, `seatAccounts[seat]` is the user id of the connection that
  counts (§8.2) for that seat at that moment, or `null`;
- it is stored in the room record and wiped by `close()`;
- nothing ever updates it: not a sign-out, a suspension, a reconnection, a
  hibernation or a takeover;
- it authorizes nothing, and it never leaves the room except as the Phase 5
  stats write.

Phase 2 builds none of this, and adds no field for it.

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
| A foreign `Origin` is refused on POST and on the WS upgrade; a missing `Origin` on an upgrade is allowed, as a guest | workers | 2-B |
| A client-supplied `x-gw-account` header is removed on both forwarded paths | workers | 2-B |
| No module other than `session.ts` reads the session cookie (source scan) | node | 2-C |
| An expired or unknown session is a guest, and its cookie is cleared; a guest request with no cookie reads no D1 | workers | 2-C |
| Logout revokes: the same cookie is a guest afterwards | workers | 2-C |
| `/api/me` DTO key sets (snapshot) | node | 2-C |
| The purge removes only expired rows when the cron fires | workers | 2-C |
| `ACCOUNTS_ENABLED` off: every auth route and `/api/me` answers 404 | workers | 2-C |
| Invalid, expired, wrong-`aud`, wrong-`iss`, wrong-`nonce`, bad-signature and wrong-`azp` ID tokens are rejected | workers | 2-D |
| **R1:** ID tokens missing `exp`, `iat`, `sub` or `nonce` are rejected; a non-numeric `exp` or `iat` is rejected; an `exp` in milliseconds, an `exp` more than 24 hours after `iat`, and a stale `iat` are rejected; a transaction cookie without `exp` gives `expired` | workers | 2-D |
| **R1:** no `/ 1000` or `* 1000` under `src/worker/auth/` outside `time.ts` (source scan) | node | 2-D |
| **R2:** replaying one callback against the strict fake IdP gives `failed` and one session row | workers | 2-D |
| **R2:** two concurrent, then two sequential, callbacks for one transaction against the lenient fake IdP leave exactly one session row and set one cookie value | workers | 2-D |
| **R4:** `issueSession` for a suspended or deleting user returns false and writes no row | workers | 2-C |
| **R4:** a suspension landing between the upsert and session creation gives `unavailable`, no `Set-Cookie`, and no row (and the same for `deleting`) | workers | 2-D |
| A mismatched `state`, a missing transaction cookie, and a tampered one each give `expired` | workers | 2-D |
| A non-relative `return` becomes `/`, including `//evil`, `/\evil`, `https://evil`, and an over-long value | node | 2-D |
| Concurrent callbacks for one `sub` make one user | workers | 2-D (Phase 1's 252-interleaving proof stands; this runs two real batches on D1) |
| Session rotation: the prior session recorded at `/start` stops working after sign-in | workers | 2-D |
| A suspended or deleting account completing sign-in gets no session | workers | 2-D |
| The fake IdP refuses non-loopback hosts, and `FAKE_IDP` is absent from `wrangler.jsonc` | node + workers | 2-D |
| Room: a user id can come only from the transport | node | 2-E |
| Room: two tabs of one account give one counting connection; when it closes, the other one counts | node | 2-E |
| **N1:** a wake (sockets re-attached in shuffled order) does not change which connection counts; a connection arriving after a wake gets an id above every surviving one | node + workers | the id fix (before 2-E), then 2-E |
| **R3:** hibernation restores only a socket's own handshake: a guest socket stays a guest after a wake, and a closed socket's account is not inherited by anyone | node | 2-E |
| **R3:** a reconnect is a new socket; one reconnecting without a valid session (signed out, suspended, revoked) is a guest, mid-game included | node + workers | 2-E |
| **R3:** nothing about accounts is written to room storage (the persisted room is byte-identical with and without signed-in players) | node | 2-E |
| Room: board views never count | node | 2-E |
| Room: no user id appears in any frame of a full game | node | 2-E |
| A non-active account's socket is a guest | workers | 2-E |
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
| 6 | `jose@6.2.12` `jwtVerify` with and without `requiredClaims`, over tokens with missing and malformed timestamps (revision 2) | Without `requiredClaims`, a token with **no `exp` was accepted**. With `requiredClaims`, a missing `exp` or `iat` was rejected. A string `exp` was rejected ("must be a number"). An `iat` in milliseconds was rejected (it reads as the future), as was an `iat` an hour old under `maxTokenAge: '10m'`. **An `exp` in milliseconds was accepted**, which is why §5.2 bounds `exp - iat`. |
| 7 | Reading `RoomDurableObject.fetch` for the hibernation ordering (revision 3) | The connection id is allocated (`String(this.nextConnId++)`) one line **before** `await this.roomFor(code)`, which is what re-attaches surviving sockets and advances `nextConnId`. After an eviction the ids can therefore repeat (§8.2 rule 3). Found by reading the code; the regression test that proves it is part of the fix. |
| 8 | PR 2-A: the identity and session suites on real local D1 through the new harness (revision 4) | **18 of 20 failed** with `D1_ERROR: LIKE or GLOB pattern too complex`. Measured on local D1, a 50-byte pattern works and 51 bytes fails; 0001's `users.id` pattern is 251 bytes. Every insert into `users` fails, so none can succeed. The only other pattern in the schema (`sessions.id_hash`, 11 bytes) is fine. Fixed by `0002_users_id_check.sql` (§1.1). Afterwards all 36 Workers-runtime tests pass. |
| 9 | PR 2-A: how local-only values reach the Worker under `vite preview`, with a temporary probe route that was not committed (revision 4) | `.dev.vars` at build and preview: **seen**, and copied into `dist/gnomeconquest/.dev.vars`. `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` on preview only: **seen**, and nothing written. The variable alone, without the flag: **not seen**. The flag on the build: **seen**, and the build wrote the process environment into `dist/gnomeconquest/.dev.vars`. Hence §3's rule. |

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
The only migration is `0002_users_id_check.sql`, in PR 2-A (§1.1).

**PR 2-A — Test harness and dependencies (P2-2), with `0002_users_id_check.sql`.
✅ Done: #62, merged and deployed 2026-09-30.** Two items it left as
follow-ups: the `npm audit` findings in dev tooling (the pool pins its own
wrangler, miniflare, undici and sharp, all within flagged ranges), and the
connection-id fix listed before 2-E below.
The harness found 0001's D1 defect (§1.1), and 2-A cannot pass on D1
without the fix, so they ship together, as separate commits.
- `@cloudflare/vitest-pool-workers@0.22.0` (dev, exact pin), a
  `vitest.workers.config.ts`, `npm run test:workers`, and a CI step.
- Phase 1's identity and session suites also run on real local D1.
- `jose@6.2.12` (runtime, exact pin, Worker only), plus the post-build check
  that it is absent from `dist/client`.
- `npm audit` and a dependency review recorded in the PR.
- Decide and verify how e2e gets local-only values (§3).

No behaviour change.

**PR 2-B — Router, `Origin`, access levels. ✅ Done: #64, merged and
deployed 2026-10-01.** Verified by hand on its staging preview (health, and
`Origin`-protected room creation) and in production (health, and a full
multiplayer game).
- `src/worker/router.ts` and `http.ts`. The existing routes move into the
  table unchanged.
- The `Origin` rule (§7.2).
- The header strip on forwarding to rooms (§8.1).
- The P2-1 machinery and its route-table tests.
- `Auth` types, with `authenticate` stubbed to always answer "guest" until
  2-C.

Safe to deploy to production. For real browsers, nothing changes.

As built (the 2-B PR):
- `src/worker/router.ts` (the checks, in §7.1's order), `http.ts`,
  `routes.ts` (the table), `env.ts` (the bindings), and
  `auth/types.ts` and `auth/session.ts` (the stub). `index.ts` only sends
  `/api/*` to the router.
- The `Origin` rule applies to a WebSocket upgrade on **any** route, not
  only `/ws`. The room accepts an upgrade on the snapshot path too, so
  checking `/ws` alone would have left a door open.
- Room paths now answer GET only, as §4's table says. Before, any method
  was forwarded, and the room answered with the snapshot. The game sends
  only GET (and the upgrade, which is a GET).
- Body rules: `application/json` only (415), a cap counted as the bytes
  arrive whatever `Content-Length` says (413), and then strict UTF-8, JSON
  and the route's schema (400). No route uses them yet.
- The Worker does not yet set `x-gw-account`; it only strips it. Setting it
  arrives with the room handoff (2-E), when something reads it.

**PR 2-C — Sessions, `/api/me`, logout.**
- `src/worker/auth/session.ts`, `issueSession` (§6.3), the `/api/me` DTO,
  logout, and the purge cron.
- The config typing and fail-closed rules (§3), the `ACCOUNTS_ENABLED` gate,
  and the new rate-limit bindings.
- `wrangler.jsonc` vars per environment, and `.dev.vars.example` updated
  (names only).

As built (the 2-C PR):
- **`src/worker/auth/session.ts`** holds the cookie: token, hash,
  `Set-Cookie` strings, `authenticate`, and logout's revoke. It is the only
  module that reads the cookie (source scan).
  - With `ACCOUNTS_ENABLED` anything but exactly `"true"`, `authenticate`
    reads neither the cookie nor D1. Production therefore resolves no
    request to an account.
  - `issueSession` is in `src/worker/db/sessions.ts` as specified, tested on
    both engines. Its only caller is 2-D's callback.
- **The router:**
  - **`enabled`:** routes can be switched off per environment, and a
    switched-off route answers the same JSON 404 as an unknown path, before
    any other check. `/api/me` and logout use it.
  - **Stale cookies:** a cookie that names no live session is cleared on
    whatever the answer is, refusals included. A WebSocket 101 is the one
    exception, since it cannot be rebuilt.
  - **Failed lookups:** if the session lookup itself fails (D1 unreachable),
    a public route still runs as a guest, and a route that needs an account
    answers `503 UNAVAILABLE` rather than a misleading 401.
- **`AUTH_LIMIT` and `ME_LIMIT`:** in namespaces 1004/1005 (production),
  2004/2005 (staging) and 3004/3005 (previews).
- **The purge cron** (`17 3 * * *`) runs in production and staging. It runs
  whether or not accounts are on.
- **Vars:** `ACCOUNTS_ENABLED` is `"false"` in production and previews (D2,
  D7) and `"true"` on staging.
- **Deferred to 2-D:** `PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, the secrets and
  their fail-closed 503 move there, because 2-D's routes are the first to
  read them.
- **e2e:** Playwright passes `ACCOUNTS_ENABLED=true` to `vite preview`
  through the process environment (the serving command only, as §3 requires).
  `e2e/accounts.spec.ts` proves it: a guest gets 401 from `/api/me`, not 404.

**PR 2-D — The Google flow and the fake IdP.**
- `src/worker/auth/google.ts` (start, callback, verification),
  `transaction.ts` (the sealed cookie) and `time.ts` (the seconds and
  milliseconds converter, §5.5).
- `src/worker/auth/fakeIdp.ts`.
- Every §11 row marked 2-D.

**Before 2-E — Fix connection-id reuse after eviction (§8.2 rule 3).**
- This is an existing bug, not Phase 2 work.
- Allocate the id after `roomFor()`, with the regression test.
- It needs its own approval, and can land any time before 2-E.
- **Done in its own PR (2026-10-02).** It was found in production: a
  player who joined after the lobby's Durable Object had been evicted got
  the host's connection id. The host then dropped out of the room's view
  until their socket redialled.
  - **The production symptom:** each screen said it was waiting for the
    other's seat.
  - **The tests,** in `src/worker/room-do.workers.test.ts`:
    - after a wake, both screens agree;
    - the host's messages still reach the host;
    - a new id is above every surviving one (N1);
    - ids stay unique when the wake is a message.

  N1's other half (a wake does not change which connection counts for an
  account) needs accounts in the room, so it ships with 2-E.

**PR 2-E — The room handoff (live authentication only).**
- `room-do.ts`: the attachment, `hello` with the third argument, and the
  replay.
- `room.ts`: the account on `ConnState`, and the counting rule in §8.2.
- No wire change, no change to `PersistedRoom`, and no frozen attribution.
  That last one is Phase 5 (§8.4).

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

**One remote database step, reviewed before it runs (✅ done):** apply
`0002_users_id_check.sql` to staging (`npm run db:migrate:staging`), check
it, then to production (`npm run db:migrate:prod`). Do it before the PR that
adds it is deployed, because that code's `/api/health` expects it. Applied
and verified on both. Nothing else in Phase 2 touches a remote database.

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
  - `/api/health` answers 200 with `0002_users_id_check.sql` as the latest
    migration.
- The only migration added is `0002_users_id_check.sql`. `0001_identity.sql`
  is byte-identical to what production ran.
- ACCOUNTS.md, this spec, DEPLOYMENT.md and MULTIPLAYER.md describe what was
  built.
