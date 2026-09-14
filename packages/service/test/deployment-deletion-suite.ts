import { expect, it } from 'vitest';
import type { ArtifactStore, DeployRecord } from '../src/store.js';

export const TENANT = { org: 'acme', app: 'support', env: 'prod' } as const;
export const ACTIVE: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'support-active',
  orgSlug: 'acme',
  appSlug: 'support',
  environment: 'prod',
  serverVersion: '1',
  deploymentVersion: 2,
  active: true,
  serverName: 'support',
  createdAt: '2026-09-14T00:00:00.000Z',
  accessMode: 'public',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: {} },
};
export const HISTORY = {
  ...ACTIVE,
  deploymentId: 'support-history',
  active: false,
  deploymentVersion: 1,
};
export function deletionSuite(make: () => Promise<ArtifactStore>) {
  it('deletes history while preserving active, exact versions, environments, and tenants', async () => {
    const store = await make();
    const others = [
      ACTIVE,
      { ...ACTIVE, deploymentId: 'semver', serverVersion: '1.0.0' },
      { ...ACTIVE, deploymentId: 'staging', environment: 'staging' },
      { ...ACTIVE, deploymentId: 'foreign', orgSlug: 'other' },
    ];
    for (const record of [HISTORY, ...others]) await store.append(record);
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'deployment',
        deploymentId: HISTORY.deploymentId,
      }),
    ).toEqual({ ok: true, deleted: [HISTORY] });
    expect((await store.loadAll()).map((r) => r.deploymentId).sort()).toEqual(
      others.map((r) => r.deploymentId).sort(),
    );
  });
  it('refuses an individually active deployment without mutation', async () => {
    const store = await make();
    await store.append(ACTIVE);
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'deployment',
        deploymentId: ACTIVE.deploymentId,
      }),
    ).toEqual({ ok: false, code: 'active_deployment' });
    expect(await store.get(ACTIVE.deploymentId)).toEqual(ACTIVE);
  });
  it('deletes the entire exact version including its active deployment', async () => {
    const store = await make();
    for (const record of [
      HISTORY,
      ACTIVE,
      { ...ACTIVE, deploymentId: 'semver', serverVersion: '1.0.0' },
    ])
      await store.append(record);
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'version',
        serverVersion: '1',
        expectedDeploymentIds: [ACTIVE.deploymentId, HISTORY.deploymentId],
      }),
    ).toMatchObject({ ok: true, deleted: expect.arrayContaining([ACTIVE, HISTORY]) });
    expect(await store.getActiveByTenantVersion(TENANT, '1')).toBeUndefined();
    expect((await store.loadAll()).map((r) => r.deploymentId)).toEqual(['semver']);
  });
  it('rejects a changed inventory and duplicate expected IDs atomically', async () => {
    const store = await make();
    for (const r of [HISTORY, ACTIVE]) await store.append(r);
    for (const expectedDeploymentIds of [
      [ACTIVE.deploymentId],
      [ACTIVE.deploymentId, HISTORY.deploymentId, 'extra'],
      [ACTIVE.deploymentId, ACTIVE.deploymentId],
    ]) {
      expect(
        await store.deleteDeployments(TENANT, {
          kind: 'version',
          serverVersion: '1',
          expectedDeploymentIds,
        }),
      ).toEqual({ ok: false, code: 'deployment_delete_conflict' });
      expect(await store.loadAll()).toHaveLength(2);
    }
  });
  it('blocks locked whole versions but permits deleting their history', async () => {
    const store = await make();
    for (const r of [HISTORY, ACTIVE]) await store.append(r);
    await store.setDeploymentLock(TENANT, '1', ACTIVE.deploymentId, {
      lockedAt: ACTIVE.createdAt,
      lockedBySubject: 'owner',
    });
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'version',
        serverVersion: '1',
        expectedDeploymentIds: [ACTIVE.deploymentId, HISTORY.deploymentId],
      }),
    ).toEqual({ ok: false, code: 'deployment_locked' });
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'deployment',
        deploymentId: HISTORY.deploymentId,
      }),
    ).toMatchObject({ ok: true });
  });
  it('refuses archived targets until restored', async () => {
    const store = await make();
    for (const r of [HISTORY, ACTIVE]) await store.append(r);
    await store.archiveApp('acme', 'support', ACTIVE.createdAt);
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'deployment',
        deploymentId: HISTORY.deploymentId,
      }),
    ).toEqual({ ok: false, code: 'app_archived' });
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'version',
        serverVersion: '1',
        expectedDeploymentIds: [ACTIVE.deploymentId, HISTORY.deploymentId],
      }),
    ).toEqual({ ok: false, code: 'app_archived' });
  });
  it('does not reveal missing or foreign deployment targets', async () => {
    const store = await make();
    await store.append(ACTIVE);
    for (const ref of [
      { ...TENANT, org: 'other' },
      { ...TENANT, env: 'staging' },
    ]) {
      expect(
        await store.deleteDeployments(ref, {
          kind: 'deployment',
          deploymentId: ACTIVE.deploymentId,
        }),
      ).toEqual({ ok: false, code: 'deployment_not_found' });
      expect(
        await store.deleteDeployments(ref, {
          kind: 'version',
          serverVersion: '1',
          expectedDeploymentIds: [ACTIVE.deploymentId],
        }),
      ).toEqual({ ok: false, code: 'version_not_found' });
    }
  });
  it('deletes legacy records without confusing them with numeric versions', async () => {
    const store = await make();
    const { serverVersion: _version, ...legacy } = { ...ACTIVE, deploymentId: 'legacy-deploy' };
    await store.append(legacy);
    await store.append(ACTIVE);
    expect(
      await store.deleteDeployments(TENANT, {
        kind: 'version',
        expectedDeploymentIds: [legacy.deploymentId],
      }),
    ).toEqual({ ok: true, deleted: [legacy] });
    expect(await store.get(ACTIVE.deploymentId)).toEqual(ACTIVE);
  });
}
