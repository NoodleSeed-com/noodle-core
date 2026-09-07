import { describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { builtInDefinitionAtRelease } from '../src/business-information/profiles.js';

describe('explicit request-bundle migration', () => {
  it('preserves identity, history, replay, grants and expiry while moving status to one payload field', async () => {
    let release = 1;
    const now = new Date('2030-01-01T00:00:00Z');
    const store = new InMemoryBusinessInformationStore({
      managedDefinition: (key) => builtInDefinitionAtRelease(key, release),
      now: () => now,
    });
    const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
    await store.createInstallation({
      scope,
      definition: builtInDefinitionAtRelease('travel', 1),
      managedCollections: ['travel_requests'],
      retentionDays: 90,
      actorSubject: 'owner',
    });
    const input = {
      scope,
      collectionKey: 'travel_requests',
      payload: { request_type: 'refund', summary: 'Keep all history' },
      idempotencyKey: 'existing-request',
      origin: { kind: 'embedded' as const },
      actorSubject: 'visitor',
    };
    const created = await store.createRequest(input);
    if (created.disposition !== 'created') throw new Error('expected create');
    const granted = await store.getGrant(scope, 'owner');
    const legacy = await store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.record.id,
      expectedRevision: 1,
      actorSubject: 'owner',
      operation: { kind: 'set_status', status: 'in_progress' },
    });
    if (!legacy.ok) throw new Error('expected historical status change');
    release = 3;
    expect(await store.getRequest(scope, 'travel_requests', created.record.id)).toEqual(
      legacy.record,
    );
    const migration = {
      scope,
      collectionKey: 'travel_requests',
      id: created.record.id,
      expectedRevision: 2,
      actorSubject: 'release-migration',
    };
    expect(await store.migrateLegacyRequest({ ...migration, expectedRevision: 1 })).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    const converted = await store.migrateLegacyRequest(migration);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.record).not.toHaveProperty('status');
    expect(converted.record).toMatchObject({
      id: created.record.id,
      createdAt: created.record.createdAt,
      retentionExpiresAt: created.record.retentionExpiresAt,
      profileVersion: 3,
      revision: 3,
      originalSchema: {
        profileVersion: 1,
        schemaVersion: 1,
        schemaDigest: created.record.schemaDigest,
      },
      content: { payload: { ...input.payload, status: 'in_progress' } },
    });
    expect(await store.getGrant(scope, 'owner')).toEqual(granted);
    expect(await store.listActivity(scope, 'travel_requests', created.record.id)).toMatchObject({
      activities: [
        { revision: 3, kind: 'schema_migrated' },
        { revision: 2, kind: 'status_changed' },
        { revision: 1, kind: 'created' },
      ],
    });
    expect(await store.migrateLegacyRequest({ ...migration, expectedRevision: 3 })).toEqual(
      converted,
    );
    expect(await store.createRequest(input)).toMatchObject({
      disposition: 'replayed',
      record: { id: created.record.id, revision: 3 },
    });
  });
});
