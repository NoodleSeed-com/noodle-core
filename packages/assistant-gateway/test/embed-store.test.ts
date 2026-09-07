import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicEmbedId, parsePublicEmbedBudget } from '../src/embed-store.js';
import { InMemoryPublicEmbedStore, newPublicEmbedId } from '../src/in-memory-embed-store.js';
import { PostgresPublicEmbedStore } from '../src/postgres-embed-store.js';
import { describeEmbedStore } from './embed-parity.js';

describe('public embed ids', () => {
  it('are self-describing and unguessable', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newPublicEmbedId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isPublicEmbedId(id)).toBe(true);
  });

  it('rejects shapes that are not public embed ids', () => {
    expect(isPublicEmbedId('sk_live_abcdefghijklmnopqrst')).toBe(false);
    expect(isPublicEmbedId('pub_short')).toBe(false);
    expect(isPublicEmbedId('')).toBe(false);
  });
});

describe('in-memory public embed store', () => {
  describeEmbedStore(async () => new InMemoryPublicEmbedStore());
});

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres public embed store', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresPublicEmbedStore(pool);

  beforeAll(async () => {
    await store.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => pool.end());

  describeEmbedStore(async () => store);

  it('mints one id under concurrent deploys of the same surface', async () => {
    const target = { org: `race-${Date.now()}`, app: 'site', env: 'prod' };
    const now = new Date('2030-07-01T00:00:00Z');
    // Two deploys landing together must not leave two live ids for one surface.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.ensure({ ...target, surfaceMode: 'public', now })),
    );
    expect(new Set(results.map((r) => r.embedId)).size).toBe(1);
    expect(await store.list(target)).toHaveLength(1);
  });
});

/**
 * The operator budget body, which arrives as parsed JSON from a PATCH and reaches `::bigint` columns.
 *
 * Two shapes get past a naive read: `null`, which `typeof` calls an object and a property access
 * turns into a 500, and an integer past 2^53, which `Number.isInteger` accepts although the value
 * the operator typed is already gone by the time it is read.
 */
describe('operator budget bodies', () => {
  it('refuses a body that is not an object rather than throwing', () => {
    for (const body of [null, undefined, 42, 'turnsPerDay=1', [1, 2]]) {
      expect(parsePublicEmbedBudget(body)).toMatchObject({ ok: false });
    }
  });

  it('refuses a number too large to have survived the trip', () => {
    expect(parsePublicEmbedBudget({ turnsPerDay: Number.MAX_SAFE_INTEGER + 2 })).toMatchObject({
      ok: false,
    });
    expect(parsePublicEmbedBudget({ turnsPerDay: 1e308 })).toMatchObject({ ok: false });
    // The boundary itself is fine; the clamp above the parser is what makes it harmless.
    expect(parsePublicEmbedBudget({ turnsPerDay: Number.MAX_SAFE_INTEGER })).toMatchObject({
      ok: true,
    });
  });

  it('still takes zero, the kill switch', () => {
    expect(parsePublicEmbedBudget({ turnsPerDay: 0 })).toEqual({
      ok: true,
      value: { turnsPerDay: 0 },
    });
  });
});
