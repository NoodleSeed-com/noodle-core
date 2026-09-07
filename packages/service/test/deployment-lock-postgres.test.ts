import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `deployment_lock_test_${process.pid}`;
const TENANT = { org: 'acme', app: 'support', env: 'prod' } as const;
const LOCK = {
  lockedAt: '2026-08-07T12:00:00.000Z',
  lockedBySubject: 'owner-subject',
  lockedByEmail: 'owner@acme.test',
} as const;
const ACTIVE: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'support-v1-active',
  orgSlug: TENANT.org,
  appSlug: TENANT.app,
  environment: TENANT.env,
  serverVersion: '1',
  deploymentVersion: 1,
  active: true,
  serverName: 'support',
  createdAt: '2026-08-07T11:00:00.000Z',
  createdBySubject: 'owner-subject',
  createdByEmail: 'owner@acme.test',
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: {} },
};

describe.skipIf(!URL)('Postgres deployment version locks', () => {
  let admin: Pool;
  let pool: Pool;
  let store: PostgresArtifactStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` });
    store = new PostgresArtifactStore(pool);
    await store.ensureSchema();
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

  it('round-trips lock metadata and exposes only safe summary fields', async () => {
    await store.append(ACTIVE);
    expect(await store.setDeploymentLock(TENANT, 'v1', ACTIVE.deploymentId, LOCK)).toMatchObject({
      ok: true,
      changed: true,
      record: { deploymentLock: LOCK },
    });
    expect(await store.get(ACTIVE.deploymentId)).toMatchObject({ deploymentLock: LOCK });
    expect(await store.listDeployments({ org: TENANT.org })).toEqual([
      expect.objectContaining({
        deploymentLock: { lockedAt: LOCK.lockedAt, lockedByEmail: LOCK.lockedByEmail },
      }),
    ]);
  });

  it('blocks store and raw-SQL writes that could move a locked version pointer', async () => {
    const historical = { ...ACTIVE, deploymentId: 'support-v1-history', active: false };
    await store.append(historical);
    await store.append(ACTIVE);
    await store.setDeploymentLock(TENANT, '1', ACTIVE.deploymentId, LOCK);

    await expect(store.append(ACTIVE)).resolves.toBeUndefined();
    await expect(store.append({ ...ACTIVE, manifest: 'changed: true\n' })).rejects.toMatchObject({
      code: 'deployment_locked',
    });
    expect(await store.get(ACTIVE.deploymentId)).toMatchObject({
      manifest: ACTIVE.manifest,
      deploymentLock: LOCK,
    });

    await expect(
      store.append({
        ...ACTIVE,
        deploymentId: 'support-v1-candidate',
        deploymentVersion: 2,
        active: false,
      }),
    ).rejects.toMatchObject({ code: 'deployment_locked' });
    await expect(store.activateDeployment(TENANT, historical.deploymentId)).rejects.toMatchObject({
      code: 'deployment_locked',
    });
    await expect(
      store.activateDeployment(TENANT, historical.deploymentId, undefined, {
        automationId: 'locked-automation',
      }),
    ).rejects.toMatchObject({ code: 'deployment_locked' });
    await expect(
      pool.query(
        `INSERT INTO deploy_records
          (deployment_id, org_slug, app_slug, environment, deployment_version, active,
           server_name, created_at, created_by_subject, created_by_email, access_mode, server_auth,
           caller_key_hash, manifest, connectors, hosted_assets, secrets, schema_version,
           deployment_source, org_membership_sources, server_version, archived_at,
           deployment_locked_at, deployment_locked_by_subject, deployment_locked_by_email)
          SELECT 'support-v1-raw', org_slug, app_slug, environment, 3, false, server_name,
                 created_at, created_by_subject, created_by_email, access_mode, server_auth,
                 caller_key_hash, manifest, connectors, hosted_assets, secrets, schema_version,
                 deployment_source, org_membership_sources, server_version, archived_at,
                 NULL, NULL, NULL
          FROM deploy_records WHERE deployment_id = $1`,
        [ACTIVE.deploymentId],
      ),
    ).rejects.toThrow(/deployment_locked/);
    await expect(
      pool.query('UPDATE deploy_records SET active = false WHERE deployment_id = $1', [
        ACTIVE.deploymentId,
      ]),
    ).rejects.toThrow(/deployment_locked/);
    await expect(
      pool.query('DELETE FROM deploy_records WHERE deployment_id = $1', [ACTIVE.deploymentId]),
    ).rejects.toThrow(/deployment_locked/);
    await expect(
      pool.query(
        `UPDATE deploy_records
         SET deployment_locked_at = NULL,
             deployment_locked_by_subject = NULL,
             deployment_locked_by_email = NULL
         WHERE deployment_id = $1`,
        [ACTIVE.deploymentId],
      ),
    ).rejects.toThrow(/deployment_locked/);

    const operator = await pool.connect();
    try {
      await operator.query('BEGIN');
      await operator.query(`SELECT set_config('noodle.deployment_lock_mutation', '1', true)`);
      const deliberateUnlock = await operator.query(
        `UPDATE deploy_records
         SET deployment_locked_at = NULL,
             deployment_locked_by_subject = NULL,
             deployment_locked_by_email = NULL
         WHERE deployment_id = $1`,
        [ACTIVE.deploymentId],
      );
      expect(deliberateUnlock.rowCount).toBe(1);
      await operator.query('ROLLBACK');
    } finally {
      operator.release();
    }
  });

  it('serializes a concurrent lock and deploy so only one can move the version', async () => {
    await store.append(ACTIVE);
    const candidate = {
      ...ACTIVE,
      deploymentId: 'support-v1-racing-candidate',
      deploymentVersion: 2,
    };

    const [lockAttempt, deployAttempt] = await Promise.allSettled([
      store.setDeploymentLock(TENANT, '1', ACTIVE.deploymentId, LOCK),
      store.append(candidate),
    ]);

    if (lockAttempt.status === 'fulfilled' && lockAttempt.value.ok) {
      expect(deployAttempt).toMatchObject({
        status: 'rejected',
        reason: { code: 'deployment_locked' },
      });
      expect(await store.get(ACTIVE.deploymentId)).toMatchObject({
        active: true,
        deploymentLock: LOCK,
      });
      return;
    }

    expect(deployAttempt.status).toBe('fulfilled');
    expect(lockAttempt).toMatchObject({
      status: 'fulfilled',
      value: { ok: false, reason: 'conflict' },
    });
    expect(await store.get(candidate.deploymentId)).toMatchObject({
      active: true,
      deploymentLock: undefined,
    });
  });

  it('serializes a concurrent lock and rollback pointer change', async () => {
    const historical = {
      ...ACTIVE,
      deploymentId: 'support-v1-racing-history',
      deploymentVersion: 0,
      active: false,
    };
    await store.append(historical);
    await store.append(ACTIVE);

    const [lockAttempt, activationAttempt] = await Promise.allSettled([
      store.setDeploymentLock(TENANT, '1', ACTIVE.deploymentId, LOCK),
      store.activateDeployment(TENANT, historical.deploymentId),
    ]);

    if (lockAttempt.status === 'fulfilled' && lockAttempt.value.ok) {
      expect(activationAttempt).toMatchObject({
        status: 'rejected',
        reason: { code: 'deployment_locked' },
      });
      expect(await store.get(ACTIVE.deploymentId)).toMatchObject({
        active: true,
        deploymentLock: LOCK,
      });
      return;
    }

    expect(activationAttempt.status).toBe('fulfilled');
    expect(lockAttempt).toMatchObject({
      status: 'fulfilled',
      value: { ok: false, reason: 'conflict' },
    });
    expect(await store.get(historical.deploymentId)).toMatchObject({
      active: true,
      deploymentLock: undefined,
    });
  });

  it('allows non-pointer updates, other scopes, and deployment after unlock', async () => {
    await store.append(ACTIVE);
    await store.setDeploymentLock(TENANT, '1', ACTIVE.deploymentId, LOCK);

    await expect(
      store.updateActiveAccess(TENANT, ACTIVE.deploymentId, {
        accessMode: 'owner-only',
        ownerSubject: 'transferred-owner',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: ACTIVE.createdBySubject,
      }),
    ).resolves.toMatchObject({ ownerSubject: 'transferred-owner', deploymentLock: LOCK });
    await expect(
      store.updateActiveAccess(TENANT, ACTIVE.deploymentId, {
        accessMode: 'public',
        expectedAccessMode: 'owner-only',
        expectedOwnerSubject: 'transferred-owner',
      }),
    ).resolves.toMatchObject({
      accessMode: 'public',
      ownerSubject: 'transferred-owner',
      deploymentLock: LOCK,
    });
    await expect(store.archiveApp(TENANT.org, TENANT.app, LOCK.lockedAt)).resolves.toBeDefined();
    await expect(store.restoreApp(TENANT.org, TENANT.app)).resolves.toBeDefined();

    await expect(
      store.append({
        ...ACTIVE,
        deploymentId: 'support-v2-active',
        serverVersion: '2',
        deploymentVersion: 2,
      }),
    ).resolves.toBeUndefined();
    await store.setDeploymentLock(TENANT, '1', ACTIVE.deploymentId, undefined);
    await expect(
      store.append({
        ...ACTIVE,
        deploymentId: 'support-v1-next',
        deploymentVersion: 3,
      }),
    ).resolves.toBeUndefined();
  });
});
