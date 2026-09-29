/**
 * Accounts and the Google identities that sign in as them.
 *
 * Policy lives elsewhere: this module reports a user's `status` and never
 * decides what a non-active account may do. That is enforced once, centrally,
 * in Phase 2's router (ACCOUNTS.md §9.5, requirement P2-1).
 *
 * Every statement here that changes a `users` row also sets `updated_at`
 * (there is no trigger; a test scans this directory for `UPDATE users`).
 */

import type { Db, DbValue } from './db';

export type UserStatus = 'active' | 'suspended' | 'deleting';

export interface SignedInUser {
  userId: string;
  status: UserStatus;
  /** True only for the request that created the account. */
  created: boolean;
}

/** Google's `sub` is an opaque string of at most 255 ASCII characters. */
const MAX_SUBJECT = 255;

/**
 * The sign-in batch, as data, so the tests can run exactly these statements
 * in any interleaving (see ACCOUNTS_SPEC_PHASE_1.md §5.2.1 for why every
 * interleaving is safe). `?1` = the candidate user id, `?2` = now, `?3` = sub.
 */
export function upsertGoogleUserStatements(
  candidateId: string,
  now: number,
  subject: string,
): Array<{ sql: string; values: DbValue[] }> {
  const all: DbValue[] = [candidateId, now, subject];
  return [
    // S1: create the account only if this sub has no identity yet.
    {
      sql: `INSERT INTO users (id, status, created_at, updated_at, last_login_at)
              SELECT ?1, 'active', ?2, ?2, ?2
              WHERE NOT EXISTS (SELECT 1 FROM auth_identities WHERE provider = 'google' AND subject = ?3)`,
      values: all,
    },
    // S2: link the sub to it, unless another request linked the sub first.
    // The (provider, subject) primary key is what makes "linked once" true.
    {
      sql: `INSERT INTO auth_identities (provider, subject, user_id, created_at)
              SELECT 'google', ?3, ?1, ?2
              WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)
              ON CONFLICT (provider, subject) DO NOTHING`,
      values: all,
    },
    // S3: if the link went to another request's account, remove the one S1
    // made. Nothing can refer to it, so no race can leave it behind.
    {
      sql: `DELETE FROM users
              WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM auth_identities WHERE user_id = ?1)`,
      values: [candidateId],
    },
    // S4: record the sign-in on whichever account owns the sub. max() so an
    // isolate whose clock is slightly behind cannot move time backwards.
    {
      sql: `UPDATE users
              SET last_login_at = max(coalesce(last_login_at, 0), ?2), updated_at = max(updated_at, ?2)
              WHERE id = (SELECT user_id FROM auth_identities WHERE provider = 'google' AND subject = ?3)`,
      values: all,
    },
    // S5: the one true answer — read through the link, never the candidate.
    {
      sql: `SELECT u.id AS user_id, u.status AS status, (u.id = ?1) AS created
              FROM auth_identities i JOIN users u ON u.id = i.user_id
              WHERE i.provider = 'google' AND i.subject = ?3`,
      values: all,
    },
  ];
}

/**
 * The account a verified Google `sub` signs in as, created on first sign-in.
 *
 * One `batch()` — one transaction — and never read-then-decide-then-write:
 * two concurrent first sign-ins for the same sub always end with one account,
 * one identity, the same answer for both, and no orphan.
 */
export async function upsertGoogleUser(
  db: Db,
  subject: string,
  now: number,
  candidateId: string = crypto.randomUUID(),
): Promise<SignedInUser> {
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT) {
    throw new Error('upsertGoogleUser: invalid subject');
  }
  const statements = upsertGoogleUserStatements(candidateId, now, subject).map(({ sql, values }) =>
    db.prepare(sql).bind(...values),
  );
  const results = await db.batch<{ user_id: string; status: UserStatus; created: number }>(statements);
  const row = results[results.length - 1]?.results[0];
  // Unreachable by construction (§5.2.1, point 3); loud if the invariant ever breaks.
  if (!row) throw new Error('upsertGoogleUser: no account for the identity after sign-in');
  return { userId: row.user_id, status: row.status, created: row.created === 1 };
}

/** A user's id and status, or null if there is no such user. */
export async function getUser(db: Db, userId: string): Promise<{ id: string; status: UserStatus } | null> {
  return db.prepare('SELECT id, status FROM users WHERE id = ?1').bind(userId).first<{ id: string; status: UserStatus }>();
}
