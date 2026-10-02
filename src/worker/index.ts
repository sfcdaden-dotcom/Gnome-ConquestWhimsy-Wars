/**
 * Worker entry: a room API in front of the same static bundle the game has
 * always been.
 *
 *   /api/*          → the router (./router.ts), over the route table in ./routes.ts
 *   everything else → the SPA assets, exactly as before
 *   cron            → the daily purge of expired sessions (wrangler.jsonc triggers)
 */

import { authenticate } from './auth/session';
import { fromD1 } from './db/db';
import { purgeExpiredSessions } from './db/sessions';
import type { WorkerEnv } from './env';
import { dispatch } from './router';
import { ROUTES } from './routes';

export { RoomDurableObject } from './room-do';

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return dispatch(ROUTES, request, env, ctx, authenticate);
    return env.ASSETS.fetch(request);
  },

  // Expired sessions already resolve as guests; this only keeps the table small
  // (ACCOUNTS_SPEC_PHASE_2.md §6.6). It runs whether or not accounts are on:
  // with them off the table is empty and the purge costs one indexed DELETE.
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await purgeExpiredSessions(fromD1(env.DB), Date.now());
  },
} satisfies ExportedHandler<WorkerEnv>;
