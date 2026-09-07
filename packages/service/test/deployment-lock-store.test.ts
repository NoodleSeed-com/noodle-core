import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ArtifactStore,
  type DeployRecord,
  InMemoryArtifactStore,
  JsonFileArtifactStore,
} from '../src/index.js';

const TENANT = { org: 'acme', app: 'support', env: 'prod' } as const;
const LOCK = {
  lockedAt: '2026-08-07T12:00:00.000Z',
  lockedBySubject: 'owner-subject',
  lockedByEmail: 'owner@acme.test',
} as const;
const ACTIVE_V1: DeployRecord = {
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

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function stores(): Promise<readonly [string, ArtifactStore][]> {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-deployment-lock-'));
  dirs.push(dir);
  return [
    ['memory', new InMemoryArtifactStore()],
    ['json-file', new JsonFileArtifactStore(dir)],
  ];
}

describe('deployment version locks', () => {
  it('locks the exact active version and exposes safe lock metadata', async () => {
    for (const [name, store] of await stores()) {
      await store.append(ACTIVE_V1);

      const result = await store.setDeploymentLock(TENANT, 'v1', ACTIVE_V1.deploymentId, LOCK);

      expect(result, name).toMatchObject({
        ok: true,
        changed: true,
        record: { deploymentId: ACTIVE_V1.deploymentId, deploymentLock: LOCK },
      });
      expect(await store.listDeployments({ org: TENANT.org }), name).toEqual([
        expect.objectContaining({
          deploymentId: ACTIVE_V1.deploymentId,
          deploymentLock: {
            lockedAt: LOCK.lockedAt,
            lockedByEmail: LOCK.lockedByEmail,
          },
        }),
      ]);
    }
  });

  it('keeps repeated lock and unlock requests idempotent', async () => {
    for (const [name, store] of await stores()) {
      await store.append(ACTIVE_V1);
      await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, LOCK);

      expect(
        await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, {
          ...LOCK,
          lockedAt: '2026-08-07T13:00:00.000Z',
        }),
        name,
      ).toMatchObject({ ok: true, changed: false, record: { deploymentLock: LOCK } });
      expect(
        await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, undefined),
        name,
      ).toMatchObject({
        ok: true,
        changed: true,
        record: { deploymentId: ACTIVE_V1.deploymentId },
      });
      expect(
        await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, undefined),
        name,
      ).toMatchObject({ ok: true, changed: false });
    }
  });

  it('rejects stale, missing, archived, and unversioned lock targets', async () => {
    for (const [name, store] of await stores()) {
      await store.append(ACTIVE_V1);
      expect(await store.setDeploymentLock(TENANT, '1', 'stale-deployment', LOCK), name).toEqual({
        ok: false,
        reason: 'conflict',
      });
      expect(
        await store.setDeploymentLock(
          { ...TENANT, env: 'staging' },
          '1',
          ACTIVE_V1.deploymentId,
          LOCK,
        ),
        name,
      ).toEqual({ ok: false, reason: 'no_active_deployment' });

      const legacy = { ...ACTIVE_V1, deploymentId: 'support-legacy', serverVersion: undefined };
      await store.append(legacy);
      expect(await store.setDeploymentLock(TENANT, '2', legacy.deploymentId, LOCK), name).toEqual({
        ok: false,
        reason: 'no_active_deployment',
      });

      const archived = {
        ...ACTIVE_V1,
        deploymentId: 'support-v2-archived',
        serverVersion: '2',
        archivedAt: '2026-08-07T12:30:00.000Z',
      };
      await store.append(archived);
      expect(await store.setDeploymentLock(TENANT, '2', archived.deploymentId, LOCK), name).toEqual(
        { ok: false, reason: 'no_active_deployment' },
      );
    }
  });

  it('blocks every new record and activation in the locked version scope', async () => {
    for (const [name, store] of await stores()) {
      const historical = {
        ...ACTIVE_V1,
        deploymentId: 'support-v1-history',
        deploymentVersion: 0,
        active: false,
      };
      await store.append(historical);
      await store.append(ACTIVE_V1);
      await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, LOCK);

      await expect(
        store.append({
          ...ACTIVE_V1,
          deploymentId: 'support-v1-candidate',
          deploymentVersion: 2,
          active: false,
        }),
        name,
      ).rejects.toMatchObject({ code: 'deployment_locked' });
      await expect(
        store.activateDeployment(TENANT, historical.deploymentId),
        name,
      ).rejects.toMatchObject({
        code: 'deployment_locked',
      });
    }
  });

  it('preserves a lock on exact same-id retries and rejects same-id mutation attempts', async () => {
    for (const [name, store] of await stores()) {
      await store.append(ACTIVE_V1);
      await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, LOCK);

      await expect(store.append(ACTIVE_V1), name).resolves.toBeUndefined();
      expect(await store.get(ACTIVE_V1.deploymentId), name).toMatchObject({
        active: true,
        manifest: ACTIVE_V1.manifest,
        deploymentLock: LOCK,
      });
      await expect(
        store.append({ ...ACTIVE_V1, active: false, manifest: 'changed: true\n' }),
        name,
      ).rejects.toMatchObject({ code: 'deployment_locked' });
      await expect(
        store.append({ ...ACTIVE_V1, environment: 'staging' }),
        name,
      ).rejects.toMatchObject({ code: 'deployment_locked' });
      expect(await store.get(ACTIVE_V1.deploymentId), name).toMatchObject({
        environment: TENANT.env,
        active: true,
        manifest: ACTIVE_V1.manifest,
        deploymentLock: LOCK,
      });
    }
  });

  it('keeps other versions and environments deployable', async () => {
    for (const [name, store] of await stores()) {
      await store.append(ACTIVE_V1);
      await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, LOCK);
      const v2 = {
        ...ACTIVE_V1,
        deploymentId: 'support-v2-active',
        serverVersion: '2',
        deploymentVersion: 2,
      };
      const stagingV1 = {
        ...ACTIVE_V1,
        deploymentId: 'support-staging-v1',
        environment: 'staging',
        deploymentVersion: 3,
      };

      await expect(store.append(v2), name).resolves.toBeUndefined();
      await expect(store.append(stagingV1), name).resolves.toBeUndefined();
    }
  });

  it('allows access and archive lifecycle updates without removing the lock', async () => {
    for (const [name, store] of await stores()) {
      await store.append(ACTIVE_V1);
      await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, LOCK);

      await expect(
        store.updateActiveAccess(TENANT, ACTIVE_V1.deploymentId, {
          accessMode: 'owner-only',
          ownerSubject: 'transferred-owner',
          expectedAccessMode: 'owner-only',
          expectedOwnerSubject: ACTIVE_V1.createdBySubject,
        }),
        name,
      ).resolves.toMatchObject({ ownerSubject: 'transferred-owner', deploymentLock: LOCK });
      await expect(
        store.updateActiveAccess(TENANT, ACTIVE_V1.deploymentId, {
          accessMode: 'public',
          expectedAccessMode: 'owner-only',
          expectedOwnerSubject: 'transferred-owner',
        }),
        name,
      ).resolves.toMatchObject({
        accessMode: 'public',
        ownerSubject: 'transferred-owner',
        deploymentLock: LOCK,
      });
      await expect(
        store.archiveApp(TENANT.org, TENANT.app, LOCK.lockedAt),
        name,
      ).resolves.toBeDefined();
      await expect(
        store.append({
          ...ACTIVE_V1,
          deploymentId: 'support-v1-while-archived',
          deploymentVersion: 2,
          active: false,
        }),
        name,
      ).rejects.toMatchObject({ code: 'deployment_locked' });
      await expect(store.restoreApp(TENANT.org, TENANT.app), name).resolves.toBeDefined();
      expect(await store.get(ACTIVE_V1.deploymentId), name).toMatchObject({
        active: true,
        accessMode: 'public',
        deploymentLock: LOCK,
      });
    }
  });

  it('allows deployment again after unlock', async () => {
    for (const [name, store] of await stores()) {
      await store.append(ACTIVE_V1);
      await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, LOCK);
      await store.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, undefined);

      await expect(
        store.append({
          ...ACTIVE_V1,
          deploymentId: 'support-v1-next',
          deploymentVersion: 2,
        }),
        name,
      ).resolves.toBeUndefined();
    }
  });

  it('persists a lock across JSON-file store restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noodle-deployment-lock-restart-'));
    dirs.push(dir);
    const first = new JsonFileArtifactStore(dir);
    await first.append(ACTIVE_V1);
    await first.setDeploymentLock(TENANT, '1', ACTIVE_V1.deploymentId, LOCK);

    const restarted = new JsonFileArtifactStore(dir);
    expect(await restarted.get(ACTIVE_V1.deploymentId)).toMatchObject({ deploymentLock: LOCK });
    await expect(
      restarted.append({
        ...ACTIVE_V1,
        deploymentId: 'support-v1-restart',
        deploymentVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'deployment_locked' });
  });
});
