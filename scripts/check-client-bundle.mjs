#!/usr/bin/env node
/**
 * Fails if server-only code has reached the browser bundle.
 *
 * `jose` verifies Google's ID tokens inside the Worker (ACCOUNTS_SPEC_PHASE_2.md
 * §5.2). It has no business in dist/client: the browser never sees a token,
 * and a copy there would mean an import chain from the UI into src/worker has
 * appeared. Vite would bundle it without complaint, so this checks the output.
 *
 * Run after `npm run build`:  node scripts/check-client-bundle.mjs [dir]
 * (dir defaults to dist/client). CI runs it on every build.
 *
 * It looks for jose's error codes, which survive minification because they
 * are string literals. So that the markers cannot quietly stop meaning
 * anything (a jose release renaming them), the script first confirms each one
 * really occurs in the installed jose, and fails if not.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const MARKERS = [
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWE_DECRYPTION_FAILED',
];

const root = path.resolve(import.meta.dirname, '..');
const target = path.resolve(root, process.argv[2] ?? 'dist/client');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const text = (list) => list.filter((f) => /\.(m?js|cjs|html)$/.test(f)).map((f) => [f, readFileSync(f, 'utf8')]);

function fail(message) {
  console.error(`check-client-bundle: ${message}`);
  process.exit(1);
}

// 1. The markers must identify jose, or finding none of them proves nothing.
const joseSource = text(files(path.join(root, 'node_modules/jose/dist')));
for (const marker of MARKERS) {
  if (!joseSource.some(([, body]) => body.includes(marker))) {
    fail(`marker ${marker} no longer occurs in node_modules/jose; update MARKERS`);
  }
}

// 2. None of them may appear in the browser bundle.
let bundle;
try {
  bundle = text(files(target));
} catch {
  fail(`${path.relative(root, target)} does not exist; run npm run build first`);
}
if (bundle.length === 0) fail(`no JavaScript found under ${path.relative(root, target)}`);

const hits = bundle.flatMap(([file, body]) =>
  MARKERS.filter((m) => body.includes(m)).map((m) => `${path.relative(root, file)}: ${m}`),
);
if (hits.length > 0) fail(`server-only code (jose) found in the client bundle:\n  ${hits.join('\n  ')}`);

console.log(`check-client-bundle: ${bundle.length} file(s) under ${path.relative(root, target)}, no jose`);
