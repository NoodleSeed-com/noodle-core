import { describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { builtInDefinitionAtRelease } from '../src/business-information/profiles.js';
import { describeBusinessInformationStore } from './business-information-store-suite.js';

describe('in-memory business information store', () => {
  let now = new Date('2030-01-01T00:00:00.000Z');
  describeBusinessInformationStore(async () => {
    now = new Date('2030-01-01T00:00:00.000Z');
    return {
      store: new InMemoryBusinessInformationStore({ now: () => new Date(now) }),
      advance: (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  });

  it('advances old and new installations together without rewriting operator state or old records', async () => {
    let stableRelease = 1;
    let id = 0;
    const store = new InMemoryBusinessInformationStore({
      managedDefinition: (key) => builtInDefinitionAtRelease(key, stableRelease),
      id: () => `record-${++id}`,
      publicId: () => `sol-${++id}`,
    });
    const oldScope = {
      org: 'acme',
      app: 'travel-old',
      env: 'prod',
      installationId: 'travel-old-prod',
    };
    const installed = await store.createInstallation({
      scope: oldScope,
      definition: builtInDefinitionAtRelease('travel', 1),
      managedCollections: ['travel_requests'],
      retentionDays: 90,
      actorSubject: 'owner',
      actorEmail: 'owner@example.com',
    });
    if (installed.disposition !== 'created') throw new Error('old installation was not created');
    const oldRecord = await store.createRequest({
      scope: oldScope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'old-record',
      payload: { request_type: 'refund', summary: 'Keep the original schema.' },
      origin: { kind: 'portal' },
      actorSubject: 'owner',
    });
    if (oldRecord.disposition !== 'created') throw new Error('old record was not created');
    await store.setGrant({
      scope: oldScope,
      subject: 'operator',
      email: 'operator@example.com',
      role: 'operator',
      expectedRevision: 0,
      actorSubject: 'owner',
    });
    await store.mutateRequest({
      scope: oldScope,
      collectionKey: 'travel_requests',
      id: oldRecord.record.id,
      expectedRevision: 1,
      actorSubject: 'owner',
      operation: { kind: 'assign', assigneeSubject: 'operator' },
    });
    const paused = await store.setIntakeState({
      scope: oldScope,
      expectedRevision: 1,
      active: false,
      actorSubject: 'owner',
    });
    expect(paused).toMatchObject({ ok: true, installation: { revision: 2 } });

    stableRelease = 2;
    const upgraded = await store.getInstallation(oldScope);
    expect(upgraded).toMatchObject({
      publicId: installed.installation.publicId,
      profileVersion: 2,
      managedCollections: ['travel_requests'],
      retentionDays: 90,
      intakeActive: false,
      revision: 2,
      definition: { reference: { kind: 'managed', definitionId: 'travel', release: 2 } },
    });
    await expect(store.getGrant(oldScope, 'operator')).resolves.toMatchObject({
      role: 'operator',
      revision: 1,
    });
    await expect(
      store.setIntakeState({
        scope: oldScope,
        expectedRevision: 2,
        active: true,
        actorSubject: 'owner',
      }),
    ).resolves.toMatchObject({
      ok: true,
      installation: { profileVersion: 2, intakeActive: true, revision: 3 },
    });
    const preserved = await store.getRequest(oldScope, 'travel_requests', oldRecord.record.id);
    expect(preserved).toMatchObject({
      profileVersion: 1,
      schemaVersion: 1,
      schemaDigest: oldRecord.record.schemaDigest,
      assigneeSubject: 'operator',
      revision: 2,
    });
    await expect(
      store.listRequests({ scope: oldScope, collectionKey: 'travel_requests' }),
    ).resolves.toMatchObject({ records: [{ profileVersion: 1, schemaVersion: 1 }] });
    await expect(
      store.exportRequests({ scope: oldScope, collectionKey: 'travel_requests' }),
    ).resolves.toMatchObject({ records: [{ profileVersion: 1, schemaVersion: 1 }] });
    await expect(
      store.listActivity(oldScope, 'travel_requests', oldRecord.record.id),
    ).resolves.toMatchObject({
      activities: [
        { revision: 2, kind: 'assigned' },
        { revision: 1, kind: 'created' },
      ],
    });
    const updated = await store.mutateRequest({
      scope: oldScope,
      collectionKey: 'travel_requests',
      id: oldRecord.record.id,
      expectedRevision: 2,
      actorSubject: 'operator',
      operation: {
        kind: 'update',
        payload: { request_type: 'refund', summary: 'Still valid without optional fields.' },
      },
    });
    expect(updated).toMatchObject({
      ok: true,
      record: { profileVersion: 1, schemaVersion: 1, revision: 3 },
    });
    await expect(
      store.mutateRequest({
        scope: oldScope,
        collectionKey: 'travel_requests',
        id: oldRecord.record.id,
        expectedRevision: 3,
        actorSubject: 'operator',
        operation: {
          kind: 'update',
          payload: {
            request_type: 'refund',
            summary: 'Do not change the accepted record schema.',
            priority: 'urgent',
          },
        },
      }),
    ).rejects.toThrow(/outside the editable field set/);

    const newScope = {
      org: 'acme',
      app: 'travel-new',
      env: 'prod',
      installationId: 'travel-new-prod',
    };
    const newer = await store.createInstallation({
      scope: newScope,
      definition: builtInDefinitionAtRelease('travel', 2),
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    expect(newer).toMatchObject({
      disposition: 'created',
      installation: { profileVersion: 2 },
    });
    const newRecord = await store.createRequest({
      scope: newScope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'new-record',
      payload: {
        request_type: 'information',
        summary: 'Use the current stable schema.',
        priority: 'urgent',
      },
      origin: { kind: 'portal' },
      actorSubject: 'owner',
    });
    expect(newRecord).toMatchObject({
      disposition: 'created',
      record: { profileVersion: 2, schemaVersion: 2 },
    });
  });
});
