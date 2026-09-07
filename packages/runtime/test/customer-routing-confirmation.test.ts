import {
  computeSignatureHash,
  type OperationSignature,
  type ResolvedOperationRef,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import type { CredentialRequest } from '../src/broker/types.js';
import type { Connector, ConnectorCall } from '../src/connector/types.js';
import {
  executePreparedTool,
  freezeCustomerRoutes,
  isConfirmationRequired,
  prepareToolForConfirmation,
  resolveCustomerConnectorRoute,
} from '../src/index.js';
import type { PolicyContext, PolicyGate } from '../src/policy/types.js';

const FIRST_ROUTE = 'https://first.api.noodleseed.dev/v1';
const SECOND_ROUTE = 'https://second.api.noodleseed.dev/v2';
const ENDPOINTS = {
  customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
} as const;
const MULTI_ENDPOINTS = {
  ...ENDPOINTS,
  billing_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
} as const;

const emptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const outputSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
} as const;

const actionSignature: OperationSignature = {
  type: 'action',
  input: emptySchema,
  output: outputSchema,
};

const readSignature: OperationSignature = {
  type: 'read',
  input: emptySchema,
  output: outputSchema,
};

type CustomerActionRef = ResolvedOperationRef & {
  readonly customerActionEndpointDependencies: readonly string[];
};

function routedRef(
  operation: 'mutate' | 'read_nested' | 'read_later' | 'wrapped_action_one' | 'wrapped_action_two',
  signature: OperationSignature,
): ResolvedOperationRef {
  return {
    resolved: true,
    alias: 'api',
    connectorId: 'customer_records',
    connectorVersion: '1.0.0',
    operation,
    signatureHash: computeSignatureHash(operation, signature),
    customerEndpoint: 'customer_api',
    customerEndpointDependencies: ['customer_api'],
  };
}

const actionRef: CustomerActionRef = {
  ...routedRef('mutate', actionSignature),
  customerActionEndpointDependencies: ['customer_api'],
};
const nestedReadRef = routedRef('read_nested', readSignature);
const laterReadRef = routedRef('read_later', readSignature);

function wrappedActionRef(
  operation: 'wrapped_action_one' | 'wrapped_action_two',
): CustomerActionRef {
  const ref = routedRef(operation, readSignature);
  const { customerEndpoint: _customerEndpoint, ...wrapperRef } = ref;
  return {
    ...wrapperRef,
    customerActionEndpointDependencies: ['customer_api'],
  };
}

function artifact(): RuntimeArtifact {
  return {
    artifactSchemaVersion: '0.15.0',
    resolution: 'resolved',
    source: {
      manifestName: 'confirmed_customer_route',
      manifestVersion: '2',
      coreVersion: '2',
    },
    server: {
      name: 'confirmed_customer_route',
      title: 'Confirmed Customer Route',
      version: '1.0.0',
    },
    capabilities: { tools: ['update_customer'] },
    customerEndpoints: ENDPOINTS,
    tools: [
      {
        name: 'update_customer',
        description: 'Update and reread one customer record.',
        inputSchema: emptySchema,
        annotations: { confirm: true },
        fulfilment: {
          kind: 'flow',
          steps: [
            {
              id: 'mutate',
              kind: 'operation',
              operationRef: actionRef,
              args: {},
            },
            {
              id: 'read_later',
              kind: 'operation',
              operationRef: laterReadRef,
              args: {},
            },
          ],
          output: {
            value: {
              kind: 'path',
              root: 'steps',
              segments: [
                { kind: 'prop', name: 'read_later' },
                { kind: 'prop', name: 'value' },
              ],
            },
          },
        },
      },
    ],
  };
}

function harness(baseUrl = FIRST_ROUTE) {
  const connectorCalls: ConnectorCall[] = [];
  const credentialRequests: CredentialRequest[] = [];
  const policyContexts: PolicyContext[] = [];
  const connector: Connector = {
    id: 'customer_records',
    version: '1.0.0',
    signature(operation) {
      return operation === 'mutate'
        ? actionSignature
        : operation === 'read_nested' ||
            operation === 'read_later' ||
            operation === 'wrapped_action_one' ||
            operation === 'wrapped_action_two'
          ? readSignature
          : undefined;
    },
    async invoke(call) {
      connectorCalls.push(call);
      if (call.operation === 'mutate') {
        await call.host?.callOperation(nestedReadRef, {}, 'nested');
        return { value: 'mutated' };
      }
      if (call.operation === 'wrapped_action_one') {
        await call.host?.callOperation(actionRef, {}, 'nested_action');
        return { value: 'wrapped_action_one' };
      }
      return { value: call.operation };
    },
  };
  const policy: PolicyGate = {
    async before(context) {
      policyContexts.push(context);
      return { allow: true };
    },
    async after(_context, output) {
      return output;
    },
  };
  const routes = freezeCustomerRoutes(ENDPOINTS, { customer_api: baseUrl });
  const deps = {
    connectors: { resolve: () => connector },
    broker: {
      async getCredential(request: CredentialRequest) {
        credentialRequests.push(request);
        return { token: 'service-token' };
      },
    },
    policy,
    customerRoutes: routes,
  };
  return {
    artifact: artifact(),
    connectorCalls,
    credentialRequests,
    policyContexts,
    routes,
    deps,
  };
}

