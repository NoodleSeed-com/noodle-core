import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `app_lifecycle_lock_${process.pid}`;
const ORG = 'acme';
const APP = 'support';
const CUTOFF = '2026-08-10T00:00:00.000Z';
const OLD_ARCHIVE = '2026-08-01T00:00:00.000Z';
const FRESH_ARCHIVE = '2026-08-20T00:00:00.000Z';
const OLD_DEPLOYMENT_ID = 'support-old-11111111';
const NEW_DEPLOYMENT_ID = 'support-new-22222222';

describe.skipIf(!URL)('Postgres app lifecycle parent locking', () => {
  let admin: Pool;
  let pool: Pool;
  let first: LifecycleStore;
  let second: LifecycleStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 8, options: `-c search_path=${SCHEMA}` });
    first = lifecycleStore(pool);
    second = lifecycleStore(pool);
    await first.store.ensureSchema();
  });

  beforeEach(async () => {
    first.reset();
    second.reset();
    await pool.query('TRUNCATE deploy_records, environments, apps, orgs CASCADE');
    await pool.query(`INSERT INTO orgs (slug) VALUES ('acme')`);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.end();
    }
  });

  it('retains the app when append owns the parent before sweep', async () => {
    await seedExpiredApp();
    const appendOwner = pausedStore(first, 'append');
    const sweepWaiter = observedStore(second, 'sweep');

    const [append, sweep] = await runOrderedRace(
      appendOwner,
      () => appendOwner.store.append(record(NEW_DEPLOYMENT_ID)),
      sweepWaiter,
      () => sweepWaiter.store.sweepArchived(CUTOFF),
    );

    expect(append).toBeUndefined();
    expect(sweep).toEqual([]);
    expect(await second.store.get(NEW_DEPLOYMENT_ID)).toBeDefined();
  });

  it('recreates the app when sweep owns the parent before append', async () => {
    await seedExpiredApp();
    const sweepOwner = pausedStore(first, 'sweep');
    const appendWaiter = observedStore(second, 'append');

    const [sweep] = await runOrderedRace(
      sweepOwner,
      () => sweepOwner.store.sweepArchived(CUTOFF),
      appendWaiter,
      () => appendWaiter.store.append(record(NEW_DEPLOYMENT_ID)),
    );

    expect(sweep.map((entry) => entry.deploymentId)).toEqual([OLD_DEPLOYMENT_ID]);
    expect(await second.store.get(NEW_DEPLOYMENT_ID)).toBeDefined();
  });

  it('retains the restored app when restore owns the parent before sweep', async () => {
    await seedExpiredApp();
    const restoreOwner = pausedStore(first, 'restore');
    const sweepWaiter = observedStore(second, 'sweep');

    const [, sweep] = await runOrderedRace(
      restoreOwner,
      () => restoreOwner.store.restoreApp(ORG, APP),
      sweepWaiter,
      () => sweepWaiter.store.sweepArchived(CUTOFF),
    );

    expect(sweep).toEqual([]);
    expect(await second.store.getAppArchivedAt(ORG, APP)).toBeUndefined();
  });

  it('returns missing when sweep owns the parent before restore', async () => {
    await seedExpiredApp();
    const sweepOwner = pausedStore(first, 'sweep');
    const restoreWaiter = observedStore(second, 'restore');

    const [, restore] = await runOrderedRace(
      sweepOwner,
      () => sweepOwner.store.sweepArchived(CUTOFF),
      restoreWaiter,
      () => restoreWaiter.store.restoreApp(ORG, APP),
    );

    expect(restore).toBeUndefined();
  });

  it('retains the freshly archived app when archive owns the parent before sweep', async () => {
    await first.store.append(record(OLD_DEPLOYMENT_ID));
    const archiveOwner = pausedStore(first, 'archive');
    const sweepWaiter = observedStore(second, 'sweep');

    const [, sweep] = await runOrderedRace(
      archiveOwner,
      () => archiveOwner.store.archiveApp(ORG, APP, FRESH_ARCHIVE),
      sweepWaiter,
      () => sweepWaiter.store.sweepArchived(CUTOFF),
    );

    expect(sweep).toEqual([]);
  });

  it('returns missing when sweep owns the parent before archive', async () => {
    await seedExpiredApp();
    const sweepOwner = pausedStore(first, 'sweep');
    const archiveWaiter = observedStore(second, 'archive');

    const [, archive] = await runOrderedRace(
      sweepOwner,
      () => sweepOwner.store.sweepArchived(CUTOFF),
      archiveWaiter,
      () => archiveWaiter.store.archiveApp(ORG, APP, FRESH_ARCHIVE),
    );

    expect(archive).toBeUndefined();
  });

  async function seedExpiredApp(): Promise<void> {
    await first.store.append(record(OLD_DEPLOYMENT_ID, OLD_ARCHIVE));
  }
});

