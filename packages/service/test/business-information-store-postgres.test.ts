import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { builtInDefinitionAtRelease } from '../src/business-information/profiles.js';
import { describeBusinessInformationStore } from './business-information-store-suite.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres business information store', () => {
  const schema = `business_information_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  let now = new Date('2030-01-01T00:00:00.000Z');
  const store = new PostgresBusinessInformationStore(pool, new TestPayloadCipher(), {
    now: () => new Date(now),
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  describeBusinessInformationStore(async () => {
    now = new Date('2030-01-01T00:00:00.000Z');
    return {
      store,
      advance: (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  });

  it('creates on the selected stable release even when a newer definition is bundled', async () => {
    const stable = new PostgresBusinessInformationStore(pool, new TestPayloadCipher(), {
      managedDefinition: (key) => builtInDefinitionAtRelease(key, 3),
    });
    const scope = {
      org: `org-${randomUUID()}`,
      app: 'stable',
      env: 'prod',
      installationId: 'stable-prod',
    };
    const result = await stable.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    expect(result.installation.profileVersion).toBe(3);
    expect((await stable.getInstallation(scope))?.definition.reference).toMatchObject({
      release: 3,
    });
  });

  it('edits against the accepted schema after the managed release changes without losing prior fields', async () => {
    const legacyStore = new PostgresBusinessInformationStore(pool, new TestPayloadCipher(), {
      now: () => new Date(now),
      managedDefinition: (key) => builtInDefinitionAtRelease(key, 1),
    });
    const scope = {
      org: `org-${randomUUID()}`,
      app: 'history',
      env: 'prod',
      installationId: 'history-prod',
    };
    await legacyStore.createInstallation({
      scope,
      definition: builtInDefinitionAtRelease('travel', 1),
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const created = await legacyStore.createRequest({
      scope,
      collectionKey: 'travel_requests',
      payload: { request_type: 'refund', summary: 'Original', booking_reference: 'KEEP-ME' },
      idempotencyKey: 'historical-edit',
      origin: { kind: 'mcp' },
      actorSubject: 'visitor',
    });
    if (created.disposition !== 'created') throw new Error('expected record');
    const command = {
      scope,
      collectionKey: 'travel_requests',
      id: created.record.id,
      expectedRevision: 1,
      actorSubject: 'owner',
    };
    await expect(
      store.mutateRequest({
        ...command,
        operation: { kind: 'update', payload: { priority: 'urgent' } },
      }),
    ).rejects.toThrow(/schema/);
    expect(
      await store.mutateRequest({
        ...command,
        operation: { kind: 'update', payload: { summary: 'Corrected' } },
      }),
    ).toMatchObject({
      ok: true,
      record: {
        schemaVersion: 1,
        schemaDigest: created.record.schemaDigest,
        revision: 2,
        content: { payload: { summary: 'Corrected', booking_reference: 'KEEP-ME' } },
      },
    });
    expect(await store.getRequest(scope, command.collectionKey, command.id)).toMatchObject({
      schemaVersion: 1,
      revision: 2,
    });
    expect(
      await store.mutateRequest({
        ...command,
        expectedRevision: 2,
        operation: { kind: 'update', payload: {}, unset: ['booking_reference'] },
      }),
    ).toMatchObject({ ok: true, record: { schemaVersion: 1, revision: 3 } });
    expect(await store.getRequest(scope, command.collectionKey, command.id)).not.toHaveProperty(
      'content.payload.booking_reference',
    );
  });

  it('commits legacy schema conversion and historical reader identity durably with replay intact', async () => {
    const legacyStore = new PostgresBusinessInformationStore(pool, new TestPayloadCipher(), {
      now: () => new Date(now),
      managedDefinition: (key) => builtInDefinitionAtRelease(key, 1),
    });
    const scope = {
      org: `org-${randomUUID()}`,
      app: 'migration',
      env: 'prod',
      installationId: 'migration-prod',
    };
    await legacyStore.createInstallation({
      scope,
      definition: builtInDefinitionAtRelease('travel', 1),
      managedCollections: ['travel_requests'],
      retentionDays: 90,
      actorSubject: 'owner',
    });
    const input = {
      scope,
      collectionKey: 'travel_requests',
      payload: { request_type: 'refund', summary: 'Retain historical identity' },
      idempotencyKey: 'migration-request',
      origin: { kind: 'embedded' as const },
      actorSubject: 'visitor',
    };
    const created = await legacyStore.createRequest(input);
    if (created.disposition !== 'created') throw new Error('expected legacy row');
    const command = {
      scope,
      collectionKey: 'travel_requests',
      id: created.record.id,
      expectedRevision: 1,
      actorSubject: 'release-migration',
    };
    const raced = await Promise.all([
      store.migrateLegacyRequest(command),
      store.migrateLegacyRequest(command),
    ]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(raced.filter((result) => !result.ok)).toMatchObject([{ reason: 'conflict' }]);
    const read = await store.getRequest(scope, 'travel_requests', created.record.id);
    expect(read).not.toHaveProperty('status');
    expect(read).toMatchObject({
      revision: 2,
      profileVersion: 4,
      createdAt: created.record.createdAt,
      retentionExpiresAt: created.record.retentionExpiresAt,
      originalSchema: {
        profileVersion: 1,
        schemaVersion: 1,
        schemaDigest: created.record.schemaDigest,
      },
      content: { payload: { ...input.payload, status: 'new' } },
    });
    expect(await store.listActivity(scope, 'travel_requests', created.record.id)).toMatchObject({
      activities: [
        { kind: 'schema_migrated', revision: 2 },
        { kind: 'created', revision: 1 },
      ],
    });
    expect(await store.createRequest(input)).toMatchObject({
      disposition: 'replayed',
      record: { id: created.record.id, revision: 2 },
    });
    expect(await store.listAcceptedSchemaInventory()).toEqual(
      expect.arrayContaining([
        {
          profileKey: 'travel',
          profileVersion: 1,
          collectionKey: 'travel_requests',
          schemaVersion: 1,
          schemaDigest: created.record.schemaDigest,
        },
        {
          profileKey: 'travel',
          profileVersion: 4,
          collectionKey: 'travel_requests',
          schemaVersion: 4,
          schemaDigest: read?.schemaDigest,
        },
      ]),
    );
  });
});

describe('Postgres payload custody', () => {
  it('fails closed without a payload cipher', () => {
    expect(() => new PostgresBusinessInformationStore({} as pg.Pool, undefined as never)).toThrow(
      /cipher/,
    );
  });
});
