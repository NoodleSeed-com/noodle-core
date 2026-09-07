import { describe, expect, it } from 'vitest';
import type { Connector } from '../src/connector/types.js';
import { withConnectorSnapshot } from '../src/connector-snapshot.js';

const ref = {
  resolved: true,
  connectorId: 'records',
  connectorVersion: '1',
  operation: 'create',
  signatureHash: 'signature',
} as const;
describe('connector snapshot execution bounds', () => {
  it('retains the declared action deadline once per operation and invocation', () => {
    let bound = 10000;
    const connector: Connector = {
      id: 'records',
      version: '1',
      signature: () => undefined,
      executionBoundMs: (operation) => (operation === 'create' ? bound : undefined),
      invoke: async () => ({ ok: true }),
    };
    const dependencies = {
      connectors: { resolve: () => connector },
      broker: { getCredential: async () => ({ token: '' }) },
    };
    const snapshot = withConnectorSnapshot(dependencies).connectors.resolve(ref);
    expect(snapshot?.executionBoundMs?.('create')).toBe(10000);
    bound = 20000;
    expect(snapshot?.executionBoundMs?.('create')).toBe(10000);
    expect(snapshot?.executionBoundMs?.('read')).toBeUndefined();
    expect(
      withConnectorSnapshot(dependencies).connectors.resolve(ref)?.executionBoundMs?.('create'),
    ).toBe(20000);
  });
});
