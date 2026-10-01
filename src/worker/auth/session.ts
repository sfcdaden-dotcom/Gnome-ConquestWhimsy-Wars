/**
 * `authenticate`: who is this request? (ACCOUNTS_SPEC_PHASE_2.md §6.2.)
 *
 * PR 2-B: a stub that answers "guest" for everyone, so the router, its access
 * levels and the `Origin` rule can ship before sessions exist. PR 2-C replaces
 * the body with the session-cookie lookup; this stays the only module that
 * reads that cookie.
 */

import type { Auth } from './types';
import { GUEST } from './types';

export type Authenticate = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Auth>;

export const authenticate: Authenticate = async () => GUEST;
