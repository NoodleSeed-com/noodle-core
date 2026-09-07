import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOURCE_METADATA_BYTES } from '../src/business-information/source-custody-budget.js';
import { PostgresSourceIngestionStore } from '../src/business-information/source-ingestion-postgres-store.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';
import { refreshBinding } from './source-refresh-conformance.js';

describe.skipIf(process.env.DATABASE_URL_TEST === undefined)(
  'source custody additive migration',
  () => {
    const schema = `source_migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL_TEST,
      max: 1,
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

    it('backfills existing encrypted data, tombstones, suppression and receipts without changing their authority', async () => {
      const binding = refreshBinding(randomUUID());
      const { scope } = binding;
      await pool.query(
        `INSERT INTO business_solution_installations (
      org_slug,app_slug,environment,installation_id,public_id,profile_key,profile_version,
      managed_collections,retention_days,revision,create_fingerprint,created_at,created_by_subject,updated_at,updated_by_subject
    ) VALUES ($1,$2,$3,$4,$4,'travel',1,ARRAY['stock'],30,1,'fixture',clock_timestamp(),'fixture',clock_timestamp(),'fixture')`,
        [scope.org, scope.app, scope.env, scope.installationId],
      );
      await store.createBinding(binding);
      const request = await store.requestRefresh({
        ...binding,
        expectedRevision: 1,
        idempotencyKey: 'old-completed',
        now: new Date(),
      });
      if (!request.ok) throw new Error('Missing receipt');
      const lease = await store.claimDue({
        now: new Date(),
        workerId: 'migration-fixture',
        leaseMs: 60_000,
      });
      if (!lease) throw new Error('Missing lease');
      await store.commitPage({
        lease,
        now: new Date(),
        page: {
          records: [
            { id: 'A', record: { stock: 1 } },
            { id: 'B', record: { stock: 2 } },
          ],
          deletedIds: [],
          complete: true,
        },
      });
      await store.suppressExternalRecord({
        ...binding,
        sourceId: 'B',
        reason: 'customer_request',
        now: new Date(),
      });
      const before = await pool.query('SELECT * FROM business_external_records ORDER BY record_id');
      const suppression = await store.listSuppressions(binding);
      const accepted = await store.getBinding(binding);
      // Recreate the pre-capacity table shape, with actual retained rows rather than mock counters.
      await pool.query(`DROP FUNCTION source_custody_guard() CASCADE;
      DROP FUNCTION source_custody_deferred_check() CASCADE;
      DROP FUNCTION source_custody_check_transaction();
      DROP FUNCTION source_custody_projected(text,jsonb,bigint);
      DROP FUNCTION source_custody_charge(bigint,bigint,bigint);
      DROP FUNCTION source_custody_cost(text,jsonb);
      DROP TABLE source_custody_bindings,source_custody_installations,source_custody_organizations;
      ALTER TABLE business_source_refresh_requests DROP COLUMN target_scan_generation;
      ALTER TABLE business_source_refresh_requests DROP COLUMN terminal_at`);
      const cutover = new Date();
      await store.ensureSchema();
      expect(
        (await pool.query('SELECT * FROM business_external_records ORDER BY record_id')).rows,
      ).toEqual(before.rows);
      expect(await store.listSuppressions(binding)).toEqual(suppression);
      expect(await store.getBinding(binding)).toEqual(accepted);
      const usage = await pool.query(
        'SELECT replica_rows,row_units,refresh_keys FROM source_custody_installations',
      );
      expect(usage.rows).toEqual([{ replica_rows: '2', row_units: '4', refresh_keys: '1' }]);
      const retained = await pool.query('SELECT retained_bytes FROM source_custody_bindings');
      const org = await pool.query('SELECT charged_bytes FROM source_custody_organizations');
      expect(Number(org.rows[0].charged_bytes)).toBe(
        2 * Number(retained.rows[0].retained_bytes) + 2 * SOURCE_METADATA_BYTES,
      );
      const replay = await store.requestRefresh({
        ...binding,
        expectedRevision: 1,
        idempotencyKey: 'old-completed',
        now: new Date(),
      });
      expect(replay).toMatchObject({
        ok: true,
        receipt: { id: request.receipt.id, state: 'completed' },
      });
      if (!replay.ok || !replay.receipt.replayExpiresAt) throw new Error('Missing bounded replay');
      expect(Date.parse(replay.receipt.replayExpiresAt)).toBeGreaterThanOrEqual(
        cutover.getTime() + 30 * 86_400_000,
      );
      await store.ensureSchema();
      expect(
        (await pool.query('SELECT charged_bytes FROM source_custody_organizations')).rows,
      ).toEqual(org.rows);
    });
  },
);
