/** The Worker's bindings (wrangler.jsonc). */
export interface WorkerEnv {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  /**
   * Cloudflare rate-limit bindings (wrangler.jsonc). Optional in the type
   * because they are not always there: `vite dev` and older local runtimes
   * hand the Worker an env without them, and a game that will not run locally
   * because a production defence is missing is a worse trade than a local run
   * that is not rate limited.
   */
  ROOM_CREATE_LIMIT?: RateLimit;
  ROOM_JOIN_LIMIT?: RateLimit;
  HEALTH_LIMIT?: RateLimit;
  /** Sign-in and sign-out, per IP: 20 a minute (a sign-in is two requests). */
  AUTH_LIMIT?: RateLimit;
  /** `GET /api/me`, per IP: 60 a minute. It reads D1 whenever it is called. */
  ME_LIMIT?: RateLimit;
  /**
   * The accounts database (ACCOUNTS.md, migrations/). Every SQL statement
   * lives in src/worker/db/; nothing else touches this binding directly.
   */
  DB: D1Database;
  /**
   * Accounts on or off (decision D2): exactly `"true"` turns them on. Anything
   * else, missing included, is off: the auth routes and `/api/me` answer 404
   * and no request is ever resolved to an account. `"false"` in production and
   * in branch previews (D7); `"true"` on staging and locally.
   */
  ACCOUNTS_ENABLED?: string;
}

/** The env keys a route may name as its rate limit. */
export type LimitBinding = 'ROOM_CREATE_LIMIT' | 'ROOM_JOIN_LIMIT' | 'HEALTH_LIMIT' | 'AUTH_LIMIT' | 'ME_LIMIT';

/** Accounts are on only when the var says exactly `"true"` (fail closed). */
export function accountsEnabled(env: Pick<WorkerEnv, 'ACCOUNTS_ENABLED'>): boolean {
  return env.ACCOUNTS_ENABLED === 'true';
}
