import { describe, expect, it } from 'vitest';
import type {
  ManagedRequestRecord,
  SolutionInstallation,
} from '../src/business-information/contracts.js';
import {
  assertCompatibleManagedRelease,
  assertManagedRollbackReaders,
  collectionForStoredRecord,
} from '../src/business-information/managed-releases.js';
import {
  BUILT_IN_SOLUTION_PROFILE_RELEASES,
  BUILT_IN_SOLUTION_PROFILES,
  builtInCollection,
  builtInDefinition,
  builtInDefinitionAtRelease,
  validateProfilePayload,
} from '../src/business-information/profiles.js';

const examples = {
  travel: {
    collection: 'travel_requests',
    payload: { request_type: 'refund', summary: 'Refund the unused segment.' },
  },
  b2b_saas: {
    collection: 'service_requests',
    payload: { request_type: 'support', summary: 'Workspace provisioning did not complete.' },
  },
  ecommerce: {
    collection: 'return_requests',
    payload: { order_reference: 'ORDER-9', reason: 'Item arrived damaged.' },
  },
  restaurant: {
    collection: 'guest_requests',
    payload: { request_type: 'reservation_help', summary: 'Move dinner to 20:00.' },
  },
} as const;

describe('built-in managed request profiles', () => {
  it('admits every shipped consecutive managed release through compatibility checks', () => {
    for (const key of ['travel', 'ecommerce', 'restaurant'] as const)
      for (const release of BUILT_IN_SOLUTION_PROFILE_RELEASES[key].slice(1))
        expect(() =>
          assertCompatibleManagedRelease(
            builtInDefinitionAtRelease(key, release.version - 1),
            builtInDefinitionAtRelease(key, release.version),
          ),
        ).not.toThrow();
  });

  it('rejects narrowed or removed settings and new requirements on an existing managed tool', () => {
    const previous = builtInDefinition('travel');
    if (previous.reference.kind !== 'managed') throw new Error('expected managed definition');
    const priorSetting = previous.variables?.[0];
    if (!priorSetting) throw new Error('managed setting missing');
    const setting = {
      ...priorSetting,
      name: 'MODE',
      valueSchema: { type: 'string', enum: ['short', 'long'], maxLength: 20 },
    };
    const base = { ...previous, variables: [setting] };
    const next = {
      ...base,
      reference: { ...previous.reference, release: previous.reference.release + 1 },
    };
    expect(() => assertCompatibleManagedRelease(base, { ...next, variables: [] })).toThrow(
      /setting/,
    );
    expect(() =>
      assertCompatibleManagedRelease(base, {
        ...next,
        variables: [{ ...setting, valueSchema: { ...setting.valueSchema, enum: ['short'] } }],
      }),
    ).toThrow(/setting/);
    expect(() =>
      assertCompatibleManagedRelease(base, {
        ...next,
        variables: [{ ...setting, requiredFor: ['submit_travel_request'] }],
      }),
    ).toThrow(/requirement/);
    expect(() =>
      assertCompatibleManagedRelease(base, {
        ...next,
        variables: [
          {
            ...setting,
            valueSchema: { ...setting.valueSchema, enum: ['short', 'long', 'medium'] },
            portal: { label: 'New label' },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertCompatibleManagedRelease(base, {
        ...next,
        variables: [{ ...setting, requiredFor: ['submit_travel_request'], default: 'short' }],
      }),
    ).not.toThrow();
  });
  it('keeps four vertical profiles as declarative data with one collection each', () => {
    expect(Object.keys(BUILT_IN_SOLUTION_PROFILES).sort()).toEqual([
      'b2b_saas',
      'ecommerce',
      'restaurant',
      'travel',
    ]);
    for (const [profileKey, example] of Object.entries(examples)) {
      const profile = BUILT_IN_SOLUTION_PROFILES[profileKey as keyof typeof examples];
      expect(profile.collections).toHaveLength(1);
      expect(profile.collections[0]).toMatchObject({
        key: example.collection,
        schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
      });
      expect(profile.collections[0]?.labels.plural.length).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(examples))('validates the %s request schema', (profileKey, example) => {
    expect(
      validateProfilePayload(
        profileKey as keyof typeof examples,
        example.collection,
        example.payload,
      ),
    ).toEqual(example.payload);
  });

  it('rejects unknown fields and missing required profile fields', () => {
    expect(() =>
      validateProfilePayload('travel', 'travel_requests', {
        request_type: 'refund',
        summary: 'Valid',
        undeclared: true,
      }),
    ).toThrow(/undeclared/);
    expect(() =>
      validateProfilePayload('ecommerce', 'return_requests', { reason: 'Missing order' }),
    ).toThrow(/order_reference/);
    expect(() => builtInCollection('travel', 'service_requests')).toThrow(/not declared/);
  });

  it('keeps immutable historical schemas while the current release accepts additive fields', () => {
    const release1 = builtInDefinitionAtRelease('travel', 1);
    const release2 = builtInDefinition('travel');
    expect(release2.reference).toMatchObject({ kind: 'managed', release: 4 });
    expect(release1.collections[0]).toMatchObject({ schemaVersion: 1 });
    expect(release2.collections[0]).toMatchObject({
      schemaVersion: 4,
      management: { assignment: true, notes: true },
    });
    expect(release2.collections[0]).not.toHaveProperty('behavior');
    expect(release1.collections[0]?.schemaDigest).not.toBe(release2.collections[0]?.schemaDigest);
    expect(() =>
      validateProfilePayload('travel', 'travel_requests', {
        request_type: 'information',
        summary: 'Where is the check-in desk?',
        priority: 'urgent',
      }),
    ).not.toThrow();
  });

  it('accepts the declared compatible release and rejects breaking release shapes', () => {
    const release1 = builtInDefinitionAtRelease('travel', 1);
    const release2 = builtInDefinitionAtRelease('travel', 2);
    expect(() => assertCompatibleManagedRelease(release1, release2)).not.toThrow();

    const collection = release2.collections[0];
    if (collection === undefined) throw new Error('travel release has no collection');
    const schema = structuredClone(collection.recordSchema) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    schema.required.push('priority');
    expect(() =>
      assertCompatibleManagedRelease(release1, {
        ...release2,
        collections: [{ ...collection, recordSchema: schema }],
      }),
    ).toThrow(/required fields/);

    const narrowed = structuredClone(collection.recordSchema) as {
      properties: Record<string, { enum?: string[] }>;
    };
    const requestType = narrowed.properties.request_type;
    if (requestType === undefined) throw new Error('travel release has no request_type');
    requestType.enum = ['service'];
    expect(() =>
      assertCompatibleManagedRelease(release1, {
        ...release2,
        collections: [{ ...collection, recordSchema: narrowed }],
      }),
    ).toThrow(/field semantics/);
  });

  it('rejects rollback below the newest accepted record schema', () => {
    const release1 = builtInDefinitionAtRelease('travel', 1);
    const release2 = builtInDefinitionAtRelease('travel', 2);
    const v1 = release1.collections[0];
    const v2 = release2.collections[0];
    if (v1 === undefined || v2 === undefined) throw new Error('travel release has no collection');
    const records = [
      {
        profileKey: 'travel',
        profileVersion: 1,
        collectionKey: v1.key,
        schemaVersion: v1.schemaVersion,
        schemaDigest: v1.schemaDigest,
      },
      {
        profileKey: 'travel',
        profileVersion: 2,
        collectionKey: v2.key,
        schemaVersion: v2.schemaVersion,
        schemaDigest: v2.schemaDigest,
      },
    ];
    expect(() => assertManagedRollbackReaders('travel', 2, records)).not.toThrow();
    expect(() => assertManagedRollbackReaders('travel', 1, records)).toThrow(
      /cannot read accepted profile release 2/,
    );
  });

  it('fails closed for an unknown stored record schema identity', () => {
    const definition = builtInDefinitionAtRelease('travel', 2);
    const collection = definition.collections[0];
    if (collection === undefined) throw new Error('travel release has no collection');
    const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
    const installation: SolutionInstallation = {
      scope,
      publicId: 'sol_travel',
      profileKey: 'travel',
      profileVersion: 2,
      managedCollections: ['travel_requests'],
      definition,
      retentionDays: 30,
      intakeActive: true,
      revision: 1,
      createdAt: '2030-01-01T00:00:00.000Z',
      createdBySubject: 'owner',
      updatedAt: '2030-01-01T00:00:00.000Z',
      updatedBySubject: 'owner',
    };
    const record: ManagedRequestRecord = {
      scope,
      collectionKey: 'travel_requests',
      id: 'record-1',
      profileKey: 'travel',
      profileVersion: 2,
      schemaVersion: collection.schemaVersion,
      schemaDigest: 'f'.repeat(64),
      status: 'new',
      origin: { kind: 'portal' },
      revision: 1,
      retentionExpiresAt: '2030-01-31T00:00:00.000Z',
      createdAt: '2030-01-01T00:00:00.000Z',
      createdBySubject: 'owner',
      updatedAt: '2030-01-01T00:00:00.000Z',
      updatedBySubject: 'owner',
      content: {
        payload: { request_type: 'service', summary: 'Unknown schema identity.' },
        notes: [],
      },
    };
    expect(() => collectionForStoredRecord(installation, record)).toThrow(
      /unsupported schema identity/,
    );
    expect(() =>
      collectionForStoredRecord(installation, { ...record, profileVersion: 99 }),
    ).toThrow(/unsupported built-in solution profile release/);
  });
});
