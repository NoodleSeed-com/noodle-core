import type { CustomerEndpointPolicy, ResolvedOperationRef } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { compileConnectors, connectorFileSchema } from '../src/index.js';

const emptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const suffixPolicy = {
  allowedHttpsHostSuffixes: ['noodleseed.dev'],
} as const satisfies CustomerEndpointPolicy;

const exactPolicy = {
  allowedHttpsOrigins: ['https://api.noodleseed.dev'],
} as const satisfies CustomerEndpointPolicy;

function delegatedTokenExchange(tokenUrl = 'https://idp.noodleseed.dev/oauth/token') {
  return {
    kind: 'delegatedTokenExchange',
    tokenUrl,
    clientId: 'CUSTOMER_API_CLIENT_ID',
    clientSecret: 'CUSTOMER_API_CLIENT_SECRET',
  } as const;
}

function routedHttp(input: {
  readonly id?: string;
  readonly version?: string;
  readonly key?: string;
  readonly policy?: CustomerEndpointPolicy;
  readonly operationType?: 'read' | 'action';
  readonly allowedOrigins?: readonly string[];
  readonly auth?: unknown;
  readonly operationAuth?: unknown;
}) {
  const http: Record<string, unknown> = {
    baseUrl: {
      kind: 'customerEndpoint',
      name: input.key ?? 'customer_api',
      policy: input.policy ?? suffixPolicy,
    },
  };
  if (Object.hasOwn(input, 'allowedOrigins')) http.allowedOrigins = input.allowedOrigins;
  if (Object.hasOwn(input, 'auth')) http.auth = input.auth;
  const operation: Record<string, unknown> = {
    type: input.operationType ?? 'read',
    method: 'GET',
    path: '/records',
    input: emptySchema,
    output: emptySchema,
  };
  if (Object.hasOwn(input, 'operationAuth')) operation.auth = input.operationAuth;
  return {
    id: input.id ?? 'customer_records',
    version: input.version ?? '1.0.0',
    kind: 'custom',
    http,
    operations: { list_records: operation },
  };
}

function compile(definitions: readonly unknown[]) {
  return compileConnectors(JSON.stringify({ connectors: definitions }));
}

describe('customer endpoint connector schema', () => {
  it.each([suffixPolicy, exactPolicy])('accepts a normalized policy arm', (policy) => {
    expect(connectorFileSchema.safeParse({ connectors: [routedHttp({ policy })] }).success).toBe(
      true,
    );
  });

  it.each([
    {},
    { allowedHttpsOrigins: [] },
    { allowedHttpsHostSuffixes: [] },
    {
      allowedHttpsOrigins: ['https://api.noodleseed.dev'],
      allowedHttpsHostSuffixes: ['noodleseed.dev'],
    },
    { allowedHttpsHostSuffixes: ['noodleseed.dev'], unexpected: true },
  ])('rejects an invalid raw policy', (policy) => {
    expect(
      connectorFileSchema.safeParse({ connectors: [routedHttp({ policy: policy as never })] })
        .success,
    ).toBe(false);
  });

  it('rejects an invalid endpoint name', () => {
    expect(
      connectorFileSchema.safeParse({ connectors: [routedHttp({ key: 'Customer-Api' })] }).success,
    ).toBe(false);
  });
});

