import { computeSignatureHash, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  type ConnectorRegistry,
  executePreparedTool,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  isConfirmationRequired,
  prepareToolForConfirmation,
  StaticServiceBroker,
} from '../src/index.js';

const actionSignature = {
  type: 'action' as const,
  input: {
    type: 'object' as const,
    properties: { account: { type: 'string' } },
    required: ['account'],
    additionalProperties: false,
  },
  output: {
    type: 'object' as const,
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false,
  },
};

const readSignature = {
  type: 'read' as const,
  input: {
    type: 'object' as const,
    properties: { value: { type: 'string' } },
    additionalProperties: false,
  },
  output: {
    type: 'object' as const,
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
};

function path(root: 'input' | 'steps', ...names: string[]) {
  return {
    kind: 'path' as const,
    root,
    segments: names.map((name) => ({ kind: 'prop' as const, name })),
  };
}

function ref(operation: string, signature: typeof actionSignature | typeof readSignature) {
  return {
    resolved: true as const,
    alias: operation,
    connectorId: 'mail',
    connectorVersion: '1.0.0',
    operation,
    signatureHash: computeSignatureHash(operation, signature),
  };
}

function condition(account: string) {
  return {
    kind: 'cond' as const,
    op: 'eq' as const,
    left: {
      kind: 'path' as const,
      root: 'input',
      segments: [
        { kind: 'prop' as const, name: 'accounts' },
        { kind: 'index' as const, value: 0 },
      ],
    },
    right: { kind: 'literal' as const, value: account },
  };
}

function conditionalArtifact(): RuntimeArtifact {
  return {
    artifactSchemaVersion: '0.11.0',
    resolution: 'resolved',
    source: { manifestName: 'conditional', manifestVersion: '2' },
    server: { name: 'conditional', title: 'Conditional', version: '1.0.0' },
    capabilities: { tools: ['route'] },
    tools: [
      {
        name: 'route',
        description: 'Route one action.',
        inputSchema: { type: 'object' },
        annotations: { confirm: true },
        fulfilment: {
          kind: 'flow',
          steps: [
            {
              id: 'personal',
              kind: 'operation',
              if: condition('personal@example.com'),
              operationRef: ref('mutate_personal', actionSignature),
              args: { account: { kind: 'literal', value: 'personal@example.com' } },
            },
            {
              id: 'work',
              kind: 'operation',
              if: condition('work@example.com'),
              operationRef: ref('mutate_work', actionSignature),
              args: { account: { kind: 'literal', value: 'work@example.com' } },
            },
            {
              id: 'merge',
              kind: 'operation',
              operationRef: ref('merge', readSignature),
              args: {
                value: {
                  kind: 'coalesce',
                  left: path('steps', 'personal', 'requestId'),
                  right: path('steps', 'work', 'requestId'),
                },
              },
            },
          ],
          output: { value: path('steps', 'merge', 'value') },
        },
      },
    ],
  };
}

describe('conditional confirmation actions', () => {
  it('prepares one eligible action, discloses its trailing read, and rejects zero or two actions', async () => {
    const calls: string[] = [];
    const connector = new InMemoryConnector('mail', '1.0.0', {
      mutate_personal: {
        signature: actionSignature,
        handler: () => {
          calls.push('personal');
          return { requestId: 'personal-result' };
        },
      },
      mutate_work: {
        signature: actionSignature,
        handler: () => {
          calls.push('work');
          return { requestId: 'work-result' };
        },
      },
      merge: {
        signature: readSignature,
        handler: (args) => {
          calls.push('merge');
          return { value: args.value };
        },
      },
    });
    const artifact = conditionalArtifact();
    const deps = {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    };
    const prepared = await prepareToolForConfirmation(
      artifact,
      'route',
      { accounts: ['work@example.com'] },
      deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(prepared.review.action).toMatchObject({
      operation: 'mutate_work',
      additionalOperationCount: 1,
    });
    await expect(executePreparedTool(artifact, prepared.continuation, deps)).resolves.toEqual({
      status: 'completed',
      output: { value: 'work-result' },
    });
    expect(calls).toEqual(['work', 'merge']);

    await expect(
      prepareToolForConfirmation(artifact, 'route', { accounts: ['unknown@example.com'] }, deps),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'invalid_confirmation_flow' } });

    const twoEligible = structuredClone(artifact);
    const flow = twoEligible.tools[0]?.fulfilment;
    if (flow?.kind !== 'flow') throw new Error('expected flow');
    for (const step of flow.steps.slice(0, 2)) {
      if (step.kind === 'operation') delete (step as { if?: unknown }).if;
    }
    await expect(
      prepareToolForConfirmation(twoEligible, 'route', { accounts: ['work@example.com'] }, deps),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'invalid_confirmation_flow' } });

    const conservative = structuredClone(artifact);
    const conservativeFlow = conservative.tools[0]?.fulfilment;
    if (conservativeFlow?.kind !== 'flow') throw new Error('expected flow');
    const trailingRead = conservativeFlow.steps[2];
    if (trailingRead?.kind !== 'operation') throw new Error('expected trailing read');
    (trailingRead as { if?: unknown }).if = {
      kind: 'truthy',
      operand: path('steps', 'work', 'requestId'),
    };
    const conservativelyPrepared = await prepareToolForConfirmation(
      conservative,
      'route',
      { accounts: ['work@example.com'] },
      deps,
    );
    if (!isConfirmationRequired(conservativelyPrepared)) {
      throw new Error('expected conservative confirmation');
    }
    expect(conservativelyPrepared.review.action?.additionalOperationCount).toBe(1);
    expect(calls).toEqual(['work', 'merge']);
  });

  it('preflights every direct signature before proposal and before the reviewed side effect', async () => {
    const calls: string[] = [];
    const valid = new InMemoryConnector('mail', '1.0.0', {
      mutate_personal: { signature: actionSignature, handler: () => ({ requestId: 'personal' }) },
      mutate_work: {
        signature: actionSignature,
        handler: () => {
          calls.push('work');
          return { requestId: 'work' };
        },
      },
      merge: { signature: readSignature, handler: (args) => ({ value: args.value }) },
    });
    const driftedRead = {
      ...readSignature,
      output: { ...readSignature.output, properties: { value: { type: 'number' as const } } },
    };
    const drifted = new InMemoryConnector('mail', '1.0.0', {
      mutate_personal: { signature: actionSignature, handler: () => ({ requestId: 'never' }) },
      mutate_work: {
        signature: actionSignature,
        handler: () => {
          calls.push('drifted-work');
          return { requestId: 'never' };
        },
      },
      merge: { signature: driftedRead, handler: () => ({ value: 1 }) },
    });
    const artifact = conditionalArtifact();
    const broker = new StaticServiceBroker({ token: 'svc' });
    const stableDeps = { connectors: new InMemoryConnectorRegistry([valid]), broker };
    const driftedDeps = { connectors: new InMemoryConnectorRegistry([drifted]), broker };
    const input = { accounts: ['work@example.com'] };

    await expect(
      prepareToolForConfirmation(artifact, 'route', input, driftedDeps),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'signature_drift' } });
    const prepared = await prepareToolForConfirmation(artifact, 'route', input, stableDeps);
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    await expect(
      executePreparedTool(artifact, prepared.continuation, driftedDeps),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'signature_drift' } });
    expect(calls).toEqual([]);
  });

  it('isolates snapshotted signatures from connector-owned mutation during an action invoke', async () => {
    const mutableRead = structuredClone(readSignature);
    const artifact = conditionalArtifact();
    const flow = artifact.tools[0]?.fulfilment;
    if (flow?.kind !== 'flow') throw new Error('expected flow');
    const merge = flow.steps[2];
    if (merge?.kind !== 'operation' || !merge.operationRef.resolved) {
      throw new Error('expected resolved merge');
    }
    merge.operationRef.signatureHash = computeSignatureHash('merge', mutableRead);
    const calls: string[] = [];
    const connector = new InMemoryConnector('mail', '1.0.0', {
      mutate_personal: { signature: actionSignature, handler: () => ({ requestId: 'personal' }) },
      mutate_work: {
        signature: actionSignature,
        handler: () => {
          calls.push('work');
          (mutableRead.output.properties.value as { type: string }).type = 'number';
          return { requestId: 'work-result' };
        },
      },
      merge: {
        signature: mutableRead,
        handler: (args) => {
          calls.push('merge');
          return { value: args.value };
        },
      },
    });
    const deps = {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    };
    const prepared = await prepareToolForConfirmation(
      artifact,
      'route',
      { accounts: ['work@example.com'] },
      deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');

    await expect(executePreparedTool(artifact, prepared.continuation, deps)).resolves.toEqual({
      status: 'completed',
      output: { value: 'work-result' },
    });
    expect(calls).toEqual(['work', 'merge']);
  });

  it('uses one stable connector/signature snapshot and revalidates replayed tool input', async () => {
    const calls: string[] = [];
    const connector = new InMemoryConnector('mail', '1.0.0', {
      mutate_work: {
        signature: actionSignature,
        handler: () => {
          calls.push('work');
          return { requestId: 'request-123' };
        },
      },
    });
    let resolutions = 0;
    const changingRegistry: ConnectorRegistry = {
      resolve: () => {
        resolutions += 1;
        return resolutions === 1 ? connector : undefined;
      },
    };
    const operationRef = ref('mutate_work', actionSignature);
    const artifact: RuntimeArtifact = {
      ...conditionalArtifact(),
      tools: [
        {
          name: 'route',
          description: 'Route one action.',
          annotations: { confirm: true },
          inputSchema: {
            type: 'object',
            properties: { account: { type: 'string' } },
            required: ['account'],
            additionalProperties: false,
          },
          fulfilment: {
            kind: 'operation',
            operationRef,
            args: { account: path('input', 'account') },
          },
        },
      ],
    };
    const deps = {
      connectors: changingRegistry,
      broker: new StaticServiceBroker({ token: 'svc' }),
    };
    const prepared = await prepareToolForConfirmation(
      artifact,
      'route',
      { account: 'work@example.com' },
      deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    resolutions = 0;

    await expect(
      executePreparedTool(
        artifact,
        { ...prepared.continuation, input: { account: 'work@example.com', unexpected: true } },
        deps,
      ),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'arg_invalid' } });
    expect(calls).toEqual([]);
    resolutions = 0;
    await expect(executePreparedTool(artifact, prepared.continuation, deps)).resolves.toEqual({
      status: 'completed',
      output: { requestId: 'request-123' },
    });
    expect(resolutions).toBe(1);
    expect(calls).toEqual(['work']);
  });
});
