import type { ResolvedOperationRef } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCallHost } from '../src/connector/types.js';
import { nestedOperationHost } from '../src/nested-operation-host.js';

const child: ResolvedOperationRef = {
  resolved: true,
  alias: 'selected',
  connectorId: 'api',
  connectorVersion: '1.0.0',
  operation: 'read',
  signatureHash: 'signature',
  credentialBinding: {
    bindingId: 'selected',
    connectionId: 'operator_account',
    connectionConfigRevision: 'revision',
    profile: 'user',
    presentation: { kind: 'bearer' },
    requiredScopes: ['records.read'],
  },
};
const parent: ResolvedOperationRef = {
  resolved: true,
  alias: 'wrapper',
  connectorId: 'wrapper',
  connectorVersion: '1.0.0',
  operation: 'compute',
  signatureHash: 'outer',
  calls: [child],
};
describe('nested connector host authority', () => {
  it('uses the compiled account and original host receiver rather than caller metadata', async () => {
    const received = vi.fn();
    const host: ConnectorCallHost = {
      async callOperation(ref, args, path) {
        expect(this).toBe(host);
        received(ref, args, path);
        return { ok: true };
      },
    };
    const wrapped = nestedOperationHost(parent, host);
    const binding = child.credentialBinding;
    if (!binding) throw new Error('Fixture account binding is missing');
    await expect(
      wrapped.callOperation(
        {
          ...child,
          alias: 'forged',
          credentialBinding: { ...binding, connectionId: 'attacker_account' },
        },
        { id: 'one' },
        'host.read',
      ),
    ).resolves.toEqual({ ok: true });
    expect(received).toHaveBeenCalledExactlyOnceWith(child, { id: 'one' }, 'host.read');
  });

  it.each([
    { connectorId: 'other' },
    { connectorVersion: '2.0.0' },
    { operation: 'write' },
    { signatureHash: 'changed' },
  ])('refuses unmatched nested identity before any host call', async (changed) => {
    const callOperation = vi.fn();
    const host = nestedOperationHost(parent, { callOperation });
    expect(() => host.callOperation({ ...child, ...changed }, {}, 'host.read')).toThrow(
      'Undeclared nested connector',
    );
    expect(callOperation).not.toHaveBeenCalled();
  });

  it('treats explicit empty calls as no host authority and preserves older artifact behavior', () => {
    const host: ConnectorCallHost = { callOperation: vi.fn() };
    expect(() =>
      nestedOperationHost({ ...parent, calls: [] }, host).callOperation(child, {}, 'host.read'),
    ).toThrow();
    const { calls: _calls, ...legacy } = parent;
    expect(nestedOperationHost(legacy, host)).toBe(host);
  });
  it.each([
    true,
    false,
  ])('inherits the runtime deadline and receiver for declared calls=%s', async (declared) => {
    const inherited = AbortSignal.timeout(1000);
    const received = vi.fn();
    const host: ConnectorCallHost = {
      async callOperation(ref, args, path, signal) {
        expect(this).toBe(host);
        received(ref, args, path, signal);
        return {};
      },
    };
    const { calls: _calls, ...legacy } = parent;
    const wrapped = nestedOperationHost(declared ? parent : legacy, host, inherited);
    await wrapped.callOperation(child, {}, 'host.read', new AbortController().signal);
    expect(received).toHaveBeenCalledExactlyOnceWith(child, {}, 'host.read', inherited);
  });
});
