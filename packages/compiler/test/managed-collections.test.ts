import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';
import {
  MAX_MANAGED_COLLECTION_DESCRIPTION_LENGTH,
  MAX_MANAGED_COLLECTION_NAME_LENGTH,
  MAX_MANAGED_COLLECTION_RECORD_FIELDS,
  MAX_MANAGED_COLLECTION_SCHEMA_VERSION,
  MAX_MANAGED_COLLECTION_TITLE_LENGTH,
  MAX_MANAGED_COLLECTIONS,
} from '../src/managed-collections.js';

const baseRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'summary'],
  properties: {
    reference: { type: 'string', minLength: 1, maxLength: 120 },
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const;

function manifest(input: {
  readonly collections?: readonly unknown[];
  readonly toolName?: string;
  readonly manifestVersion?: '1' | '2';
}) {
  return {
    manifestVersion: input.manifestVersion ?? '2',
    server: {
      name: 'managed_requests',
      title: 'Managed requests',
      version: '1.0.0',
      ...(input.collections === undefined ? {} : { collections: input.collections }),
    },
    tools: [
      {
        name: input.toolName ?? 'health',
        description: 'Return service health.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  };
}

function collection(recordSchema: unknown = baseRecordSchema) {
  return {
    name: 'service_requests',
    title: 'Service requests',
    description: 'Customer requests that the business can review and resolve.',
    schemaVersion: 1,
    recordSchema,
  };
}

const boundConnector = {
  inventory: {
    id: 'inventory_api',
    version: '1.0.0',
    binding: {
      profile: 'customer',
      connection: { id: 'inventory_connection', source: { kind: 'externalExchange' as const } },
    },
  },
};

const scanInput = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'limit'],
  properties: {
    mode: { type: 'string', enum: ['snapshot', 'changes'] },
    cursor: { type: 'string' },
    checkpoint: { type: 'string' },
    limit: { type: 'integer', minimum: 1 },
  },
} as const;

function scanOutput(recordSchema: unknown = baseRecordSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['records', 'deletedIds', 'complete'],
    properties: {
      records: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'record'],
          properties: {
            id: { type: 'string' },
            version: { type: 'string' },
            record: recordSchema,
          },
        },
      },
      deletedIds: { type: 'array', items: { type: 'string' } },
      nextCursor: { type: 'string' },
      checkpoint: { type: 'string' },
      complete: { type: 'boolean' },
      resetRequired: { type: 'boolean' },
    },
  } as const;
}

function sourceCatalog(type: 'read' | 'action' = 'read', output: unknown = scanOutput()) {
  return {
    get(id: string, version: string) {
      if (id !== 'inventory_api' || version !== '1.0.0') return undefined;
      return {
        id,
        version,
        kind: 'custom' as const,
        credentialProfiles: { customer: { kind: 'bearer' as const } },
        operations: {
          scan_stock: { type, input: scanInput, output: output as Record<string, unknown> },
        },
      };
    },
  };
}

