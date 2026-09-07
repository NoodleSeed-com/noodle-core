import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import type { DeployRecord } from '../src/store.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(!databaseUrl)('installation and application lifecycle authority', () => {
  const schema = `installation_lifecycle_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  const artifacts = new PostgresArtifactStore(pool);
  const cipher = new TestPayloadCipher();
  const store = new PostgresBusinessInformationStore(pool, cipher);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await artifacts.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  async function setup() {
    const org = `org-${randomUUID()}`;
    await pool.query(`INSERT INTO orgs(slug) VALUES ($1)`, [org]);
    const scope = { org, app: 'travel', env: 'prod', installationId: 'travel-prod' };
    const record: DeployRecord = {
      schemaVersion: 1,
      deploymentId: `travel-${randomUUID()}`,
      orgSlug: org,
      appSlug: scope.app,
      environment: scope.env,
      deploymentVersion: 1,
      active: true,
      serverName: 'travel',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBySubject: 'owner',
      accessMode: 'public',
      manifest: 'manifestVersion: "2"',
      secrets: { enc: 'none', values: {} },
    };
    await artifacts.append(record);
    const { installation } = await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const generation = await artifacts.getAppGeneration(org, 'travel');
    if (!generation) throw new Error('app missing');
    expect(await store.bindApplication(scope, generation)).toBe(true);
    const create = (key: string) =>
      store.createRequest({
        scope,
        collectionKey: 'travel_requests',
        payload: { request_type: 'service', summary: 'Retained' },
        idempotencyKey: key,
        origin: { kind: 'embedded' },
        actorSubject: 'visitor',
      });
    return { scope, record, installation, generation, create };
  }
  it('retains records, grants and replay after archive and purge; same-name recreation cannot revive intake', async () => {
    const { scope, record, generation, create } = await setup();
    const accepted = await create('before');
    expect(accepted.disposition).toBe('created');
    await artifacts.archiveApp(scope.org, scope.app, '2026-02-01T00:00:00.000Z');
    expect(await store.getInstallation(scope)).toMatchObject({
      intakeActive: false,
      revision: 2,
      applicationGeneration: generation,
    });
    expect(await create('after')).toEqual({ disposition: 'paused' });
    expect((await create('before')).disposition).toBe('replayed');
    const resume = async () =>
      store.setIntakeState({
        scope,
        active: true,
        expectedRevision: (await store.getInstallation(scope))?.revision ?? 0,
        actorSubject: 'owner',
      });
    expect(await resume()).toMatchObject({ ok: false, reason: 'application_unavailable' });
    await artifacts.sweepArchived('2026-04-01T00:00:00.000Z');
    expect(await artifacts.getApp(scope.org, scope.app)).toBeUndefined();
    expect(await store.getInstallation(scope)).toMatchObject({
      intakeActive: false,
      applicationGeneration: 'retired',
    });
    expect(
      (await store.listRequests({ scope, collectionKey: 'travel_requests' })).records,
    ).toHaveLength(1);
    expect(await store.getGrant(scope, 'owner')).toMatchObject({ role: 'administrator' });
    await artifacts.append({
      ...record,
      deploymentId: `travel-${randomUUID()}`,
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    const replacement = await artifacts.getAppGeneration(scope.org, scope.app);
    expect(replacement).not.toBe(generation);
    expect(await store.bindApplication(scope, replacement ?? '')).toBe(false);
    expect(await resume()).toMatchObject({ ok: false, reason: 'application_unavailable' });
    expect(await create('replacement')).toEqual({ disposition: 'paused' });
    expect(
      (await store.exportRequests({ scope, collectionKey: 'travel_requests' })).records,
    ).toHaveLength(1);
    if (accepted.disposition !== 'created') throw new Error('record missing');
    expect(
      await store.deleteRequest({
        scope,
        collectionKey: 'travel_requests',
        id: accepted.record.id,
        expectedRevision: 1,
        actorSubject: 'owner',
        reason: 'customer_request',
      }),
    ).toMatchObject({ ok: true });
  });
  it('keeps restore paused and serializes an admitted create with archive through the app lock', async () => {
    const { scope, create } = await setup();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT 1 FROM apps WHERE org_slug=$1 AND slug=$2 FOR UPDATE`, [
      scope.org,
      scope.app,
    ]);
    let settled = false;
    const pending = create('raced').then((result) => {
      settled = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      await blocker.query(
        `UPDATE deploy_records SET archived_at=now() WHERE org_slug=$1 AND app_slug=$2`,
        [scope.org, scope.app],
      );
      await blocker.query('COMMIT');
      expect(await pending).toEqual({ disposition: 'paused' });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await artifacts.archiveApp(scope.org, scope.app, new Date().toISOString());
    await artifacts.restoreApp(scope.org, scope.app);
    expect(await create('restored')).toEqual({ disposition: 'paused' });
    expect(
      await store.setIntakeState({
        scope,
        active: true,
        expectedRevision: 2,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ ok: true });
    expect((await create('resumed')).disposition).toBe('created');
  });
  it('binds legacy rows only with an older live application inventory and never a recreated app', async () => {
    const { scope, generation } = await setup();
    await pool.query(
      `UPDATE business_solution_installations SET application_generation=NULL WHERE org_slug=$1`,
      [scope.org],
    );
    expect(await store.bindApplication(scope, generation)).toBe(true);
    await pool.query(
      `UPDATE business_solution_installations SET application_generation=NULL,created_at='2025-01-01' WHERE org_slug=$1`,
      [scope.org],
    );
    expect(await store.bindApplication(scope, generation)).toBe(false);
    expect(await store.bindApplication(scope, 'not-a-date')).toBe(false);
  });
  it('blocks new staff records before activation and after archive while preserving committed replay', async () => {
    const { scope } = await setup();
    const pendingScope = { ...scope, env: 'staging', installationId: 'pending' };
    await store.createInstallation({
      scope: pendingScope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const create = (target: typeof scope, key: string) =>
      store.createRequest({
        scope: target,
        collectionKey: 'travel_requests',
        payload: { request_type: 'service', summary: 'Staff' },
        idempotencyKey: key,
        origin: { kind: 'portal' },
        actorSubject: 'owner',
      });
    expect(await create(pendingScope, 'pending')).toEqual({ disposition: 'paused' });
    expect(
      await store.setIntakeState({
        scope,
        active: false,
        expectedRevision: 1,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ ok: true });
    expect((await create(scope, 'accepted')).disposition).toBe('created');
    await artifacts.archiveApp(scope.org, scope.app, new Date().toISOString());
    expect(await create(scope, 'after')).toEqual({ disposition: 'paused' });
    expect((await create(scope, 'accepted')).disposition).toBe('replayed');
  });

  it.each([
    ['revocation', 'revoke'],
    ['assignment', 'revoke'],
    ['revocation', 'invitation'],
    ['assignment', 'invitation'],
  ] as const)('serializes the assignee grant when %s acquires authority first (%s)', async (first, method) => {
    const { scope, create } = await setup();
    const record = await create('assignment-race');
    if (record.disposition !== 'created') throw new Error('record missing');
    await store.setGrant({
      scope,
      subject: 'operator',
      email: 'operator@example.test',
      role: 'operator',
      actorSubject: 'owner',
      expectedRevision: 0,
    });
    const tokenDigest = createHash('sha256').update(randomUUID()).digest('hex');
    if (method === 'invitation') {
      expect(
        await store.createInvitation({
          scope,
          invitationId: `binv_${randomUUID()}`,
          email: 'operator@example.test',
          role: 'viewer',
          tokenDigest,
          idempotencyKey: 'viewer-invitation',
          actorSubject: 'owner',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).toMatchObject({ disposition: 'created' });
    }
    const entered = signal();
    const release = signal();
    const assign = (revision = 1) =>
      store.mutateRequest({
        scope,
        collectionKey: 'travel_requests',
        id: record.record.id,
        expectedRevision: revision,
        actorSubject: 'owner',
        operation: { kind: 'assign', assigneeSubject: 'operator' },
      });
    const revoke = () =>
      method === 'invitation'
        ? store.claimInvitation({
            tokenDigest,
            subject: 'operator',
            email: 'operator@example.test',
          })
        : store.revokeGrant({
            scope,
            subject: 'operator',
            expectedRevision: 1,
            actorSubject: 'owner',
          });
    let waitingFinished = false;
    if (first === 'revocation') {
      const revoking = withPostgresTransaction(pool, async () => {
        const result = await revoke();
        entered.resolve();
        await release.promise;
        return result;
      });
      await entered.promise;
      const assigning = assign().then((result) => {
        waitingFinished = true;
        return result;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(waitingFinished).toBe(false);
      } finally {
        release.resolve();
      }
      expect(await revoking).toMatchObject({ ok: true });
      expect(await assigning).toMatchObject({ ok: false, reason: 'invalid_assignee' });
      expect(
        (await store.listActivity(scope, 'travel_requests', record.record.id)).activities,
      ).toHaveLength(1);
    } else {
      const seal = cipher.seal.bind(cipher);
      const spy = vi.spyOn(cipher, 'seal').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return seal(...args);
      });
      try {
        const assigning = assign();
        await entered.promise;
        const revoking = revoke().then((result) => {
          waitingFinished = true;
          return result;
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(waitingFinished).toBe(false);
        } finally {
          release.resolve();
        }
        const [assigned, revoked] = await Promise.all([assigning, revoking]);
        expect(assigned).toMatchObject({ ok: true, record: { revision: 2 } });
        expect(revoked).toMatchObject({ ok: true });
      } finally {
        release.resolve();
        spy.mockRestore();
      }
      expect(await store.getRequest(scope, 'travel_requests', record.record.id)).toMatchObject({
        revision: 2,
        assigneeSubject: 'operator',
      });
      expect(await assign(2)).toMatchObject({ ok: false, reason: 'invalid_assignee' });
      expect(
        (await store.listActivity(scope, 'travel_requests', record.record.id)).activities,
      ).toHaveLength(2);
    }
  });
});
