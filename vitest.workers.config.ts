// The Workers-runtime test project (`npm run test:workers`): tests that must
// run inside workerd, against real local D1, rather than on Node
// (ACCOUNTS.md §9.5, requirement P2-2). They are named *.workers.test.ts; the
// Node project in vite.config.ts excludes them, and this one runs nothing else.
//
// The bindings come from wrangler.jsonc itself (the top-level environment,
// never --env), so what these tests see is what `vite preview` and production
// see. The database is local and in-memory: nothing here reaches Cloudflare.

import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: path.join(root, 'wrangler.jsonc') },
      miniflare: {
        // The real migration files, handed to the tests so they can apply
        // them to the test database (see src/worker/db/d1TestEnv.ts).
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(root, 'migrations')) },
        // A second, disposable local D1 for testing the migrations themselves:
        // those tests need a database at 0001 only, which DB never is again
        // once the suites have migrated it.
        d1Databases: ['MIGRATION_DB'],
      },
    })),
  ],
  test: {
    include: ['src/**/*.workers.test.ts'],
  },
});
