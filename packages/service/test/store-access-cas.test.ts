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

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

function accessCompareAndSetSuite(name: string, makeStore: () => Promise<ArtifactStore>): void {
  describe(`${name} access compare-and-set`, () => {
    it('rejects one of two concurrent writes that observed the same access mode', async () => {
      const store = await makeStore();
      await store.append(RECORD);

      const [first, stale] = await Promise.all([
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

      expect(first).toMatchObject({ accessMode: 'authenticated' });
      expect(stale).toBeUndefined();
      await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
        deploymentId: RECORD.deploymentId,
        accessMode: 'authenticated',
      });
    });

    it('keeps a legacy owner-only no-op absent and rejects it after a concurrent winner', async () => {
      const store = await makeStore();
      const { accessMode: _accessMode, ownerSubject: _ownerSubject, ...legacy } = RECORD;
      await store.append(legacy);

      const noOp = await store.updateActiveAccess(TENANT, RECORD.deploymentId, {
        accessMode: 'owner-only',
        expectedAccessMode: undefined,
        expectedOwnerSubject: RECORD.createdBySubject,
      });

      expect(noOp).not.toHaveProperty('accessMode');
      await expect(store.get(RECORD.deploymentId)).resolves.not.toHaveProperty('accessMode');

      await store.append(legacy);
      const [winner, staleNoOp] = await Promise.all([
        store.updateActiveAccess(TENANT, RECORD.deploymentId, {
          accessMode: 'public',
          expectedAccessMode: undefined,
          expectedOwnerSubject: RECORD.createdBySubject,
        }),
        store.updateActiveAccess(TENANT, RECORD.deploymentId, {
          accessMode: 'owner-only',
          expectedAccessMode: undefined,
          expectedOwnerSubject: RECORD.createdBySubject,
        }),
      ]);

      expect(winner).toMatchObject({ accessMode: 'public' });
      expect(staleNoOp).toBeUndefined();
      await expect(store.getActiveByTenant(TENANT)).resolves.toMatchObject({
        accessMode: 'public',
      });
    });

    it('allows one winner when access and owner writes share the same observed state', async () => {
      const store = await makeStore();
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
      const store = await makeStore();
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
}

accessCompareAndSetSuite('InMemoryArtifactStore', () =>
  Promise.resolve(new InMemoryArtifactStore()),
);
accessCompareAndSetSuite('JsonFileArtifactStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-access-cas-'));
  dirs.push(dir);
  return new JsonFileArtifactStore(dir);
});
