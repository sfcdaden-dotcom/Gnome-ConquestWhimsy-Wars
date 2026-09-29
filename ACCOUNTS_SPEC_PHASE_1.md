# Phase 1 — Persistence foundation (implementation spec + schema for review)

**Status: implemented 2026-09-29** as four commits titled "Phase 1 (1/4)"
through "(4/4)". `0001_identity.sql` is frozen (§3). It has been applied only
to local and test databases. **Not yet applied to staging or production**:
that needs the human steps in DEPLOYMENT.md first (`wrangler d1 create`,
pinning the ids).

As built, relative to §6:
- The Room DO does not take `env` yet. Nothing needs it before Phase 5, and
  an unused parameter fails this repo's lint settings.
- `LATEST_MIGRATION` in `src/worker/db/schema.ts` is a constant, kept in step
  with the folder by a unit test, not derived at build time.

Verification: 2,984 unit tests, lint, `tsc -b` and the build are clean. All
77 Playwright tests pass from an empty local state, including
`e2e/schema.spec.ts`. A manual negative control confirmed `/api/health`
answers 503 on an unmigrated local database and 200 after
`npm run db:migrate:local`.

This is the document to review before a persistent database becomes part of
the application. It contains:

- the complete proposed D1 schema, split into migrations by the phase that
  needs them;
- every constraint, index and foreign-key action, with the reason for it;
- what deletion does to each table;
- the data-access boundaries;
- the Phase 1 change list.

