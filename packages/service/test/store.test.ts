import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ArtifactStore,
  type DeployRecord,
  deploymentOwnerSubject,
  InMemoryArtifactStore,
  JsonFileArtifactStore,
} from '../src/index.js';

const RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'hello-abcd1234',
  orgSlug: 'acme',
  appSlug: 'hello',
  environment: 'prod',
  deploymentVersion: 1,
  active: true,
  serverName: 'hello',
  createdAt: '2026-06-03T00:00:00.000Z',
  createdBySubject: 'owner-sub',
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: { httpbin_token: 'tok-secret-123' } },
};

let dirs: string[] = [];
async function tmpDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe('JsonFileArtifactStore', () => {
  it('round-trips a record: append then loadAll', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    await store.append(RECORD);
    expect(await store.loadAll()).toEqual([RECORD]);
  });

  it('preserves deployment source in records and list summaries without inventing legacy values', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    const sourced = {
      ...RECORD,
      deploymentSource: 'console-example' as const,
    } as DeployRecord & { readonly deploymentSource: 'console-example' };
    await store.append(sourced);

    expect(
      ((await store.get(sourced.deploymentId)) as typeof sourced | undefined)?.deploymentSource,
    ).toBe('console-example');
    expect(
      (
        (await store.listDeployments({ org: sourced.orgSlug }))[0] as
          | { readonly deploymentSource?: string }
          | undefined
      )?.deploymentSource,
    ).toBe('console-example');

    const legacy = { ...RECORD, deploymentId: 'legacy-abcd1234', active: false };
    await store.append(legacy);
    expect(
      'deploymentSource' in
        ((await store.get(legacy.deploymentId)) as DeployRecord & {
          readonly deploymentSource?: string;
        }),
    ).toBe(false);
  });

  it('writes one JSON file per deployment under <dataDir>/deployments/<deploymentId>.json', async () => {
    const dir = await tmpDataDir();
    await new JsonFileArtifactStore(dir).append(RECORD);
    const file = join(dir, 'deployments', `${RECORD.deploymentId}.json`);
    expect((await stat(file)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8')).deploymentId).toBe(RECORD.deploymentId);
  });

  it('replaces the record on a second append for the same deploymentId', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    await store.append(RECORD);
    await store.append({ ...RECORD, serverName: 'hello-v2' });
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.serverName).toBe('hello-v2');
  });

  it('loadAll on a fresh (nonexistent) data dir returns []', async () => {
    expect(await new JsonFileArtifactStore(await tmpDataDir()).loadAll()).toEqual([]);
  });

  it('skips a corrupt record file instead of crashing (fail-soft)', async () => {
    const dir = await tmpDataDir();
    const store = new JsonFileArtifactStore(dir);
    await store.append(RECORD);
    // Plant a corrupt JSON file alongside the good one.
    await writeFile(
      join(dir, 'deployments', 'broken-00000000.json'),
      '{ "serverId": "x", not json',
      'utf8',
    );
    // The good record is returned; the corrupt file is skipped, not thrown.
    expect(await store.loadAll()).toEqual([RECORD]);
  });

  it('rejects a deploymentId that is not a safe filename (path-safety guard)', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    await expect(store.append({ ...RECORD, deploymentId: '../escape' })).rejects.toThrow(
      /invalid deploymentId/,
    );
  });

  it('get returns one record by id, undefined for an unknown id', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    await store.append(RECORD);
    expect(await store.get(RECORD.deploymentId)).toEqual(RECORD);
    expect(await store.get('nope-00000000')).toBeUndefined();
  });

  it('getActiveByTenant returns the active record for an app environment', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    await store.append(RECORD);
    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(
      RECORD,
    );
  });

  it('keeps active deployments independently per server version', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    const v1 = { ...RECORD, deploymentId: 'hello-v1aaaaaa', serverVersion: '1' };
    const v2 = {
      ...RECORD,
      deploymentId: 'hello-v2bbbbbb',
      serverVersion: '2.0.0',
      deploymentVersion: 2,
    };
    await store.append(v1);
    await store.append(v2);

    expect(
      await store.getActiveByTenantVersion({ org: 'acme', app: 'hello', env: 'prod' }, '1'),
    ).toEqual(v1);
    expect(
      await store.getActiveByTenantVersion({ org: 'acme', app: 'hello', env: 'prod' }, 'v2_0_0'),
    ).toEqual(v2);
    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(v2);
  });

  it('redeploys the same server version without deactivating other versions', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    const oldV1 = { ...RECORD, deploymentId: 'hello-v1aaaaaa', serverVersion: '1' };
    const newV1 = {
      ...RECORD,
      deploymentId: 'hello-v1cccccc',
      serverVersion: '1',
      deploymentVersion: 3,
      serverName: 'hello-v1-new',
    };
    const v2 = {
      ...RECORD,
      deploymentId: 'hello-v2bbbbbb',
      serverVersion: '2.0.0',
      deploymentVersion: 2,
    };
    await store.append(oldV1);
    await store.append(v2);
    await store.append(newV1);

    expect((await store.get(oldV1.deploymentId))?.active).toBe(false);
    expect((await store.get(v2.deploymentId))?.active).toBe(true);
    expect(
      await store.getActiveByTenantVersion({ org: 'acme', app: 'hello', env: 'prod' }, '1'),
    ).toEqual(newV1);
  });

  it('activates an older record atomically for the same tenant environment', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    const newer = {
      ...RECORD,
      deploymentId: 'hello-newer1234',
      deploymentVersion: 2,
      serverName: 'hello-v2',
    };
    await store.append(RECORD);
    await store.append(newer);

    const result = await store.activateDeployment(
      { org: 'acme', app: 'hello', env: 'prod' },
      RECORD.deploymentId,
    );

    expect(result).toMatchObject({
      active: RECORD,
      previousActive: newer,
      alreadyActive: false,
    });
    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(
      RECORD,
    );
    expect((await store.get(newer.deploymentId))?.active).toBe(false);
  });

  it('does not activate a deployment from another tenant environment', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    await store.append(RECORD);

    await expect(
      store.activateDeployment({ org: 'acme', app: 'other', env: 'prod' }, RECORD.deploymentId),
    ).resolves.toBeUndefined();
  });

  it('get returns undefined for an unsafe id (no throw, no traversal)', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    expect(await store.get('../escape')).toBeUndefined();
  });

  it('persists identity metadata and the tagged secret envelope', async () => {
    const dir = await tmpDataDir();
    await new JsonFileArtifactStore(dir).append(RECORD);
    const parsed = JSON.parse(
      await readFile(join(dir, 'deployments', `${RECORD.deploymentId}.json`), 'utf8'),
    );
    expect(parsed.accessMode).toBe('owner-only');
    expect(parsed).not.toHaveProperty('callerKey');
    expect(parsed).not.toHaveProperty('callerKeyHash');
    // Slice 25 writes the interim plaintext envelope; Slice 26 (ADR 0028) swaps in ciphertext.
    expect(parsed.secrets).toEqual({ enc: 'none', values: { httpbin_token: 'tok-secret-123' } });
  });

  it('round-trips a distinct owner binding without changing creator provenance', async () => {
    const store = new JsonFileArtifactStore(await tmpDataDir());
    const bound = { ...RECORD, ownerSubject: 'oauth-human' };

    await store.append(bound);

    await expect(store.get(bound.deploymentId)).resolves.toEqual(bound);
    expect(deploymentOwnerSubject((await store.get(bound.deploymentId)) as DeployRecord)).toBe(
      'oauth-human',
    );
  });
});

