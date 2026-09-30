/**
 * How local-only values reach the Worker in local runs and e2e, and the one
 * way of doing it that must never happen (ACCOUNTS_SPEC_PHASE_2.md §3).
 *
 * `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` hands the process environment to the
 * Worker as bindings. On `vite preview` (or `wrangler dev`) that is what e2e
 * wants. On a BUILD it is a leak: the Cloudflare Vite plugin writes the
 * environment it was built with into dist/gnomeconquest/.dev.vars, every
 * variable of it, CI's included. So the flag may only ever be set on the
 * command that serves, never on one that builds. This checks every place a
 * command is written: package.json scripts, the Playwright web server, and CI.
 */

import { describe, expect, it } from 'vitest';

// One glob per pattern, options inline: Vite resolves these at build time and
// cannot read options from a variable.
const FILES = {
  ...(import.meta.glob('../../package.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>),
  ...(import.meta.glob('../../playwright.config.ts', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>),
  ...(import.meta.glob('../../.github/workflows/*.yml', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>),
};

const FLAG = 'CLOUDFLARE_INCLUDE_PROCESS_ENV';

/**
 * Each use of the flag, with the shell command it applies to: from the flag
 * to the end of its command (`&&`, `;`, `|`, a newline, or a closing quote).
 * A use is safe only if that command serves rather than builds.
 */
export function unsafeUses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`${FLAG}[^\\n;&|"'\`]*`, 'g'))) {
    const command = m[0];
    const serves = /\b(?:vite preview|wrangler dev)\b/.test(command);
    const builds = /\b(?:build|deploy)\b/.test(command);
    if (!serves || builds) out.push(command.trim());
  }
  return out;
}

describe('local-only environment values', () => {
  it('found the files commands are written in', () => {
    const names = Object.keys(FILES);
    expect(names).toContain('../../package.json');
    expect(names).toContain('../../playwright.config.ts');
    expect(names.some((n) => n.endsWith('/ci.yml'))).toBe(true);
  });

  it('are never passed to a build through the process environment', () => {
    for (const [file, text] of Object.entries(FILES)) expect(unsafeUses(text), file).toEqual([]);
  });

  it('the check itself tells a serving command from a building one', () => {
    expect(unsafeUses('CLOUDFLARE_INCLUDE_PROCESS_ENV=true npx vite preview --port 4173')).toEqual([]);
    expect(unsafeUses('npm run build && CLOUDFLARE_INCLUDE_PROCESS_ENV=true wrangler dev')).toEqual([]);
    expect(unsafeUses('CLOUDFLARE_INCLUDE_PROCESS_ENV=true npm run build')).toHaveLength(1);
    expect(unsafeUses('"build": "CLOUDFLARE_INCLUDE_PROCESS_ENV=true vite build"')).toHaveLength(1);
    expect(unsafeUses('env:\n  CLOUDFLARE_INCLUDE_PROCESS_ENV: true\nrun: npm run build')).toHaveLength(1);
  });
});
