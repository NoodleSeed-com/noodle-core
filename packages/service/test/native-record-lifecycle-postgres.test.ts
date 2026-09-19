import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { PostgresBusinessWorkspaceBackend } from '../src/business-workspaces/postgres.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const connectionString = process.env.DATABASE_URL_TEST;
describe.skipIf(!connectionString)('native lifecycle durable transactions', () => {
  const schema = `native_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const sweepPool = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const cipher = new TestPayloadCipher();
  const store = new PostgresBusinessInformationStore(pool, cipher);
  const backend = new PostgresBusinessWorkspaceBackend(pool, cipher);
  const artifacts = new PostgresArtifactStore(pool);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await artifacts.ensureSchema();
    await store.ensureSchema();
    await store.ensureSchema();
    await backend.ensureSchema();
  });
  afterAll(async () => {
    await sweepPool.end();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  async function fixture() {
    const scope = {
      org: `org-${randomUUID()}`,
      app: 'travel',
      env: 'prod',
      installationId: 'native',
    };
    await artifacts.createOrg({ slug: scope.org });
    await artifacts.append({
      schemaVersion: 1,
      deploymentId: `deploy-${randomUUID()}`,
      orgSlug: scope.org,
      appSlug: scope.app,
      environment: scope.env,
      deploymentVersion: 1,
      active: true,
      serverName: 'travel',
      createdAt: new Date().toISOString(),
      createdBySubject: 'owner',
      accessMode: 'public',
      manifest: 'manifestVersion: "2"',
      secrets: { enc: 'none', values: {} },
    });
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'legacy-owner',
    });
    const generation = await artifacts.getAppGeneration(scope.org, scope.app);
    if (!generation || !(await store.bindApplication(scope, generation)))
      throw new Error('active application fixture missing');
    const workspaces = new BusinessWorkspaceStore(backend, { isIdentityActive: async () => true });
    await workspaces.initializeNewWorkspace({ org: scope.org, ownerSubject: 'owner' });
    store.staff.configure(workspaces);
    const record = await store.createRequest({
      scope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'first',
      payload: { request_type: 'information', summary: 'Preserved content' },
      origin: { kind: 'portal' },
      actorSubject: 'owner',
    });
    if (record.disposition !== 'created') throw new Error('record fixture missing');
    return { scope, workspaces, record: record.record };
  }
  it('borrows one connection and rolls back policy, records, custody and receipt together', async () => {
    const { scope, record } = await fixture();
    const preview = await store.nativeLifecycle.preview(scope, 'owner');
    const total = async () =>
      Number(
        (
          await pool.query('SELECT retained_bytes FROM native_record_custody WHERE org_slug=$1', [
            scope.org,
          ])
        ).rows[0]?.retained_bytes,
      );
    const before = await total();
    await expect(
      withPostgresTransaction(pool, async () => {
        await store.nativeLifecycle.migrate({ scope, actor: 'owner', preview });
        expect(
          (await store.getRequest(scope, 'travel_requests', record.id))?.retentionExpiresAt,
        ).toBeNull();
        throw new Error('rollback-all');
      }),
    ).rejects.toThrow('rollback-all');
    expect((await store.nativeLifecycle.preview(scope, 'owner')).policy).toBe('legacy_expiry');
    expect(await total()).toBe(before);
    expect((await store.getRequest(scope, 'travel_requests', record.id))?.retentionExpiresAt).toBe(
      record.retentionExpiresAt,
    );
    expect((await store.nativeLifecycle.migrate({ scope, actor: 'owner', preview })).replayed).toBe(
      false,
    );
    expect(await total()).toBeLessThan(before);
    const actual = Number(
      (
        await pool.query(
          `SELECT
      (SELECT COALESCE(sum(octet_length(to_jsonb(r)::text)+CASE WHEN deleted_at IS NULL THEN 16384 ELSE 0 END),0) FROM managed_request_records r WHERE org_slug=$1)+
      (SELECT COALESCE(sum(octet_length(to_jsonb(a)::text)),0) FROM managed_request_activities a WHERE org_slug=$1) AS total`,
          [scope.org],
        )
      ).rows[0]?.total,
    );
    expect(await total()).toBe(actual);
  });
  it('survives restart without decrypting or rewriting payloads, notes, revisions or activity', async () => {
    const { scope, workspaces, record } = await fixture();
    const preview = await store.nativeLifecycle.preview(scope, 'owner');
    const before = (
      await pool.query(
        'SELECT content_ciphertext,revision FROM managed_request_records WHERE org_slug=$1',
        [scope.org],
      )
    ).rows;
    const open = vi.spyOn(cipher, 'open');
    await store.nativeLifecycle.migrate({ scope, actor: 'owner', preview });
    expect(
      open.mock.calls.filter(([, context]) => context.collectionKey === 'travel_requests'),
    ).toHaveLength(0);
    open.mockRestore();
    const restarted = new PostgresBusinessInformationStore(pool, cipher);
    await restarted.ensureSchema();
    restarted.staff.configure(workspaces);
    expect(
      await restarted.nativeLifecycle.migrate({ scope, actor: 'owner', preview }),
    ).toMatchObject({ replayed: true });
    expect(
      (
        await pool.query(
          'SELECT content_ciphertext,revision FROM managed_request_records WHERE org_slug=$1',
          [scope.org],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await restarted.listActivity(scope, 'travel_requests', record.id)).activities,
    ).toHaveLength(1);
    expect((await restarted.getRequest(scope, 'travel_requests', record.id))?.content).toEqual(
      record.content,
    );
  });
  it('rejects stale writers restoring expiry and cannot introduce explicit-erasure records without migration', async () => {
    const { scope, record } = await fixture();
    await expect(
      pool.query('UPDATE managed_request_records SET retention_expires_at=NULL WHERE org_slug=$1', [
        scope.org,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'native_lifecycle_required' });
    const preview = await store.nativeLifecycle.preview(scope, 'owner');
    await store.nativeLifecycle.migrate({ scope, actor: 'owner', preview });
    await expect(
      pool.query('UPDATE managed_request_records SET retention_expires_at=$2 WHERE org_slug=$1', [
        scope.org,
        record.retentionExpiresAt,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'native_lifecycle_required' });
    expect(
      (await store.getRequest(scope, 'travel_requests', record.id))?.retentionExpiresAt,
    ).toBeNull();
  });
  it('serializes migration against an expiry sweep: migration wins without erasure, sweep wins without revival', async () => {
    const sweep = new PostgresBusinessInformationStore(sweepPool, cipher, {
      now: () => new Date(Date.now() + 100 * 86_400_000),
    });
    const preserved = await fixture();
    const review = await store.nativeLifecycle.preview(preserved.scope, 'owner');
    await withPostgresTransaction(pool, async () => {
      await store.nativeLifecycle.migrate({
        scope: preserved.scope,
        actor: 'owner',
        preview: review,
      });
      // The other replica sees the old finite expiry but must skip the migration's row lock.
      expect(await sweep.purgeExpired({ scope: preserved.scope })).toBe(0);
    });
    expect(await sweep.purgeExpired({ scope: preserved.scope })).toBe(0);
    expect(
      await sweep.getRequest(preserved.scope, 'travel_requests', preserved.record.id),
    ).toMatchObject({ retentionExpiresAt: null });
    const erased = await fixture();
    const old = await store.nativeLifecycle.preview(erased.scope, 'owner');
    await withPostgresTransaction(sweepPool, async () => {
      expect(await sweep.purgeExpired({ scope: erased.scope })).toBe(1);
    });
    await expect(
      store.nativeLifecycle.migrate({ scope: erased.scope, actor: 'owner', preview: old }),
    ).rejects.toThrow('lifecycle_conflict');
    const current = await store.nativeLifecycle.preview(erased.scope, 'owner');
    await store.nativeLifecycle.migrate({ scope: erased.scope, actor: 'owner', preview: current });
    expect(
      await store.getRequest(erased.scope, 'travel_requests', erased.record.id),
    ).toBeUndefined();
  });
});
