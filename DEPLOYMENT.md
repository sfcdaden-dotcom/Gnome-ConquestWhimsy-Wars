# Deploying Whimsy Wars

Whimsy Wars ships as **a static bundle plus an optional multiplayer Worker**.

- **Single-device play** (hot-seat and CPU) is still fully client-only and
  makes **zero network requests** after loading. Host the bundle anywhere.
- **Multiplayer** (private rooms — see [MULTIPLAYER.md](MULTIPLAYER.md)) needs
  the Cloudflare Worker and its Durable Objects, so it is Cloudflare-specific.
  A static-only deploy still runs local play; the Online screen just reports
  that room creation failed, rather than hanging on a dead button.

`npm run build` produces both: `dist/client/` (the bundle) and
`dist/gnomeconquest/` (the Worker).

## Build

```bash
npm ci
npm test          # 71 tests must pass
npm run build     # tsc -b (strict) && vite build → dist/
npm run preview   # sanity-check the production bundle locally
```

The bundle uses a **relative base path** (`base: './'`), so it works at a
domain root *and* under a subpath (e.g. GitHub Pages' `/repo-name/`).

## Recommended hosts

Any of these free tiers is more than enough. **Cloudflare Pages or Netlify are
preferred** because they honor the `public/_headers` file (full security
headers including `frame-ancestors`, plus immutable caching for hashed
assets).

### Cloudflare Workers (required for multiplayer)
1. `npm run deploy` — builds and publishes the Worker, its assets and the
   `ROOMS` Durable Object namespace (declared in `wrangler.jsonc`).
2. `npx wrangler dev` runs the whole thing locally, rooms included — the
   per-IP rate-limit bindings (`ROOM_CREATE_LIMIT`, `ROOM_JOIN_LIMIT`, also
   declared in `wrangler.jsonc`) are enforced locally too, so a local run
   behaves like the deployed one. Both are optional in the Worker's env type:
   a runtime that does not provide them serves unlimited rather than failing
   to boot. The limits inside a room are the room's own and need no binding —
   see MULTIPLAYER.md, "Rate limiting".
3. Durable Objects are the only paid-tier requirement; everything else fits
   the free tier.

### The accounts database (D1) and staging

Accounts (ACCOUNTS.md) add one Cloudflare D1 database per environment. Its
schema is the `migrations/` folder: numbered SQL files, applied in order and
recorded by wrangler in the database's `d1_migrations` table.

**One-time setup: done 2026-09-29.** Both databases exist
(`gnomeconquest` and `gnomeconquest-staging`), and their ids are pinned in
`wrangler.jsonc`. The ids are identifiers, not secrets. A new environment
would repeat this: create the database (dashboard, or
`npx wrangler d1 create <name>`) and pin its id in that environment's
`d1_databases` entry.

**Every release that includes a migration, in this order:**

1. `npm run db:migrate:staging`, then `npm run deploy:staging`, then check
   staging.
2. `npm run db:migrate:prod`, then `npm run deploy`.
3. After deploying, `GET /api/health` should answer `200`. A `503` means the
   code expects a migration the database does not have.

**Rules:**

- **Migrate first, then deploy.** The code being replaced must keep working
  against the new schema, and the new code against the old one for the few
  minutes in between. So a migration only ever *adds* (expand); removing
  anything the old code used waits for a later release (contract).
- **A migration applied to production is never edited.** Every change is a
  new, higher-numbered file. `migrations/0001_identity.sql` is frozen, and a
  unit test pins its hash.
- **Nothing automated touches a remote database.** Unit tests use an
  in-memory SQLite that runs the same migrations
  (`src/worker/db/testDb.ts`). Local runs and the Playwright suite use
  miniflare's local D1 under `.wrangler/` (git-ignored), migrated by
  `npm run db:migrate:local`. Production data is never copied to staging or
  to a developer machine.
- The `db:*` scripts pass `-c wrangler.jsonc` explicitly, so they always read
  the source config, never the last build's output.

`npm run deploy:staging` builds with `CLOUDFLARE_ENV=staging` (POSIX shells),
so the staging Worker, its database and its Durable Object namespace are
separate from production's. Staging rooms and production rooms never meet.


1. Create the account and a new project (drag-and-drop the `dist/` folder, or
   connect a git repository).
2. If connecting git: build command `npm run build`, output directory `dist`.
3. Done — `_headers` is picked up automatically from the build output.

### GitHub Pages
1. Push the repo to GitHub; enable Pages (deploy from a branch or an Actions
   workflow that runs `npm run build` and publishes `dist/`).
2. Works out of the box thanks to the relative base path.
3. Caveat: Pages ignores `_headers`. The build-time CSP `<meta>` tag still
   applies the script/style/img policy; only `frame-ancestors`/`X-Frame-Options`
   (clickjacking) and cache tuning are lost. Acceptable for a game, but
   header-aware hosts are stricter.

### Vercel
Works the same as Netlify; to get the custom headers, mirror `public/_headers`
into a `vercel.json` `headers` entry (Vercel doesn't read `_headers`).

## Security posture (what's already done)

- **CSP**: `connect-src 'self'` already permits the room WebSocket (same
  origin) and nothing else. Injected into `index.html` at build time (dev mode is exempt —
  Vite's dev tooling needs inline scripts): `default-src 'none'` with narrow
  allowances; no external origins of any kind. Mirrored with `frame-ancestors
  'none'` in `_headers`.
- **Headers** (`public/_headers`): `nosniff`, `no-referrer`, frame denial,
  restrictive `Permissions-Policy`, COOP/CORP.
- **No data collection**: no cookies, no telemetry, no third-party anything.
  Single-device play still makes no network calls at all. Multiplayer
  necessarily adds some state: a room holds a board, seat names and a private
  per-player reconnect token for the length of one game, and the client keeps
  that token in localStorage so a refresh does not cost you your seat. No
  accounts, no email, no persistence beyond the room.
- **Dependencies**: `npm audit` — 0 vulnerabilities (2026-07-16). Re-run
  before each release.
- **Cheating, single-device**: out of scope. The whole game runs client-side;
  a player "hacking" their own hot-seat game affects only themselves.
- **Cheating, multiplayer**: the room is authoritative. Clients hold no game
  state — they render `viewFor(state, theirSeat)`, so hands, the draw pile and
  the RNG never reach them — and every action is checked against the seat the
  *connection* holds before the engine is asked. The deck is sealed behind a
  server secret and published, via commit–reveal, only when the game ends. See
  [MULTIPLAYER.md](MULTIPLAYER.md), and TECH_DEBT.md for the limits this does
  not claim to cover.

## Pre-release checklist (human steps)

- [x] **License**: proprietary, all rights reserved — see `LICENSE`.
- [ ] **Initialize git + push** (`git init`) if deploying via a connected
      repository — also your rollback story.
- [ ] Pick the host, create the account yourself, and deploy `dist/`.
- [ ] After the first deploy: load the site, open devtools, confirm zero
      console errors and that the CSP header/meta is present.
- [ ] Optionally set a custom domain (all hosts above provide HTTPS
      automatically — never serve over plain HTTP).

## Browser support baseline

Evergreen browsers (2023+): the app uses `structuredClone`, CSS `color-mix()`,
container queries, and `dvh` units. No IE/legacy support by design.