Decisions it implements are recorded in [ACCOUNTS.md §19](ACCOUNTS.md#19-decisions-approved-2026-09-29).

## 1. Scope: what Phase 1 actually lands

**Phase 1 applies only migration `0001_identity.sql`**: the three tables
Phase 2's sign-in needs (`users`, `auth_identities`, `sessions`), plus the
data-access layer and test harness around them. No HTTP route reads or writes
them until Phase 2.

Migrations `0002`–`0006` are included **for review now** so that the whole
model can be judged at once. Each is applied only when its phase ships. That
phase's PR brings the migration back for a final look, and it may be revised
if the phase in between taught us something. This keeps the point of no
return per table, not all at once.

| Migration | Tables | Applied in |
|---|---|---|
| `0001_identity.sql` | `users`, `auth_identities`, `sessions` | **Phase 1** |
| `0002_profiles.sql` | `profiles`, `username_holds`, `username_rules`, `username_removals` | Phase 3 |
| `0003_customization.sql` | `customizations` | Phase 4 |
| `0004_matches.sql` | `matches`, `match_players` | Phase 5 |
| `0005_social.sql` | `friendships`, `friend_requests`, `blocks` | Phase 6 |
| `0006_privacy.sql` | `privacy_settings` | Phase 7 |

## 2. Conventions (all migrations)

- **IDs:** `TEXT` holding `crypto.randomUUID()`. They are random, so they
  cannot be enumerated or used to infer creation order. The `user_id` is the
  only identity key anywhere, and nothing keys on a username, email or Google
  id.
- **Time:** `INTEGER` epoch milliseconds, matching the rest of the codebase
  (`Date.now()`, the room's deadlines).
- **Booleans:** `INTEGER` with `CHECK (x IN (0, 1))`.
- **Enumerations:** `TEXT` with `CHECK (x IN (...))`. Adding a value later
  requires a table rebuild in SQLite. That friction is intentional for
  identity and result enums. The alternative, unchecked strings, is how
  invalid states get in.
- **Foreign keys:** declared on every reference, with an explicit `ON DELETE`.
  D1 enforces foreign keys. Plain SQLite does not by default, so the test
  adapter runs `PRAGMA foreign_keys = ON`, and a test proves enforcement is
  active in both environments (§6).
- **No PII by default.** No table has a column for email, real name,
  birthdate, location, IP address, user agent or a Google profile field.
- **No interactive transactions** (a D1 constraint). Every multi-row invariant
  is either a constraint, or a conditional statement inside one
  `db.batch([...])`, which D1 runs atomically and serialised against other
  batches.

## 3. The schema

### 0001_identity.sql (Phase 1): FROZEN 2026-09-29

This is the whole file, byte for byte, as committed at
`migrations/0001_identity.sql`. **Frozen 2026-09-29.** Once it has been
applied to production it is never edited again, and every later schema
change is a new migration file. A unit test pins the file's SHA-256 so an
accidental edit fails CI. It has been executed against SQLite with
foreign keys on. Every constraint below was exercised, refusing its bad case
and accepting a valid row (see §5.2.1 for the race run). `STRICT` was
confirmed to work on miniflare's D1 engine (§6, PR 1-D verification).

```sql
-- 0001_identity.sql
--
-- Accounts, Phase 1: the internal account, the Google identity that signs in
-- as it, and sessions. Reviewed in ACCOUNTS_SPEC_PHASE_1.md before being
-- applied anywhere.
--
-- Conventions: ids are crypto.randomUUID() text; times are epoch milliseconds.
-- This migration stores no email, name, IP address, user agent or Google
-- profile field. STRICT tables make SQLite enforce the declared column types
-- (an INTEGER column refuses 'abc') instead of silently storing anything.

-- The internal account. Private: never serialised to a client.
CREATE TABLE users (
  -- Exactly what crypto.randomUUID() produces: a lowercase RFC 9562 version-4
  -- UUID (8-4-4-4-12 hex; version nibble 4; variant nibble 8, 9, a or b). GLOB
  -- matches the whole string, so this pins length, alphabet and layout at once.
  id            TEXT    NOT NULL PRIMARY KEY
                        CHECK (id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'deleting')),
  created_at    INTEGER NOT NULL CHECK (created_at > 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= created_at),
  last_login_at INTEGER          CHECK (last_login_at IS NULL OR last_login_at >= created_at)
) STRICT;

-- Which Google account signs in as which user. The primary key is the
-- guarantee that one Google identity can never belong to two accounts, however
-- many sign-ins race (see the upsert batch in ACCOUNTS_SPEC_PHASE_1.md §5.2).
CREATE TABLE auth_identities (
  provider   TEXT    NOT NULL CHECK (provider IN ('google')),
  subject    TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)   -- one Google identity per account; also indexes user_id for the cascade
) STRICT;

-- Sessions. The cookie carries 256 random bits; only their SHA-256 (hex) is
-- stored, so a copy of this table signs nobody in.
CREATE TABLE sessions (
  id_hash             TEXT    NOT NULL PRIMARY KEY
                              CHECK (length(id_hash) = 64 AND id_hash NOT GLOB '*[^0-9a-f]*'),
  user_id             TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          INTEGER NOT NULL CHECK (created_at > 0),
  last_seen_at        INTEGER NOT NULL CHECK (last_seen_at >= created_at),
  idle_expires_at     INTEGER NOT NULL CHECK (idle_expires_at > last_seen_at),      -- last_seen + 30 days, capped
  absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at > created_at),    -- created + 90 days, never moved
  CHECK (idle_expires_at <= absolute_expires_at)
) STRICT;

CREATE INDEX sessions_by_user   ON sessions(user_id);              -- sign out everywhere; deletion cascade
-- A session is expired exactly when now >= idle_expires_at: the CHECK above
-- caps idle at absolute, so a session past its absolute limit is always past
-- its idle one too. Validity checks and the purge therefore both test
-- idle_expires_at alone, and this index serves the purge.
CREATE INDEX sessions_by_expiry ON sessions(idle_expires_at);
```

Notes for review:

- **`status` is data, not policy.** The meaning of `suspended` and `deleting`
  is enforced centrally in Phase 2 (ACCOUNTS.md §9.5, requirement P2-1).
  There, any authenticated request whose user is not `active` is rejected in
  one place, before any endpoint runs. `deleting` exists so a deletion that
  spans D1 and the UserHub DO can be resumed, and the account is unusable
  while it runs.
- **Why each `CHECK` is there.**
  - `users.id` must match exactly what `crypto.randomUUID()` produces: a
    lowercase RFC 9562 version-4 UUID. The whole-string `GLOB` pins length,
    alphabet, dash positions, the version nibble and the variant nibble.
    10,000 real `crypto.randomUUID()` values were accepted, and ten malformed
    shapes were refused (uppercase, no dashes, version 1, variant `c`, nil,
    braces, a non-hex character, 36 × `x`, a trailing space, too long). The
    repository still generates ids only through `crypto.randomUUID()`; the
    database makes any other shape impossible to store.
  - `updated_at >= created_at` and `last_login_at >= created_at` catch a
    wrong argument order at the database, not in production data.
  - The `id_hash` check guarantees only a lowercase hex SHA-256 can ever be
    stored, never a raw cookie value by mistake.
  - The expiry checks make "idle never outlives absolute" a database fact.
- **Indexes, verified with `EXPLAIN QUERY PLAN`.**
  - The two primary keys, plus `UNIQUE (user_id, provider)`, which also
    serves the `ON DELETE CASCADE` lookup from `users`.
  - `sessions_by_user`: sign-out-everywhere (`DELETE FROM sessions WHERE
    user_id = ?` → covering-index search) and the cascade.
  - `sessions_by_expiry`, on **`idle_expires_at`**, not
    `absolute_expires_at`.
    - A session expires through either limit, but the table's own `CHECK
      (idle_expires_at <= absolute_expires_at)` means any session past its
      absolute limit is also past its idle one. `now >= idle_expires_at` is
      therefore the complete expiry test.
    - The planned purge, `DELETE FROM sessions WHERE idle_expires_at <= ?`,
      plans as `SEARCH … USING COVERING INDEX sessions_by_expiry`.
    - Testing both columns (`… OR absolute_expires_at <= ?`) would plan as
      a full `SCAN`, so the single-column predicate is both sufficient and
      the fast one.
    - Session resolution (`WHERE id_hash = ? AND idle_expires_at > ?`)
      searches by primary key.
- **`updated_at` is maintained by the repository, not a trigger.** Every
  repository statement that changes a `users` row also sets `updated_at`. In
  Phase 1 that is only the sign-in batch; `status` changes arrive in later
  phases under the same rule. Two tests enforce it: a behavioural test
  (sign-in moves `updated_at`), and a source scan that fails if any `UPDATE
  users` statement in `src/worker/db/` omits `updated_at`.
- **Deliberately absent.** No email (decision 1). No IP address or user
  agent, so there is no device list. No `deleted_at` tombstone: deletion
  deletes (§4).
- **Clock skew.** Workers isolates can disagree slightly about the time, so
  the sign-in batch uses `max(…)` when touching `last_login_at` and
  `updated_at`. A slightly-behind isolate therefore cannot trip the ordering
  checks.

### 0002_profiles.sql (Phase 3, reviewed now)

```sql
-- The public profile. Every column here is either public or moderation state.
CREATE TABLE profiles (
  user_id             TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username            TEXT,               -- as chosen, case preserved; NULL only while 'removed'
  username_key        TEXT    UNIQUE,     -- lowercase; the uniqueness key (decision 4)
  username_state      TEXT    NOT NULL DEFAULT 'active'
                              CHECK (username_state IN ('active', 'removed')),
  username_changed_at INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (
    (username_state = 'active'
       AND username IS NOT NULL AND username_key IS NOT NULL
       AND username_key = lower(username)
       AND length(username) BETWEEN 3 AND 20
       AND username NOT GLOB '*[^A-Za-z0-9_]*')
    OR
    (username_state = 'removed'
       AND username IS NULL AND username_key IS NULL)
  )
);
-- The row exists once a username has first been chosen. A signed-in user without a row
-- is "needs a username" and cannot use public/social functions.
--
-- Administrative removal (decision 4) sets username_state = 'removed' and NULLs both
-- name columns in one statement. The user_id, friendships, stats and matches are untouched.
-- The UI shows a generic placeholder ("a gnome awaiting a new name"), and social/public
-- functions are refused until a new name is chosen. SQLite UNIQUE permits many NULLs, so
-- any number of profiles can be 'removed' at once.
--
-- The CHECK re-states the ASCII rule in the database, so no code path can store a non-ASCII
-- or wrong-case key even if application validation regresses. The GLOB is an ASCII
-- character-class test.
--
-- Uniqueness is case-insensitive ASCII only (decision 4, confirmed 2026-09-29). There is
-- deliberately no lookalike/confusable folding in v1: "MushroomKinq42" can coexist with
-- "MushroomKing42". Impersonation is handled by moderation (username_rules 'removed',
-- forced rename), not by the uniqueness key.

-- Previously owned names, reserved to their previous owner for 90 days (decision 4).
CREATE TABLE username_holds (
  username_key      TEXT    PRIMARY KEY,
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hold_until        INTEGER NOT NULL
);
CREATE INDEX username_holds_by_expiry   ON username_holds(hold_until);
-- A claim of a name is refused while a hold exists for its key, owned by someone
-- else, with hold_until > now. The previous owner may reclaim it. Enforced by a conditional
-- statement in the claim batch (§5.2), since a UNIQUE cannot span two tables. Expired holds
-- are ignored by that condition, and purged opportunistically.
-- ON DELETE CASCADE: see §4. Whether a deleted user's names get a quarantine is a policy item.

-- Name rules, as data, so they can change without a code change or redeploy (decision 4).
CREATE TABLE username_rules (
  term       TEXT    NOT NULL,            -- lowercase; compared against username_key
  match_kind TEXT    NOT NULL CHECK (match_kind IN ('exact', 'contains')),
  category   TEXT    NOT NULL CHECK (category IN ('system', 'offensive', 'removed')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (term, match_kind)
);
-- Seeded in the migration with the 'system' terms only: admin, mod, moderator, support,
-- staff, system, official, gnomewars, whimsywars, gnomeconquest, cpu, guest, deleted,
-- host, null, undefined, anonymous, plus the default seat names rose, thistle, marigold,
-- bramble (exact).
-- 'offensive' entries are operational data, loaded by an operator
-- (`wrangler d1 execute … --file`), not committed to the repo.
-- 'removed' entries are written when a moderator removes a name, so it cannot simply be
-- re-registered.
-- The table is read once per validation, is small, and is cached in Worker memory for a
-- short time.

-- Minimal record of administrative removals (decision 4: reviewable later, no platform yet).
CREATE TABLE username_removals (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    REFERENCES users(id) ON DELETE SET NULL,
  username_key TEXT    NOT NULL,
  reason       TEXT    NOT NULL CHECK (reason IN ('offensive', 'impersonation', 'other')),
  removed_at   INTEGER NOT NULL
);
CREATE INDEX username_removals_by_user ON username_removals(user_id);
-- No free-text notes column, deliberately: no moderator prose about players is stored.
-- ON DELETE SET NULL keeps "this name was removed" without the link to the person.
-- Whether to keep these rows at all after deletion is a policy item (§4).
```

### 0003_customization.sql (Phase 4, reviewed now)

```sql
CREATE TABLE customizations (
  user_id        TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  look_json      TEXT    NOT NULL CHECK (json_valid(look_json) AND length(look_json) <= 1024),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  updated_at     INTEGER NOT NULL
);
-- look_json is exactly GnomeLookWire, validated by src/net/lookSchema.ts (Phase 0.5) before
-- it is written. It is stored as JSON, not columns: the character creator's layers come from
-- the asset folders, and a new layer should not need a migration. schema_version gates a
-- future shape change. The 1024-byte CHECK is a database-level backstop; a valid look is
-- under 400 bytes.
-- No colour columns: garment is a seat-relative index (ACCOUNTS.md §8.2), and decision 10
-- keeps profiles on the seat-1 presentation.
```

### 0004_matches.sql (Phase 5, reviewed now)

```sql
CREATE TABLE matches (
  id            TEXT    PRIMARY KEY,     -- minted by the room at start(); the idempotency key
  category      TEXT    NOT NULL CHECK (category IN ('human', 'cpu')),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER NOT NULL,
  player_count  INTEGER NOT NULL CHECK (player_count IN (2, 4)),
  board_size    INTEGER NOT NULL CHECK (board_size >= 5 AND board_size % 2 = 1),
  garden_preset TEXT    NOT NULL,
  end_reason    TEXT    NOT NULL CHECK (end_reason IN ('lastStanding', 'draw')),
  turns         INTEGER NOT NULL CHECK (turns >= 0),
  action_count  INTEGER NOT NULL CHECK (action_count >= 0),
  record_schema INTEGER NOT NULL,
  CHECK (finished_at >= started_at)
);
-- category (decision 6), fixed at start() from the seats:
--   'human'  two or more seats controlled by people (account or guest), with or without CPUs.
--   'cpu'    exactly one seat controlled by a person; the rest are CPUs.
-- No room code, no player names, no seed, no record. Nothing here identifies a person.
-- Only completed ('lastStanding' / 'draw') matches with at least one account seat are written.

CREATE TABLE match_players (
  match_id         TEXT    NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat             INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
  user_id          TEXT    REFERENCES users(id) ON DELETE SET NULL,
  seat_kind        TEXT    NOT NULL CHECK (seat_kind IN ('account', 'guest', 'cpu')),
  cpu_difficulty   TEXT    CHECK (cpu_difficulty IN ('easy', 'normal', 'hard')),
  result           TEXT    NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
  taken_over       INTEGER NOT NULL DEFAULT 0 CHECK (taken_over IN (0, 1)),
  eliminated_by    TEXT    CHECK (eliminated_by IN ('home-captured', 'home-destroyed', 'reinforcements')),
  gnomes_spawned   INTEGER NOT NULL CHECK (gnomes_spawned >= 0),
  gnomes_lost      INTEGER NOT NULL CHECK (gnomes_lost >= 0),
  gardens_planted  INTEGER NOT NULL CHECK (gardens_planted >= 0),
  gardens_upgraded INTEGER NOT NULL CHECK (gardens_upgraded >= 0),
  wishes_spent     INTEGER NOT NULL CHECK (wishes_spent >= 0),
  cards_played     INTEGER NOT NULL CHECK (cards_played >= 0),
  planted_by_type  TEXT    NOT NULL CHECK (json_valid(planted_by_type)),
  PRIMARY KEY (match_id, seat),
  CHECK (user_id IS NULL OR seat_kind = 'account'),          -- only account seats name a user
  CHECK ((seat_kind = 'cpu') = (cpu_difficulty IS NOT NULL)),
  CHECK (taken_over = 0 OR (seat_kind <> 'cpu' AND result = 'loss'))  -- decision 6
);
CREATE UNIQUE INDEX match_players_one_seat_per_user
  ON match_players(match_id, user_id) WHERE user_id IS NOT NULL;  -- decision 7, enforced here too
CREATE INDEX match_players_by_user ON match_players(user_id, match_id);
-- seat_kind = 'account' with user_id NULL means "a deleted account". That is the
-- anonymisation state, and it renders as "a deleted gnome".
-- taken_over forces result = 'loss' at the database level (decision 6), and records the
-- takeover separately from the win/loss value.
-- Statistics are aggregates over these rows, computed on read. There are no counter columns
-- anywhere, so a retried report (INSERT … ON CONFLICT DO NOTHING) cannot double-count, and
-- deleting a user's rows needs no recomputation.
-- Only statistics the engine reliably produces (ACCOUNTS.md §12): no kills, no home captures.
```

### 0005_social.sql (Phase 6, reviewed now)

```sql
-- One row per friendship, stored canonically (smaller id first).
CREATE TABLE friendships (
  user_a     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)            -- no self-friendship; (B,A) cannot duplicate (A,B)
);
CREATE INDEX friendships_by_b ON friendships(user_b);   -- the PK already serves lookups by user_a

-- At most one pending request per pair, in either direction, by primary key.
CREATE TABLE friend_requests (
  user_a     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester  TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b),
  CHECK (requester IN (user_a, user_b))
);
CREATE INDEX friend_requests_by_b ON friend_requests(user_b);
-- A request that would duplicate a friendship, or cross a block, is refused by the
-- conditional insert (§5.3). Constraints alone cannot express "not if a row exists in
-- another table".

-- Blocks: directional and private to the blocker.
CREATE TABLE blocks (
  blocker    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker <> blocked)
);
CREATE INDEX blocks_by_blocked ON blocks(blocked);
-- Generic user-to-user rows with no feature-specific columns, so the same table can later
-- gate private-room admission or any other social system (decision 9) without a migration.
-- A single query answers "is there a block either way between X and Y?".
```

### 0006_privacy.sql (Phase 7, reviewed now)

```sql
CREATE TABLE privacy_settings (
  user_id          TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  presence_visible INTEGER NOT NULL DEFAULT 1 CHECK (presence_visible IN (0, 1)),  -- decision 5
  updated_at       INTEGER NOT NULL
);
-- A missing row means the defaults. When presence_visible = 0, every other user's view of
-- this user is 'offline'. The UserHub never sends the real state and never sends "hidden".
-- Presence itself is never written here or anywhere in D1 (decision 15).
```

## 4. What deletion does, table by table

Deletion runs as follows:

1. Set `users.status = 'deleting'` and delete the user's sessions.
2. Purge the UserHub DO: pending invites, social sockets closed.
3. `DELETE FROM users WHERE id = ?`. The foreign-key actions below do the
   rest in the same statement.

Every row falls into exactly one category:

| Table | On delete | Category | Affects other users? |
|---|---|---|---|
| `users` | Row deleted | **Deleted** | No |
| `auth_identities` | CASCADE | **Deleted.** A later sign-in with the same Google account creates a new, unrelated account. No hash of `sub` is kept (decision 11). | No |
| `sessions` | Deleted in step 1, and CASCADE as a backstop | **Deleted** | No |
| `profiles` | CASCADE | **Deleted.** The username becomes claimable immediately. | Possibly: someone else could take the name at once. **Policy decision:** a post-deletion quarantine would mean keeping the name, unlinked, for a period. |
| `username_holds` owned by the user | CASCADE | **Deleted.** Held old names are released. | Same policy question as above |
| `username_rules` | Not linked to users | Unaffected | — |
| `username_removals` | SET NULL | **Anonymised:** the removed name is kept, the person is not. | No. **Policy decision:** keep, or delete on account deletion. |
| `customizations` | CASCADE | **Deleted** | No |
| `privacy_settings` | CASCADE | **Deleted** | No |
| `matches` | Not linked to users | **Retained.** Contains no personal data. | No |
| `match_players` for the user | SET NULL on `user_id` | **Anonymised.** The row stays, with its result and counts, and becomes "a deleted gnome". | **Yes.** Other players' histories stay intact and show a deleted gnome in that seat. **Policy decision:** whether the per-seat counts of a deleted user should also be zeroed. They are not identifying without the link, and the default here keeps them. |
| `friendships` involving the user | CASCADE | **Deleted** | **Yes.** The user disappears from friends' lists. No notification is sent. |
| `friend_requests` involving the user | CASCADE | **Deleted** | **Yes.** Pending requests vanish for the other party. |
| `blocks` where the user is the blocker | CASCADE | **Deleted** | No |
| `blocks` where the user is blocked | CASCADE | **Deleted** | **Yes.** If the same person makes a new account, the old block does not carry over. **Policy decision**, tied to decision 11: carrying it over would need a retained identifier. |
| UserHub DO storage | Purged in step 2 | **Deleted** | Pending invites *from* the user disappear. |
| Live rooms | Attribution already frozen at start; the report inserts `NULL` | **Anonymised** at write time | No |
| Worker logs (observability) | Outside D1 | **Policy decision.** The rule is never to log usernames, cookies or request bodies, only opaque ids where necessary. Retention follows the Cloudflare account setting. | No |

Every policy item above can be changed later by editing the deletion flow or
one foreign-key action. None of them is baked into a column that would need a
data migration to undo.

## 5. Data-access boundaries

```text
client ──HTTP/WS──▶ Worker handlers (src/worker/api/*)      authenticate → authorize → validate → call repo → map to DTO
                          │
                          ▼
                    Repositories (src/worker/db/*)           the ONLY code that contains SQL; returns internal types
                          │
                          ▼
                    Db interface (src/worker/db/db.ts)       prepare/bind/first/all/run/batch: the D1 subset we use
                     ├─ D1Database                           production / wrangler dev / vite preview (miniflare)
                     └─ testDb (node:sqlite adapter)         vitest; runs the real migrations/*.sql

Room DO / UserHub DO ──RoomHost/HubHost hooks──▶ repositories   (room.ts and hub.ts never import db/)
```

Rules, each enforced by review and, where possible, by a test:

1. **SQL lives only in `src/worker/db/`.** Handlers, `room.ts`, `hub.ts` and
   the client never contain SQL. There is one place to audit for injection:
   every value is `bind()`-ed, and no SQL is built by string concatenation.
   A unit test scans `src/` and fails if `.prepare(` appears outside
   `src/worker/db/`.
2. **Repositories return internal types; handlers return DTOs.** A DTO is
   built field by field in `src/net/apiTypes.ts` mappers. No row object is
   ever passed to `Response.json`. A snapshot test of each public DTO pins
   its exact key set.
3. **Every repository function that acts for a user takes the acting
   `userId` as a parameter and puts it in the `WHERE` clause.** A handler
   cannot express "delete request X" without also saying whose request.
   This is the IDOR defence.
4. **Multi-row invariants are single batches** with conditional statements.
   A repository never does read, decide, write across round trips.
5. **The platform-free cores (`room.ts`, the future `hub.ts`) stay
   platform-free.** They reach persistence only through their host
   interfaces, which the DO glue implements with repositories.

### 5.1 Phase 1 repository surface (identity only)

```ts
// src/worker/db/identity.ts
upsertGoogleUser(db, sub, now): Promise<{ userId: string; created: boolean }>   // atomic; §5.2
getActiveUser(db, userId): Promise<{ id: string; status: UserStatus } | null>

// src/worker/db/sessions.ts
createSession(db, userId, idHash, now): Promise<void>        // sets idle/absolute expiry
resolveSession(db, idHash, now): Promise<{ userId: string; status: UserStatus } | null>  // expired → null; status is policy-free (P2-1)
touchSession(db, idHash, now): Promise<void>                  // no-op if touched in the last 24 h
revokeSession(db, idHash): Promise<void>
revokeAllSessions(db, userId): Promise<void>
purgeExpiredSessions(db, now): Promise<number>   // DELETE FROM sessions WHERE idle_expires_at <= ?
```

The cookie format, hashing and rotation belong to Phase 2
(`src/worker/auth/session.ts`). The repository only ever sees the hash.

### 5.2 Canonical batch patterns (the models later phases copy)

Idempotent account creation (Phase 1 implements and tests this). One
`db.batch([...])`, where `?1` is a freshly minted user id, `?2` is now and
`?3` is the verified Google `sub`:

```sql
-- S1: create the account only if this sub has no identity yet.
INSERT INTO users (id, status, created_at, updated_at, last_login_at)
  SELECT ?1, 'active', ?2, ?2, ?2
  WHERE NOT EXISTS (SELECT 1 FROM auth_identities WHERE provider = 'google' AND subject = ?3);
-- S2: link the sub to it, unless another request linked the sub first.
INSERT INTO auth_identities (provider, subject, user_id, created_at)
  SELECT 'google', ?3, ?1, ?2
  WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)
  ON CONFLICT (provider, subject) DO NOTHING;
-- S3: if the link lost, remove the account S1 made; nothing refers to it.
DELETE FROM users
  WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM auth_identities WHERE user_id = ?1);
-- S4: record the sign-in on whichever account owns the sub.
UPDATE users SET last_login_at = max(coalesce(last_login_at, 0), ?2), updated_at = max(updated_at, ?2)
  WHERE id = (SELECT user_id FROM auth_identities WHERE provider = 'google' AND subject = ?3);
-- S5: the one true answer.
SELECT u.id AS user_id, u.status, (u.id = ?1) AS created
  FROM auth_identities i JOIN users u ON u.id = i.user_id
  WHERE i.provider = 'google' AND i.subject = ?3;
```

#### 5.2.1 Why this is race-safe, and what provides the guarantee

The scenario: two requests for a Google `sub` never seen before run at the
same time. Examples are a double-clicked callback, or two tabs completing
sign-in at once. Each request mints its own candidate id (`uA`, `uB`) and
runs the batch above.

The required outcome is exactly one `users` row and exactly one
`auth_identities` row for the sub, both callers told the same `user_id`,
exactly one of them told `created`, and no orphaned account.

**Layer 1: what D1 provides.** D1 runs a `batch()` as a single SQLite
transaction: statements execute in order, and any failure rolls back the
whole batch. Every D1 database has a single primary that executes writes one
at a time, and SQLite's own isolation is serialisable. So in practice batch
A runs entirely before or entirely after batch B:

- If A runs first, it creates `uA` and the identity.
- B then sees the identity: S1 inserts nothing, S2's
  `WHERE EXISTS (users uB)` is false, and S3 has nothing to delete.
- B's S5 returns `uA` with `created = 0`.

**Layer 2: what the schema and statements provide, without relying on
Layer 1.** The design does not depend on batches being serialised. Suppose
the two batches were interleaved at the finest granularity SQLite allows,
individual statements, each of which is atomic. Then:

1. **`PRIMARY KEY (provider, subject)` on `auth_identities` is the
   guarantee that the sub is linked exactly once.** Both S2s may run, but
   only one row can exist. The loser's `ON CONFLICT … DO NOTHING` turns the
   collision into a no-op instead of an error, so neither request fails.
2. **Both callers get the same account because S4 and S5 read the link, not
   their own candidate.** Whatever the interleaving, the only row S5 can see
   is the single identity row from (1).
3. **Some identity always exists by the time either S5 runs.** A request's
   S2 inserts nothing only if the sub was already linked, or if its own S1
   inserted nothing, which again means the sub was already linked. So S5
   never returns zero rows.
4. **S3 removes the loser's orphan.** The loser's S1 may have created `uB`
   before the winner's S2 linked the sub to `uA`. S3 deletes the batch's own
   candidate only if no identity refers to it. The winner's S3 always runs
   after its own successful S2, so the winner's account is never deleted.
   The `FOREIGN KEY … ON DELETE CASCADE` on `auth_identities.user_id` is
   irrelevant here, because the deleted row has no children by construction.
5. **`UNIQUE (user_id, provider)`** stops a candidate from being linked to a
   *second* Google identity, so the invariant "one account per Google
   identity, one Google identity per account" is closed in both directions
   by constraints.

This was checked exhaustively, not argued alone. All 252 statement-level
interleavings of two five-statement batches were run against the schema
above. **All 252 ended with one user, one identity, the same `user_id` for
both callers and exactly one `created`.** The winner was A in 126 and B in
126.

The same run **without S3** found **40 interleavings that leave an orphaned
`users` row**. In none of them did the callers disagree, because (1) and (2)
still hold. S3 is the statement that makes orphan-freedom independent of
batch serialisation. The earlier draft of this spec lacked it.

**What the code must not do:**
- split the batch into separate calls, which would lose Layer 1's rollback
  on failure;
- route this batch to a read replica. D1 read replication is not enabled,
  and if it ever is, sign-in must use a primary-first session;
- read the identity before the batch and branch on the result
  (read-then-decide-then-write is exactly the race this avoids).

PR 1-C's tests pin all of these: the exhaustive interleaving run, plus a test
that `upsertGoogleUser` issues exactly one `batch()` call.

Username claim (Phase 3, shown so the pattern is reviewed with the schema).
One conditional `INSERT … ON CONFLICT(user_id) DO UPDATE` that succeeds only
if all of the following hold, with `UNIQUE(username_key)` catching a simultaneous claim by someone else:

- no unexpired hold on the key belongs to another user;
- no `username_rules` entry matches;
- the 30-day cooldown has passed, or this is the first name;

and, in the same batch, an `INSERT INTO username_holds` for the name being
given up.

### 5.3 Friend request (Phase 6)

One batch:

1. Insert the canonical pair `WHERE NOT EXISTS (friendship) AND NOT EXISTS
   (block either way)`, `ON CONFLICT DO NOTHING`.
2. If the existing row's requester is the other party, a second conditional
   statement converts it into a friendship.

## 6. Phase 1 change list (small PRs)

**Prerequisites (human, done once; the PRs need them):**

- `wrangler d1 create gnomeconquest` (production) and
  `wrangler d1 create gnomeconquest-staging`. Put the two ids in 1-A.
- Nothing Google-related is needed until Phase 2.

### PR 1-A — Bindings, environments, env typing

- `wrangler.jsonc`:
  - `d1_databases: [{ binding: "DB", database_name: "gnomeconquest", database_id: …, migrations_dir: "migrations" }]`.
  - An `env.staging` block (decision 17): its own Worker name
    (`gnomeconquest-staging`), its own D1 id, its own `ROOMS` DO namespace,
    and rate-limit bindings. Durable Object namespaces are per-Worker, so
    staging rooms and production rooms never meet.
- `npm run cf-typegen`, commit `worker-configuration.d.ts`. `WorkerEnv` in
  `src/worker/index.ts` gains `DB: D1Database` (required) and the DO
  constructor accepts `env`, unused until Phase 5.
- `.dev.vars.example` with commented placeholders for Phase 2's secrets. The
  file documents names only and holds no values. `.dev.vars` is already
  git-ignored.
- `package.json` scripts: `db:migrate:local`, `db:migrate:staging`,
  `db:migrate:prod` (wrappers around `wrangler d1 migrations apply`),
  `deploy:staging`.
- DEPLOYMENT.md:
  - migrate first, then deploy;
  - expand/contract discipline (a deployed Worker must work against both the
    previous and the next schema);
  - staging first, always;
  - **never point local or CI at a remote database.** Tests use the in-memory
    adapter, and local dev uses miniflare's local D1 (`.wrangler/state`,
    git-ignored).

Tests: none new beyond build and typecheck. Behaviour is unchanged.

### PR 1-B — Migration 0001 and the test harness

- `migrations/0001_identity.sql`, exactly as §3.
- `src/worker/db/db.ts`: the `Db` interface, which is the subset of
  `D1Database` we use, so the adapter cannot drift.
- `src/worker/db/testDb.ts`: a `Db` over `node:sqlite` (`DatabaseSync`,
  `:memory:`). It sets `PRAGMA foreign_keys = ON`, applies `migrations/*.sql`
  in filename order, and implements `batch()` as `BEGIN` … `COMMIT` /
  `ROLLBACK`, matching D1's atomic batch semantics.
  - `node:sqlite` ships with Node 22, which CI already pins. It prints an
    ExperimentalWarning, and that is the known cost. The fallback, if its API
    shifts, is `better-sqlite3` behind the same interface.
  - `@cloudflare/vitest-pool-workers` is the more faithful option, but it
    adds a second pool and its vitest-4 support must be confirmed. Revisit in
    Phase 2 if the adapter shows gaps.
- `src/worker/db/migrations.test.ts`:
  - migrations apply cleanly from an empty database;
  - **foreign-key enforcement is on**: inserting an `auth_identities` row
    for a missing user fails;
  - every `CHECK` in 0001 rejects its bad case: bad status, bad provider,
    empty subject, `id_hash` of the wrong length, `idle > absolute`;
  - `PRIMARY KEY (provider, subject)` and `UNIQUE (user_id, provider)` each
    reject a duplicate;
  - deleting a user cascades to identities and sessions.

### PR 1-C — Identity and session repositories

- `src/worker/db/identity.ts`, `src/worker/db/sessions.ts` (§5.1).
- Tests (`identity.test.ts`, `sessions.test.ts`, on `testDb`):
  - `upsertGoogleUser` for a new `sub` creates exactly one user and one
    identity;
  - the same `sub` again returns the same user with `created: false`;
  - **every statement-level interleaving of two first sign-ins for one new
    `sub`** (all 252) leaves exactly one user and one identity, with no
    orphan, the same `user_id` for both callers and exactly one
    `created: true` (§5.2.1). The statements are driven through the
    repository's exported statement list, so the test runs what the code
    runs;
  - `upsertGoogleUser` issues its statements as exactly one `batch()` call;
  - different `sub`s give different users;
  - `resolveSession` returns `null` past `idle_expires_at`, and past
    `absolute_expires_at` even when recently touched;
  - `touchSession` extends idle expiry but never past absolute, and writes
    at most once per 24 hours;
  - `revokeAllSessions` removes every session of that user only;
  - `purgeExpiredSessions` removes only expired rows;
  - `resolveSession` returns the user's `status` with the session: a
    `suspended` or `deleting` user resolves, with that status, so that Phase
    2's single central check (ACCOUNTS.md §9.5, P2-1) can refuse them. The
    repository does not decide policy.

### PR 1-D — Local and e2e plumbing, and proof they share one database

- `playwright.config.ts`: `webServer.command` becomes
  `wrangler d1 migrations apply DB --local && npm run build && npx vite preview …`.
  Neither step may pass `--env` / `CLOUDFLARE_ENV`. The local database file
  is chosen per database binding, so the migration and the served Worker
  must resolve the same top-level `d1_databases` entry.
- **`GET /api/health`**, the one Phase 1 route that touches D1. It is
  read-only: `SELECT 1 FROM d1_migrations WHERE name = ?`, where `?` is the
  latest migration filename compiled into the Worker. It answers `200
  {"ok":true}` when the schema the code expects is present, and `503
  {"ok":false}` otherwise. It reveals nothing else: no migration names, no
  counts. It is limited per IP (a new `HEALTH_LIMIT` rate-limit binding,
  30/min). It is also the post-deploy check DEPLOYMENT.md will prescribe,
  because it catches code deployed before its migration.
- **`e2e/schema.spec.ts`** asserts `GET /api/health` is `200`. That passes
  only if the database the `webServer` command migrated is the database the
  Playwright-driven Worker reads. A unit test with `testDb` covers the `503`
  path. (`reuseExistingServer` is on outside CI, so locally a stale server
  started before a new migration will fail this test. That is the test doing
  its job.)
- CI is otherwise unchanged. Unit tests use `testDb`, and the e2e job
  migrates local D1 itself from a clean checkout.

**Verified before writing this (2026-09-29), in a throwaway worktree**, with
a probe binding, a probe migration and a probe route, following exactly the
steps above:

| Step | Command | Result |
|---|---|---|
| 1 | `npm run build`, then `vite preview` (as Playwright does), `GET /api/_probe` | `D1_ERROR: no such table: probe`. The Worker is bound to a local D1, and it is empty. |
| 2 | `wrangler d1 migrations apply DB --local` | "Executing on local database DB … from `.wrangler/state/v3/d1`"; `0001_probe.sql ✅` |
| 3 | `vite preview` again, `GET /api/_probe` | Returned the random marker the migration inserted (`probe-1790699938433814837`). |
| — | Files | Exactly one D1 database file under `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`, before and after. It sits beside the Room DO state `vite preview` wrote, and `d1_migrations` in it records `0001_probe.sql`. |
| — | Build output | `dist/gnomeconquest/wrangler.json` carries the same binding and database id, with `migrations_dir` rewritten to `../../migrations`, which is the same folder. |

The probe also confirmed that miniflare's D1 accepts `STRICT` tables. The
worktree was deleted afterwards, and nothing from it is in the repo.

## 7. Exit criteria for Phase 1

- `0001_identity.sql` is applied locally, in CI's e2e runs, and to staging,
  then (on approval) to production. No other migration is applied.
- The existing suites are green. The new repository and constraint tests are
  green.
- No HTTP route touches the database except `GET /api/health`, which reads
  only the migration table. The game behaves exactly as before for every
  player.
- `e2e/schema.spec.ts` passes in CI: the migrated local D1 and the
  Playwright Worker are proven to be one database on every run.
- DEPLOYMENT.md describes migrations, staging, and the rule that production
  data is never used for development or automated testing.
