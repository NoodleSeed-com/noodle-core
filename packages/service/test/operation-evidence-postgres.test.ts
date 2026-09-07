import { randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { PostgresOperationEvidenceStore } from '../src/operation-evidence-postgres.js';
import { describeOperationEvidence } from './operation-evidence-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL operation evidence', () => {
  const schema = `operation_evidence_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  const store = new PostgresOperationEvidenceStore(
    pool,
    new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 11).toString('base64'))),
  );
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  describeOperationEvidence(async () => {
    await pool.query('TRUNCATE operation_evidence, operation_history_settings');
    return store;
  });
});
