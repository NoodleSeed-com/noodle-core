import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { ACTIVE, deletionSuite, HISTORY, TENANT } from './deployment-deletion-suite.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `deployment_delete_test_${process.pid}`;
describe.skipIf(!URL)('Postgres deployment deletion', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresArtifactStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 6, options: `-c search_path=${SCHEMA}` });
    store = new PostgresArtifactStore(pool);
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE deploy_records, environments, apps, orgs CASCADE');
    await pool.query("INSERT INTO orgs (slug) VALUES ('acme'), ('other')");
  });
  deletionSuite(async () => store);
  it('preserves app/environment anchors when the last version is deleted', async () => {
    await store.append(ACTIVE);
    const before = await store.getAppGeneration('acme', 'support');
    const scope = { level: 'env', ...TENANT } as const;
    await store.setConfigValue({ kind: 'variable', scope, name: 'REGION', value: 'retained' });
    await store.deleteDeployments(TENANT, {
      kind: 'version',
      serverVersion: '1',
      expectedDeploymentIds: [ACTIVE.deploymentId],
    });
    expect(await store.getAppGeneration('acme', 'support')).toEqual(before);
    expect(await store.resolveConfigValues('variable', scope)).toEqual({ REGION: 'retained' });
    expect(await store.getEnvironment('acme', 'support', 'prod')).toMatchObject({
      deploymentCount: 0,
      isProduction: true,
    });
  });
  it('rolls back deletion with the enclosing transaction on the same connection', async () => {
    for (const record of [HISTORY, ACTIVE]) await store.append(record);
    await expect(
      withPostgresTransaction(pool, async () => {
        expect(
          await store.deleteDeployments(TENANT, {
            kind: 'version',
            serverVersion: '1',
            expectedDeploymentIds: [HISTORY.deploymentId, ACTIVE.deploymentId],
          }),
        ).toMatchObject({ ok: true });
        expect(await store.get(ACTIVE.deploymentId)).toBeUndefined();
        throw new Error('abort delete');
      }),
    ).rejects.toThrow('abort delete');
    expect(await store.loadAll()).toHaveLength(2);
  });
  it('serializes concurrent deploy and inventory deletion without partial deletion', async () => {
    for (const record of [HISTORY, ACTIVE]) await store.append(record);
    const newer = { ...ACTIVE, deploymentId: 'newer', deploymentVersion: 3 };
    const [deleted] = await Promise.all([
      store.deleteDeployments(TENANT, {
        kind: 'version',
        serverVersion: '1',
        expectedDeploymentIds: [HISTORY.deploymentId, ACTIVE.deploymentId],
      }),
      store.append(newer),
    ]);
    const ids = (await store.loadAll()).map((record) => record.deploymentId).sort();
    expect(ids).toEqual(
      deleted.ok ? ['newer'] : [ACTIVE.deploymentId, HISTORY.deploymentId, 'newer'].sort(),
    );
    if (!deleted.ok) expect(deleted.code).toBe('deployment_delete_conflict');
  });
  it('serializes rollback and individual deletion so an active deployment cannot disappear', async () => {
    for (const record of [HISTORY, ACTIVE]) await store.append(record);
    const [deleted, activated] = await Promise.all([
      store.deleteDeployments(TENANT, { kind: 'deployment', deploymentId: HISTORY.deploymentId }),
      store.activateDeployment(TENANT, HISTORY.deploymentId),
    ]);
    if (deleted.ok) {
      expect(activated).toBeUndefined();
      expect(await store.getActiveByTenant(TENANT)).toMatchObject({
        deploymentId: ACTIVE.deploymentId,
      });
    } else {
      expect(deleted.code).toBe('active_deployment');
      expect(await store.getActiveByTenant(TENANT)).toMatchObject({
        deploymentId: HISTORY.deploymentId,
      });
    }
  });
  it('rolls back every deleted row when the database fails during the delete statement', async () => {
    for (const record of [HISTORY, ACTIVE]) await store.append(record);
    await pool.query(`CREATE FUNCTION fail_deployment_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected deletion failure'; END; $$`);
    await pool.query(
      `CREATE TRIGGER deletion_failure AFTER DELETE ON deploy_records FOR EACH ROW EXECUTE FUNCTION fail_deployment_delete()`,
    );
    try {
      await expect(
        store.deleteDeployments(TENANT, {
          kind: 'version',
          serverVersion: '1',
          expectedDeploymentIds: [HISTORY.deploymentId, ACTIVE.deploymentId],
        }),
      ).rejects.toThrow('injected deletion failure');
      expect(await store.loadAll()).toHaveLength(2);
      expect(await store.getActiveByTenantVersion(TENANT, '1')).toMatchObject({
        deploymentId: ACTIVE.deploymentId,
      });
    } finally {
      await pool.query('DROP TRIGGER deletion_failure ON deploy_records');
      await pool.query('DROP FUNCTION fail_deployment_delete()');
    }
  });
  it('serializes whole-version deletion with a concurrently applied lock', async () => {
    await store.append(ACTIVE);
    const [deleted, locked] = await Promise.all([
      store.deleteDeployments(TENANT, {
        kind: 'version',
        serverVersion: '1',
        expectedDeploymentIds: [ACTIVE.deploymentId],
      }),
      store.setDeploymentLock(TENANT, '1', ACTIVE.deploymentId, {
        lockedAt: ACTIVE.createdAt,
        lockedBySubject: 'owner',
      }),
    ]);
    if (deleted.ok) expect(locked).toEqual({ ok: false, reason: 'no_active_deployment' });
    else {
      expect(deleted.code).toBe('deployment_locked');
      expect(locked.ok).toBe(true);
    }
  });
  it('serializes deletion with app archive while preserving the surviving history', async () => {
    for (const record of [HISTORY, ACTIVE]) await store.append(record);
    const [deleted] = await Promise.all([
      store.deleteDeployments(TENANT, { kind: 'deployment', deploymentId: HISTORY.deploymentId }),
      store.archiveApp('acme', 'support', ACTIVE.createdAt),
    ]);
    if (!deleted.ok) expect(deleted.code).toBe('app_archived');
    expect(await store.get(ACTIVE.deploymentId)).toMatchObject({ archivedAt: ACTIVE.createdAt });
  });
});
