import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryAssistantContinuityStore } from '../src/in-memory-continuity-store.js';
import { PostgresAssistantContinuityStore } from '../src/postgres-continuity-store.js';
import { describeContinuityStore } from './continuity-store-suite.js';

describe('in-memory continuity store', () => {
  describeContinuityStore('in-memory', () => new InMemoryAssistantContinuityStore());
});

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres continuity store', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresAssistantContinuityStore(pool);

  beforeAll(async () => {
    await store.ensureSchema();
    // Twice, because a boot that re-runs the schema must be a no-op rather than an error.
    await store.ensureSchema();
  });
  afterAll(async () => pool.end());

  describeContinuityStore('postgres', () => store);

  it('lets exactly one of several racing backends spend a handle', async () => {
    const now = new Date('2030-07-01T00:00:00Z');
    const context = {
      embedId: `emb_${Date.now()}`,
      originHash: 'origin-a',
      visitorHash: 'visitor-a',
    };
    const issued = await store.issue({
      sessionId: `sess_${Date.now()}`,
      tenant: { org: `race-${Date.now()}`, app: 'site', env: 'prod' },
      context,
      now,
    });
    if (issued === undefined) throw new Error('expected a handle');

    // The race the single-statement claim exists for: eight backends, one handle. A second winner
    // would mean one page-hop consumed two restores from the visitor's chain.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claim({ handle: issued.handle, context, now })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(7);
  });
});
