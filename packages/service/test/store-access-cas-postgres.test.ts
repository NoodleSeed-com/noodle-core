import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `artifact_access_cas_test_${process.pid}`;
const TENANT = { org: 'acme', app: 'support', env: 'prod' } as const;
const RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'support-abcd1234',
  orgSlug: TENANT.org,
  appSlug: TENANT.app,
  environment: TENANT.env,
  serverVersion: '1',
  deploymentVersion: 1,
  active: true,
  serverName: 'support',
  createdAt: '2026-07-28T00:00:00.000Z',
  createdBySubject: 'owner-subject',
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: {} },
};

describe.skipIf(!URL)('PostgresArtifactStore access compare-and-set', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresArtifactStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 3, options: `-c search_path=${SCHEMA}` });
    store = new PostgresArtifactStore(pool);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE deploy_records, environments, apps, orgs CASCADE');
    await pool.query(`INSERT INTO orgs (slug) VALUES ('acme')`);
  });

  it.each([
    { manifest: 'changed manifest' },
    { connectors: 'changed connector catalog' },
    {
      hostedAssets: [
        {
          logicalId: 'logo',
          sourcePath: './logo.png',
          contentHash: 'a'.repeat(64),
          mimeType: 'image/png',
          byteLength: 1,
          width: 1,
          height: 1,
          publicUrl: 'https://assets.example/logo.png',
          objectKey: 'logo.png',
        },
      ],
    },
    { serverAuth: { issuer: 'https://revision.example', audience: 'api://changed' } },
  ])('rejects a changed validated activation revision %# without pointer or projection writes', async (change) => {
    await store.append(RECORD);
    const target: DeployRecord = {
      ...RECORD,
      deploymentId: 'revision-target',
      active: false,
      schemaVersion: 2,
      accessMode: 'mixed',
      serverAuth: { issuer: 'https://revision.example', audience: 'api://revision' },
    };
    await store.append(target);
    const observed = await store.get(target.deploymentId);
    if (observed === undefined) throw new Error('missing target');
    await store.append({ ...target, ...change });
    await expect(
      store.activateDeployment(TENANT, target.deploymentId, {
        expectedAccessMode: observed.accessMode,
        expectedSchemaVersion: observed.schemaVersion,
        expectedRevision: observed,
        serverAuth: target.serverAuth,
      }),
    ).resolves.toBeUndefined();
    expect(await store.getActiveByTenant(TENANT)).toEqual(RECORD);
    expect(await store.get(target.deploymentId)).toMatchObject({ active: false, ...change });
  });
  it('atomically adopts same-mode mixed customer policy and rejects a stale no-op', async () => {
    const auth = { issuer: 'https://adoption-cas.example', audience: 'api://adoption' };
    await store.append({ ...RECORD, accessMode: 'mixed', serverAuth: auth });
    const input = {
      accessMode: 'mixed' as const,
      expectedAccessMode: 'mixed' as const,
      expectedSchemaVersion: 1,
      expectedOwnerSubject: RECORD.createdBySubject,
      expectedManifest: RECORD.manifest,
      schemaVersion: 2 as const,
      serverAuth: auth,
    };
    const outcomes = await Promise.all([
      store.updateActiveAccess(TENANT, RECORD.deploymentId, input),
      store.updateActiveAccess(TENANT, RECORD.deploymentId, input),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes).toContain(undefined);
    expect(await store.getActiveByTenant(TENANT)).toMatchObject({
      schemaVersion: 2,
      accessMode: 'mixed',
      serverAuth: auth,
    });
    await expect(
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'mixed',
        expectedAccessMode: 'mixed',
        expectedOwnerSubject: RECORD.createdBySubject,
        expectedSchemaVersion: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects access adoption when the compiled manifest revision changed', async () => {
    await store.append(RECORD);
    await expect(
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'mixed',
        expectedAccessMode: RECORD.accessMode,
        expectedSchemaVersion: 1,
        expectedOwnerSubject: RECORD.createdBySubject,
        expectedManifest: 'stale manifest',
        schemaVersion: 2,
      }),
    ).resolves.toBeUndefined();
    expect(await store.getActiveByTenant(TENANT)).toMatchObject({
      schemaVersion: 1,
      accessMode: RECORD.accessMode,
    });
  });

  it('rejects one of two concurrent writes that observed the same access mode', async () => {
    await store.append(RECORD);

    const results = await Promise.all([
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'authenticated',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'public',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
    ]);

    const winners = results.filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);
    expect(results).toContain(undefined);
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: winners[0]?.accessMode,
    });
  });

  it('rejects a stale no-op after a winning access change', async () => {
    await store.append(RECORD);
    await expect(
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'public',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
    ).resolves.toMatchObject({ accessMode: 'public' });

    await expect(
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'owner-only',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
    ).resolves.toBeUndefined();
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: 'public',
    });
  });

  it('does not update the requested deployment after it stops being active', async () => {
    const newer = {
      ...RECORD,
      deploymentId: 'support-newer1234',
      deploymentVersion: 2,
    };
    await store.append(RECORD);
    await store.append(newer);

    await expect(
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'customers',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
    ).resolves.toBeUndefined();
    await expect(store.getActiveByTenant(TENANT)).resolves.toEqual(newer);
  });

  it('allows one winner when access and owner writes share the same observed state', async () => {
    await store.append(RECORD);

    const results = await Promise.all([
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'owner-only',
        ownerSubject: 'oauth-owner-a',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'public',
        ownerSubject: 'oauth-owner-b',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
    ]);

    const winners = results.filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);
    expect(results).toContain(undefined);
    await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
      accessMode: winners[0]?.accessMode,
      ownerSubject: winners[0]?.ownerSubject,
      createdBySubject: RECORD.createdBySubject,
    });
  });

  it('preserves owner state when a stale deploy record is appended again', async () => {
    await store.append(RECORD);
    await expect(
      store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'owner-only',
        ownerSubject: 'oauth-transferred-owner',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: RECORD.createdBySubject,
      }),
    ).resolves.toMatchObject({
      accessMode: 'owner-only',
      ownerSubject: 'oauth-transferred-owner',
    });

    await store.append(RECORD);

    await expect(store.get(RECORD.deploymentId)).resolves.toMatchObject({
      accessMode: 'owner-only',
      ownerSubject: 'oauth-transferred-owner',
      createdBySubject: RECORD.createdBySubject,
    });
  });
});
