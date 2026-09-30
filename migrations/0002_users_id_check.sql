-- 0002_users_id_check.sql
--
-- Replaces the users.id CHECK from 0001_identity.sql with one that D1 can
-- evaluate. Nothing else about any table changes.
--
-- Why: 0001 checks the id with a single GLOB of 251 bytes. D1 refuses any
-- LIKE or GLOB pattern longer than 50 bytes ("LIKE or GLOB pattern too
-- complex"), so on D1 that CHECK fails for EVERY row: no users row can ever be
-- inserted. Node's SQLite allows much longer patterns, which is why 0001's
-- tests passed there. See ACCOUNTS_SPEC_PHASE_2.md §1.1.
--
-- 0001 is production history and is not edited; this file supersedes the one
-- CHECK. SQLite cannot alter a CHECK in place, so users is rebuilt.
--
-- The rebuild copies no rows, because there are none to copy: on D1 the old
-- CHECK made every insert into users fail, and auth_identities and sessions
-- both reference users. The guard below does not assume that. It makes the
-- migration FAIL if any identity table holds a row, rather than rebuild over
-- data it did not expect.

-- Guard. Fails with "CHECK constraint failed: identity_rows = 0" if any of the
-- three identity tables holds a row, before anything else in this file runs.
-- IF NOT EXISTS: if a failed run ever left this table behind, a retry reuses
-- it instead of failing on CREATE. (Locally, wrangler applies a migration as
-- one batch, so a failure leaves nothing behind at all.)
CREATE TABLE IF NOT EXISTS _0002_guard (
  identity_rows INTEGER NOT NULL CHECK (identity_rows = 0)
) STRICT;
INSERT INTO _0002_guard (identity_rows)
  SELECT (SELECT count(*) FROM users)
       + (SELECT count(*) FROM auth_identities)
       + (SELECT count(*) FROM sessions);
DROP TABLE _0002_guard;

-- The new users table: 0001's columns and CHECKs exactly, except the id CHECK.
CREATE TABLE users_0002 (
  -- Exactly what crypto.randomUUID() produces: a lowercase RFC 9562 version-4
  -- UUID, 8-4-4-4-12 hex, version nibble 4, variant nibble 8, 9, a or b. The
  -- same set of strings 0001's GLOB described, built from pieces D1 accepts:
  --   36 characters, all of them hex digits or dashes;
  --   exactly four dashes (32 characters remain without them), at positions
  --     9, 14, 19 and 24, so every other position is a hex digit;
  --   the version and variant nibbles.
  -- The one pattern, '*[^0-9a-f-]*', is 13 bytes; D1's limit is 50.
  id            TEXT    NOT NULL PRIMARY KEY
                        CHECK (
                          length(id) = 36
                          AND id NOT GLOB '*[^0-9a-f-]*'
                          AND length(replace(id, '-', '')) = 32
                          AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
                          AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
                          AND substr(id, 15, 1) = '4'
                          AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
                        ),
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'deleting')),
  created_at    INTEGER NOT NULL CHECK (created_at > 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= created_at),
  last_login_at INTEGER          CHECK (last_login_at IS NULL OR last_login_at >= created_at)
) STRICT;

-- Swap it in. auth_identities and sessions reference users by name, so once
-- the rename lands their foreign keys (and ON DELETE CASCADE) point at the new
-- table. The guard has already proved there are no rows for DROP TABLE's
-- implicit delete to cascade through.
DROP TABLE users;
ALTER TABLE users_0002 RENAME TO users;
