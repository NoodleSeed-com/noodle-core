import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ArtifactStore,
  type DeployRecord,
  InMemoryArtifactStore,
  JsonFileArtifactStore,
  type TenantRef,
} from '../src/index.js';

import { activateInMemory } from '../src/registry-state.js';

const PROD = { org: 'acme', app: 'support', env: 'prod' } as const;
const DEV = { org: 'acme', app: 'support', env: 'dev' } as const;
const OTHER = { org: 'acme', app: 'other', env: 'prod' } as const;
const AUTH = { issuer: 'https://idp.example', audience: 'acme-support' } as const;
const OTHER_AUTH = { issuer: 'https://idp.example', audience: 'other-support' } as const;

describe.each(['memory', 'json'] as const)('%s store customer OIDC binding lifecycle', (kind) => {
  it('reserves one audience across mixed customer and customers deployments', () =>
    withStore(kind, async (store) => {
      const results = await Promise.allSettled([
        store.append({ ...record('mixed-customer', PROD), schemaVersion: 2, accessMode: 'mixed' }),
        store.append(record('customers-peer', OTHER)),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expectConflict(results);
    }));

  it('does not reserve dormant auth in legacy mixed deployments', () =>
    withStore(kind, async (store) => {
      await store.append({ ...record('legacy-mixed', PROD), accessMode: 'mixed' });
      await expect(store.append(record('customer-owner', OTHER))).resolves.toBeUndefined();
      expect(await store.loadAll()).toHaveLength(2);
    }));

  it('requires a valid non-null mixed customer projection', () =>
    withStore(kind, async (store) => {
      await expect(
        store.append({
          ...record('bad-mixed', PROD),
          schemaVersion: 2,
          accessMode: 'mixed',
          serverAuth: { kind: 'federatedOidc', issuers: [] },
        }),
      ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });
      expect(await store.loadAll()).toHaveLength(0);
    }));

  it('refuses access writes validated against an older record version', () =>
    withStore(kind, async (store) => {
      await store.append({
        ...record('mixed-record', PROD),
        schemaVersion: 2,
        accessMode: 'mixed',
        createdBySubject: 'owner',
      });
      await expect(
        store.updateActiveAccess(PROD, 'mixed-record', {
          accessMode: 'public',
          expectedAccessMode: 'mixed',
          expectedOwnerSubject: 'owner',
          expectedSchemaVersion: 1,
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.updateActiveAccess(PROD, 'mixed-record', {
          accessMode: 'public',
          expectedAccessMode: 'mixed',
          expectedOwnerSubject: 'owner',
        }),
      ).resolves.toBeUndefined();
      await expect(store.get('mixed-record')).resolves.toMatchObject({
        schemaVersion: 2,
        accessMode: 'mixed',
      });
      await expect(
        store.updateActiveAccess(PROD, 'mixed-record', {
          accessMode: 'public',
          expectedAccessMode: 'mixed',
          expectedOwnerSubject: 'owner',
          expectedSchemaVersion: 2,
        }),
      ).resolves.toMatchObject({ schemaVersion: 2, accessMode: 'public' });
    }));

  it('refuses activation validated against an older record version', () =>
    withStore(kind, async (store) => {
      await store.append({
        ...record('future-history', PROD),
        schemaVersion: 2,
        accessMode: 'mixed',
        active: false,
      });
      await expect(
        store.activateDeployment(PROD, 'future-history', {
          expectedAccessMode: 'mixed',
          expectedSchemaVersion: 1,
        }),
      ).resolves.toBeUndefined();
      await expect(store.get('future-history')).resolves.toMatchObject({ active: false });
    }));

  it.each([false, true])('requires explicit v2 activation intent (explicit: %s)', (explicit) =>
    withStore(kind, async (store) => {
      const target = {
        ...record('future-target', PROD),
        schemaVersion: 2,
        accessMode: 'mixed' as const,
        active: false,
      };
      await store.append(target);
      const result = await store.activateDeployment(
        PROD,
        target.deploymentId,
        explicit ? { expectedAccessMode: 'mixed', expectedSchemaVersion: 2 } : undefined,
      );
      if (explicit) expect(result).toMatchObject({ active: { schemaVersion: 2, active: true } });
      else expect(result).toBeUndefined();
      await expect(store.get(target.deploymentId)).resolves.toMatchObject({ active: explicit });
    }));

  it('refuses an older writer that would replace a newer active policy', () =>
    withStore(kind, async (store) => {
      await store.append({
        ...record('mixed-record', PROD),
        schemaVersion: 2,
        accessMode: 'mixed',
      });
      for (const deploymentId of ['mixed-record', 'new-older-writer']) {
        await expect(
          store.append({ ...record(deploymentId, PROD), accessMode: 'mixed' }),
        ).rejects.toMatchObject({ code: 'unsupported_deployment_record_version' });
      }
      await expect(store.get('mixed-record')).resolves.toMatchObject({
        schemaVersion: 2,
        active: true,
      });
      expect(await store.loadAll()).toHaveLength(1);
    }));

  it('refuses an unversioned activation that would replace a newer policy', () =>
    withStore(kind, async (store) => {
      await store.append({ ...record('old-pending', PROD), active: false });
      await store.append({ ...record('new-active', PROD), schemaVersion: 2, accessMode: 'mixed' });
      await expect(store.activateDeployment(PROD, 'old-pending')).rejects.toMatchObject({
        code: 'unsupported_deployment_record_version',
      });
      await expect(store.get('new-active')).resolves.toMatchObject({ active: true });
      // An explicit rollback validated against the historical record remains supported.
      await expect(
        store.activateDeployment(PROD, 'old-pending', {
          expectedAccessMode: 'customers',
          expectedSchemaVersion: 1,
        }),
      ).resolves.toMatchObject({ active: { deploymentId: 'old-pending' } });
    }));

  it('rejects active customer records without a valid persisted auth projection', () =>
    withStore(kind, async (store) => {
      await expect(
        store.append({ ...record('missing-auth', PROD), serverAuth: undefined }),
      ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });
      await expect(
        store.append({
          ...record('malformed-auth', PROD),
          serverAuth: { kind: 'federatedOidc', issuers: [] } as never,
        }),
      ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });
      expect(await store.loadAll()).toHaveLength(0);
    }));

  it('serializes competing active deploy records', () =>
    withStore(kind, async (store) => {
      const results = await Promise.allSettled([
        store.append(record('prod-deploy', PROD)),
        store.append(record('dev-deploy', DEV)),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expectConflict(results);
      expect((await store.loadAll()).filter(isActiveCustomer)).toHaveLength(1);
    }));

  it('serializes competing customer-access transitions', () =>
    withStore(kind, async (store) => {
      await store.append(ownerRecord('prod-owner', PROD));
      await store.append(ownerRecord('dev-owner', DEV));

      const results = await Promise.allSettled([
        store.updateActiveAccess(PROD, 'prod-owner', {
          accessMode: 'customers',
          expectedAccessMode: 'owner-only',
          expectedOwnerSubject: 'owner',
        }),
        store.updateActiveAccess(DEV, 'dev-owner', {
          accessMode: 'customers',
          expectedAccessMode: 'owner-only',
          expectedOwnerSubject: 'owner',
        }),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expectConflict(results);
      expect((await store.loadAll()).filter(isActiveCustomer)).toHaveLength(1);
    }));

  it('serializes competing rollback activations', () =>
    withStore(kind, async (store) => {
      for (const [tenant, prefix] of [
        [PROD, 'prod'],
        [DEV, 'dev'],
      ] as const) {
        await store.append({ ...ownerRecord(`${prefix}-current`, tenant), deploymentVersion: 2 });
        await store.append({
          ...record(`${prefix}-rollback`, tenant),
          active: false,
          deploymentVersion: 1,
        });
      }

      const results = await Promise.allSettled([
        store.activateDeployment(PROD, 'prod-rollback'),
        store.activateDeployment(DEV, 'dev-rollback'),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expectConflict(results);
      expect((await store.loadAll()).filter(isActiveCustomer)).toHaveLength(1);
    }));

  it('rejects a conflicting restore before clearing archive stamps', () =>
    withStore(kind, async (store) => {
      await store.append(record('archived-owner', PROD));
      await store.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');
      await store.append(record('current-owner', OTHER));

      await expect(store.restoreApp(PROD.org, PROD.app)).rejects.toMatchObject({
        code: 'customer_auth_audience_conflict',
      });
      await expect(store.getAppArchivedAt(PROD.org, PROD.app)).resolves.toBe(
        '2026-07-30T00:00:00.000Z',
      );
    }));

  it('rejects a semantically stale restore projection before clearing archive stamps', () =>
    withStore(kind, async (store) => {
      await store.append(record('stale-projection', PROD));
      await store.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');

      await expect(
        store.restoreApp(PROD.org, PROD.app, {
          customerAuthProjections: [
            {
              deploymentId: 'stale-projection',
              manifest: '{}',
              serverAuth: OTHER_AUTH,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'customer_auth_audience_conflict' });
      await expect(store.getAppArchivedAt(PROD.org, PROD.app)).resolves.toBe(
        '2026-07-30T00:00:00.000Z',
      );
    }));

  it('accepts an exact compiler-authoritative restore projection', () =>
    withStore(kind, async (store) => {
      await store.append(record('exact-projection', PROD));
      await store.archiveApp(PROD.org, PROD.app, '2026-07-30T00:00:00.000Z');

      await expect(
        store.restoreApp(PROD.org, PROD.app, {
          customerAuthProjections: [
            {
              deploymentId: 'exact-projection',
              manifest: '{}',
              serverAuth: AUTH,
            },
          ],
        }),
      ).resolves.toEqual({ restoredDeployments: 1 });
    }));
});

describe('no-store activation version guard', () => {
  it.each([false, true])('requires explicit v2 activation intent (explicit: %s)', (explicit) => {
    const target = {
      ...record('future-target', PROD),
      schemaVersion: 2,
      accessMode: 'mixed' as const,
      active: false,
    };
    const records = new Map([[target.deploymentId, target]]);
    const result = activateInMemory(
      records,
      PROD,
      target.deploymentId,
      explicit ? { expectedAccessMode: 'mixed', expectedSchemaVersion: 2 } : undefined,
    );
    if (explicit) expect(result).toMatchObject({ active: { schemaVersion: 2, active: true } });
    else expect(result).toBeUndefined();
    expect(records.get(target.deploymentId)).toMatchObject({ active: explicit });
  });

  it('preserves the implicit downgrade guard and explicit historical rollback', () => {
    const historical = { ...record('old-pending', PROD), active: false };
    const current = {
      ...record('new-active', PROD),
      schemaVersion: 2,
      accessMode: 'mixed' as const,
    };
    const records = new Map([
      [historical.deploymentId, historical],
      [current.deploymentId, current],
    ]);
    expect(() => activateInMemory(records, PROD, historical.deploymentId)).toThrow(
      expect.objectContaining({ code: 'unsupported_deployment_record_version' }),
    );
    expect(records.get(current.deploymentId)).toMatchObject({ active: true });
    expect(
      activateInMemory(records, PROD, historical.deploymentId, {
        expectedAccessMode: 'customers',
        expectedSchemaVersion: 1,
      }),
    ).toMatchObject({ active: { deploymentId: historical.deploymentId } });
  });
});

async function withStore(
  kind: 'memory' | 'json',
  run: (store: ArtifactStore) => Promise<void>,
): Promise<void> {
  if (kind === 'memory') return run(new InMemoryArtifactStore());
  const root = await mkdtemp(join(tmpdir(), 'customer-auth-store-lifecycle-'));
  try {
    await run(new JsonFileArtifactStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectConflict(results: readonly PromiseSettledResult<unknown>[]): void {
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toMatchObject({ code: 'customer_auth_audience_conflict' });
}

function isActiveCustomer(item: DeployRecord): boolean {
  return item.active && item.archivedAt === undefined && item.accessMode === 'customers';
}

function ownerRecord(deploymentId: string, tenant: TenantRef): DeployRecord {
  return {
    ...record(deploymentId, tenant),
    accessMode: 'owner-only',
    createdBySubject: 'owner',
  };
}

function record(deploymentId: string, tenant: TenantRef): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId,
    orgSlug: tenant.org,
    appSlug: tenant.app,
    environment: tenant.env,
    serverVersion: '1',
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-07-30T00:00:00.000Z',
    accessMode: 'customers',
    serverAuth: AUTH,
    manifest: '{}',
    secrets: { enc: 'none', values: {} },
  };
}