type LifecycleOperation = 'append' | 'archive' | 'restore' | 'sweep';

interface PausedStore {
  readonly store: PostgresArtifactStore;
  readonly acquired: Promise<void>;
  readonly release: () => void;
}

interface ObservedStore {
  readonly store: PostgresArtifactStore;
  readonly attempted: Promise<void>;
}

interface LifecycleStore {
  readonly store: PostgresArtifactStore;
  readonly intercept: (
    hook: (sql: string, run: () => Promise<unknown>) => Promise<unknown>,
  ) => void;
  readonly reset: () => void;
}

function pausedStore(controlled: LifecycleStore, operation: LifecycleOperation): PausedStore {
  const acquired = deferred();
  const release = deferred();
  let locked = false;
  controlled.intercept(async (sql, run) => {
    if (!locked && isAppLock(sql, operation)) {
      const result = await run();
      locked = true;
      acquired.resolve();
      await release.promise;
      return result;
    }
    if (!locked && isOperationPastAppLock(sql, operation)) {
      throw new Error(`${operation} reached app data before locking its parent`);
    }
    return run();
  });
  return {
    store: controlled.store,
    acquired: acquired.promise,
    release: release.resolve,
  };
}

function observedStore(controlled: LifecycleStore, operation: LifecycleOperation): ObservedStore {
  const attempted = deferred();
  controlled.intercept((sql, run) => {
    if (isAppLock(sql, operation)) attempted.resolve();
    return run();
  });
  return {
    store: controlled.store,
    attempted: attempted.promise,
  };
}

function lifecycleStore(pool: Pool): LifecycleStore {
  let hook = (_sql: string, run: () => Promise<unknown>) => run();
  const wrapped = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property !== 'query') return Reflect.get(target, property, receiver);
          return (sql: string, values?: readonly unknown[]) =>
            hook(sql, () => target.query(sql, values)) as ReturnType<typeof target.query>;
        },
      });
    },
  } as Pool;
  return {
    store: new PostgresArtifactStore(wrapped),
    intercept: (next) => {
      hook = next;
    },
    reset: () => {
      hook = (_sql, run) => run();
    },
  };
}

async function runOrderedRace<OwnerResult, WaiterResult>(
  owner: PausedStore,
  ownerAction: () => Promise<OwnerResult>,
  waiter: ObservedStore,
  waiterAction: () => Promise<WaiterResult>,
): Promise<readonly [OwnerResult, WaiterResult]> {
  const ownerResult = ownerAction();
  await reachedBeforeCompletion(owner.acquired, ownerResult);
  const waiterResult = waiterAction();
  try {
    await reachedBeforeCompletion(waiter.attempted, waiterResult);
  } finally {
    owner.release();
  }
  return Promise.all([ownerResult, waiterResult]);
}

async function reachedBeforeCompletion(signal: Promise<void>, operation: Promise<unknown>) {
  await Promise.race([
    signal,
    operation.then(
      () => Promise.reject(new Error('operation completed before reaching its app lock')),
      (error: unknown) => Promise.reject(error),
    ),
  ]);
}

function isAppLock(sql: string, operation: LifecycleOperation): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  if (operation === 'append') {
    return (
      normalized.includes('INSERT INTO apps (org_slug, slug)') &&
      normalized.includes('DO UPDATE') &&
      normalized.includes('RETURNING slug')
    );
  }
  if (operation === 'sweep') {
    return normalized.includes('FROM apps app') && normalized.includes('FOR UPDATE OF app');
  }
  return (
    normalized.includes('SELECT slug FROM apps') &&
    normalized.includes('WHERE org_slug = $1 AND slug = $2') &&
    normalized.includes('FOR UPDATE')
  );
}

function isOperationPastAppLock(sql: string, operation: LifecycleOperation): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  if (operation === 'append') return normalized.includes('FROM deploy_records');
  if (operation === 'archive') return normalized.startsWith('UPDATE deploy_records');
  if (operation === 'restore') return normalized.includes('FROM deploy_records');
  return normalized.startsWith('DELETE FROM deploy_records');
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function record(deploymentId: string, archivedAt?: string): DeployRecord {
  return {
    schemaVersion: 1,
    deploymentId,
    orgSlug: ORG,
    appSlug: APP,
    environment: 'prod',
    deploymentVersion: deploymentId === OLD_DEPLOYMENT_ID ? 1 : 2,
    active: false,
    serverName: 'support',
    createdAt: '2026-07-01T00:00:00.000Z',
    createdBySubject: 'owner-subject',
    accessMode: 'owner-only',
    manifest: 'manifestVersion: "1"\n',
    secrets: { enc: 'none', values: {} },
    ...(archivedAt === undefined ? {} : { archivedAt }),
  };
}