describe('managed collection compilation', () => {
  it('projects a valid declaration with a stable record-schema digest', () => {
    const first = compileManifest(manifest({ collections: [collection()] }));
    const reordered = compileManifest(
      manifest({
        collections: [
          collection({
            properties: {
              summary: { maxLength: 1000, minLength: 1, type: 'string' },
              reference: { maxLength: 120, minLength: 1, type: 'string' },
            },
            required: ['reference', 'summary'],
            additionalProperties: false,
            type: 'object',
          }),
        ],
      }),
    );
    expect(first.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(first.artifact.server.managedCollections).toEqual([
      {
        ...collection(),
        schemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: { authority: 'native' },
      },
    ]);
    expect(first.artifact.server.managedCollections?.[0]?.schemaDigest).toBe(
      reordered.artifact.server.managedCollections?.[0]?.schemaDigest,
    );
  });

  it('emits native authority and resolves a normalized external source', () => {
    const nativeResult = compileManifest(manifest({ collections: [collection()] }));
    expect(nativeResult.ok).toBe(true);
    if (nativeResult.ok) {
      expect(nativeResult.artifact.server.managedCollections?.[0]?.source).toEqual({
        authority: 'native',
      });
    }

    const externalManifest = manifest({
      collections: [{ ...collection(), source: { connector: 'inventory', scan: 'scan_stock' } }],
    });
    const result = compileManifest(
      { ...externalManifest, connectors: boundConnector },
      { catalog: sourceCatalog() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.managedCollections?.[0]?.source).toMatchObject({
      authority: 'external',
      connectorAlias: 'inventory',
      connectorId: 'inventory_api',
      connectorVersion: '1.0.0',
      scan: {
        resolved: true,
        operation: 'scan_stock',
        credentialBinding: {
          bindingId: 'inventory',
          connectionId: 'inventory_connection',
          profile: 'customer',
          presentation: { kind: 'bearer' },
          requiredScopes: [],
        },
      },
    });
  });

  it('rejects unbound, write-classified and schema-incompatible sources', () => {
    const external = {
      ...manifest({
        collections: [{ ...collection(), source: { connector: 'inventory', scan: 'scan_stock' } }],
      }),
      connectors: boundConnector,
    };
    const unbound = compileManifest(
      { ...external, connectors: { inventory: { id: 'inventory_api', version: '1.0.0' } } },
      { catalog: sourceCatalog() },
    );
    const write = compileManifest(external, { catalog: sourceCatalog('action') });
    const wrongRecord = compileManifest(external, {
      catalog: sourceCatalog(
        'read',
        scanOutput({
          type: 'object',
          additionalProperties: false,
          required: ['other'],
          properties: { other: { type: 'string' } },
        }),
      ),
    });

    for (const result of [unbound, write, wrongRecord]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({ code: 'invalid_managed_collection_source' }),
        );
      }
    }
  });

  it('rejects an unimplemented targeted-get declaration rather than advertising unused behavior', () => {
    const result = compileManifest({
      ...manifest({
        collections: [
          {
            ...collection(),
            source: { connector: 'inventory', scan: 'scan_stock', get: 'get_stock' },
          },
        ],
      }),
      connectors: boundConnector,
    });
    expect(result.ok).toBe(false);
  });

  it('reserves each future generated submit tool name', () => {
    const result = compileManifest(
      manifest({ collections: [collection()], toolName: 'submit_service_requests' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'reserved_name', path: 'tools.0.name' }),
    );
  });

  it.each([
    ['Bad-Name', 1],
    ['service_requests', 0],
    ['service_requests', -1],
    ['service_requests', 1.5],
    ['service_requests', MAX_MANAGED_COLLECTION_SCHEMA_VERSION + 1],
  ])('rejects invalid name/version pair %s/%s', (name, schemaVersion) => {
    const result = compileManifest({
      ...manifest({ collections: [] }),
      server: {
        ...manifest({ collections: [] }).server,
        collections: [{ ...collection(), name, schemaVersion }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    [{ name: `a${'b'.repeat(MAX_MANAGED_COLLECTION_NAME_LENGTH)}` }, 'name', 'invalid_name'],
    [{ title: 'x'.repeat(MAX_MANAGED_COLLECTION_TITLE_LENGTH + 1) }, 'title', 'invalid_shape'],
    [
      { description: 'x'.repeat(MAX_MANAGED_COLLECTION_DESCRIPTION_LENGTH + 1) },
      'description',
      'invalid_shape',
    ],
  ])('rejects out-of-bounds collection %s', (override, field, code) => {
    const result = compileManifest(manifest({ collections: [{ ...collection(), ...override }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code, path: `server.collections.0.${field}` }),
    );
  });

  it('rejects duplicate names and more than the collection limit', () => {
    const duplicate = compileManifest(manifest({ collections: [collection(), collection()] }));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.errors).toContainEqual(
        expect.objectContaining({ code: 'invalid_managed_collection' }),
      );
    }

    const tooMany = compileManifest(
      manifest({
        collections: Array.from({ length: MAX_MANAGED_COLLECTIONS + 1 }, (_, index) => ({
          ...collection(),
          name: `request_${index}`,
        })),
      }),
    );
    expect(tooMany.ok).toBe(false);
  });

  it.each([
    'cardNumber',
    'cvv',
    'passwordHash',
    'access_token',
    'clientSecret',
    'passportNumber',
    'governmentId',
    'healthCondition',
    'biometricTemplate',
  ])('rejects prohibited sensitive field %s at any nesting level', (field) => {
    const result = compileManifest(
      manifest({
        collections: [
          collection({
            type: 'object',
            additionalProperties: false,
            properties: {
              details: {
                type: 'object',
                additionalProperties: false,
                properties: { [field]: { type: 'string' } },
              },
            },
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid_managed_collection' }),
    );
  });

  it('rejects oversized and over-deep record schemas', () => {
    const oversized = compileManifest(
      manifest({
        collections: [
          collection({
            ...baseRecordSchema,
            description: 'x'.repeat(70 * 1024),
          }),
        ],
      }),
    );
    expect(oversized.ok).toBe(false);

    let nested: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 20; depth += 1) {
      nested = {
        type: 'object',
        additionalProperties: false,
        properties: { child: nested },
      };
    }
    const tooDeep = compileManifest(manifest({ collections: [collection(nested)] }));
    expect(tooDeep.ok).toBe(false);
  });

  it('rejects unclosed nested objects and excessive field counts', () => {
    const unclosed = compileManifest(
      manifest({
        collections: [
          collection({
            type: 'object',
            additionalProperties: false,
            properties: {
              details: { type: 'object', properties: { summary: { type: 'string' } } },
            },
          }),
        ],
      }),
    );
    expect(unclosed.ok).toBe(false);

    const tooManyFields = compileManifest(
      manifest({
        collections: [
          collection({
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(
              Array.from({ length: MAX_MANAGED_COLLECTION_RECORD_FIELDS + 1 }, (_, index) => [
                `field_${index}`,
                { type: 'string' },
              ]),
            ),
          }),
        ],
      }),
    );
    expect(tooManyFields.ok).toBe(false);
  });

  it('keeps Core v1 unchanged and does not project a v2 collection field', () => {
    const withUnknownV2Field = compileManifest(
      manifest({ manifestVersion: '1', collections: [collection()] }),
    );
    expect(withUnknownV2Field.ok).toBe(true);
    if (!withUnknownV2Field.ok) return;
    expect(withUnknownV2Field.artifact.server.managedCollections).toBeUndefined();
    expect(compileManifest(manifest({ manifestVersion: '1' })).ok).toBe(true);
  });
});
