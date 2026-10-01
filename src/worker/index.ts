/**
 * Worker entry: a room API in front of the same static bundle the game has
 * always been.
 *
 *   /api/*          → the router (./router.ts), over the route table in ./routes.ts
 *   everything else → the SPA assets, exactly as before
 */

import { authenticate } from './auth/session';
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
} satisfies ExportedHandler<WorkerEnv>;
