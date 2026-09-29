/**
 * The accounts database, as the Worker under test sees it.
 *
 * The webServer command in playwright.config.ts migrates the local D1 database
 * (`npm run db:migrate:local`) and then serves the build with `vite preview`.
 * Those are two different programs — wrangler and the Cloudflare Vite
 * plugin's miniflare — and nothing but their configuration says they share one
 * database. This asks the served Worker whether it can see the migration the
 * other program applied: `GET /api/health` answers 200 only if
 * `d1_migrations` in the Worker's own database records the newest migration
 * the code expects. A 503 here means they are looking at different databases
 * (or, locally, that a server started before a new migration is being reused —
 * restart it).
 */

import { expect, test } from '@playwright/test';

test('the Worker reads the database the suite migrated', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
