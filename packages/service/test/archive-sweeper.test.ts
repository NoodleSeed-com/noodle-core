import { describe, expect, it, vi } from 'vitest';
import {
  ArchiveSweeper,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  type DeployRecord,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryConfigStore,
  resolveArchiveRetentionDays,
  ServerRegistry,
} from '../src/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: {} },
};

describe('resolveArchiveRetentionDays', () => {
  it('defaults to 30 days', () => {
    expect(resolveArchiveRetentionDays({})).toBe(30);
    expect(DEFAULT_ARCHIVE_RETENTION_DAYS).toBe(30);
    expect(resolveArchiveRetentionDays({ NOODLE_ARCHIVE_RETENTION_DAYS: ' ' })).toBe(30);
  });

  it('honors the NOODLE_ARCHIVE_RETENTION_DAYS override', () => {
    expect(resolveArchiveRetentionDays({ NOODLE_ARCHIVE_RETENTION_DAYS: '7' })).toBe(7);
  });

  it('fails closed on a non-positive or non-integer override', () => {
    expect(() => resolveArchiveRetentionDays({ NOODLE_ARCHIVE_RETENTION_DAYS: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => resolveArchiveRetentionDays({ NOODLE_ARCHIVE_RETENTION_DAYS: 'never' })).toThrow(
      /positive integer/,
    );
  });
});

async function harness(nowIso: string) {
  const store = new InMemoryArtifactStore();
  const configStore = new InMemoryConfigStore();
  const audit = new InMemoryAuditStore();
  const registry = new ServerRegistry(store, undefined, configStore);
  let now = new Date(nowIso);
  const sweeper = new ArchiveSweeper({
    registry,
    configStore,
    audit,
    retentionDays: 30,
    clock: () => now,
  });
  return {
    store,
    configStore,
    audit,
    registry,
    sweeper,
    setNow: (next: Date) => {
      now = next;
    },
    getNow: () => now,
  };
}

describe('ArchiveSweeper', () => {
  it('hard-deletes only past-retention apps, reclaims their config, and audits each purge', async () => {
    const h = await harness('2026-08-10T00:00:00.000Z');
    await h.store.append(RECORD);
    await h.store.append({
      ...RECORD,
      deploymentId: 'hello-stag5678',
      environment: 'staging',
      deploymentVersion: 2,
    });
    await h.store.append({
      ...RECORD,
      deploymentId: 'fresh-abcd1234',
      appSlug: 'fresh',
      deploymentVersion: 3,
    });
    await h.store.append({
      ...RECORD,
      deploymentId: 'mixed-old1234',
      appSlug: 'mixed',
      deploymentVersion: 4,
      archivedAt: '2026-07-01T00:00:00.000Z',
    });
    await h.store.append({
      ...RECORD,
      deploymentId: 'mixed-live1234',
      appSlug: 'mixed',
      deploymentVersion: 5,
    });
    // hello archived 40 days ago (past retention); fresh archived yesterday (retained).
    await h.store.archiveApp('acme', 'hello', '2026-07-01T00:00:00.000Z');
    await h.store.archiveApp('acme', 'fresh', '2026-08-09T00:00:00.000Z');
    for (const [scope, name] of [
      [{ level: 'app', org: 'acme', app: 'hello' }, 'API_KEY'],
      [{ level: 'env', org: 'acme', app: 'hello', env: 'staging' }, 'STAGE_KEY'],
      [{ level: 'org', org: 'acme' }, 'ORG_WIDE'],
      [{ level: 'app', org: 'acme', app: 'fresh' }, 'FRESH_KEY'],
      [{ level: 'app', org: 'acme', app: 'mixed' }, 'MIXED_KEY'],
      [{ level: 'env', org: 'acme', app: 'mixed', env: 'prod' }, 'MIXED_ENV_KEY'],
    ] as const) {
      await h.configStore.setConfigValue({ kind: 'secret', scope, name, value: 'v' });
    }

    const result = await h.sweeper.sweepNow();
    expect(result).toEqual({ deletedDeployments: 2, purgedApps: 1 });

    expect(await h.store.get('hello-abcd1234')).toBeUndefined();
    expect(await h.store.get('hello-stag5678')).toBeUndefined();
    expect((await h.store.get('fresh-abcd1234'))?.archivedAt).toBe('2026-08-09T00:00:00.000Z');
    expect(await h.store.get('mixed-old1234')).toBeDefined();
    expect(await h.store.get('mixed-live1234')).toBeDefined();

    expect(
      await h.configStore.listConfigValues('secret', { level: 'app', org: 'acme', app: 'hello' }),
    ).toHaveLength(0);
    expect(
      await h.configStore.listConfigValues('secret', {
        level: 'env',
        org: 'acme',
        app: 'hello',
        env: 'staging',
      }),
    ).toHaveLength(0);
    expect(
      await h.configStore.listConfigValues('secret', { level: 'org', org: 'acme' }),
    ).toHaveLength(1);
    expect(
      await h.configStore.listConfigValues('secret', { level: 'app', org: 'acme', app: 'fresh' }),
    ).toHaveLength(1);
    expect(
      await h.configStore.listConfigValues('secret', { level: 'app', org: 'acme', app: 'mixed' }),
    ).toHaveLength(1);
    expect(
      await h.configStore.listConfigValues('secret', {
        level: 'env',
        org: 'acme',
        app: 'mixed',
        env: 'prod',
      }),
    ).toHaveLength(1);

    const purged = await h.audit.list({ org: 'acme', eventType: 'app.purged' });
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({
      org: 'acme',
      app: 'hello',
      decision: 'allow',
      reasonCode: 'retention_elapsed',
    });
    expect(purged[0]?.details).toMatchObject({ deletedDeployments: 2 });
    expect(purged.some((entry) => entry.app === 'mixed')).toBe(false);
  });

  it('is a quiet no-op when nothing is past retention', async () => {
    const h = await harness('2026-08-10T00:00:00.000Z');
    await h.store.append(RECORD);
    expect(await h.sweeper.sweepNow()).toEqual({ deletedDeployments: 0, purgedApps: 0 });
    expect(await h.audit.list({ org: 'acme', eventType: 'app.purged' })).toHaveLength(0);
  });

  it('maybeSweep throttles repeat sweeps within the interval', async () => {
    const h = await harness('2026-08-10T00:00:00.000Z');
    const spy = vi.spyOn(h.registry, 'sweepArchived');

    h.sweeper.maybeSweep();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    h.sweeper.maybeSweep();
    expect(spy).toHaveBeenCalledTimes(1);

    h.setNow(new Date(h.getNow().getTime() + 7 * 60 * 60 * 1000)); // past the 6h interval
    h.sweeper.maybeSweep();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    h.setNow(new Date(h.getNow().getTime() + DAY_MS));
    h.sweeper.maybeSweep();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  });
});
