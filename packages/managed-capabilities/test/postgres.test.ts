import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresCapabilityPolicyStore } from '../src/postgres.js';
import { policyStoreConformance } from './policy-conformance.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL capability policy authority', () => {
  const schema = 'capability_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: '-c search_path=' + schema,
  });
  const store = new PostgresCapabilityPolicyStore(pool);
  beforeAll(async () => {
    await admin.query('CREATE SCHEMA ' + schema);
    await store.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  policyStoreConformance(async () => {
    await pool.query('TRUNCATE capability_policies');
    return store;
  });
  it('survives connection restart and is shared across instances', async () => {
    const scope = { org: 'recovery', app: 'demo', env: 'staging', name: 'pages' };
    const record = await store.replace(scope, {
      expectedRevision: 0,
      mutationId: 'restart',
      actor: 'owner',
      policy: { enabled: true, dailyCalls: 3 },
    });
    const reopened = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      options: '-c search_path=' + schema,
    });
    try {
      expect(await new PostgresCapabilityPolicyStore(reopened).get(scope)).toEqual(record);
    } finally {
      await reopened.end();
    }
  });
});
