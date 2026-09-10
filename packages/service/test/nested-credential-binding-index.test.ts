import type { ResolvedOperationRef, RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import { buildCredentialBindingIndex } from '../src/credential-binding-index.js';
import {
  boundArtifact,
  config,
  harness,
  request,
  response,
} from './external-credential-exchange.fixtures.js';

function nestedArtifact(): RuntimeArtifact {
  const original = boundArtifact('selected', 'operator_account');
  const originalTool = original.tools[0];
  if (
    !originalTool ||
    originalTool.fulfilment.kind !== 'operation' ||
    !originalTool.fulfilment.operationRef.resolved
  )
    throw new Error('Missing fixture operation');
  const parent: ResolvedOperationRef = {
    resolved: true,
    alias: 'wrapper',
    connectorId: 'application',
    connectorVersion: '1.0.0',
    operation: 'read',
    signatureHash: 'outer-signature',
    calls: [originalTool.fulfilment.operationRef],
  };
  return {
    ...original,
    artifactSchemaVersion: '0.20.0',
    tools: [{ ...originalTool, fulfilment: { kind: 'operation', operationRef: parent, args: {} } }],
  };
}
describe('nested credential binding index', () => {
  it('registers nested operations independently with their exact connection configuration', () => {
    const nested = nestedArtifact();
    expect(buildCredentialBindingIndex(nested)).toEqual(
      buildCredentialBindingIndex(boundArtifact('selected', 'operator_account')),
    );
  });

  it('permits the actual broker exchange for a nested operation and refuses a different account', async () => {
    const direct = boundArtifact('selected', 'operator_account');
    const descriptor = request(direct);
    const guardedFetch = vi
      .fn()
      .mockResolvedValue(
        response('account-token', 'provider-rev-1', 120),
      ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [nestedArtifact()],
      configs: [config('operator_account', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    await expect(broker.getCredential(descriptor)).resolves.toEqual({ token: 'account-token' });
    await expect(
      broker.getCredential({ ...descriptor, connectionId: 'other_account' }),
    ).rejects.toThrow();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects inconsistent nested binding configurations while preserving older artifacts', () => {
    const nested = nestedArtifact();
    expect(
      buildCredentialBindingIndex({ ...nested, connectorBindings: {} }).externalExchange,
    ).toEqual([]);
    expect(
      buildCredentialBindingIndex(boundArtifact('selected', 'operator_account')).externalExchange,
    ).toHaveLength(1);
  });
});
