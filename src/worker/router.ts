/**
 * The `/api/*` router (ACCOUNTS_SPEC_PHASE_2.md §4 and §7).
 *
 * Every API route is declared once, in the table in ./routes.ts, with a
 * method, a path, an access level and an optional rate limit. This module
 * applies the same checks to every request, in one order (§7.1):
 *
 *   1. match the table; anything else, or a route switched off in this
 *      environment, is a JSON 404;
 *   2. the `Origin` rule (§7.2);
 *   3. the route's rate limit;
 *   4. `authenticate`, only when the route needs to know who is asking;
 *   5. the access level, so a refusal happens before any handler runs;
 *   6. the body rules, for a route that takes a body;
 *   7. the handler.
 *
 * Account status is enforced here and nowhere else (requirement P2-1): a
 * `user` handler receives an `ActiveUser`, which only `authenticate` can
 * construct, and the only routes a suspended or deleting account can reach
 * are the fixed self-exit allowlist below.
 */

import type { Authenticate } from './auth/session';
import { withClearedSession } from './auth/session';
import type { ActiveUser, Auth } from './auth/types';
import { GUEST } from './auth/types';
import type { LimitBinding, WorkerEnv } from './env';
import type { BodySpec } from './http';
import { callerKey, isWebSocketUpgrade, json, overLimit, readJsonBody, refuse, tooManyRequests } from './http';

export type Method = 'GET' | 'POST';

/**
 * - `public`: anyone. With `identity: 'optional'` the handler still learns
 *   who is asking, but the route never refuses over it.
 * - `user`: an active account only. A guest gets 401 `SIGNED_OUT`; a
 *   suspended or deleting account gets 403 `ACCOUNT_UNAVAILABLE`.
 * - `self-exit`: any signed-in account, whatever its status, so that it can
 *   find out its status and sign out. Only the allowlist may use it.
 */
export type Access = 'public' | 'user' | 'self-exit';

/** The only routes a suspended or deleting account can reach (ACCOUNTS.md §9.5). */
export const SELF_EXIT_ALLOWLIST: readonly string[] = ['POST /api/auth/logout', 'GET /api/me'];

export interface RouteContext<B> {
  request: Request;
  env: WorkerEnv;
  ctx: ExecutionContext;
  /** Path parameters, by name. Each matched `[A-Za-z0-9]+`. */
  params: Record<string, string>;
  /** The parsed body, for a route that declares one; otherwise undefined. */
  body: B;
}

interface RouteBase<B> {
  method: Method;
  /** e.g. `/api/rooms/:code/ws`. A `:name` segment matches `[A-Za-z0-9]+`. */
  path: string;
  limit?: LimitBinding;
  /**
   * Refuse a request by its parameters before its rate limit is spent, so
   * garbage that could never reach anything costs the caller nothing.
   */
  checkParams?(params: Record<string, string>): Response | null;
  /** JSON body rules. A route without this never has its body read. */
  body?: BodySpec<B>;
  /**
   * Whether the route exists in this environment. When false it answers the
   * same JSON 404 as an unknown path, before any other check: a route that is
   * off is indistinguishable from one that was never there (decision D2).
   */
  enabled?(env: WorkerEnv): boolean;
}

export type RouteDef<B> = RouteBase<B> &
  (
    | { access: 'public'; identity?: 'optional'; handler(c: RouteContext<B> & { auth: Auth }): Promise<Response> }
    | { access: 'user'; handler(c: RouteContext<B> & { user: ActiveUser }): Promise<Response> }
    | {
        access: 'self-exit';
        handler(c: RouteContext<B> & { auth: Exclude<Auth, { kind: 'guest' }> }): Promise<Response>;
      }
  );

/** A route in the table. The body type is checked where the route is defined, by `route()`. */
export type Route = RouteDef<unknown>;

/** Declare a route. Ties `body.parse`'s result to the type the handler receives. */
export function route<B = undefined>(def: RouteDef<B>): Route {
  return def as unknown as Route;
}

export function routeKey(r: Pick<Route, 'method' | 'path'>): string {
  return `${r.method} ${r.path}`;
}

/**
 * Throws if the table breaks a rule the types cannot: a duplicate route, an
 * unknown access level, or a self-exit route that is not on the allowlist.
 * The route-table tests run it over the real table.
 */
export function assertRouteTable(routes: readonly Route[]): void {
  const seen = new Set<string>();
  for (const r of routes) {
    const key = routeKey(r);
    if (seen.has(key)) throw new Error(`route declared twice: ${key}`);
    seen.add(key);
    if (!r.path.startsWith('/api/')) throw new Error(`not an API route: ${key}`);
    if (r.access !== 'public' && r.access !== 'user' && r.access !== 'self-exit') {
      throw new Error(`route has no valid access level: ${key}`);
    }
    if (r.access === 'self-exit' && !SELF_EXIT_ALLOWLIST.includes(key)) {
      throw new Error(`self-exit route not on the allowlist: ${key}`);
    }
  }
}

