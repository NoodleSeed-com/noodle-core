import {
  type AssistantSessionRecord,
  InMemoryAssistantStore,
  withAssistantSessionExecutionAuthority,
} from '@noodle-borg/assistant-gateway';
import {
  computeSignatureHash,
  type OperationSignature,
  type ResolvedOperationRef,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import {
  type Connector,
  type ConnectorCall,
  type ExecuteDeps,
  executePreparedTool,
  type InvocationContext,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import {
  assistantPreparedToolContinuation,
  dispatchAssistantTool,
} from '../src/assistant-interactive.js';

const FIRST_ROUTE = 'https://tenant-a.api.noodleseed.dev/v1';
const SECOND_ROUTE = 'https://tenant-b.api.noodleseed.dev/v2';
const NOW = new Date('2030-01-01T00:00:00.000Z');
const CONTEXT: InvocationContext = {
  temporal: {
    instant: NOW.toISOString(),
    localDate: '2030-01-01',
    localTime: '00:00:00',
    utcOffset: '+00:00',
    weekday: 'Tuesday',
    timeZone: 'UTC',
    locale: 'en-US',
    source: { locale: 'platform-default', timeZone: 'platform-default' },
  },
  ambientStatus: 'not_configured',
};
const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;
const READ_SIGNATURE: OperationSignature = {
  type: 'read',
  input: EMPTY_SCHEMA,
  output: EMPTY_SCHEMA,
};
const ACTION_SIGNATURE: OperationSignature = {
  type: 'action',
  input: EMPTY_SCHEMA,
  output: EMPTY_SCHEMA,
};

describe('assistant session execution authority', () => {
  it('routes the same tool to each session tenant and fails closed when routing is omitted', async () => {
    const run = harness();

    const first = await dispatch(run, session(FIRST_ROUTE), 'read_customer');
    const second = await dispatch(run, session(SECOND_ROUTE), 'read_customer');
    const missing = await dispatch(run, session(), 'read_customer');

    expect(first).toEqual({ kind: 'tool_result', output: {} });
    expect(second).toEqual({ kind: 'tool_result', output: {} });
    expect(missing).toEqual({
      kind: 'tool_result',
      output: { error: 'connector_route_unavailable' },
    });
    expect(run.calls.map((call) => call.route?.baseUrl)).toEqual([FIRST_ROUTE, SECOND_ROUTE]);
    expect(run.credentialRoutes).toEqual(['customer_api', 'customer_api']);
  });

  it('resumes a confirmed action with the route authority stored on its session', async () => {
    const run = harness();
    const storedSession = session(FIRST_ROUTE);
    const proposed = await dispatch(run, storedSession, 'update_customer');
    expect(proposed).toMatchObject({ kind: 'event', event: 'tool_proposed' });
    if (proposed.kind !== 'event' || proposed.event !== 'tool_proposed') {
      throw new Error('expected confirmation proposal');
    }
    const interaction = await run.store.getInteraction({
      id: String(proposed.data.id),
      sessionId: storedSession.id,
      deploymentId: storedSession.deploymentId,
      now: NOW,
    });
    if (interaction?.kind !== 'confirmation') throw new Error('expected stored confirmation');
    const continuation = assistantPreparedToolContinuation(interaction);
    if (continuation === undefined) throw new Error('expected prepared continuation');

    const result = await executePreparedTool(
      run.artifact,
      continuation,
      withAssistantSessionExecutionAuthority(run.deps, run.artifact, storedSession),
    );

    expect(result).toEqual({ status: 'completed', output: {} });
    expect(run.calls.map((call) => call.route?.baseUrl)).toEqual([FIRST_ROUTE]);
  });
});

function harness() {
  const calls: ConnectorCall[] = [];
  const credentialRoutes: string[] = [];
  const connector: Connector = {
    id: 'customer_records',
    version: '1.0.0',
    signature(operation) {
      return operation === 'read_customer'
        ? READ_SIGNATURE
        : operation === 'update_customer'
          ? ACTION_SIGNATURE
          : undefined;
    },
    async invoke(call) {
      calls.push(call);
      return {};
    },
  };
  const deps: ExecuteDeps = {
    connectors: { resolve: () => connector },
    broker: {
      async getCredential(request) {
        if (request.route) credentialRoutes.push(request.route.key);
        return { token: 'downstream-token' };
      },
    },
  };
  return {
    artifact: artifact(),
    calls,
    credentialRoutes,
    deps,
    store: new InMemoryAssistantStore(),
  };
}

async function dispatch(
  run: ReturnType<typeof harness>,
  assistantSession: AssistantSessionRecord,
  toolName: 'read_customer' | 'update_customer',
) {
  const tool = run.artifact.tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`missing ${toolName}`);
  return dispatchAssistantTool({
    artifact: run.artifact,
    tool,
    arguments: {},
    executeDeps: run.deps,
    caller: assistantSession.caller,
    context: CONTEXT,
    session: assistantSession,
    store: run.store,
    audit: { emit: async () => {} },
    now: () => NOW,
  });
}

function session(route?: string): AssistantSessionRecord {
  return {
    id: `session_${route ?? 'missing'}`,
    tokenHash: 'token-hash',
    clientId: 'embed_123',
    tenant: { org: 'acme', app: 'support', env: 'prod' },
    deploymentId: 'dep_123',
    origin: 'https://app.example.com',
    caller: { subject: 'user_123', identityKind: 'customer' },
    ...(route === undefined ? {} : { customerRouting: { customer_api: route } }),
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    absoluteExpiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    history: [],
  };
}

function operationRef(
  operation: 'read_customer' | 'update_customer',
  signature: OperationSignature,
): ResolvedOperationRef {
  return {
    resolved: true,
    alias: 'records',
    connectorId: 'customer_records',
    connectorVersion: '1.0.0',
    operation,
    signatureHash: computeSignatureHash(operation, signature),
    customerEndpoint: 'customer_api',
    customerEndpointDependencies: ['customer_api'],
    ...(signature.type === 'action'
      ? { customerActionEndpointDependencies: ['customer_api'] }
      : {}),
  };
}

function artifact(): RuntimeArtifact {
  return {
    artifactSchemaVersion: '0.15.0',
    resolution: 'resolved',
    source: {
      manifestName: 'assistant_customer_routing',
      manifestVersion: '2',
      coreVersion: '2',
    },
    server: {
      name: 'assistant_customer_routing',
      title: 'Assistant Customer Routing',
      version: '1.0.0',
    },
    capabilities: { tools: ['read_customer', 'update_customer'] },
    customerEndpoints: {
      customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
    },
    tools: [
      {
        name: 'read_customer',
        description: 'Read a customer record.',
        inputSchema: EMPTY_SCHEMA,
        fulfilment: {
          kind: 'operation',
          operationRef: operationRef('read_customer', READ_SIGNATURE),
          args: {},
        },
      },
      {
        name: 'update_customer',
        description: 'Update a customer record.',
        inputSchema: EMPTY_SCHEMA,
        annotations: { confirm: true },
        fulfilment: {
          kind: 'operation',
          operationRef: operationRef('update_customer', ACTION_SIGNATURE),
          args: {},
        },
      },
    ],
  };
}
