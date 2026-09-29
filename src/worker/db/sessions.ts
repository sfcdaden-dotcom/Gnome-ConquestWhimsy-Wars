/**
 * Sessions: opaque, revocable, stored only as the SHA-256 of the cookie value.
 *
 * Lifetimes (decision 12): 30 days of inactivity, 90 days absolute. A session
 * is valid exactly while `now < idle_expires_at` — the schema caps idle expiry
 * at the absolute limit, so that one comparison covers both.
 *
 * The cookie itself, hashing and rotation are Phase 2 (src/worker/auth/); this
 * module only ever sees the hash. Like identity.ts it reports a user's status
 * and decides nothing about it (ACCOUNTS.md §9.5, P2-1).
 */

import type { Db } from './db';
import type { UserStatus } from './identity';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SESSION_IDLE_MS = 30 * DAY_MS;
export const SESSION_ABSOLUTE_MS = 90 * DAY_MS;
/** A session's last sighting is rewritten at most this often, not per request. */
export const SESSION_TOUCH_INTERVAL_MS = DAY_MS;

export async function createSession(db: Db, userId: string, idHash: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES (?1, ?2, ?3, ?3, ?3 + ?4, ?3 + ?5)`,
    )
    .bind(idHash, userId, now, Math.min(SESSION_IDLE_MS, SESSION_ABSOLUTE_MS), SESSION_ABSOLUTE_MS)
    .run();
}

/**
 * The user a live session belongs to, with their status; null for an unknown
 * or expired session. A suspended or deleting account still resolves — what it
 * may do is the router's single decision, not this function's.
 */
export async function resolveSession(
  db: Db,
  idHash: string,
  now: number,
): Promise<{ userId: string; status: UserStatus } | null> {
  const row = await db
    .prepare(
      `SELECT s.user_id AS user_id, u.status AS status
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ?1 AND s.idle_expires_at > ?2`,
    )
    .bind(idHash, now)
    .first<{ user_id: string; status: UserStatus }>();
  return row ? { userId: row.user_id, status: row.status } : null;
}

/**
 * Slide a live session's idle expiry forward — never past its absolute limit,
 * and at most once per SESSION_TOUCH_INTERVAL_MS, so an active player costs one
 * write a day rather than one per request. Returns whether it wrote.
 */
export async function touchSession(db: Db, idHash: string, now: number): Promise<boolean> {
  const { meta } = await db
    .prepare(
      `UPDATE sessions
         SET last_seen_at = ?2, idle_expires_at = min(?2 + ?3, absolute_expires_at)
         WHERE id_hash = ?1 AND idle_expires_at > ?2 AND last_seen_at <= ?2 - ?4`,
    )
    .bind(idHash, now, SESSION_IDLE_MS, SESSION_TOUCH_INTERVAL_MS)
    .run();
  return meta.changes > 0;
}

/** Sign out this session. */
export async function revokeSession(db: Db, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id_hash = ?1').bind(idHash).run();
}

/** Sign out everywhere: every session of this user, and no one else's. */
export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId).run();
}

/**
 * Remove every expired session. Tests `idle_expires_at` alone — complete,
 * because idle is capped at absolute — so it plans as a search of the expiry
 * index rather than a scan. Returns how many were removed.
 */
export async function purgeExpiredSessions(db: Db, now: number): Promise<number> {
  const { meta } = await db.prepare('DELETE FROM sessions WHERE idle_expires_at <= ?1').bind(now).run();
  return meta.changes;
}
