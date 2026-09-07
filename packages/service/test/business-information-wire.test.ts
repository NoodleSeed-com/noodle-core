import { describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import {
  builtInDefinition,
  builtInDefinitionAtRelease,
} from '../src/business-information/profiles.js';
import {
  collectionToPublicWire,
  collectionToWire,
  recordDetailToWire,
} from '../src/routes/business-information-wire.js';

describe('collection operator and public projections', () => {
  it('projects independent controls and preserves the public field boundary', () => {
    const base = builtInDefinition('travel').collections[0];
    if (base === undefined) throw new Error('missing collection');
    const collection = {
      ...base,
      management: { notes: true as const },
      fields: { summary: { label: 'Summary' }, status: { label: 'Internal handling' } },
      filterFields: ['status'],
      sortFields: ['status'],
    };
    expect(collectionToWire(collection)).toMatchObject({
      management: { notes: true },
      filterFields: ['status'],
    });
    const publicProjection = collectionToPublicWire(collection);
    expect(publicProjection).not.toHaveProperty('management');
    expect(publicProjection).not.toHaveProperty('editableFields');
    expect(publicProjection).not.toHaveProperty('filterFields');
    expect(publicProjection).not.toHaveProperty('sortFields');
    expect(publicProjection.recordSchema.properties).not.toHaveProperty('status');
    expect(publicProjection.fields).toEqual({ summary: { label: 'Summary' } });
  });

  it('keeps accepted fields but applies the current editable mask and controls', async () => {
    let release = 1;
    const store = new InMemoryBusinessInformationStore({
      managedDefinition: (key) => builtInDefinitionAtRelease(key, release),
    });
    const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
    await store.createInstallation({
      scope,
      definition: builtInDefinitionAtRelease('travel', 1),
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const created = await store.createRequest({
      scope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'old-record',
      payload: {
        request_type: 'refund',
        summary: 'Keep accepted fields',
        booking_reference: 'ABC123',
      },
      origin: { kind: 'mcp' },
      actorSubject: 'visitor',
    });
    if (created.disposition !== 'created') throw new Error('expected record');
    release = 3;
    const installation = await store.getInstallation(scope);
    if (installation === undefined) throw new Error('expected installation');
    const current = installation.definition.collections[0];
    if (current === undefined) throw new Error('expected collection');
    const detail = recordDetailToWire(
      {
        ...installation,
        definition: {
          ...installation.definition,
          collections: [
            { ...current, management: { notes: true }, editableFields: ['summary', 'status'] },
          ],
        },
      },
      created.record,
    );
    expect(detail.collection).toMatchObject({
      schemaVersion: 1,
      schemaDigest: created.record.schemaDigest,
      editableFields: ['summary'],
      management: { notes: true },
      filterFields: [],
      sortFields: [],
      fields: {},
    });
    expect(detail.record.payload.booking_reference).toBe('ABC123');
    expect(detail.collection).not.toHaveProperty('requestBehavior');
    expect(detail.collection?.recordSchema.properties).not.toHaveProperty('status');
    expect(() =>
      recordDetailToWire(installation, { ...created.record, schemaDigest: 'f'.repeat(64) }),
    ).toThrow(/unsupported schema/);
  });
});