async function prepare(run: ReturnType<typeof harness>) {
  const result = await prepareToolForConfirmation(run.artifact, 'update_customer', {}, run.deps);
  if (!isConfirmationRequired(result)) throw new Error('expected confirmation');
  return result;
}

function outcome(result: Awaited<ReturnType<typeof executePreparedTool>>) {
  return result.status === 'failed' ? result.error.code : result.status;
}

describe('confirmed customer routes', () => {
  it('keeps initial preparation failures on the safe route-unavailable error', async () => {
    const run = harness();
    const result = await prepareToolForConfirmation(
      run.artifact,
      'update_customer',
      {},
      {
        ...run.deps,
        customerRoutes: freezeCustomerRoutes(ENDPOINTS, {}),
      },
    );

    expect({
      outcome: result.status === 'failed' ? result.error.code : result.status,
      policyContexts: run.policyContexts,
      credentialRequests: run.credentialRequests,
      connectorCalls: run.connectorCalls,
    }).toEqual({
      outcome: 'connector_route_unavailable',
      policyContexts: [],
      credentialRequests: [],
      connectorCalls: [],
    });
  });

  it('stores only the URL-blind binding in the private continuation and redacts the public review', async () => {
    const run = harness();
    const prepared = await prepare(run);
    const expectedRoute = resolveCustomerConnectorRoute(run.routes, actionRef);
    if (expectedRoute === null || expectedRoute === undefined) throw new Error('expected route');

    expect(prepared.review.action).not.toHaveProperty('customerRoutes');
    expect(prepared.review.action).not.toHaveProperty('key');
    expect(prepared.review.action).not.toHaveProperty('fingerprint');
    expect(JSON.stringify(prepared.review)).not.toContain('"key"');
    expect(JSON.stringify(prepared.review)).not.toContain('"fingerprint"');
    expect(JSON.stringify(prepared.review)).not.toContain('customer_api');
    expect(JSON.stringify(prepared.review)).not.toContain(expectedRoute.fingerprint);
    expect(JSON.stringify(prepared.review)).not.toContain(FIRST_ROUTE);

    expect(prepared.continuation.reviewedAction).toMatchObject({
      connectorId: 'customer_records',
      connectorVersion: '1.0.0',
      operation: 'mutate',
      customerRoutes: [
        {
          key: 'customer_api',
          fingerprint: expectedRoute.fingerprint,
        },
      ],
    });
    expect(prepared.continuation.reviewedAction?.customerRoutes).toEqual([
      {
        key: 'customer_api',
        fingerprint: expectedRoute.fingerprint,
      },
    ]);
    expect(
      Object.keys(prepared.continuation.reviewedAction?.customerRoutes?.[0] ?? {}).sort(),
    ).toEqual(['fingerprint', 'key']);
    expect(prepared.continuation.reviewedAction).not.toHaveProperty('customerRoutes.0.baseUrl');
    expect(JSON.stringify(prepared.continuation)).not.toContain(FIRST_ROUTE);
  });

  it('accepts the same route and reuses its frozen snapshot for the action and later reads', async () => {
    const run = harness();
    const prepared = await prepare(run);
    const currentRoutes = freezeCustomerRoutes(ENDPOINTS, { customer_api: `${FIRST_ROUTE}/` });
    const expectedRoute = resolveCustomerConnectorRoute(currentRoutes, actionRef);
    if (expectedRoute === null || expectedRoute === undefined) throw new Error('expected route');

    const result = await executePreparedTool(run.artifact, prepared.continuation, {
      ...run.deps,
      customerRoutes: currentRoutes,
    });

    expect(result).toEqual({
      status: 'completed',
      output: { value: 'read_later' },
    });
    expect(prepared.continuation.reviewedAction).toHaveProperty(
      'customerRoutes.0.fingerprint',
      expectedRoute.fingerprint,
    );
    expect(run.connectorCalls.map((call) => call.operation)).toEqual([
      'mutate',
      'read_nested',
      'read_later',
    ]);
    expect(run.connectorCalls.map((call) => call.route)).toEqual([
      expectedRoute,
      expectedRoute,
      expectedRoute,
    ]);
    expect(run.credentialRequests.map((request) => request.route)).toEqual([
      { key: 'customer_api', fingerprint: expectedRoute.fingerprint },
      { key: 'customer_api', fingerprint: expectedRoute.fingerprint },
      { key: 'customer_api', fingerprint: expectedRoute.fingerprint },
    ]);
  });

  it('rejects a changed route at acceptance before policy, credentials, or connector egress', async () => {
    const run = harness();
    const prepared = await prepare(run);
    const changedRoutes = freezeCustomerRoutes(ENDPOINTS, { customer_api: SECOND_ROUTE });

    const result = await executePreparedTool(run.artifact, prepared.continuation, {
      ...run.deps,
      customerRoutes: changedRoutes,
    });

    expect({
      outcome: outcome(result),
      policyContexts: run.policyContexts,
      credentialRequests: run.credentialRequests,
      connectorCalls: run.connectorCalls,
    }).toEqual({
      outcome: 'invalid_continuation',
      policyContexts: [],
      credentialRequests: [],
      connectorCalls: [],
    });
  });

  it('rejects a missing current route at acceptance as an invalid continuation before egress', async () => {
    const run = harness();
    const prepared = await prepare(run);
    const missingRoutes = freezeCustomerRoutes(ENDPOINTS, {});

    const result = await executePreparedTool(run.artifact, prepared.continuation, {
      ...run.deps,
      customerRoutes: missingRoutes,
    });

    expect({
      outcome: outcome(result),
      policyContexts: run.policyContexts,
      credentialRequests: run.credentialRequests,
      connectorCalls: run.connectorCalls,
    }).toEqual({
      outcome: 'invalid_continuation',
      policyContexts: [],
      credentialRequests: [],
      connectorCalls: [],
    });
  });

  it('binds every sorted transitive action route and rejects drift in any one of them', async () => {
    const run = harness();
    const tool = run.artifact.tools[0];
    if (tool === undefined) throw new Error('expected tool');
    const multiRouteRef: CustomerActionRef = {
      ...actionRef,
      customerEndpointDependencies: ['billing_api', 'customer_api'],
      customerActionEndpointDependencies: ['billing_api', 'customer_api'],
    };
    const multiRouteArtifact: RuntimeArtifact = {
      ...run.artifact,
      customerEndpoints: MULTI_ENDPOINTS,
      tools: [
        {
          ...tool,
          fulfilment: { kind: 'operation', operationRef: multiRouteRef, args: {} },
        },
      ],
    };
    const preparedRoutes = freezeCustomerRoutes(MULTI_ENDPOINTS, {
      billing_api: 'https://billing.api.noodleseed.dev/v1',
      customer_api: FIRST_ROUTE,
    });
    const prepared = await prepareToolForConfirmation(
      multiRouteArtifact,
      'update_customer',
      {},
      { ...run.deps, customerRoutes: preparedRoutes },
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(prepared.continuation.reviewedAction?.customerRoutes?.map(({ key }) => key)).toEqual([
      'billing_api',
      'customer_api',
    ]);

    const result = await executePreparedTool(multiRouteArtifact, prepared.continuation, {
      ...run.deps,
      customerRoutes: freezeCustomerRoutes(MULTI_ENDPOINTS, {
        billing_api: 'https://changed.api.noodleseed.dev/v1',
        customer_api: FIRST_ROUTE,
      }),
    });

    expect({
      outcome: outcome(result),
      policyContexts: run.policyContexts,
      credentialRequests: run.credentialRequests,
      connectorCalls: run.connectorCalls,
    }).toEqual({
      outcome: 'invalid_continuation',
      policyContexts: [],
      credentialRequests: [],
      connectorCalls: [],
    });
  });

  it('rejects two transitive routed actions before policy, credentials, or connector egress', async () => {
    const run = harness();
    const tool = run.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const transitiveArtifact: RuntimeArtifact = {
      ...run.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: [
              {
                id: 'first',
                kind: 'operation',
                operationRef: wrappedActionRef('wrapped_action_one'),
                args: {},
              },
              {
                id: 'second',
                kind: 'operation',
                operationRef: wrappedActionRef('wrapped_action_two'),
                args: {},
              },
            ],
          },
        },
      ],
    };

    const result = await prepareToolForConfirmation(
      transitiveArtifact,
      'update_customer',
      {},
      run.deps,
    );

    expect({
      outcome: result.status === 'failed' ? result.error.code : result.status,
      policyContexts: run.policyContexts,
      credentialRequests: run.credentialRequests,
      connectorCalls: run.connectorCalls,
    }).toEqual({
      outcome: 'invalid_confirmation_flow',
      policyContexts: [],
      credentialRequests: [],
      connectorCalls: [],
    });
  });

  it('confirms and executes one read-signature wrapper around a routed nested action', async () => {
    const run = harness();
    const tool = run.artifact.tools[0];
    if (tool === undefined) throw new Error('expected tool');
    const wrapperArtifact: RuntimeArtifact = {
      ...run.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            kind: 'operation',
            operationRef: wrappedActionRef('wrapped_action_one'),
            args: {},
          },
        },
      ],
    };

    const prepared = await prepareToolForConfirmation(
      wrapperArtifact,
      'update_customer',
      {},
      run.deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(prepared.continuation.reviewedAction?.customerRoutes).toHaveLength(1);

    const result = await executePreparedTool(wrapperArtifact, prepared.continuation, run.deps);
    expect(result).toEqual({
      status: 'completed',
      output: { value: 'wrapped_action_one' },
    });
    expect(run.connectorCalls.map((call) => call.operation)).toEqual([
      'wrapped_action_one',
      'mutate',
      'read_nested',
    ]);
    expect(run.connectorCalls.map((call) => call.route?.baseUrl)).toEqual([
      undefined,
      FIRST_ROUTE,
      FIRST_ROUTE,
    ]);
  });

  it('rejects route drift for a read-signature action wrapper before nested execution', async () => {
    const run = harness();
    const tool = run.artifact.tools[0];
    if (tool === undefined) throw new Error('expected tool');
    const wrapperArtifact: RuntimeArtifact = {
      ...run.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            kind: 'operation',
            operationRef: wrappedActionRef('wrapped_action_one'),
            args: {},
          },
        },
      ],
    };
    const prepared = await prepareToolForConfirmation(
      wrapperArtifact,
      'update_customer',
      {},
      run.deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');

    const result = await executePreparedTool(wrapperArtifact, prepared.continuation, {
      ...run.deps,
      customerRoutes: freezeCustomerRoutes(ENDPOINTS, { customer_api: SECOND_ROUTE }),
    });

    expect({
      outcome: outcome(result),
      policyContexts: run.policyContexts,
      credentialRequests: run.credentialRequests,
      connectorCalls: run.connectorCalls,
    }).toEqual({
      outcome: 'invalid_continuation',
      policyContexts: [],
      credentialRequests: [],
      connectorCalls: [],
    });
  });

  it('rejects a prepared continuation with its private route binding removed before egress', async () => {
    const run = harness();
    const prepared = await prepare(run);
    const continuation = structuredClone(prepared.continuation);
    if (continuation.reviewedAction === undefined) throw new Error('expected reviewed action');
    delete (continuation.reviewedAction as { customerRoutes?: unknown }).customerRoutes;

    const result = await executePreparedTool(run.artifact, continuation, run.deps);

    expect({
      outcome: outcome(result),
      policyContexts: run.policyContexts,
      credentialRequests: run.credentialRequests,
      connectorCalls: run.connectorCalls,
    }).toEqual({
      outcome: 'invalid_continuation',
      policyContexts: [],
      credentialRequests: [],
      connectorCalls: [],
    });
  });

  it('defensively binds ordinary route dependencies when an action artifact omits action metadata', async () => {
    const run = harness();
    const tool = run.artifact.tools[0];
    if (tool === undefined) throw new Error('expected tool');
    const { customerActionEndpointDependencies: _omittedActionMetadata, ...legacyActionRef } =
      actionRef;
    const defensiveArtifact: RuntimeArtifact = {
      ...run.artifact,
      tools: [
        {
          ...tool,
          fulfilment: { kind: 'operation', operationRef: legacyActionRef, args: {} },
        },
      ],
    };
    const prepared = await prepareToolForConfirmation(
      defensiveArtifact,
      'update_customer',
      {},
      run.deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(prepared.continuation.reviewedAction?.customerRoutes).toHaveLength(1);

    const result = await executePreparedTool(defensiveArtifact, prepared.continuation, {
      ...run.deps,
      customerRoutes: freezeCustomerRoutes(ENDPOINTS, { customer_api: SECOND_ROUTE }),
    });

    expect({ outcome: outcome(result), connectorCalls: run.connectorCalls }).toEqual({
      outcome: 'invalid_continuation',
      connectorCalls: [],
    });
  });
});
