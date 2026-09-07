import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SOURCE_MAX_REFRESH_KEYS,
  SOURCE_MAX_REPLICA_ROWS,
  SOURCE_METADATA_BYTES,
  SOURCE_ORG_CUSTODY_BYTES,
  SourceCapacityError,
} from '../src/business-information/source-custody-budget.js';
import { PostgresSourceIngestionStore } from '../src/business-information/source-ingestion-postgres-store.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';
import { refreshBinding } from './source-refresh-conformance.js';

describe.skipIf(process.env.DATABASE_URL_TEST === undefined)(
  'PostgreSQL source custody admission',
  () => {
    const schema = `source_budget_${randomUUID().replaceAll('-', '')}`;
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
    afterEach(async () => {
      await pool.query("UPDATE business_source_bindings SET state='paused'");
    });
    afterAll(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    async function fixture(org = randomUUID()) {
      const binding = refreshBinding(randomUUID());
      const scoped = { ...binding, scope: { ...binding.scope, org } };
      await pool.query(
        `INSERT INTO business_solution_installations (
      org_slug,app_slug,environment,installation_id,public_id,profile_key,profile_version,
      managed_collections,retention_days,revision,create_fingerprint,created_at,created_by_subject,updated_at,updated_by_subject
    ) VALUES ($1,$2,$3,$4,$4,'travel',1,ARRAY['stock'],30,1,'fixture',clock_timestamp(),'fixture',clock_timestamp(),'fixture')`,
        [org, scoped.scope.app, scoped.scope.env, scoped.scope.installationId],
      );
      await store.createBinding(scoped);
      return scoped;
    }
    async function claim() {
      const lease = await store.claimDue({
        now: new Date(),
        workerId: randomUUID(),
        leaseMs: 60_000,
      });
      if (lease === undefined) throw new Error('Missing lease');
      return lease;
    }
    async function setHeadroom(org: string, bytes: number) {
      // Synthetic near-cap accounting, not a claim to have retained 1 GiB of real test payloads.
      await pool.query(
        'UPDATE source_custody_organizations SET charged_bytes=$2 WHERE org_slug=$1',
        [org, SOURCE_ORG_CUSTODY_BYTES - bytes],
      );
    }
    async function recordCount(org: string) {
      const rows = await pool.query(
        'SELECT count(*)::int AS count FROM business_external_records WHERE org_slug=$1',
        [org],
      );
      return rows.rows[0].count;
    }

    it('rolls back the entire page and cursor when a later row crosses the org ceiling', async () => {
      const binding = await fixture();
      const lease = await claim();
      await setHeadroom(binding.scope.org, 20_000);
      await expect(
        store.commitPage({
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
        }),
      ).rejects.toBeInstanceOf(SourceCapacityError);
      expect(await recordCount(binding.scope.org)).toBe(0);
      expect(await store.getBinding(binding)).toMatchObject({ revision: lease.binding.revision });
    });

    it('serializes separate installations at one organization ceiling and isolates another organization', async () => {
      const first = await fixture();
      const firstLease = await claim();
      const second = await fixture(first.scope.org);
      const secondLease = await claim();
      await setHeadroom(first.scope.org, 20_000);
      const results = await Promise.allSettled(
        [firstLease, secondLease].map((lease) =>
          store.commitPage({
            lease,
            now: new Date(),
            page: {
              records: [{ id: 'A', record: { stock: 1 } }],
              deletedIds: [],
              complete: true,
            },
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
        { reason: { code: 'source_capacity_exceeded' } },
      ]);
      expect(await recordCount(first.scope.org)).toBe(1);
      const other = await fixture();
      await expect(
        store.commitPage({
          lease: await claim(),
          now: new Date(),
          page: {
            records: [{ id: 'A', record: { stock: 2 } }],
            deletedIds: [],
            complete: true,
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(await recordCount(other.scope.org)).toBe(1);
      expect(second.scope.installationId).not.toBe(first.scope.installationId);
    });

    it('funds erasure and durable suppression at the ceiling without losing replay protection', async () => {
      const binding = await fixture();
      await store.commitPage({
        lease: await claim(),
        now: new Date(),
        page: {
          records: [{ id: 'A', record: { stock: 1 } }],
          deletedIds: [],
          complete: true,
        },
      });
      await setHeadroom(binding.scope.org, 0);
      await store.suppressExternalRecord({
        ...binding,
        sourceId: 'A',
        reason: 'customer_request',
        now: new Date(),
      });
      expect(await store.listSuppressions(binding)).toHaveLength(1);
      expect((await store.listExternalRecords({ ...binding, generation: 1 })).records).toEqual([]);
      expect(await recordCount(binding.scope.org)).toBe(1);
      const retained = await pool.query(
        'SELECT content_ciphertext FROM business_external_records WHERE org_slug=$1',
        [binding.scope.org],
      );
      expect(retained.rows[0].content_ciphertext).toBeNull();
    });

    it('uses prepaid replacement space across pages while charging the genuinely new tombstone metadata', async () => {
      const binding = await fixture();
      const text = Array.from({ length: 5 }, () => 'x'.repeat(4_000));
      await store.commitPage({
        lease: await claim(),
        now: new Date(),
        page: {
          records: [
            { id: 'A', record: { text } },
            { id: 'B', record: { text } },
          ],
          deletedIds: [],
          complete: true,
        },
      });
      await setHeadroom(binding.scope.org, 4 * SOURCE_METADATA_BYTES);
      const current = await store.getBinding(binding);
      if (!current) throw new Error('Missing binding');
      // No manual receipt is needed: make the ordinary scheduled scan due in this controlled fixture.
      await pool.query(
        'UPDATE business_source_bindings SET next_attempt_at=clock_timestamp() WHERE org_slug=$1',
        [binding.scope.org],
      );
      const first = await store.commitPage({
        lease: await claim(),
        now: new Date(),
        page: {
          records: [{ id: 'C', record: { text } }],
          deletedIds: [],
          nextCursor: 'second',
          complete: false,
        },
      });
      if (!first.ok || !first.lease) throw new Error('Missing continuation');
      await expect(
        store.commitPage({
          lease: first.lease,
          now: new Date(),
          page: {
            records: [{ id: 'D', record: { text } }],
            deletedIds: [],
            complete: true,
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(
        (await store.listExternalRecords({ ...binding, generation: 1 })).records.map(
          (row) => row.source.id,
        ),
      ).toEqual(['C', 'D']);
      expect(await recordCount(binding.scope.org)).toBe(4);
    });

    it('bounds unique coalesced keys while preserving completed and pending replays', async () => {
      const binding = await fixture();
      const first = await store.requestRefresh({
        ...binding,
        expectedRevision: 1,
        idempotencyKey: 'original',
        now: new Date(),
      });
      if (!first.ok) throw new Error('Missing receipt');
      await pool.query(
        'UPDATE source_custody_installations SET refresh_keys=$2 WHERE installation_id=$1',
        [binding.scope.installationId, SOURCE_MAX_REFRESH_KEYS],
      );
      await expect(
        store.requestRefresh({
          ...binding,
          expectedRevision: first.binding.revision,
          idempotencyKey: 'another-key',
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(SourceCapacityError);
      await expect(
        store.requestRefresh({
          ...binding,
          expectedRevision: 1,
          idempotencyKey: 'original',
          now: new Date(),
        }),
      ).resolves.toMatchObject({ ok: true, receipt: { id: first.receipt.id } });
    });

    it('bounds retained identities and suppression slots without evicting deletion protection', async () => {
      const binding = await fixture();
      const lease = await claim();
      await pool.query(
        'UPDATE source_custody_installations SET replica_rows=$2 WHERE installation_id=$1',
        [binding.scope.installationId, SOURCE_MAX_REPLICA_ROWS],
      );
      await expect(
        store.commitPage({
          lease,
          now: new Date(),
          page: {
            records: [{ id: 'A', record: { stock: 1 } }],
            deletedIds: [],
            complete: true,
          },
        }),
      ).rejects.toBeInstanceOf(SourceCapacityError);
      expect(await recordCount(binding.scope.org)).toBe(0);
      await pool.query(
        'UPDATE source_custody_installations SET row_units=$2 WHERE installation_id=$1',
        [binding.scope.installationId, 2 * SOURCE_MAX_REPLICA_ROWS],
      );
      await expect(
        store.suppressExternalRecord({
          ...binding,
          sourceId: 'unseen-A',
          reason: 'customer_request',
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(SourceCapacityError);
      expect(await store.listSuppressions(binding)).toEqual([]);
    });

    it('does not reset a counter on startup and guards an older direct SQL source writer', async () => {
      const binding = await fixture();
      await setHeadroom(binding.scope.org, 0);
      await store.ensureSchema();
      const current = await pool.query(
        'SELECT charged_bytes FROM source_custody_organizations WHERE org_slug=$1',
        [binding.scope.org],
      );
      expect(Number(current.rows[0].charged_bytes)).toBe(SOURCE_ORG_CUSTODY_BYTES);
      await expect(
        pool.query(
          `INSERT INTO business_source_refresh_requests
      (org_slug,app_slug,environment,installation_id,collection_key,binding_id,binding_generation,idempotency_digest,job_id,state,requested_at)
      VALUES ($1,'stock','prod',$2,'stock','source',1,'fixture','old-writer','queued',clock_timestamp())`,
          [binding.scope.org, binding.scope.installationId],
        ),
      ).rejects.toMatchObject({ constraint: 'source_capacity_exceeded' });
    });

    it('expires only terminal receipts after 30 days, retains pending demand and keeps suppression indefinitely', async () => {
      const binding = await fixture();
      const first = await store.requestRefresh({
        ...binding,
        expectedRevision: 1,
        idempotencyKey: 'completed',
        now: new Date(),
      });
      if (!first.ok) throw new Error('Missing receipt');
      await store.commitPage({
        lease: await claim(),
        now: new Date(),
        page: { records: [], deletedIds: [], complete: true },
      });
      const replay = await store.requestRefresh({
        ...binding,
        expectedRevision: 1,
        idempotencyKey: 'completed',
        now: new Date(),
      });
      expect(replay).toMatchObject({
        ok: true,
        receipt: { state: 'completed', replayExpiresAt: expect.any(String) },
      });
      if (!replay.ok) throw new Error('Missing replay');
      await store.requestRefresh({
        ...binding,
        expectedRevision: replay.binding.revision,
        idempotencyKey: 'pending',
        now: new Date(),
      });
      await store.suppressExternalRecord({
        ...binding,
        sourceId: 'erased-A',
        reason: 'customer_request',
        now: new Date(),
      });
      await pool.query(
        `UPDATE business_source_refresh_requests SET requested_at=clock_timestamp()-interval '40 days',
      terminal_at=CASE WHEN state='completed' THEN clock_timestamp()-interval '30 days'-interval '1 second' ELSE NULL END WHERE org_slug=$1`,
        [binding.scope.org],
      );
      expect(await store.purgeExpired({ limit: 1 })).toBe(1);
      const rows = await pool.query(
        'SELECT state FROM business_source_refresh_requests WHERE org_slug=$1',
        [binding.scope.org],
      );
      expect(rows.rows).toEqual([{ state: 'queued' }]);
      expect(await store.listSuppressions(binding)).toHaveLength(1);
      await expect(
        store.requestRefresh({
          ...binding,
          expectedRevision: 1,
          idempotencyKey: 'pending',
          now: new Date(),
        }),
      ).resolves.toMatchObject({ ok: true, receipt: { state: 'queued' } });
    });
  },
);
