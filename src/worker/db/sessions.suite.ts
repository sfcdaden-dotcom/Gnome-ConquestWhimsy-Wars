/**
 * The session repository's tests, as a suite either engine can run: the
 * in-memory SQLite adapter (sessions.test.ts) and real local D1 in the Workers
 * runtime (d1.workers.test.ts). See suiteDb.ts for why both.
 */

import { describe, expect, it } from 'vitest';
import { upsertGoogleUser } from './identity';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  createSession,
  issueSession,
  purgeExpiredSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  touchSession,
} from './sessions';
import type { FreshDb, SuiteDb } from './suiteDb';

const NOW = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

async function signedIn(db: SuiteDb, sub = 'sub-1'): Promise<string> {
  return (await upsertGoogleUser(db, sub, NOW)).userId;
}

function row(db: SuiteDb, hash: string) {
  return db.row('SELECT * FROM sessions WHERE id_hash = ?', hash);
}

export function sessionsSuite(fresh: FreshDb): void {
  describe('sessions', () => {
    it('lasts 30 days idle and 90 days absolute (decision 12)', () => {
      expect(SESSION_IDLE_MS).toBe(30 * DAY);
      expect(SESSION_ABSOLUTE_MS).toBe(90 * DAY);
    });

    it('resolves a fresh session to its user and their status', async () => {
      const db = await fresh();
      const userId = await signedIn(db);
      await createSession(db, userId, H1, NOW);

      expect(await row(db, H1)).toMatchObject({
        created_at: NOW,
        last_seen_at: NOW,
        idle_expires_at: NOW + SESSION_IDLE_MS,
        absolute_expires_at: NOW + SESSION_ABSOLUTE_MS,
      });
      expect(await resolveSession(db, H1, NOW + 1)).toEqual({ userId, status: 'active' });
      expect(await resolveSession(db, H2, NOW + 1)).toBeNull();
    });

    it('expires after 30 days without a sighting', async () => {
      const db = await fresh();
      await createSession(db, await signedIn(db), H1, NOW);
      expect(await resolveSession(db, H1, NOW + SESSION_IDLE_MS - 1)).not.toBeNull();
      expect(await resolveSession(db, H1, NOW + SESSION_IDLE_MS)).toBeNull();
    });

    it('expires at 90 days however recently it was used', async () => {
      const db = await fresh();
      await createSession(db, await signedIn(db), H1, NOW);
      // Used every day right up to the end.
      for (let t = NOW + DAY; t < NOW + SESSION_ABSOLUTE_MS; t += DAY) await touchSession(db, H1, t);

      expect((await row(db, H1))?.idle_expires_at).toBe(NOW + SESSION_ABSOLUTE_MS); // capped, never beyond
      expect(await resolveSession(db, H1, NOW + SESSION_ABSOLUTE_MS - 1)).not.toBeNull();
      expect(await resolveSession(db, H1, NOW + SESSION_ABSOLUTE_MS)).toBeNull();
    });

    it('writes a sighting at most once a day', async () => {
      const db = await fresh();
      await createSession(db, await signedIn(db), H1, NOW);

      expect(await touchSession(db, H1, NOW + SESSION_TOUCH_INTERVAL_MS - 1)).toBe(false);
      expect((await row(db, H1))?.last_seen_at).toBe(NOW);
      expect(await touchSession(db, H1, NOW + SESSION_TOUCH_INTERVAL_MS)).toBe(true);
      expect(await row(db, H1)).toMatchObject({
        last_seen_at: NOW + SESSION_TOUCH_INTERVAL_MS,
        idle_expires_at: NOW + SESSION_TOUCH_INTERVAL_MS + SESSION_IDLE_MS,
      });
    });

    it('never revives an expired session by touching it', async () => {
      const db = await fresh();
      await createSession(db, await signedIn(db), H1, NOW);
      expect(await touchSession(db, H1, NOW + SESSION_IDLE_MS)).toBe(false);
      expect(await resolveSession(db, H1, NOW + SESSION_IDLE_MS)).toBeNull();
    });

    it('still resolves a suspended or deleting account, reporting the status', async () => {
      // Refusing them is the router's single, central job (ACCOUNTS.md §9.5, P2-1).
      const db = await fresh();
      const userId = await signedIn(db);
      await createSession(db, userId, H1, NOW);
      for (const status of ['suspended', 'deleting'] as const) {
        await db.exec('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, NOW, userId);
        expect(await resolveSession(db, H1, NOW + 1)).toEqual({ userId, status });
      }
    });

    it('signs out one session', async () => {
      const db = await fresh();
      const userId = await signedIn(db);
      await createSession(db, userId, H1, NOW);
      await createSession(db, userId, H2, NOW);
      await revokeSession(db, H1);
      expect(await resolveSession(db, H1, NOW + 1)).toBeNull();
      expect(await resolveSession(db, H2, NOW + 1)).not.toBeNull();
    });

    it('signs a user out everywhere, and nobody else', async () => {
      const db = await fresh();
      const alice = await signedIn(db, 'sub-alice');
      const bob = await signedIn(db, 'sub-bob');
      await createSession(db, alice, H1, NOW);
      await createSession(db, alice, H2, NOW);
      await createSession(db, bob, H3, NOW);

      await revokeAllSessions(db, alice);

      expect(await resolveSession(db, H1, NOW + 1)).toBeNull();
      expect(await resolveSession(db, H2, NOW + 1)).toBeNull();
      expect(await resolveSession(db, H3, NOW + 1)).toEqual({ userId: bob, status: 'active' });
    });

    describe('issueSession (sign-in, §6.3)', () => {
      it('creates the session for an active account, and says so', async () => {
        const db = await fresh();
        const userId = await signedIn(db);
        expect(await issueSession(db, userId, H1, null, NOW)).toBe(true);
        expect(await row(db, H1)).toMatchObject({
          user_id: userId,
          created_at: NOW,
          idle_expires_at: NOW + SESSION_IDLE_MS,
          absolute_expires_at: NOW + SESSION_ABSOLUTE_MS,
        });
        expect(await resolveSession(db, H1, NOW + 1)).toEqual({ userId, status: 'active' });
      });

      it('gives a suspended or deleting account no session, and writes no row (R4)', async () => {
        for (const status of ['suspended', 'deleting'] as const) {
          const db = await fresh();
          const userId = await signedIn(db);
          await db.exec('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, NOW, userId);
          expect(await issueSession(db, userId, H1, null, NOW), status).toBe(false);
          expect(await db.rows('SELECT id_hash FROM sessions'), status).toEqual([]);
        }
      });

      it('revokes the browser’s previous session, whoever it belonged to', async () => {
        const db = await fresh();
        const alice = await signedIn(db, 'sub-alice');
        const bob = await signedIn(db, 'sub-bob');
        await createSession(db, bob, H2, NOW);
        expect(await issueSession(db, alice, H1, H2, NOW)).toBe(true);
        expect(await resolveSession(db, H2, NOW + 1)).toBeNull();
        expect(await resolveSession(db, H1, NOW + 1)).toEqual({ userId: alice, status: 'active' });
      });

      it('revokes the previous session even when the account turns out not to be active', async () => {
        const db = await fresh();
        const userId = await signedIn(db);
        await createSession(db, userId, H2, NOW);
        await db.exec("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?", NOW, userId);
        expect(await issueSession(db, userId, H1, H2, NOW)).toBe(false);
        expect(await db.rows('SELECT id_hash FROM sessions')).toEqual([]);
      });

      it('is a no-op when replayed: one row, and true both times (§5.4)', async () => {
        const db = await fresh();
        const userId = await signedIn(db);
        expect(await issueSession(db, userId, H1, H2, NOW)).toBe(true);
        expect(await issueSession(db, userId, H1, H2, NOW + 5)).toBe(true);
        expect(await db.rows('SELECT id_hash, created_at FROM sessions')).toEqual([{ id_hash: H1, created_at: NOW }]);
      });

      it('never deletes the session it is issuing, even if named as the prior one', async () => {
        const db = await fresh();
        const userId = await signedIn(db);
        await issueSession(db, userId, H1, null, NOW);
        expect(await issueSession(db, userId, H1, H1, NOW + 5)).toBe(true);
        expect(await resolveSession(db, H1, NOW + 6)).not.toBeNull();
      });

      it('answers false for a hash held by another user, and leaves that session alone', async () => {
        const db = await fresh();
        const alice = await signedIn(db, 'sub-alice');
        const bob = await signedIn(db, 'sub-bob');
        await issueSession(db, bob, H1, null, NOW);
        expect(await issueSession(db, alice, H1, null, NOW)).toBe(false);
        expect(await resolveSession(db, H1, NOW + 1)).toEqual({ userId: bob, status: 'active' });
      });

      it('runs as one batch', async () => {
        const db = await fresh();
        const userId = await signedIn(db);
        const before = db.batches.length;
        await issueSession(db, userId, H1, null, NOW);
        expect(db.batches.length - before).toBe(1);
        expect(db.batches.at(-1)).toHaveLength(3);
      });
    });

    it('purges only expired sessions, by either limit', async () => {
      const db = await fresh();
      const userId = await signedIn(db);
      await createSession(db, userId, H1, NOW); // will go idle
      await createSession(db, userId, H2, NOW); // kept alive until its absolute limit
      await createSession(db, userId, H3, NOW + 80 * DAY); // still fresh at the end
      for (let t = NOW + DAY; t < NOW + SESSION_ABSOLUTE_MS; t += DAY) await touchSession(db, H2, t);

      const removed = await purgeExpiredSessions(db, NOW + SESSION_ABSOLUTE_MS);

      expect(removed).toBe(2);
      expect(await db.rows('SELECT id_hash FROM sessions')).toEqual([{ id_hash: H3 }]);
    });
  });
}