describe('InMemoryArtifactStore', () => {
  it('round-trips records', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(RECORD);
    expect(await store.loadAll()).toEqual([RECORD]);
  });

  it('round-trips a distinct owner binding and resolves legacy creator fallback', async () => {
    const store = new InMemoryArtifactStore();
    const bound = { ...RECORD, ownerSubject: 'oauth-human' };
    await store.append(bound);
    expect(await store.get(bound.deploymentId)).toEqual(bound);
    expect(deploymentOwnerSubject(bound)).toBe('oauth-human');
    expect(deploymentOwnerSubject(RECORD)).toBe(RECORD.createdBySubject);
  });

  it('replaces on re-append of the same deploymentId', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(RECORD);
    await store.append({ ...RECORD, serverName: 'v2' });
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.serverName).toBe('v2');
  });

  it('get returns one record by id, undefined for an unknown id', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(RECORD);
    expect(await store.get(RECORD.deploymentId)).toEqual(RECORD);
    expect(await store.get('nope-00000000')).toBeUndefined();
  });

  it('getActiveByTenant returns the active record for an app environment', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(RECORD);
    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(
      RECORD,
    );
  });

  it('uses the highest semantic server version for unversioned tenant lookup', async () => {
    const store = new InMemoryArtifactStore();
    const high = {
      ...RECORD,
      deploymentId: 'hello-high1111',
      serverVersion: '2.0.0',
      deploymentVersion: 1,
    };
    const lowerNewer = {
      ...RECORD,
      deploymentId: 'hello-low2222',
      serverVersion: '1.99.99',
      deploymentVersion: 99,
    };
    await store.append(high);
    await store.append(lowerNewer);

    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(high);
  });

  it('falls back to the legacy active deployment when no versioned deployment exists', async () => {
    const store = new InMemoryArtifactStore();
    await store.append(RECORD);

    expect(await store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' })).toEqual(
      RECORD,
    );
  });

  it('activates an older record and preserves deployment history', async () => {
    const store = new InMemoryArtifactStore();
    const newer = {
      ...RECORD,
      deploymentId: 'hello-newer1234',
      deploymentVersion: 2,
      serverName: 'hello-v2',
    };
    await store.append(RECORD);
    await store.append(newer);

    const result = await store.activateDeployment(
      { org: 'acme', app: 'hello', env: 'prod' },
      RECORD.deploymentId,
    );

    expect(result).toMatchObject({
      active: RECORD,
      previousActive: newer,
      alreadyActive: false,
    });
    expect(await store.loadAll()).toHaveLength(2);
    expect((await store.get(RECORD.deploymentId))?.active).toBe(true);
    expect((await store.get(newer.deploymentId))?.active).toBe(false);
  });
});

