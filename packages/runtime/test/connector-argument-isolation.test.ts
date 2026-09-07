import { computeSignatureHash, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  type ExecuteDeps,
  executePreparedTool,
  executeTool,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  type InvocationContext,
  isConfirmationRequired,
  prepareToolForConfirmation,
  StaticServiceBroker,
} from '../src/index.js';

const mutateSignature = {
  type: 'action' as const,
  input: {
    type: 'object',
    properties: {
      settings: {
        type: 'object',
        properties: { team: { type: 'string' } },
        required: ['team'],
        additionalProperties: false,
      },
    },
    required: ['settings'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { mutated: { type: 'boolean' } },
    required: ['mutated'],
    additionalProperties: false,
  },
};

function contextPath(...names: string[]) {
  return {
    kind: 'path' as const,
    root: 'context' as const,
    segments: names.map((name) => ({ kind: 'prop' as const, name })),
  };
}

function stepPath(...names: string[]) {
  return {
    kind: 'path' as const,
    root: 'steps' as const,
    segments: names.map((name) => ({ kind: 'prop' as const, name })),
  };
}

function tool(name: string, confirm: boolean) {
  return {
    name,
    description: 'Prove connector arguments cannot mutate invocation context.',
    inputSchema: { type: 'object', additionalProperties: false },
    ...(confirm ? { annotations: { confirm: true } } : {}),
    fulfilment: {
      kind: 'flow' as const,
      steps: [
        {
          id: 'mutate',
          kind: 'operation' as const,
          operationRef: {
            resolved: true as const,
            alias: 'malicious',
            connectorId: 'malicious',
            connectorVersion: '1.0.0',
            operation: 'mutate',
            signatureHash: computeSignatureHash('mutate', mutateSignature),
          },
          args: { settings: contextPath('ambient', 'settings') },
        },
      ],
      output: {
        teamAfterConnector: contextPath('ambient', 'settings', 'team'),
        connectorMutatedItsCopy: stepPath('mutate', 'mutated'),
      },
    },
  };
}

const artifact: RuntimeArtifact = {
  artifactSchemaVersion: '0.11.0',
  resolution: 'resolved',
  source: { manifestName: 'connector_argument_isolation', manifestVersion: '1' },
  server: {
    name: 'connector_argument_isolation',
    title: 'Connector Argument Isolation',
    version: '1.0.0',
  },
  capabilities: { tools: ['run', 'run_confirmed'] },
  tools: [tool('run', false), tool('run_confirmed', true)],
};

function invocationContext(): InvocationContext {
  return {
    temporal: {
      instant: '2026-07-15T00:00:00.000Z',
      localDate: '2026-07-15',
      localTime: '00:00:00',
      utcOffset: '+00:00',
      weekday: 'Wednesday',
      timeZone: 'UTC',
      locale: 'en-US',
      source: { locale: 'platform-default', timeZone: 'platform-default' },
    },
    ambientStatus: 'available',
    ambient: { settings: { team: 'platform' } },
  };
}

function deps(context: InvocationContext): ExecuteDeps {
  const connector = new InMemoryConnector('malicious', '1.0.0', {
    mutate: {
      signature: mutateSignature,
      handler: (args) => {
        (args.settings as { team: string }).team = 'connector-mutated';
        return { mutated: true };
      },
    },
  });
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'service-token' }),
    context,
  };
}

describe('connector argument isolation', () => {
  it('keeps structured context immutable across an ordinary connector step', async () => {
    const context = invocationContext();

    await expect(executeTool(artifact, 'run', {}, deps(context))).resolves.toEqual({
      ok: true,
      output: {
        teamAfterConnector: 'platform',
        connectorMutatedItsCopy: true,
      },
    });
    expect(context.ambient).toEqual({ settings: { team: 'platform' } });
  });

  it('keeps structured context immutable during confirmed execution', async () => {
    const context = invocationContext();
    const executeDeps = deps(context);
    const prepared = await prepareToolForConfirmation(artifact, 'run_confirmed', {}, executeDeps);
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');

    await expect(
      executePreparedTool(artifact, prepared.continuation, executeDeps),
    ).resolves.toEqual({
      status: 'completed',
      output: {
        teamAfterConnector: 'platform',
        connectorMutatedItsCopy: true,
      },
    });
    expect(context.ambient).toEqual({ settings: { team: 'platform' } });
  });
});
