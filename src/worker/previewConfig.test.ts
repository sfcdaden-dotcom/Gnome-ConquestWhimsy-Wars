/**
 * Branch previews get their bindings from `env.staging.previews` and from
 * nowhere else (DEPLOYMENT.md, "Branch previews"). Wrangler builds a preview's
 * bindings only from that block, plus ASSETS; it never copies the Worker's own
 * D1, Durable Object or rate-limit declarations. A binding added to staging
 * but not to `previews` would leave every preview without it, which is how
 * the first previews answered /api/health 503: they had no DB at all.
 *
 * Read through wrangler's own config reader, so this checks what wrangler
 * resolves (comments, environment inheritance and all), not a hand parse.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

const configPath = path.join(import.meta.dirname, '../../wrangler.jsonc');
const production = unstable_readConfig({ config: configPath });
const staging = unstable_readConfig({ config: configPath, env: 'staging' });

type Named = { binding?: string; name?: string };

/** Every binding name a config declares, by kind. ASSETS is added to previews by wrangler itself. */
function bindingNames(c: {
  d1_databases?: Named[];
  durable_objects?: { bindings?: Named[] };
  ratelimits?: Named[];
  kv_namespaces?: Named[];
  r2_buckets?: Named[];
  services?: Named[];
  queues?: { producers?: Named[] };
  vars?: Record<string, unknown>;
}): Record<string, string[]> {
  const names = (list: Named[] | undefined) => (list ?? []).map((b) => b.binding ?? b.name ?? '').sort();
  return {
    d1_databases: names(c.d1_databases),
    durable_objects: names(c.durable_objects?.bindings),
    ratelimits: names(c.ratelimits),
    kv_namespaces: names(c.kv_namespaces),
    r2_buckets: names(c.r2_buckets),
    services: names(c.services),
    queues: names(c.queues?.producers),
    vars: Object.keys(c.vars ?? {}).sort(),
  };
}

const previews = staging.previews;

describe('branch previews (env.staging.previews)', () => {
  it('exists', () => {
    expect(previews).toBeDefined();
  });

  it('declares every binding staging declares, and nothing else', () => {
    expect(bindingNames(previews ?? {})).toEqual(bindingNames(staging));
  });

  it('uses staging’s own database, never production’s', () => {
    const db = (c: { d1_databases?: Array<{ binding: string; database_id?: string }> }) =>
      c.d1_databases?.find((d) => d.binding === 'DB')?.database_id;
    expect(db(previews ?? {})).toBe(db(staging));
    expect(db(previews ?? {})).not.toBe(db(production));
  });

  it('binds ROOMS to the same Durable Object class as staging', () => {
    const cls = (c: { durable_objects?: { bindings?: Array<{ name: string; class_name: string }> } }) =>
      c.durable_objects?.bindings?.find((b) => b.name === 'ROOMS')?.class_name;
    expect(cls(previews ?? {})).toBe(cls(staging));
  });

  it('has staging’s rate limits, in namespaces nobody else uses', () => {
    type Limit = { name: string; namespace_id: string; simple: unknown };
    const byName = (list: Limit[] | undefined) => new Map((list ?? []).map((l) => [l.name, l]));
    const mine = byName(previews?.ratelimits as Limit[] | undefined);
    const theirs = byName(staging.ratelimits as Limit[] | undefined);
    for (const [name, limit] of theirs) expect(mine.get(name)?.simple, name).toEqual(limit.simple);

    const taken = new Set(
      [...(staging.ratelimits ?? []), ...(production.ratelimits ?? [])].map((l) => String(l.namespace_id)),
    );
    const ids = [...mine.values()].map((l) => String(l.namespace_id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(taken.has(id), `namespace ${id}`).toBe(false);
  });
});

describe('production', () => {
  it('declares no previews: no branch preview may ever be bound to production’s database', () => {
    expect(production.previews).toBeUndefined();
  });
});

describe('accounts switch and cron, per environment (D2, D7, §6.6)', () => {
  it('accounts are off in production, on in staging, off in branch previews', () => {
    expect(production.vars).toMatchObject({ ACCOUNTS_ENABLED: 'false' });
    expect(staging.vars).toMatchObject({ ACCOUNTS_ENABLED: 'true' });
    expect(previews?.vars).toMatchObject({ ACCOUNTS_ENABLED: 'false' });
  });

  it('both environments purge expired sessions daily', () => {
    expect(production.triggers.crons).toEqual(['17 3 * * *']);
    expect(staging.triggers.crons).toEqual(['17 3 * * *']);
  });
});

