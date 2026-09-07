import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { PostgresSourceIngestionStore } from '../src/business-information/source-ingestion-postgres-store.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';
import { refreshBinding, sourceRefreshConformance } from './source-refresh-conformance.js';

describe.skipIf(process.env.DATABASE_URL_TEST === undefined)(
  'PostgreSQL source refresh acceptance',
  () => {
    const schema = `source_capacity_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL_TEST,
      max: 4,
      options: `-c search_path=${schema}`,
    });
    const store = new PostgresSourceIngestionStore(pool, new TestPayloadCipher(), {
      identityKey: 'fixture-source-identity-at-least-32-bytes',
    });
    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await store.ensureSchema();
    });
    afterAll(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    sourceRefreshConformance(async () => {
      const binding = refreshBinding(randomUUID());
      await pool.query(
        `INSERT INTO business_solution_installations (
      org_slug,app_slug,environment,installation_id,public_id,profile_key,profile_version,
      managed_collections,retention_days,revision,create_fingerprint,created_at,created_by_subject,updated_at,updated_by_subject
    ) VALUES ($1,$2,$3,$4,$4,'travel',1,ARRAY['stock'],30,1,'fixture',clock_timestamp(),'fixture',clock_timestamp(),'fixture')`,
        [binding.scope.org, binding.scope.app, binding.scope.env, binding.scope.installationId],
      );
      return { store, binding };
    });
  },
);
