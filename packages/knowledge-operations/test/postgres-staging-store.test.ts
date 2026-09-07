import { Pool } from 'pg';
import { afterAll, describe } from 'vitest';
import { PostgresKnowledgeStagingStore } from '../src/postgres-staging-store.js';
import { describeStagingStore } from './staging-store-parity.js';

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

const conditional = describe.skipIf(databaseUrl === undefined);

const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });

afterAll(async () => {
  await pool?.end();
});

conditional('postgres knowledge staging store', () => {
  describeStagingStore(async (now) => {
    if (pool === undefined) throw new Error('DATABASE_URL suite ran without a pool');
    const store = new PostgresKnowledgeStagingStore(pool, now);
    await store.ensureSchema();
    // Same starting universe as a fresh in-memory store, or parity compares different populations.
    await pool.query('TRUNCATE knowledge_staging_documents');
    return store;
  });
});
