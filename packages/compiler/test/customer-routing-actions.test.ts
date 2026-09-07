import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../src/index.js';
import {
  app,
  directAuth,
  emptySchema,
  routedCatalog,
  staticCatalog,
  suffixPolicy,
} from './customer-routing-fixtures.js';

describe('customer endpoint operation and surface restrictions', () => {
  it('supports a directly routed read and a nested routed read', () => {
    const direct = compileManifest(app({ auth: directAuth() }), { catalog: routedCatalog });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    const directFulfilment = direct.artifact.tools[0]?.fulfilment;
    expect(directFulfilment?.kind).toBe('operation');
    if (directFulfilment?.kind !== 'operation') return;
    expect(directFulfilment.operationRef).toMatchObject({
      resolved: true,
      customerEndpoint: 'customer_api',
      customerEndpointDependencies: ['customer_api'],
    });
    expect(directFulfilment.operationRef.customerEndpoint).toBe('customer_api');

    const nested = compileManifest(
      app({
        auth: directAuth(),
        connectorId: 'customer_wrapper',
        operation: 'nested_read',
      }),
      { catalog: routedCatalog },
    );
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    const nestedFulfilment = nested.artifact.tools[0]?.fulfilment;
    expect(nestedFulfilment?.kind).toBe('operation');
    if (nestedFulfilment?.kind !== 'operation') return;
    expect(nestedFulfilment.operationRef).not.toHaveProperty('customerEndpoint');
    expect(nestedFulfilment.operationRef).toMatchObject({
      resolved: true,
      customerEndpointDependencies: ['customer_api'],
    });
    expect(nested.artifact.customerEndpoints).toEqual({ customer_api: suffixPolicy });
  });

  it.each([
    ['direct action', 'customer_records', 'write_record', true],
    ['read wrapper around action', 'customer_records', 'read_wrapping_action', true],
    ['action wrapper', 'customer_wrapper', 'nested_action', false],
  ])('supports a confirmation-gated %s and emits only its route dependencies', (_label, connectorId, operation, hasDirectEndpoint) => {
    const result = compileManifest(
      app({ auth: directAuth(), connectorId, operation, confirm: true }),
      {
        catalog: routedCatalog,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind).toBe('operation');
    if (fulfilment?.kind !== 'operation') return;
    expect(fulfilment.operationRef).toMatchObject({
      resolved: true,
      customerEndpointDependencies: ['customer_api'],
      customerActionEndpointDependencies: ['customer_api'],
    });
    if (hasDirectEndpoint) {
      expect(fulfilment.operationRef).toHaveProperty('customerEndpoint', 'customer_api');
    } else {
      expect(fulfilment.operationRef).not.toHaveProperty('customerEndpoint');
    }
    expect(Object.keys(fulfilment.operationRef).sort()).toEqual(
      [
        'alias',
        'connectorId',
        'connectorVersion',
        ...(hasDirectEndpoint ? ['customerEndpoint'] : []),
        'customerActionEndpointDependencies',
        'customerEndpointDependencies',
        'operation',
        'resolved',
        'signatureHash',
      ].sort(),
    );
    expect(result.artifact.customerEndpoints).toEqual({ customer_api: suffixPolicy });
    expect(JSON.stringify(result.artifact)).not.toContain('tenant-a.api.noodleseed.dev');
  });

  it('projects transitive action route dependencies on a confirmed flow step', () => {
    const base = app({ auth: directAuth(), confirm: true });
    const result = compileManifest(
      {
        ...base,
        tools: [
          {
            ...base.tools[0],
            fulfilment: {
              steps: [
                {
                  id: 'wrapped_action',
                  use: 'api.read_wrapping_action',
                  args: {},
                },
              ],
              output: {},
            },
          },
        ],
      },
      { catalog: routedCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind).toBe('flow');
    if (fulfilment?.kind !== 'flow') return;
    const step = fulfilment.steps[0];
    expect(step?.kind).toBe('operation');
    if (step?.kind !== 'operation') return;
    expect(step.operationRef).toMatchObject({
      resolved: true,
      customerEndpointDependencies: ['customer_api'],
      customerActionEndpointDependencies: ['customer_api'],
    });
  });

  it('requires confirmation on every tool that can reach a customer-routed action', () => {
    const manifest = app({
      auth: directAuth(),
      operation: 'write_record',
      confirm: true,
    });
    manifest.tools.push({
      name: 'write_without_confirmation',
      description: 'Write a customer record without confirmation.',
      inputSchema: emptySchema,
      fulfilment: { use: 'api.write_record', args: {} },
    });

    const result = compileManifest(manifest, { catalog: routedCatalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors
        .filter((error) => error.code === 'customer_endpoint_action_unsupported')
        .map((error) => error.path),
    ).toEqual(['tools.1.fulfilment.use']);
  });

  it.each([
    ['unconfirmed', undefined],
    ['confirmed', true],
  ])('rejects %s action catalog metadata that omits its ordinary routed dependencies', (_label, confirm) => {
    const inconsistentCatalog = new InMemoryCatalog([
      {
        id: 'customer_records',
        version: '1.0.0',
        kind: 'custom',
        operations: {
          write_record: { type: 'action', input: emptySchema, output: emptySchema },
        },
        customerRouting: {
          directEndpoint: 'customer_api',
          endpoints: { customer_api: suffixPolicy },
          operationEndpoints: { write_record: ['customer_api'] },
          operationActionEndpoints: { write_record: [] },
        },
      },
    ]);

    const result = compileManifest(
      app({ auth: directAuth(), operation: 'write_record', confirm }),
      { catalog: inconsistentCatalog },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_routing_inconsistent',
        path: 'tools.0.fulfilment.use',
      }),
    );
  });

  it('rejects action-route metadata when the ordinary routed dependency list is empty', () => {
    const inconsistentCatalog = new InMemoryCatalog([
      {
        id: 'customer_records',
        version: '1.0.0',
        kind: 'custom',
        operations: {
          write_record: { type: 'action', input: emptySchema, output: emptySchema },
        },
        customerRouting: {
          directEndpoint: 'customer_api',
          endpoints: { customer_api: suffixPolicy },
          operationEndpoints: { write_record: [] },
          operationActionEndpoints: { write_record: ['customer_api'] },
        },
      },
    ]);

    const result = compileManifest(
      app({ auth: directAuth(), operation: 'write_record', confirm: true }),
      { catalog: inconsistentCatalog },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_routing_inconsistent',
        path: 'tools.0.fulfilment.use',
      }),
    );
  });

  it.each([
    ['direct action', 'customer_records', 'write_record'],
    ['read wrapper around action', 'customer_records', 'read_wrapping_action'],
    ['action wrapper', 'customer_wrapper', 'nested_action'],
  ])('rejects an unconfirmed %s', (_label, connectorId, operation) => {
    const result = compileManifest(app({ auth: directAuth(), connectorId, operation }), {
      catalog: routedCatalog,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_action_unsupported',
        path: 'tools.0.fulfilment.use',
      }),
    );
  });

  it.each([
    ['false', false],
    ['a truthy string', 'true'],
  ])('treats confirm %s as unconfirmed for a customer-routed action', (_label, confirm) => {
    const result = compileManifest(
      app({
        auth: directAuth(),
        operation: 'write_record',
        confirm,
      }),
      { catalog: routedCatalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_action_unsupported',
        path: 'tools.0.fulfilment.use',
      }),
    );
  });

  it.each([
    'resource',
    'prompt',
    'ambient',
  ] as const)('temporarily rejects routed %s fulfilment', (surface) => {
    const result = compileManifest(app({ auth: directAuth(), surface }), {
      catalog: routedCatalog,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_surface_unsupported',
      }),
    );
  });

  const connectionSources = [
    ['external exchange', { kind: 'externalExchange' }],
    ['managed secret', { kind: 'managedSecret', secret: 'CUSTOMER_RECORDS_TOKEN' }],
    [
      'client credentials',
      {
        kind: 'clientCredentials',
        tokenUrl: 'https://id.noodleseed.dev/oauth/token',
        clientId: 'CUSTOMER_RECORDS_CLIENT_ID',
        clientSecret: 'CUSTOMER_RECORDS_CLIENT_SECRET',
      },
    ],
    [
      'Google workload identity',
      {
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER}',
        access: { kind: 'direct' },
      },
    ],
  ] as const;

  it.each(connectionSources)('rejects a routed connector with %s', (_label, bindingSource) => {
    const result = compileManifest(app({ auth: directAuth(), bindingSource }), {
      catalog: routedCatalog,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_credential_source_unsupported',
        path: 'connectors.api.binding.connection.source',
      }),
    );
  });

  it('preserves static and managed-variable connector behavior', () => {
    const result = compileManifest(
      app({
        connectorId: 'static_records',
      }),
      { catalog: staticCatalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.customerEndpoints).toBeUndefined();
    const fulfilment = result.artifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation') return;
    expect(fulfilment.operationRef).not.toHaveProperty('customerEndpoint');
  });
});
