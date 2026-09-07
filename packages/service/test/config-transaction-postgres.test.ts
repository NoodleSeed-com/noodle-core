import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { describeConfigTransactions } from './config-transaction-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL configuration authority', () => {
  const schema = `config_tx_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  const store = new PostgresArtifactStore(pool);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  describeConfigTransactions('portable configuration transaction conformance', async () => {
    await pool.query('TRUNCATE config_values');
    return store;
  });
});
