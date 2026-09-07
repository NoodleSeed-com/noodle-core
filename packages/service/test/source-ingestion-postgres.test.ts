import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstallationScope } from '../src/business-information/contracts.js';
import type { SourceBindingCreate } from '../src/business-information/source-ingestion-contracts.js';
import { PostgresSourceIngestionStore } from '../src/business-information/source-ingestion-postgres-store.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres source ingestion store', () => {
  const schema = `source_ingestion_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  const identityKey = 'test-source-identity-key-with-32-bytes';
  const cipher = new TestPayloadCipher();
  const store = new PostgresSourceIngestionStore(pool, cipher, { identityKey });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await store.ensureSchema();
    await pool.query(
      `INSERT INTO business_solution_installations (
        org_slug, app_slug, environment, installation_id, public_id,
        profile_key, profile_version, managed_collections, retention_days,
        revision, create_fingerprint, created_at, created_by_subject,
        updated_at, updated_by_subject
      ) VALUES (
        'acme','operations','prod','installation-one','public-one',
        'travel',1,ARRAY['stock'],30,1,'fixture',clock_timestamp(),'test',clock_timestamp(),'test'
      )`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('recovers a continued scan across instances and fences the expired worker', async () => {
    await store.createBinding(binding);
    const first = await store.claimDue({
      now: new Date(0),
      workerId: 'worker-one',
      leaseMs: 60_000,
    });
    expect(first).toBeDefined();
    const committed = await store.commitPage({
      lease: required(first),
      now: new Date(0),
      page: {
        records: [{ id: 'sku-a', version: 'v1', record: { quantity: 2 } }],
        deletedIds: [],
        nextCursor: 'page-two',
        complete: false,
      },
    });
    expect(committed).toMatchObject({ ok: true, lease: { cursor: 'page-two' } });

    const restarted = new PostgresSourceIngestionStore(pool, cipher, { identityKey });
    await expect(restarted.getBinding(binding)).resolves.toMatchObject({ cursor: 'page-two' });
    await pool.query(`UPDATE business_source_bindings
      SET lease_expires_at=clock_timestamp()-interval '1 second'`);
    const second = await restarted.claimDue({
      now: new Date(0),
      workerId: 'worker-two',
      leaseMs: 60_000,
    });
    expect(second).toMatchObject({ mode: 'snapshot', cursor: 'page-two' });
    expect(required(second).fence).toBeGreaterThan(required(first).fence);

    await expect(
      store.commitPage({
        lease: required(first),
        now: new Date(0),
        page: { records: [], deletedIds: [], complete: true },
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale_fence' });
    await expect(
      restarted.commitPage({
        lease: required(second),
        now: new Date(0),
        page: {
          records: [{ id: 'sku-b', version: 'v1', record: { quantity: 3 } }],
          deletedIds: [],
          checkpoint: 'checkpoint-one',
          complete: true,
        },
      }),
    ).resolves.toMatchObject({ ok: true, binding: { health: 'current' } });
    await expect(restarted.listExternalRecords(binding)).resolves.toMatchObject({
      records: [
        { source: { id: 'sku-a' }, record: { quantity: 2 } },
        { source: { id: 'sku-b' }, record: { quantity: 3 } },
      ],
    });

    const firstPage = await restarted.listExternalRecords({ ...binding, limit: 1 });
    expect(firstPage.records).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    const secondPage = await restarted.listExternalRecords({
      ...binding,
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    expect(secondPage.records).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(
      [...firstPage.records, ...secondPage.records].map((item) => item.source.id).sort(),
    ).toEqual(['sku-a', 'sku-b']);
    const secondRecord = required(secondPage.records[0]);
    await expect(
      restarted.getExternalRecord({ ...binding, recordId: secondRecord.id }),
    ).resolves.toMatchObject({ id: secondRecord.id, source: { id: secondRecord.source.id } });
  });

  it('durably suppresses erased source identities and never stores their plaintext identity', async () => {
    const restarted = new PostgresSourceIngestionStore(pool, cipher, { identityKey });
    await restarted.suppressExternalRecord({
      ...binding,
      sourceId: 'sku-a',
      reason: 'customer_request',
      now: new Date(0),
    });
    const anotherProcess = new PostgresSourceIngestionStore(pool, cipher, { identityKey });
    await expect(anotherProcess.listExternalRecords(binding)).resolves.toMatchObject({
      records: [{ source: { id: 'sku-b' } }],
    });
    await expect(anotherProcess.listSuppressions(binding)).resolves.toHaveLength(1);

    const raw = await pool.query(`SELECT source_identity_digest, content_ciphertext
      FROM business_external_records ORDER BY record_id`);
    expect(JSON.stringify(raw.rows)).not.toContain('sku-a');
    expect(raw.rows[0]?.source_identity_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows only one process to claim a due binding', async () => {
    const current = required(await store.getBinding(binding));
    await store.requestRefresh({
      ...binding,
      expectedRevision: current.revision,
      idempotencyKey: 'concurrent-claim',
      now: new Date(0),
    });
    const claims = await Promise.all([
      store.claimDue({ now: new Date(0), workerId: 'worker-three', leaseMs: 60_000 }),
      store.claimDue({ now: new Date(0), workerId: 'worker-four', leaseMs: 60_000 }),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    await expect(
      store.commitPage({
        lease: required(claims.find((claim) => claim !== undefined)),
        now: new Date(0),
        page: { records: [], deletedIds: [], checkpoint: 'concurrent-claim', complete: true },
      }),
    ).resolves.toMatchObject({ ok: true, binding: { health: 'current' } });
  });

  it('persists optimistic pause and resume transitions', async () => {
    const current = required(await store.getBinding(binding));
    const paused = await store.setBindingState({
      ...binding,
      expectedRevision: current.revision,
      state: 'paused',
      now: new Date(),
    });
    expect(paused).toMatchObject({ ok: true, binding: { state: 'paused', health: 'paused' } });
    if (!paused.ok) throw new Error('expected paused source');
    await expect(
      store.setBindingState({
        ...binding,
        expectedRevision: paused.binding.revision,
        state: 'active',
        now: new Date(),
      }),
    ).resolves.toMatchObject({ ok: true, binding: { state: 'active' } });
  });

  it('persists CAS replacement fences and idempotent refresh receipts across instances', async () => {
    const before = required(await store.getBinding(binding));
    const queued = await store.requestRefresh({
      ...binding,
      expectedRevision: before.revision,
      idempotencyKey: 'before-binding-replacement',
      now: new Date(),
    });
    expect(queued).toMatchObject({ ok: true, receipt: { state: 'queued', coalesced: false } });
    const oldLease = required(
      await store.claimDue({ now: new Date(), workerId: 'old-binding-worker', leaseMs: 60_000 }),
    );
    const replaced = await store.replaceBinding({
      ...binding,
      generation: 2,
      expectedRevision: oldLease.binding.revision,
      now: new Date(),
    });
    expect(replaced).toMatchObject({
      ok: true,
      binding: { generation: 2, fence: oldLease.fence + 1, scanGeneration: 0 },
    });
    await expect(
      store.commitPage({
        lease: oldLease,
        now: new Date(),
        page: { records: [], deletedIds: [], complete: true },
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale_fence' });
    await expect(store.listSuppressions(binding)).resolves.toMatchObject([
      { bindingGeneration: 2, reason: 'customer_request' },
    ]);

    if (!replaced.ok) throw new Error('expected source replacement');
    const requested = await store.requestRefresh({
      ...binding,
      expectedRevision: replaced.binding.revision,
      idempotencyKey: 'durable-manual-refresh',
      now: new Date(),
    });
    expect(requested).toMatchObject({
      ok: true,
      receipt: { state: 'queued', coalesced: false },
    });
    const restarted = new PostgresSourceIngestionStore(pool, cipher, { identityKey });
    await expect(
      restarted.requestRefresh({
        ...binding,
        expectedRevision: replaced.binding.revision,
        idempotencyKey: 'durable-manual-refresh',
        now: new Date(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      receipt: { id: requested.ok ? requested.receipt.id : '', coalesced: true },
    });
    const lease = required(
      await restarted.claimDue({
        now: new Date(),
        workerId: 'new-binding-worker',
        leaseMs: 60_000,
      }),
    );
    await expect(
      restarted.requestRefresh({
        ...binding,
        expectedRevision: lease.binding.revision,
        idempotencyKey: 'durable-manual-refresh',
        now: new Date(),
      }),
    ).resolves.toMatchObject({ ok: true, receipt: { state: 'running', coalesced: true } });
    await expect(
      restarted.commitPage({
        lease,
        now: new Date(),
        page: { records: [], deletedIds: [], complete: true },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      restarted.requestRefresh({
        ...binding,
        expectedRevision: lease.binding.revision,
        idempotencyKey: 'durable-manual-refresh',
        now: new Date(),
      }),
    ).resolves.toMatchObject({ ok: true, receipt: { state: 'completed', coalesced: true } });
    const raw = await pool.query(
      `SELECT idempotency_digest FROM business_source_refresh_requests
       WHERE binding_generation=2`,
    );
    expect(JSON.stringify(raw.rows)).not.toContain('durable-manual-refresh');
  });

  it('erases expired external payloads in bounded batches', async () => {
    const current = required(await store.getBinding(binding));
    await store.requestRefresh({
      ...binding,
      expectedRevision: current.revision,
      idempotencyKey: 'retention-fixture',
      now: new Date(),
    });
    const lease = required(
      await store.claimDue({ now: new Date(), workerId: 'retention-worker', leaseMs: 60_000 }),
    );
    await store.commitPage({
      lease,
      now: new Date(),
      page: {
        records: [{ id: 'expired-stock', version: 'v1', record: { quantity: 1 } }],
        deletedIds: [],
        complete: true,
      },
    });
    const beforeExpiry = required(
      (await store.listExternalRecords({ ...binding, generation: 2 })).records.find(
        (record) => record.source.id === 'expired-stock',
      ),
    );
    await pool.query(`UPDATE business_source_bindings SET health='reauth_required'`);
    await expect(store.listExternalRecords({ ...binding, generation: 2 })).resolves.toEqual({
      records: [],
    });
    await expect(
      store.getExternalRecord({ ...binding, generation: 2, recordId: beforeExpiry.id }),
    ).resolves.toBeUndefined();
    await pool.query(`UPDATE business_source_bindings SET health='stale'`);
    await expect(
      store.getExternalRecord({ ...binding, generation: 2, recordId: beforeExpiry.id }),
    ).resolves.toMatchObject({ id: beforeExpiry.id });
    await pool.query(`UPDATE business_external_records
      SET retention_expires_at=clock_timestamp()-interval '1 second'
      WHERE deleted_at IS NULL`);

    await expect(store.listExternalRecords({ ...binding, generation: 2 })).resolves.toEqual({
      records: [],
    });
    await expect(
      store.getExternalRecord({ ...binding, generation: 2, recordId: beforeExpiry.id }),
    ).resolves.toBeUndefined();
    await expect(store.purgeExpired({ limit: 1 })).resolves.toBe(1);
    const raw = await pool.query(`SELECT deleted_at, content_ciphertext
      FROM business_external_records ORDER BY record_id`);
    expect(raw.rows.some((row) => row.deleted_at !== null && row.content_ciphertext === null)).toBe(
      true,
    );
  });
});

describe('Postgres source ingestion custody', () => {
  it('fails closed without a payload cipher or strong source identity key', () => {
    expect(
      () =>
        new PostgresSourceIngestionStore({} as pg.Pool, undefined as never, {
          identityKey: 'test-source-identity-key-with-32-bytes',
        }),
    ).toThrow(/cipher/i);
    expect(
      () =>
        new PostgresSourceIngestionStore({} as pg.Pool, new TestPayloadCipher(), {
          identityKey: 'short',
        }),
    ).toThrow(/32 bytes/i);
  });
});

const scope: InstallationScope = {
  org: 'acme',
  app: 'operations',
  env: 'prod',
  installationId: 'installation-one',
};

const binding: SourceBindingCreate = {
  scope,
  collectionKey: 'stock',
  id: 'warehouse-source',
  generation: 1,
  schemaVersion: 1,
  schemaDigest: 'a'.repeat(64),
  queryFingerprint: 'b'.repeat(64),
  scan: {
    connector: 'warehouse',
    connectorVersion: '2026-09-05',
    operation: 'scan_stock',
    signatureDigest: 'c'.repeat(64),
  },
  retentionDays: 30,
  pollIntervalMs: 60_000,
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected value');
  return value;
}
