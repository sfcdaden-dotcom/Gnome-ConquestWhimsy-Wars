/**
 * The account API's response bodies, shared by the Worker that builds them and
 * the client that reads them (ACCOUNTS_SPEC_PHASE_2.md §6.5).
 *
 * Every body is built field by field by a mapper here, never by serialising a
 * database row (ACCOUNTS.md §9.5, "Explicit DTOs"). A snapshot test pins each
 * key set, so a new field is always a deliberate change.
 */

export type AccountStatus = 'active' | 'suspended' | 'deleting';

/**
 * `GET /api/me` for a signed-in caller. The status, and nothing else: the user
 * id is never sent, because the `users` row is private (Phase 1 §3). Phase 3
 * adds `needsUsername` and `username`.
 */
export interface MeResponse {
  status: AccountStatus;
}

export function toMeResponse(status: AccountStatus): MeResponse {
  return { status };
}
