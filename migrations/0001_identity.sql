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
