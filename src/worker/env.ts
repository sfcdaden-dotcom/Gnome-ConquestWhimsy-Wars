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
  /**
   * The accounts database (ACCOUNTS.md, migrations/). Every SQL statement
   * lives in src/worker/db/; nothing else touches this binding directly.
   */
  DB: D1Database;
}

/** The env keys a route may name as its rate limit. */
export type LimitBinding = 'ROOM_CREATE_LIMIT' | 'ROOM_JOIN_LIMIT' | 'HEALTH_LIMIT';
