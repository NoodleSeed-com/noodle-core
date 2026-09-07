import {
  computeSignatureHash,
  type OperationSignature,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import {
  executePreparedTool,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  prepareToolForConfirmation,
} from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationActivity } from '../src/application-activity.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { createOperationEvidencePort } from '../src/operation-evidence.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';
import { ServerRegistry } from '../src/registry.js';

describe('restored invocation and evidence epoch boundaries', () => {
  it('refuses an old prepared action after the actual service activity binding rotates its epoch', async () => {
    const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel' };
    const installations = new InMemoryBusinessInformationStore();
    await installations.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const signature: OperationSignature = {
      type: 'action',
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'object' },
    };
    const operation = {
      resolved: true as const,
      alias: 'provider',
      connectorId: 'provider',
      connectorVersion: '1',
      operation: 'send',
      signatureHash: computeSignatureHash('send', signature),
    };
    const artifact: RuntimeArtifact = {
      artifactSchemaVersion: '0.19.0',
      resolution: 'resolved',
      source: { manifestName: 'recovery-test', manifestVersion: '1' },
      server: { name: 'recovery-test', version: '1', title: 'Recovery test' },
      tools: [
        {
          name: 'send',
          description: 'Send a confirmed external action.',
          inputSchema: signature.input,
          fulfilment: { kind: 'operation', operationRef: operation, args: {} },
        },
      ],
      capabilities: { tools: ['send'] },
    };
    const send = vi.fn().mockResolvedValue({ ok: true });
    const getCredential = vi.fn().mockResolvedValue({});
    const target: ServedTarget = {
      org: scope.org,
      app: scope.app,
      environment: scope.env,
      deploymentId: 'deployment-one',
      served: {
        artifact,
        deps: {
          connectors: new InMemoryConnectorRegistry([
            new InMemoryConnector('provider', '1', { send: { signature, handler: send } }),
          ]),
          broker: { getCredential },
          executionBinding: { revision: 'unchanged-config-and-account', connections: {} },
        },
      },
    };
    const store = new InMemoryOperationEvidenceStore();
    const registry = new ServerRegistry();
    const bind = (epoch: string) =>
      new ApplicationActivity({
        store,
        epoch,
        identityKey: 'identity-key-with-at-least-thirty-two-characters',
        allowance: async () => ({ maximumDays: 7, defaultDays: 7, revision: 'free-2' }),
      }).bind(target, { installations, registry });
    const before = await bind('before-restore-epoch');
    const prepared = await prepareToolForConfirmation(artifact, 'send', {}, before.served.deps);
    if (prepared.status !== 'confirmation_required')
      throw new Error('Expected pending external action');
    const after = await bind('after-restore-epoch');
    expect(after.served.deps.executionBinding?.revision).not.toBe(
      before.served.deps.executionBinding?.revision,
    );
    expect(
      await executePreparedTool(artifact, prepared.continuation, after.served.deps),
    ).toMatchObject({ status: 'failed', error: { code: 'configuration_changed' } });
    expect(send).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
  });

  it('never treats a new epoch as permission to reclaim an uncertain accepted invocation', async () => {
    const store = new InMemoryOperationEvidenceStore();
    const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel' };
    const options = {
      store,
      scope,
      deploymentId: 'same-deployment',
      epoch: 'before-restore-epoch',
      identityKey: 'identity-key-with-at-least-thirty-two-characters',
      now: () => 1000,
      authorize: async () => true,
      executionBoundMs: () => 1000,
      historyDays: async () => 7,
      connectionGeneration: () => undefined,
    };
    const intent = {
      id: 'accepted-before-restore',
      tool: 'send',
      arguments: {},
      operation: {
        resolved: true as const,
        alias: 'provider',
        connectorId: 'provider',
        connectorVersion: '1',
        operation: 'send',
        signatureHash: 'signature',
      },
    };
    expect(await createOperationEvidencePort(options).begin(intent)).toBeDefined();
    await store.sweep(2001);
    expect((await store.list(scope, 2001, 7, 10))[0]?.outcome).toBe('unknown');
    expect(
      await createOperationEvidencePort({ ...options, epoch: 'after-restore-epoch' }).begin(intent),
    ).toBeUndefined();
  });
});