describe('customer endpoint connector restrictions', () => {
  it('rejects connector allowedOrigins even when the authored array is empty', () => {
    const result = compile([routedHttp({ allowedOrigins: [] })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_allowed_origins',
        path: 'connectors.customer_records.http.allowedOrigins',
      }),
    );
  });

  const unsupportedAuth = [
    ['bearer', { kind: 'bearer', secret: 'TOKEN' }],
    ['api key', { kind: 'apiKey', header: 'X-API-Key', secret: 'TOKEN' }],
    [
      'client credentials',
      {
        kind: 'clientCredentials',
        tokenUrl: 'https://idp.noodleseed.dev/token',
        clientId: 'CLIENT_ID',
        clientSecret: 'CLIENT_SECRET',
      },
    ],
    ['delegated OAuth', { kind: 'delegatedOAuth', provider: 'firebase' }],
    [
      'delegated session cookie',
      {
        kind: 'delegatedSessionCookie',
        provider: 'firebase',
        sessionUrl: 'https://api.noodleseed.dev/session',
      },
    ],
  ] as const;

  it.each(unsupportedAuth)('rejects connector-level %s auth', (_label, auth) => {
    const result = compile([routedHttp({ auth })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_unsupported_auth',
        path: 'connectors.customer_records.http.auth',
      }),
    );
  });

  it.each(unsupportedAuth)('rejects operation-level %s auth', (_label, auth) => {
    const result = compile([routedHttp({ operationAuth: auth })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_unsupported_auth',
        path: 'connectors.customer_records.operations.list_records.auth',
      }),
    );
  });

  it.each([
    [
      'connector-level',
      { auth: { kind: 'bearer', secret: 'TOKEN' } },
      'connectors.customer_records.http.auth',
    ],
    [
      'operation-level',
      { operationAuth: { kind: 'bearer', secret: 'TOKEN' } },
      'connectors.customer_records.operations.list_records.auth',
    ],
  ] as const)('identifies the compiled %s bearer fallback and repair', (_level, input, path) => {
    const result = compile([routedHttp(input)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual({
      code: 'customer_endpoint_unsupported_auth',
      path,
      message:
        'customer endpoint connectors accept only no auth or delegatedTokenExchange auth; found bearer auth at this path, so remove it or replace it with delegatedTokenExchange',
    });
  });

  it('accepts no auth and delegated token exchange', () => {
    const noAuth = compile([routedHttp({})]);
    expect(noAuth.ok).toBe(true);

    const exchanged = compile([routedHttp({ auth: delegatedTokenExchange() })]);
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    expect(exchanged.secretBindings).toContainEqual(
      expect.objectContaining({
        connectorId: 'customer_records',
        authKind: 'delegatedTokenExchange',
        customerEndpoint: 'customer_api',
        tokenExchange: expect.objectContaining({
          tokenUrl: 'https://idp.noodleseed.dev/oauth/token',
        }),
      }),
    );
  });

  it('retains the customer endpoint on operation-level delegated token exchange bindings', () => {
    const result = compile([
      routedHttp({ operationAuth: delegatedTokenExchange(), key: 'tenant_api' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.secretBindings).toContainEqual(
      expect.objectContaining({
        connectorId: 'customer_records',
        operation: 'list_records',
        authKind: 'delegatedTokenExchange',
        customerEndpoint: 'tenant_api',
      }),
    );
  });

  it.each([
    'http://idp.noodleseed.dev/token',
    'https://idp.noodleseed.dev/${env.TOKEN_PATH}',
    'https:////idp.noodleseed.dev/token',
  ])('rejects non-fixed delegated token exchange URL %j', (tokenUrl) => {
    const result = compile([routedHttp({ auth: delegatedTokenExchange(tokenUrl) })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_invalid_token_url',
        path: 'connectors.customer_records.http.auth.tokenUrl',
      }),
    );
  });

  it('preserves static and managed-variable base URL behavior', () => {
    const staticResult = compile([
      {
        id: 'static_api',
        version: '1.0.0',
        http: { baseUrl: 'https://api.noodleseed.dev' },
        operations: {
          list: { type: 'read', path: '/records', input: emptySchema, output: emptySchema },
        },
      },
    ]);
    expect(staticResult.ok).toBe(true);
    if (staticResult.ok) expect(staticResult.catalog[0]?.customerRouting).toBeUndefined();

    const variableResult = compile([
      {
        id: 'variable_api',
        version: '1.0.0',
        http: {
          baseUrl: '${env.CUSTOMER_API_BASE_URL}',
          allowedOrigins: ['https://api.noodleseed.dev'],
        },
        operations: {
          list: { type: 'read', path: '/records', input: emptySchema, output: emptySchema },
        },
      },
    ]);
    expect(variableResult.ok).toBe(true);
    if (variableResult.ok) expect(variableResult.catalog[0]?.customerRouting).toBeUndefined();
  });
});

describe('customer endpoint catalog dependency metadata', () => {
  it.each([
    ['first declaration order', false],
    ['reversed declaration order', true],
  ])('keeps colliding legacy composite identities distinct in %s', (_label, reversed) => {
    const first = routedHttp({
      id: 'alpha@beta',
      version: 'gamma',
      key: 'first_endpoint',
    });
    const second = routedHttp({
      id: 'alpha',
      version: 'beta@gamma',
      key: 'second_endpoint',
      policy: exactPolicy,
    });
    const result = compile(reversed ? [second, first] : [first, second]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.catalog.find((entry) => entry.id === 'alpha@beta' && entry.version === 'gamma')
        ?.customerRouting,
    ).toMatchObject({
      directEndpoint: 'first_endpoint',
      endpoints: { first_endpoint: suffixPolicy },
      operationEndpoints: { list_records: ['first_endpoint'] },
    });
    expect(
      result.catalog.find((entry) => entry.id === 'alpha' && entry.version === 'beta@gamma')
        ?.customerRouting,
    ).toMatchObject({
      directEndpoint: 'second_endpoint',
      endpoints: { second_endpoint: exactPolicy },
      operationEndpoints: { list_records: ['second_endpoint'] },
    });
  });

  it.each([
    ['first declaration order', false],
    ['reversed declaration order', true],
  ])('keeps colliding legacy operation memo identities distinct in %s', (_label, reversed) => {
    const operation = {
      type: 'read',
      method: 'GET',
      path: '/records',
      input: emptySchema,
      output: emptySchema,
    };
    const first = {
      ...routedHttp({
        id: 'memo@left',
        version: '1',
        key: 'first_endpoint',
      }),
      operations: { 'read.items': operation },
    };
    const second = {
      ...routedHttp({
        id: 'memo',
        version: 'left@1.read',
        key: 'second_endpoint',
        policy: exactPolicy,
      }),
      operations: { items: operation },
    };
    const result = compile(reversed ? [second, first] : [first, second]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.catalog.find((entry) => entry.id === 'memo@left' && entry.version === '1')
        ?.customerRouting?.operationEndpoints['read.items'],
    ).toEqual(['first_endpoint']);
    expect(
      result.catalog.find((entry) => entry.id === 'memo' && entry.version === 'left@1.read')
        ?.customerRouting?.operationEndpoints.items,
    ).toEqual(['second_endpoint']);
  });

  it('preserves an own __proto__ endpoint without prototype mutation', () => {
    const result = compile([routedHttp({ key: '__proto__' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const routing = result.catalog[0]?.customerRouting;
    expect(routing).toBeDefined();
    if (routing === undefined) return;
    expect(Object.getPrototypeOf(routing.endpoints)).toBeNull();
    expect(Object.hasOwn(routing.endpoints, '__proto__')).toBe(true);
    expect(routing.endpoints.__proto__).toEqual(suffixPolicy);
    expect(routing.operationEndpoints.list_records).toEqual(['__proto__']);
    expect(({} as { claim?: unknown }).claim).toBeUndefined();
  });

  it('emits direct read and action endpoint dependencies exactly', () => {
    const result = compile([
      {
        ...routedHttp({}),
        operations: {
          read_records: {
            type: 'read',
            method: 'GET',
            path: '/records',
            input: emptySchema,
            output: emptySchema,
          },
          write_record: {
            type: 'action',
            method: 'POST',
            path: '/records',
            input: emptySchema,
            output: emptySchema,
          },
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog[0]?.customerRouting).toEqual({
      directEndpoint: 'customer_api',
      endpoints: { customer_api: suffixPolicy },
      operationEndpoints: {
        read_records: ['customer_api'],
        write_record: ['customer_api'],
      },
      operationActionEndpoints: {
        read_records: [],
        write_record: ['customer_api'],
      },
    });
  });

  it('propagates a sorted transitive union and action dependencies through compute calls', () => {
    const result = compile([
      routedHttp({ id: 'z_api', key: 'z_endpoint' }),
      routedHttp({ id: 'a_api', key: 'a_endpoint', policy: exactPolicy }),
      {
        id: 'inner',
        version: '1.0.0',
        operations: {
          read_both: {
            type: 'read',
            input: emptySchema,
            output: emptySchema,
            calls: { z: 'z_api.list_records', a: 'a_api.list_records' },
            code: "(input) => ({ ...callOperation('z', input), ...callOperation('a', input) })",
          },
        },
      },
      {
        id: 'outer',
        version: '1.0.0',
        operations: {
          read_wrapper: {
            type: 'read',
            input: emptySchema,
            output: emptySchema,
            calls: { inner: 'inner.read_both' },
            code: "(input) => callOperation('inner', input)",
          },
          action_wrapper: {
            type: 'action',
            input: emptySchema,
            output: emptySchema,
            calls: { inner: 'inner.read_both' },
            code: "(input) => callOperation('inner', input)",
          },
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.catalog.find((entry) => entry.id === 'outer')?.customerRouting).toEqual({
      endpoints: {
        a_endpoint: exactPolicy,
        z_endpoint: suffixPolicy,
      },
      operationEndpoints: {
        action_wrapper: ['a_endpoint', 'z_endpoint'],
        read_wrapper: ['a_endpoint', 'z_endpoint'],
      },
      operationActionEndpoints: {
        action_wrapper: ['a_endpoint', 'z_endpoint'],
        read_wrapper: [],
      },
    });
  });

  it('marks a read wrapper around a routed action as action-dependent', () => {
    const result = compile([
      routedHttp({ id: 'write_api', operationType: 'action' }),
      {
        id: 'wrapper',
        version: '1.0.0',
        operations: {
          read_wrapper: {
            type: 'read',
            input: emptySchema,
            output: emptySchema,
            calls: { write: 'write_api.list_records' },
            code: "(input) => callOperation('write', input)",
          },
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.catalog.find((entry) => entry.id === 'wrapper')?.customerRouting
        ?.operationActionEndpoints.read_wrapper,
    ).toEqual(['customer_api']);
  });

  it('accepts the same key and policy but rejects a conflicting policy', () => {
    expect(compile([routedHttp({ id: 'first' }), routedHttp({ id: 'second' })]).ok).toBe(true);

    const conflict = compile([
      routedHttp({ id: 'first' }),
      routedHttp({ id: 'second', policy: exactPolicy }),
    ]);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.errors).toContainEqual(
      expect.objectContaining({
        code: 'customer_endpoint_policy_conflict',
        path: 'connectors.second.http.baseUrl.policy',
      }),
    );
  });

  it('adds the endpoint key to a nested direct HTTP call reference', async () => {
    const result = compile([
      routedHttp({
        id: 'customer_api_connector',
        auth: delegatedTokenExchange(),
      }),
      {
        id: 'wrapper',
        version: '1.0.0',
        operations: {
          read_wrapper: {
            type: 'read',
            input: emptySchema,
            output: emptySchema,
            calls: { customer: 'customer_api_connector.list_records' },
            code: "(input) => callOperation('customer', input)",
          },
        },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wrapper = result.connectors.find((entry) => entry.id === 'wrapper');
    const refs: ResolvedOperationRef[] = [];
    await wrapper?.invoke({
      operation: 'read_wrapper',
      args: {},
      credential: { token: '' },
      host: {
        async callOperation(ref) {
          refs.push(ref);
          return {};
        },
      },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.customerEndpoint).toBe('customer_api');
    expect(refs[0]).toMatchObject({
      connectorId: 'customer_api_connector',
      operation: 'list_records',
      customerEndpoint: 'customer_api',
    });
    const nestedBindings = result.secretBindings.filter(
      (binding) => binding.connectorId === 'customer_api_connector',
    );
    expect(nestedBindings).toEqual([
      expect.objectContaining({
        authKind: 'delegatedTokenExchange',
        customerEndpoint: 'customer_api',
      }),
    ]);
    expect(nestedBindings[0]).not.toHaveProperty('operation');
  });
});
