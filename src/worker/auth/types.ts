/**
 * Who a request is (ACCOUNTS.md §9.5). `authenticate` (./session.ts) answers
 * that; the router decides from it, once, whether a route may run.
 */

declare const activeUser: unique symbol;

/**
 * An account whose status was `active` when this request was authenticated.
 * Only `authenticate` constructs one, so a handler for a `user` route, which
 * receives an `ActiveUser`, cannot be written against a suspended or deleting
 * account (requirement P2-1).
 */
export interface ActiveUser {
  readonly id: string;
  readonly [activeUser]: true;
}

export type Auth =
  /**
   * `staleSession`: the request carried a session cookie that matches no live
   * session (unknown, expired or revoked). It is a guest, and the router
   * clears the cookie on the way out so the browser stops sending it.
   */
  | { kind: 'guest'; staleSession?: true }
  | { kind: 'user'; user: ActiveUser }
  | { kind: 'unavailable'; userId: string; status: 'suspended' | 'deleting' };

export const GUEST: Auth = Object.freeze({ kind: 'guest' });

/**
 * The header that tells a room which account a socket is signed in as
 * (ACCOUNTS_SPEC_PHASE_2.md §8.1). Only the Worker may set it: every request
 * forwarded to a room has any client-supplied copy deleted first.
 */
export const ACCOUNT_HEADER = 'x-gw-account';