interface Compiled {
  route: Route;
  pattern: RegExp;
  names: string[];
}

const compiledTables = new WeakMap<readonly Route[], Compiled[]>();

function compile(routes: readonly Route[]): Compiled[] {
  let compiled = compiledTables.get(routes);
  if (!compiled) {
    compiled = routes.map((route) => {
      const names: string[] = [];
      const source = route.path
        .split('/')
        .map((segment) => {
          if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          names.push(segment.slice(1));
          return '([A-Za-z0-9]+)';
        })
        .join('/');
      return { route, pattern: new RegExp(`^${source}$`), names };
    });
    compiledTables.set(routes, compiled);
  }
  return compiled;
}

function find(routes: readonly Route[], method: string, pathname: string) {
  for (const { route, pattern, names } of compile(routes)) {
    if (route.method !== method) continue;
    const m = pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    names.forEach((name, i) => (params[name] = m[i + 1]));
    return { route, params };
  }
  return null;
}

/**
 * The `Origin` rule (§7.2, decision D5): the request's own origin, and no
 * list. Returns a refusal, or whether the request may carry an identity.
 *
 * - Anything but GET and HEAD needs an `Origin` equal to the origin the
 *   browser connected to. Browsers send it on every such request, the game's
 *   own `fetch('/api/rooms', { method: 'POST' })` included.
 * - A WebSocket upgrade with a foreign `Origin` is refused. One with no
 *   `Origin` is not a browser being ridden, so it may connect, but only ever
 *   as a guest.
 * - Other GETs are not checked: they change nothing, and with no CORS headers
 *   a page on another origin cannot read what they answer.
 */
function checkOrigin(request: Request, url: URL): { refused: Response } | { identity: boolean } {
  const origin = request.headers.get('Origin');
  const bad = { refused: refuse(403, 'BAD_ORIGIN') };
  if (request.method !== 'GET' && request.method !== 'HEAD' && origin !== url.origin) return bad;
  if (isWebSocketUpgrade(request)) {
    if (origin === null) return { identity: false };
    if (origin !== url.origin) return bad;
  }
  return { identity: true };
}

/** Answer one `/api/*` request from `routes`. */
export async function dispatch(
  routes: readonly Route[],
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  authenticate: Authenticate,
): Promise<Response> {
  const url = new URL(request.url);

  // 1. The table.
  const found = find(routes, request.method, url.pathname);
  if (!found) return json({ error: 'Not found' }, 404);
  const { route, params } = found;
  if (route.enabled && !route.enabled(env)) return json({ error: 'Not found' }, 404);
  const early = route.checkParams?.(params);
  if (early) return early;

  // 2. Origin.
  const origin = checkOrigin(request, url);
  if ('refused' in origin) return origin.refused;

  // 3. Rate limit.
  if (route.limit && (await overLimit(env[route.limit], callerKey(request)))) return tooManyRequests();

  // 4. Who is asking, only if this route will look. If the lookup itself
  // fails (D1 unreachable), a public route still runs, as a guest: it never
  // refuses over identity. A route that needs an account cannot, so it says so.
  const wantsAuth = route.access !== 'public' || route.identity === 'optional';
  let auth: Auth = GUEST;
  if (wantsAuth && origin.identity) {
    try {
      auth = await authenticate(request, env, ctx);
    } catch (err) {
      console.error('router: authenticate failed', { error: err instanceof Error ? err.name : typeof err });
      if (route.access !== 'public') return refuse(503, 'UNAVAILABLE');
    }
  }

  // 5–7. Access, body, handler. A cookie that named no live session is
  // cleared on whatever the answer is, refusals included.
  const res = await authorised(route, { request, env, ctx, params }, auth);
  return auth.kind === 'guest' && auth.staleSession ? withClearedSession(res) : res;
}

async function authorised(
  route: Route,
  base: { request: Request; env: WorkerEnv; ctx: ExecutionContext; params: Record<string, string> },
  auth: Auth,
): Promise<Response> {
  // 5. Access. Each case narrows `auth` to what its handler is owed.
  let run: (body: unknown) => Promise<Response>;
  switch (route.access) {
    case 'public':
      run = (body) => route.handler({ ...base, body, auth });
      break;
    case 'user': {
      if (auth.kind === 'guest') return refuse(401, 'SIGNED_OUT');
      if (auth.kind === 'unavailable') return refuse(403, 'ACCOUNT_UNAVAILABLE');
      const user = auth.user;
      run = (body) => route.handler({ ...base, body, user });
      break;
    }
    case 'self-exit': {
      if (auth.kind === 'guest') return refuse(401, 'SIGNED_OUT');
      const signedIn = auth;
      run = (body) => route.handler({ ...base, body, auth: signedIn });
      break;
    }
  }

  // 6. Body.
  if (!route.body) return run(undefined);
  const read = await readJsonBody(base.request, route.body);
  if (!read.ok) return read.response;

  // 7. The handler.
  return run(read.value);
}
