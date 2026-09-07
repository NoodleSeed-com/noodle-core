import type {
  CustomerEndpointPolicy,
  ResolvedOperationRef,
  RuntimeArtifact,
} from '@noodle-borg/compiler';
import { computeSignatureHash } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import {
  type Connector,
  ConnectorInvocationError,
  type ConnectorTraceEvent,
} from '../src/connector/types.js';
import {
  freezeCustomerRoutes,
  resolveCustomerConnectorRoute,
  resolveCustomerRouteBinding,
} from '../src/customer-routing.js';
import { executeTool } from '../src/execute.js';
import {
  harness,
  operationRef,
  ROUTE_URL,
  routedArtifact,
  SIGNATURE,
} from './customer-routing-fixtures.js';
import { artifact } from './execute-fixtures.js';

describe('customer route freezing', () => {
  it('canonicalizes and deeply freezes exact-origin and suffix-authorized routes', () => {
    const endpoints = {
      suffix: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
      exact: { allowedHttpsOrigins: ['https://tenant.api.noodleseed.dev'] },
    } as const;
    const frozen = freezeCustomerRoutes(endpoints, {
      suffix: 'https://tenant.api.noodleseed.dev/v1/',
      exact: 'https://tenant.api.noodleseed.dev/base/',
      ignored: 'https://ignored.api.noodleseed.dev',
    });

    expect(frozen.endpoints).toEqual({
      exact: {
        available: true,
        baseUrl: 'https://tenant.api.noodleseed.dev/base',
        policy: endpoints.exact,
      },
      suffix: {
        available: true,
        baseUrl: 'https://tenant.api.noodleseed.dev/v1',
        policy: endpoints.suffix,
      },
    });
    expect(Object.hasOwn(frozen.endpoints, 'ignored')).toBe(false);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.endpoints.exact)).toBe(true);
    expect(Object.isFrozen(frozen.endpoints.exact?.policy)).toBe(true);
  });

  it.each([
    ['missing', {}],
    ['empty', { customer_api: '' }],
    ['whitespace', { customer_api: ` ${ROUTE_URL}` }],
    ['malformed', { customer_api: 'not-a-url' }],
    ['http', { customer_api: 'http://tenant.api.noodleseed.dev' }],
    ['disallowed', { customer_api: 'https://tenant.example.org' }],
    ['encoded path escape', { customer_api: `${ROUTE_URL}/%2Fprivate` }],
    ['oversized', { customer_api: `https://tenant.api.noodleseed.dev/${'a'.repeat(2_100)}` }],
  ])('records a %s route as unavailable without throwing', (_name, raw) => {
    const frozen = freezeCustomerRoutes(routedArtifact().customerEndpoints, raw);

    expect(frozen.endpoints.customer_api).toEqual({
      available: false,
      policy: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
    });
  });

  it('freezes a defensive copy that cannot be redirected by later claim mutation', () => {
    const raw = { customer_api: ROUTE_URL };
    const frozen = freezeCustomerRoutes(routedArtifact().customerEndpoints, raw);
    raw.customer_api = 'https://other.api.noodleseed.dev';

    expect(resolveCustomerConnectorRoute(frozen, operationRef())).toMatchObject({
      baseUrl: ROUTE_URL,
    });
  });

  it('never throws for hostile declaration or claim accessors', () => {
    const declarations = {
      get customer_api(): CustomerEndpointPolicy {
        throw new Error('declaration getter must not escape');
      },
    };
    const raw = {
      get customer_api(): string {
        throw new Error('claim getter must not escape');
      },
    };

    expect(() => freezeCustomerRoutes(declarations, raw)).not.toThrow();
    expect(
      freezeCustomerRoutes(routedArtifact().customerEndpoints, raw).endpoints.customer_api,
    ).toEqual({
      available: false,
      policy: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
    });
    expect(() =>
      freezeCustomerRoutes(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('ownKeys must not escape');
            },
          },
        ),
        {},
      ),
    ).not.toThrow();
  });

  it('permits explicit exact-origin ports but rejects ports under suffix policies', () => {
    expect(
      freezeCustomerRoutes(
        { customer_api: { allowedHttpsOrigins: ['https://tenant.api.noodleseed.dev:8443'] } },
        { customer_api: 'https://tenant.api.noodleseed.dev:8443/v1' },
      ).endpoints.customer_api,
    ).toMatchObject({ available: true });
    expect(
      freezeCustomerRoutes(
        { customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] } },
        { customer_api: 'https://tenant.api.noodleseed.dev:8443/v1' },
      ).endpoints.customer_api,
    ).toMatchObject({ available: false });
  });

  it('binds fingerprints to connector, endpoint, canonical URL, and policy', () => {
    const ref = operationRef();
    const stable = resolveCustomerConnectorRoute(
      freezeCustomerRoutes(routedArtifact().customerEndpoints, { customer_api: ROUTE_URL }),
      ref,
    );
    const again = resolveCustomerConnectorRoute(
      freezeCustomerRoutes(routedArtifact().customerEndpoints, {
        customer_api: `${ROUTE_URL}/`,
      }),
      ref,
    );
    expect(stable).not.toBeNull();
    expect(again).toEqual(stable);

    const variants: Array<{
      endpoints: Readonly<Record<string, CustomerEndpointPolicy>>;
      raw: Readonly<Record<string, string>>;
      ref: ResolvedOperationRef;
    }> = [
      {
        endpoints: routedArtifact().customerEndpoints ?? {},
        raw: { customer_api: ROUTE_URL },
        ref: { ...ref, connectorId: 'other_records' },
      },
      {
        endpoints: routedArtifact().customerEndpoints ?? {},
        raw: { customer_api: ROUTE_URL },
        ref: { ...ref, connectorVersion: '2.0.0' },
      },
      {
        endpoints: {
          alternate_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
        },
        raw: { alternate_api: ROUTE_URL },
        ref: { ...ref, customerEndpoint: 'alternate_api' },
      },
      {
        endpoints: routedArtifact().customerEndpoints ?? {},
        raw: { customer_api: 'https://other.api.noodleseed.dev/v1' },
        ref,
      },
      {
        endpoints: {
          customer_api: { allowedHttpsOrigins: ['https://tenant.api.noodleseed.dev'] },
        },
        raw: { customer_api: ROUTE_URL },
        ref,
      },
    ];
    for (const variant of variants) {
      const changed = resolveCustomerConnectorRoute(
        freezeCustomerRoutes(variant.endpoints, variant.raw),
        variant.ref,
      );
      expect(changed?.fingerprint).not.toBe(stable?.fingerprint);
    }

    const reordered = resolveCustomerConnectorRoute(
      freezeCustomerRoutes(
        {
          customer_api: {
            allowedHttpsHostSuffixes: ['api.noodleseed.dev', 'noodleseed.dev'],
          },
        },
        { customer_api: ROUTE_URL },
      ),
      ref,
    );
    const reorderedAgain = resolveCustomerConnectorRoute(
      freezeCustomerRoutes(
        {
          customer_api: {
            allowedHttpsHostSuffixes: ['noodleseed.dev', 'api.noodleseed.dev'],
          },
        },
        { customer_api: ROUTE_URL },
      ),
      ref,
    );
    expect(reorderedAgain).toEqual(reordered);
  });

  it('derives a URL-blind binding for broker and probe cache identity', () => {
    const routes = freezeCustomerRoutes(routedArtifact().customerEndpoints, {
      customer_api: ROUTE_URL,
    });
    const ref = operationRef();
    const full = resolveCustomerConnectorRoute(routes, ref);
    const binding = resolveCustomerRouteBinding(routes, {
      connectorId: ref.connectorId,
      connectorVersion: ref.connectorVersion,
      key: 'customer_api',
    });

    expect(binding).toEqual({
      key: 'customer_api',
      fingerprint: full?.fingerprint,
    });
    expect(binding).not.toHaveProperty('baseUrl');
    expect(JSON.stringify(binding)).not.toContain(ROUTE_URL);
    expect(
      resolveCustomerRouteBinding(routes, {
        connectorId: ref.connectorId,
        connectorVersion: ref.connectorVersion,
        key: 'missing_api',
      }),
    ).toBeNull();

    for (const requirement of [
      {
        connectorId: 'other_records',
        connectorVersion: ref.connectorVersion,
        key: 'customer_api',
      },
      {
        connectorId: ref.connectorId,
        connectorVersion: '2.0.0',
        key: 'customer_api',
      },
    ]) {
      expect(resolveCustomerRouteBinding(routes, requirement)?.fingerprint).not.toBe(
        binding?.fingerprint,
      );
    }
  });
});