/** App soft-delete/archive contract (ADR 0117) — behavior-identical across store backends. */
function archiveStoreSuite(name: string, makeStore: () => Promise<ArtifactStore>): void {
  const TENANT = { org: 'acme', app: 'hello', env: 'prod' } as const;
  const PROD = RECORD;
  const STAGING: DeployRecord = {
    ...RECORD,
    deploymentId: 'hello-stag1234',
    environment: 'staging',
    deploymentVersion: 2,
  };
  const OTHER_APP: DeployRecord = {
    ...RECORD,
    deploymentId: 'other-abcd1234',
    appSlug: 'other',
    serverName: 'other',
    deploymentVersion: 3,
  };
  const AT = '2026-07-04T00:00:00.000Z';

  async function seeded(): Promise<ArtifactStore> {
    const store = await makeStore();
    await store.append(PROD);
    await store.append(STAGING);
    await store.append(OTHER_APP);
    return store;
  }

  describe(`${name} app archive (ADR 0117)`, () => {
    it('archives every record for the app across environments and reports the stamp', async () => {
      const store = await seeded();
      expect(await store.getAppArchivedAt('acme', 'hello')).toBeUndefined();

      const result = await store.archiveApp('acme', 'hello', AT);
      expect(result).toEqual({ archivedAt: AT, archivedDeployments: 2, alreadyArchived: false });
      expect(await store.getAppArchivedAt('acme', 'hello')).toBe(AT);
      expect((await store.get(PROD.deploymentId))?.archivedAt).toBe(AT);
      expect((await store.get(STAGING.deploymentId))?.archivedAt).toBe(AT);
      // The neighbouring app is untouched.
      expect((await store.get(OTHER_APP.deploymentId))?.archivedAt).toBeUndefined();
      expect(await store.getAppArchivedAt('acme', 'other')).toBeUndefined();
    });

    it('hides archived deployments from the default list and shows them with includeArchived', async () => {
      const store = await seeded();
      await store.archiveApp('acme', 'hello', AT);

      const visible = await store.listDeployments({ org: 'acme' });
      expect(visible.map((d) => d.deploymentId)).toEqual([OTHER_APP.deploymentId]);

      const all = await store.listDeployments({ org: 'acme', includeArchived: true });
      expect(all).toHaveLength(3);
      const archived = all.filter((d) => d.appSlug === 'hello');
      expect(archived).toHaveLength(2);
      for (const summary of archived) expect(summary.archivedAt).toBe(AT);
      expect(all.find((d) => d.appSlug === 'other')?.archivedAt).toBeUndefined();
    });

    it('makes tenant lookups miss for an archived app (MCP lookup miss)', async () => {
      const store = await seeded();
      const versioned: DeployRecord = {
        ...RECORD,
        deploymentId: 'hello-vers1234',
        serverVersion: '1',
        deploymentVersion: 4,
      };
      await store.append(versioned);
      await store.archiveApp('acme', 'hello', AT);

      expect(await store.getActiveByTenant(TENANT)).toBeUndefined();
      expect(await store.getActiveByTenantVersion(TENANT, '1')).toBeUndefined();
      expect(
        await store.getActiveByTenant({ org: 'acme', app: 'other', env: 'prod' }),
      ).toBeDefined();
    });

    it('re-archiving is a no-op that preserves the original retention stamp', async () => {
      const store = await seeded();
      await store.archiveApp('acme', 'hello', AT);
      const again = await store.archiveApp('acme', 'hello', '2026-07-10T00:00:00.000Z');
      expect(again).toEqual({ archivedAt: AT, archivedDeployments: 0, alreadyArchived: true });
      expect(await store.getAppArchivedAt('acme', 'hello')).toBe(AT);
    });

    it('returns undefined for archive/restore of an unknown app', async () => {
      const store = await seeded();
      expect(await store.archiveApp('acme', 'ghost', AT)).toBeUndefined();
      expect(await store.restoreApp('acme', 'ghost')).toBeUndefined();
    });

    it('restore clears the stamp and the app serves and lists again', async () => {
      const store = await seeded();
      await store.archiveApp('acme', 'hello', AT);
      const result = await store.restoreApp('acme', 'hello');
      expect(result).toEqual({ restoredDeployments: 2 });
      expect(await store.getAppArchivedAt('acme', 'hello')).toBeUndefined();
      expect((await store.get(PROD.deploymentId))?.archivedAt).toBeUndefined();
      expect(await store.getActiveByTenant(TENANT)).toBeDefined();
      const visible = await store.listDeployments({ org: 'acme', app: 'hello' });
      expect(visible).toHaveLength(2);
    });

    it('restore of a non-archived app restores nothing', async () => {
      const store = await seeded();
      expect(await store.restoreApp('acme', 'hello')).toEqual({ restoredDeployments: 0 });
    });

    it('sweepArchived hard-deletes only records archived before the cutoff', async () => {
      const store = await seeded();
      await store.archiveApp('acme', 'hello', AT);
      await store.archiveApp('acme', 'other', '2026-07-20T00:00:00.000Z');

      const deleted = await store.sweepArchived('2026-07-10T00:00:00.000Z');
      expect(deleted.map((record) => record.deploymentId).sort()).toEqual(
        [PROD.deploymentId, STAGING.deploymentId].sort(),
      );
      expect(await store.get(PROD.deploymentId)).toBeUndefined();
      expect(await store.get(STAGING.deploymentId)).toBeUndefined();
      // Archived after the cutoff: retained, still archived.
      expect((await store.get(OTHER_APP.deploymentId))?.archivedAt).toBe(
        '2026-07-20T00:00:00.000Z',
      );
      expect(await store.getAppArchivedAt('acme', 'hello')).toBeUndefined();
      expect(await store.listDeployments({ org: 'acme', includeArchived: true })).toHaveLength(1);
    });

    it('sweeps only complete apps whose every deployment crossed retention', async () => {
      const store = await seeded();
      await store.append({
        ...OTHER_APP,
        deploymentId: 'mixed-old1234',
        appSlug: 'mixed',
        archivedAt: AT,
      });
      await store.append({ ...OTHER_APP, deploymentId: 'mixed-live1234', appSlug: 'mixed' });
      await store.append({
        ...OTHER_APP,
        deploymentId: 'newer-old1234',
        appSlug: 'newer',
        archivedAt: AT,
      });
      await store.append({
        ...OTHER_APP,
        deploymentId: 'newer-fresh1234',
        appSlug: 'newer',
        archivedAt: '2026-07-20T00:00:00.000Z',
      });
      await store.append({
        ...OTHER_APP,
        deploymentId: 'eligible-a1234',
        appSlug: 'eligible',
        archivedAt: AT,
      });
      await store.append({
        ...OTHER_APP,
        deploymentId: 'eligible-b1234',
        appSlug: 'eligible',
        archivedAt: AT,
      });

      const deleted = await store.sweepArchived('2026-07-10T00:00:00.000Z');

      expect(deleted.map((record) => record.deploymentId).sort()).toEqual(
        ['eligible-a1234', 'eligible-b1234'].sort(),
      );
      expect(await store.get('mixed-old1234')).toBeDefined();
      expect(await store.get('mixed-live1234')).toBeDefined();
      expect(await store.get('newer-old1234')).toBeDefined();
      expect(await store.get('newer-fresh1234')).toBeDefined();
    });
  });
}

