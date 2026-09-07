import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryAssistantElevationStore } from '../src/in-memory-elevation-store.js';
import { PostgresAssistantElevationStore } from '../src/postgres-elevation-store.js';
import { describeElevationStore } from './elevation-store-suite.js';

describe('in-memory elevation store', () => {
  describeElevationStore('in-memory', () => new InMemoryAssistantElevationStore());
});

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres elevation store', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresAssistantElevationStore(pool);

  beforeAll(async () => {
    await store.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => pool.end());

  describeElevationStore('postgres', () => store);

  it('lets exactly one of several racing backends spend a continuation', async () => {
    const now = new Date('2030-07-01T00:00:00Z');
    const tenant = { org: `race-${Date.now()}`, app: 'site', env: 'prod' };
    const { continuation } = await store.request({
      sessionId: `sess_${Date.now()}`,
      tenant,
      tool: 'my_orders',
      now,
    });

    // The race the single-statement claim exists for: eight backends, one elevation.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claim({ continuation, tenant, now })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(7);
  });
});