describe('customer route execution', () => {
  it('passes only the safe binding to the broker and the full route to the connector', async () => {
    const run = harness();

    await expect(executeTool(run.artifact, 'list_records', {}, run.deps)).resolves.toEqual({
      ok: true,
      output: {},
    });
    const expectedRoute = resolveCustomerConnectorRoute(run.routes, operationRef(run.artifact));
    expect(expectedRoute).not.toBeNull();
    expect(run.requests).toEqual([
      {
        connectorId: 'customer_records',
        connectorVersion: '1.0.0',
        operation: 'list_records',
        route: { key: 'customer_api', fingerprint: expectedRoute?.fingerprint },
      },
    ]);
    expect(run.requests[0]).not.toHaveProperty('route.baseUrl');
    expect(run.calls).toEqual([
      expect.objectContaining({
        route: expectedRoute,
      }),
    ]);
    expect(run.contexts[0]).not.toHaveProperty('route');
  });

  it.each([
    ['missing', {}],
    ['malformed', { customer_api: 'not-a-url' }],
    ['disallowed', { customer_api: 'https://tenant.example.org' }],
  ])('returns one safe error for a %s route before policy, broker, or connector', async (_name, raw) => {
    const run = harness({ raw });

    await expect(executeTool(run.artifact, 'list_records', {}, run.deps)).resolves.toEqual({
      ok: false,
      error: {
        code: 'connector_route_unavailable',
        message: 'Customer connector route is unavailable.',
      },
    });
    expect(run.policy.before).not.toHaveBeenCalled();
    expect(run.requests).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it('keeps static calls unchanged and does not expose routes through caller or policy', async () => {
    const staticArtifact = artifact('minimal.resolved.artifact.json');
    const caller = { subject: 'customer-123' };
    const run = harness({ caller });
    const ref = staticArtifact.tools[0]?.fulfilment;
    const staticConnector: Connector = {
      id: 'acme_orders',
      version: '1.2.0',
      signature: () =>
        ref?.kind === 'operation'
          ? {
              type: 'read',
              input: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
                additionalProperties: false,
              },
              output: {
                type: 'object',
                properties: { order: { type: 'object' } },
                additionalProperties: false,
              },
            }
          : undefined,
      invoke(call) {
        run.calls.push(call);
        return { order: { id: 'A1' } };
      },
    };

    const result = await executeTool(
      staticArtifact,
      'get_order',
      { order_id: 'A1' },
      {
        ...run.deps,
        connectors: { resolve: () => staticConnector },
      },
    );

    expect(result.ok).toBe(true);
    expect(run.requests[0]).not.toHaveProperty('route');
    expect(run.calls[0]).not.toHaveProperty('route');
    expect(run.contexts[0]).not.toHaveProperty('route');
    expect(JSON.stringify(caller)).not.toContain(ROUTE_URL);
  });

  it('isolates concurrent snapshots used by one shared connector registry', async () => {
    const first = harness({ raw: { customer_api: 'https://first.api.noodleseed.dev/v1' } });
    const secondRoutes = freezeCustomerRoutes(routedArtifact().customerEndpoints, {
      customer_api: 'https://second.api.noodleseed.dev/v2',
    });

    await Promise.all([
      executeTool(first.artifact, 'list_records', {}, first.deps),
      executeTool(
        first.artifact,
        'list_records',
        {},
        {
          ...first.deps,
          customerRoutes: secondRoutes,
        },
      ),
    ]);

    expect(first.calls.map((call) => call.route?.baseUrl).sort()).toEqual([
      'https://first.api.noodleseed.dev/v1',
      'https://second.api.noodleseed.dev/v2',
    ]);
  });

  it('checks connector availability, signature drift, and arguments before route availability', async () => {
    const unavailable = harness({ raw: {} });
    await expect(
      executeTool(
        unavailable.artifact,
        'list_records',
        {},
        {
          ...unavailable.deps,
          connectors: { resolve: () => undefined },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'connector_unavailable' },
    });

    const drifted = harness({ raw: {} });
    vi.spyOn(drifted.connector, 'signature').mockReturnValue({
      ...SIGNATURE,
      input: { type: 'object', properties: { id: { type: 'string' } } },
    });
    await expect(
      executeTool(drifted.artifact, 'list_records', {}, drifted.deps),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'signature_drift' },
    });

    const invalidArgs = harness({ raw: {} });
    const fulfilment = invalidArgs.artifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation') throw new Error('expected operation fulfilment');
    const invalidArtifact: RuntimeArtifact = {
      ...invalidArgs.artifact,
      tools: invalidArgs.artifact.tools.map((tool, index) =>
        index === 0
          ? {
              ...tool,
              fulfilment: {
                ...fulfilment,
                args: { unexpected: { kind: 'literal', value: true } },
              },
            }
          : tool,
      ),
    };
    await expect(
      executeTool(invalidArtifact, 'list_records', {}, invalidArgs.deps),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'arg_invalid' },
    });
    expect(invalidArgs.policy.before).not.toHaveBeenCalled();
  });

  it('reuses the same frozen snapshot for nested connector calls', async () => {
    const run = harness();
    const ref = operationRef(run.artifact);
    const nestedRef: ResolvedOperationRef = {
      ...ref,
      operation: 'list_related_records',
      signatureHash: computeSignatureHash('list_related_records', SIGNATURE),
    };
    vi.spyOn(run.connector, 'invoke').mockImplementation((call) => {
      run.calls.push(call);
      if (call.operation === 'list_records') {
        return call.host?.callOperation(nestedRef, {}, 'nested');
      }
      return {};
    });

    await expect(executeTool(run.artifact, 'list_records', {}, run.deps)).resolves.toEqual({
      ok: true,
      output: {},
    });

    expect(run.calls.map((call) => call.route)).toHaveLength(2);
    expect(run.calls[1]?.route).toEqual(run.calls[0]?.route);
    expect(run.requests.map((request) => request.route)).toEqual([
      run.requests[0]?.route,
      run.requests[0]?.route,
    ]);
  });

  it('fails an unavailable nested route before its broker or connector call', async () => {
    const run = harness();
    const ref = {
      ...operationRef(run.artifact),
      customerEndpoint: undefined,
      customerEndpointDependencies: ['missing_api'],
    } as ResolvedOperationRef & {
      readonly customerEndpointDependencies: readonly string[];
    };
    const fulfilment = run.artifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation') throw new Error('expected operation fulfilment');
    const artifact = {
      ...run.artifact,
      tools: [
        {
          ...run.artifact.tools[0],
          fulfilment: { ...fulfilment, operationRef: ref },
        },
      ],
    };
    const nestedRef: ResolvedOperationRef = {
      ...ref,
      operation: 'list_related_records',
      signatureHash: computeSignatureHash('list_related_records', SIGNATURE),
      customerEndpoint: 'missing_api',
    };
    vi.spyOn(run.connector, 'invoke').mockImplementation((call) => {
      run.calls.push(call);
      return call.host?.callOperation(nestedRef, {}, 'nested');
    });

    await expect(executeTool(artifact, 'list_records', {}, run.deps)).resolves.toEqual({
      ok: false,
      error: {
        code: 'connector_route_unavailable',
        message: 'Customer connector route is unavailable.',
        path: undefined,
      },
    });
    expect(run.requests).toHaveLength(0);
    expect(run.calls).toHaveLength(0);
  });

  it('omits routed response excerpts, route keys, fingerprints, and URLs from traces', async () => {
    const run = harness();
    const events: ConnectorTraceEvent[] = [];
    const expectedRoute = resolveCustomerConnectorRoute(run.routes, operationRef(run.artifact));
    vi.spyOn(run.connector, 'invoke').mockRejectedValue(
      new ConnectorInvocationError(
        `customer_api ${expectedRoute?.fingerprint} failed at ${ROUTE_URL}`,
        {
          status: 503,
          category: 'upstream_5xx',
          attempts: 2,
          retryable: false,
          responseExcerpt: `customer_api ${expectedRoute?.fingerprint} ${ROUTE_URL}`,
        },
      ),
    );

    const result = await executeTool(
      run.artifact,
      'list_records',
      {},
      {
        ...run.deps,
        trace: { record: (event) => events.push(event) },
      },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'connector_error' } });
    expect(events).toEqual([
      {
        kind: 'connector',
        connectorId: 'customer_records',
        connectorVersion: '1.0.0',
        operation: 'list_records',
        status: 503,
        category: 'upstream_5xx',
        attempts: 2,
        retryable: false,
      },
    ]);
    const serialized = JSON.stringify({ result, events });
    expect(serialized).not.toContain('customer_api');
    expect(serialized).not.toContain('fingerprint');
    expect(serialized).not.toContain(ROUTE_URL);
  });

  it('drops runtime-poisoned connector metadata before recording a routed trace', async () => {
    const run = harness();
    const events: ConnectorTraceEvent[] = [];
    const expectedRoute = resolveCustomerConnectorRoute(run.routes, operationRef(run.artifact));
    const poison = `customer_api ${expectedRoute?.fingerprint} ${ROUTE_URL}`;
    const error = new ConnectorInvocationError(
      'connector request failed',
    ) as ConnectorInvocationError & Record<string, unknown>;
    Object.assign(error, {
      status: poison,
      category: poison,
      attempts: poison,
      retryable: poison,
      retryAfterMs: poison,
      responseExcerpt: poison,
    });
    vi.spyOn(run.connector, 'invoke').mockRejectedValue(error);

    const result = await executeTool(
      run.artifact,
      'list_records',
      {},
      {
        ...run.deps,
        trace: { record: (event) => events.push(event) },
      },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'connector_error' } });
    expect(events).toEqual([
      {
        kind: 'connector',
        connectorId: 'customer_records',
        connectorVersion: '1.0.0',
        operation: 'list_records',
      },
    ]);
    const serialized = JSON.stringify({ result, events });
    expect(serialized).not.toContain('customer_api');
    expect(serialized).not.toContain(expectedRoute?.fingerprint);
    expect(serialized).not.toContain(ROUTE_URL);
  });

  it('normalizes a getPrototypeOf-throwing connector rejection without invoking its trap', async () => {
    const run = harness();
    const events: ConnectorTraceEvent[] = [];
    const rejection = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`proxy trap reached ${ROUTE_URL}`);
        },
      },
    );
    vi.spyOn(run.connector, 'invoke').mockRejectedValue(rejection);

    const result = await executeTool(
      run.artifact,
      'list_records',
      {},
      {
        ...run.deps,
        trace: { record: (event) => events.push(event) },
      },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'connector_error' } });
    expect(events).toEqual([]);
    expect(JSON.stringify({ result, events })).not.toContain(ROUTE_URL);
  });

  it('ignores hostile accessors on a branded connector rejection', async () => {
    const run = harness();
    const events: ConnectorTraceEvent[] = [];
    const rejection = new ConnectorInvocationError('safe');
    for (const key of [
      'message',
      'status',
      'category',
      'attempts',
      'retryable',
      'retryAfterMs',
      'responseExcerpt',
    ]) {
      Object.defineProperty(rejection, key, {
        configurable: true,
        get() {
          throw new Error(`hostile ${key} ${ROUTE_URL}`);
        },
      });
    }
    vi.spyOn(run.connector, 'invoke').mockRejectedValue(rejection);

    const result = await executeTool(
      run.artifact,
      'list_records',
      {},
      {
        ...run.deps,
        trace: { record: (event) => events.push(event) },
      },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'connector_error' } });
    expect(events).toEqual([
      {
        kind: 'connector',
        connectorId: 'customer_records',
        connectorVersion: '1.0.0',
        operation: 'list_records',
      },
    ]);
    expect(JSON.stringify({ result, events })).not.toContain(ROUTE_URL);
  });
});
