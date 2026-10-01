/**
 * Sessions on the wire (ACCOUNTS_SPEC_PHASE_2.md §6): the cookie, and
 * `authenticate`, which answers "who is this request?".
 *
 * This is the ONLY module that reads the session cookie; a source scan
 * (session.test.ts) fails if any other module does. The database only ever
 * sees the cookie's SHA-256 (src/worker/db/sessions.ts).
 *
 * `__Host-gw_session` carries 256 random bits as 43 characters of base64url.
 * The `__Host-` prefix forbids a `Domain` attribute, so a sibling subdomain can
 * neither read nor plant it; `HttpOnly` keeps it from page script (R7); and
 * `SameSite=Strict` keeps cross-site requests from carrying it.
 */

import { fromD1 } from '../db/db';
import { resolveSession, revokeSession, touchSession } from '../db/sessions';
import type { WorkerEnv } from '../env';
import { accountsEnabled } from '../env';
import type { ActiveUser, Auth } from './types';
import { GUEST } from './types';

export const SESSION_COOKIE = '__Host-gw_session';

/** The cookie's `Max-Age`, in seconds (HTTP's unit): the 90-day absolute lifetime (D6). */
export const SESSION_COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';

export type Authenticate = (request: Request, env: WorkerEnv, ctx: ExecutionContext) => Promise<Auth>;

/** A fresh session token: 32 random bytes, base64url, no padding (43 characters). */
export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** What `sessions.id_hash` stores: the lowercase hex SHA-256 of the token. */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `Set-Cookie` for a new session. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${ATTRIBUTES}; Max-Age=${SESSION_COOKIE_MAX_AGE_S}`;
}

/** `Set-Cookie` that removes the session cookie. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;
}

/**
 * The session token the request carries: absent, malformed, or a token of the
 * right shape. Only the shape is checked here; whether it is live is D1's
 * answer.
 */
function readSessionToken(request: Request): { state: 'absent' } | { state: 'malformed' } | { state: 'present'; token: string } {
  const header = request.headers.get('Cookie');
  if (!header) return { state: 'absent' };
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const token = part.slice(eq + 1).trim();
    return TOKEN_SHAPE.test(token) ? { state: 'present', token } : { state: 'malformed' };
  }
  return { state: 'absent' };
}

/**
 * Who is this request? Never throws on a guest (§6.2).
 *
 * | cookie                        | answer                         | D1        |
 * |-------------------------------|--------------------------------|-----------|
 * | accounts off, or no cookie    | guest                          | no read   |
 * | malformed                     | guest                          | no read   |
 * | unknown, expired or revoked   | guest, and the cookie cleared  | one read  |
 * | live, account active          | the user; touched in waitUntil | one read  |
 * | live, suspended or deleting   | unavailable                    | one read  |
 */
export const authenticate: Authenticate = async (request, env, ctx) => {
  if (!accountsEnabled(env)) return GUEST;
  const cookie = readSessionToken(request);
  if (cookie.state !== 'present') return GUEST;

  const db = fromD1(env.DB);
  const hash = await hashSessionToken(cookie.token);
  const now = Date.now();
  const session = await resolveSession(db, hash, now);
  if (!session) return { kind: 'guest', staleSession: true };

  if (session.status !== 'active') return { kind: 'unavailable', userId: session.userId, status: session.status };

  // At most one write a day (SESSION_TOUCH_INTERVAL_MS), off the request's path.
  ctx.waitUntil(
    touchSession(db, hash, now).catch((err) => {
      console.error('session: touch failed', { error: err instanceof Error ? err.name : typeof err });
    }),
  );
  // The one place an ActiveUser is made: only here, and only for `active`.
  return { kind: 'user', user: { id: session.userId } as ActiveUser };
};

/** Revoke the session this request carries, if it carries one. Logout's work (§6.4). */
export async function revokeRequestSession(request: Request, env: WorkerEnv): Promise<void> {
  const cookie = readSessionToken(request);
  if (cookie.state !== 'present') return;
  await revokeSession(fromD1(env.DB), await hashSessionToken(cookie.token));
}

/**
 * `res` with the session cookie cleared. A WebSocket upgrade is passed through
 * untouched: its 101 cannot be rebuilt, and the next ordinary response clears
 * the cookie anyway.
 */
export function withClearedSession(res: Response): Response {
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.append('Set-Cookie', clearedSessionCookie());
  return out;
}
