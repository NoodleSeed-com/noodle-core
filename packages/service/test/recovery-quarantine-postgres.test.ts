import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { SecretBoxPayloadCipher } from '../src/business-information-cipher.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';
import { closeHttpServer, listenHttpServer } from '../src/service-resource-cleanup.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const scope = { org: 'recovery-example', app: 'travel', env: 'prod', installationId: 'travel' };
const collection = 'travel_requests';
const prefix = `/v1/orgs/${scope.org}/solution-installations/${scope.installationId}`;
const recordPath = `${prefix}/collections/${collection}/records`;
const now = () => new Date('2030-01-02T00:00:00Z');

describe.skipIf(!databaseUrl)('encrypted PostgreSQL restore quarantine', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const schemas: string[] = [];
  const pools: pg.Pool[] = [];
  const cipher = new SecretBoxPayloadCipher(
    new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 7).toString('base64'))),
  );
  const controlPlane = new InMemoryControlPlaneStore();
  beforeAll(async () => {
    await controlPlane.createOrg({ slug: scope.org });
  });
  afterAll(async () => {
    for (const pool of pools) await pool.end();
    for (const schema of schemas) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  async function empty() {
    const schema = `restore_${randomUUID().replaceAll('-', '')}`;
    schemas.push(schema);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      options: `-c search_path=${schema}`,
    });
    pools.push(pool);
    const store = new PostgresBusinessInformationStore(pool, cipher, { now });
    await store.ensureSchema();
    return { schema, pool, store };
  }

  // A consistent logical snapshot of this fixture's complete native authority, using actual encrypted
  // rows and real constraints/triggers. This is not a Cloud SQL PITR or a fleet-wide coverage receipt.
  async function snapshot(source: Awaited<ReturnType<typeof empty>>) {
    const target = await empty();
    const client = await target.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      for (const table of [
        'business_solution_installations',
        'business_installation_grants',
        'managed_request_records',
        'managed_request_activities',
      ])
        await client.query(
          `INSERT INTO ${target.schema}.${table} SELECT * FROM ${source.schema}.${table}`,
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return target;
  }

  async function setup() {
    const original = await empty();
    await original.store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: [collection],
      actorSubject: 'owner',
    });
    await original.store.setGrant({
      scope,
      subject: 'viewer',
      email: 'viewer@example.test',
      role: 'viewer',
      expectedRevision: 0,
      actorSubject: 'owner',
    });
    const create = (idempotencyKey: string) =>
      original.store.createRequest({
        scope,
        collectionKey: collection,
        payload: { request_type: 'service', summary: `private-${idempotencyKey}` },
        idempotencyKey,
        origin: { kind: 'api' },
        actorSubject: 'owner',
      });
    const erased = await create('later-erased');
    const retained = await create('retained');
    if (erased.disposition !== 'created' || retained.disposition !== 'created')
      throw new Error('record fixture failed');
    return { original, erased: erased.record, retained: retained.record };
  }

  async function laterChanges(f: Awaited<ReturnType<typeof setup>>) {
    expect(
      await f.original.store.deleteRequest({
        scope,
        collectionKey: collection,
        id: f.erased.id,
        expectedRevision: 1,
        actorSubject: 'owner',
        reason: 'customer_request',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await f.original.store.revokeGrant({
        scope,
        subject: 'viewer',
        expectedRevision: 1,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await f.original.store.setIntakeState({
        scope,
        active: false,
        expectedRevision: 1,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ ok: true });
  }

  async function listen(
    store: PostgresBusinessInformationStore,
    recoveryMode: 'quarantined' | 'reopened',
  ) {
    const server = createServer(
      createServiceHandler(new ServerRegistry(), {
        recoveryMode,
        businessInformationStore: store,
        controlPlaneStore: controlPlane,
        clock: now,
        deployGate: {
          authorize: async (req) => ({
            ok: true,
            identity: {
              subject: req.headers.authorization === 'Bearer viewer' ? 'viewer' : 'owner',
              email: 'actor@example.test',
              superAdmin: false,
            },
          }),
        },
      }),
    );
    await listenHttpServer(server, 0, '127.0.0.1');
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => closeHttpServer(server),
    };
  }

  it('keeps a real older encrypted snapshot inaccessible despite restored active grants and missing erasure history', async () => {
    const f = await setup();
    const older = await snapshot(f.original);
    await laterChanges(f);
    // Restricted fixture inspection establishes precisely the unsafe history the old snapshot lost.
    expect(await older.store.getRequest(scope, collection, f.erased.id)).toMatchObject({
      content: { payload: { summary: 'private-later-erased' } },
    });
    expect(await older.store.getInstallation(scope)).toMatchObject({ intakeActive: true });
    expect(await older.store.getGrant(scope, 'viewer')).not.toHaveProperty('revokedAt');
    const read = vi.spyOn(older.store, 'getRequest');
    for (let restart = 0; restart < 2; restart += 1) {
      const service = await listen(older.store, 'quarantined');
      try {
        for (const path of [
          recordPath,
          `${recordPath}/${f.erased.id}`,
          `${recordPath}/export`,
          `${prefix}/grants`,
          `${prefix}/settings`,
          `${prefix}/activity`,
        ]) {
          const response = await fetch(service.url + path, {
            headers: { authorization: 'Bearer viewer' },
          });
          expect(response.status).toBe(503);
          expect(await response.text()).not.toContain('private-later-erased');
        }
      } finally {
        await service.close();
      }
    }
    expect(read).not.toHaveBeenCalled();
    // No timer, epoch, new grant or fresh consent can prove missing post-backup authority.
    expect(await older.store.getRequest(scope, collection, f.erased.id)).toBeDefined();
  });

  it('reopens only the controlled complete-history fixture and preserves erasure, revoked access and replay across replicas', async () => {
    const f = await setup();
    await laterChanges(f);
    // No other writer exists in this fixture; this snapshot includes every acknowledged mutation.
    const complete = await snapshot(f.original);
    for (let replica = 0; replica < 2; replica += 1) {
      const reopenedStore = new PostgresBusinessInformationStore(complete.pool, cipher, { now });
      const service = await listen(reopenedStore, 'reopened');
      try {
        expect(
          (
            await fetch(`${service.url}${recordPath}`, {
              headers: { authorization: 'Bearer viewer' },
            })
          ).status,
        ).toBe(403);
        const records = await fetch(`${service.url}${recordPath}`, {
          headers: { authorization: 'Bearer owner' },
        });
        expect(records.status, await records.clone().text()).toBe(200);
        const body = await records.text();
        expect(body).toContain('private-retained');
        expect(body).not.toContain('private-later-erased');
        expect((await reopenedStore.getInstallation(scope))?.intakeActive).toBe(false);
        expect(await reopenedStore.getRequest(scope, collection, f.erased.id)).toBeUndefined();
        const replay = await reopenedStore.createRequest({
          scope,
          collectionKey: collection,
          payload: { request_type: 'service', summary: 'private-retained' },
          idempotencyKey: 'retained',
          origin: { kind: 'api' },
          actorSubject: 'owner',
        });
        expect(replay.disposition).toBe('replayed');
      } finally {
        await service.close();
      }
    }
  });
});
