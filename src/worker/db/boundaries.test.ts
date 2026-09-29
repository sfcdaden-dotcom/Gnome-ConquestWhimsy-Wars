/**
 * The data-access rules that are easy to state and easy to break by accident
 * (ACCOUNTS_SPEC_PHASE_1.md §5), checked against the source itself.
 */

import { describe, expect, it } from 'vitest';

/**
 * Every TypeScript source file under src/, as text. Vite keys each file
 * relative to THIS file: `./identity.ts` for the db layer, `../index.ts` for the
 * Worker entry, `../../net/room.ts` for the rest of src/.
 */
const SOURCES = import.meta.glob('../../**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const inDbLayer = (path: string) => path.startsWith('./');
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

describe('the data-access boundary', () => {
  it('found the sources it is meant to police', () => {
    const paths = Object.keys(SOURCES);
    expect(paths).toContain('../index.ts');
    expect(paths).toContain('../room-do.ts');
    expect(paths).toContain('../../net/room.ts');
    expect(paths).toContain('./identity.ts');
    expect(paths).toContain('./sessions.ts');
  });

  it('keeps SQL inside src/worker/db/', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !inDbLayer(path) && !isTest(path))
      .filter(([, text]) => /\.prepare\(|\.batch\(/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('sets updated_at in every statement that updates a user', () => {
    // No trigger maintains updated_at; the repositories do, and this keeps
    // them honest as statements are added.
    const statements = Object.entries(SOURCES)
      .filter(([path]) => inDbLayer(path) && !isTest(path))
      .flatMap(([path, text]) =>
        [...text.matchAll(/UPDATE\s+users\s+SET\b[\s\S]*?(?=`)/g)].map((m) => ({ path, sql: m[0] })),
      );
    expect(statements.length).toBeGreaterThan(0);
    for (const { path, sql } of statements) expect(sql, path).toMatch(/updated_at\s*=/);
  });
});