archiveStoreSuite('InMemoryArtifactStore', () => Promise.resolve(new InMemoryArtifactStore()));
archiveStoreSuite(
  'JsonFileArtifactStore',
  async () => new JsonFileArtifactStore(await tmpDataDir()),
);

function lifecyclePreconditionSuite(name: string, makeStore: () => Promise<ArtifactStore>): void {
  describe(`${name} lifecycle preconditions`, () => {
    it('mutates only the expected active row and rejects a changed rollback target', async () => {
      const store = await makeStore();
      const inactive = { ...RECORD, active: false };
      const active = {
        ...RECORD,
        deploymentId: 'hello-newer1234',
        deploymentVersion: 2,
      };
      await store.append(inactive);
      await store.append(active);

      await expect(
        store.updateActiveAccess(
          { org: 'acme', app: 'hello', env: 'prod' },
          inactive.deploymentId,
          {
            accessMode: 'customers',
            expectedAccessMode: 'owner-only',
            expectedOwnerSubject: inactive.createdBySubject,
          },
        ),
      ).resolves.toBeUndefined();
      await expect(
        store.activateDeployment(
          { org: 'acme', app: 'hello', env: 'prod' },
          inactive.deploymentId,
          { expectedAccessMode: 'customers' },
        ),
      ).resolves.toBeUndefined();
      await expect(
        store.getActiveByTenant({ org: 'acme', app: 'hello', env: 'prod' }),
      ).resolves.toEqual(active);
    });
  });
}

lifecyclePreconditionSuite('InMemoryArtifactStore', () =>
  Promise.resolve(new InMemoryArtifactStore()),
);
lifecyclePreconditionSuite(
  'JsonFileArtifactStore',
  async () => new JsonFileArtifactStore(await tmpDataDir()),
);
