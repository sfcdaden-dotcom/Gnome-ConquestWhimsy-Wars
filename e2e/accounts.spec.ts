/**
 * Accounts, as the Worker under test serves them.
 *
 * Local runs have accounts on (ACCOUNTS_SPEC_PHASE_2.md §3). CI has no
 * .dev.vars, so playwright.config.ts passes ACCOUNTS_ENABLED=true to
 * `vite preview` through the process environment. If that wiring broke, the
 * Worker would fall back to wrangler.jsonc's "false" and /api/me would answer
 * 404: this is the check that it did not.
 *
 * Sign-in itself, and the UI, are tested from PR 2-F.
 */

import { expect, test } from '@playwright/test';

test('accounts are on, and a guest is told it is signed out', async ({ request }) => {
  const res = await request.get('/api/me');
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'SIGNED_OUT' });
});

test('a stale session cookie is cleared, not trusted', async ({ request }) => {
  const res = await request.get('/api/me', { headers: { Cookie: `__Host-gw_session=${'a'.repeat(43)}` } });
  expect(res.status()).toBe(401);
  expect(res.headers()['set-cookie']).toMatch(/^__Host-gw_session=;.*Max-Age=0/);
});

test('signing out requires the page’s own origin', async ({ request, baseURL }) => {
  expect((await request.post('/api/auth/logout', { headers: { Origin: 'https://evil.example' } })).status()).toBe(403);
  expect((await request.post('/api/auth/logout', { headers: { Origin: baseURL! } })).status()).toBe(401);
});
