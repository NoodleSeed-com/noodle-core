import { describe, expect, it } from 'vitest';
import {
  type CatalogConnector,
  compileManifest,
  computeSignatureHash,
  InMemoryCatalog,
} from '../src/index.js';

const signature = {
  type: 'read' as const,
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', properties: {}, additionalProperties: false },
};
const child = {
  connectorId: 'api',
  connectorVersion: '1.0.0',
  operation: 'read',
  signatureHash: computeSignatureHash('read', signature),
};
const api: CatalogConnector = {
  id: 'api',
  version: '1.0.0',
  kind: 'custom',
  operations: { read: signature },
  credentialProfiles: { user: { kind: 'bearer' } },
  operationCredentials: { read: { profiles: ['user'], scopes: ['records.read'] } },
};
function wrapper(calls = [child]): CatalogConnector {
  return {
    id: 'wrapper',
    version: '1.0.0',
    kind: 'custom',
    operations: { execute: signature, unused: signature },
    operationCalls: { execute: calls, unused: [] },
  };
}
function manifest() {
  return {
    manifestVersion: '2',
    server: { name: 'sample', title: 'Sample', version: '1.0.0' },
    connectors: {
      wrapper: { id: 'wrapper', version: '1.0.0' },
      selected: {
        id: 'api',
        version: '1.0.0',
        binding: {
          profile: 'user',
          connection: { id: 'account', source: { kind: 'externalExchange' } },
        },
      },
    },
    tools: [
      {
        name: 'read',
        description: 'Read through application computation.',
        inputSchema: signature.input,
        fulfilment: { use: 'wrapper.execute', args: {} },
      },
    ],
  };
}
describe('nested connector account binding resolution', () => {
  it('counts reachable bound aliases and emits exact per-operation credential authority', () => {
    const result = compileManifest(manifest(), { catalog: new InMemoryCatalog([wrapper(), api]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment).toMatchObject({
      kind: 'operation',
      operationRef: {
        calls: [
          {
            ...child,
            alias: 'selected',
            credentialBinding: {
              bindingId: 'selected',
              connectionId: 'account',
              requiredScopes: ['records.read'],
              presentation: { kind: 'bearer' },
            },
          },
        ],
      },
    });
  });
  it('keeps unused aliases invalid when only an unreferenced compute operation calls them', () => {
    const result = compileManifest(manifest(), {
      catalog: new InMemoryCatalog([
        { ...wrapper([]), operationCalls: { execute: [], unused: [child] } },
        api,
      ]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'unused_connector_alias', path: 'connectors.selected' }),
      );
  });
  it('does not borrow a same-id binding at another version', () => {
    const input = manifest();
    input.connectors.selected.version = '2.0.0';
    const result = compileManifest(input, {
      catalog: new InMemoryCatalog([wrapper(), api, { ...api, version: '2.0.0' }]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'connector_binding_required' }),
      );
  });
  it('rejects ambiguous aliases instead of selecting an account implicitly', () => {
    const input = manifest();
    const result = compileManifest(
      {
        ...input,
        connectors: {
          ...input.connectors,
          second: {
            ...input.connectors.selected,
            binding: {
              ...input.connectors.selected.binding,
              connection: { id: 'second_account', source: { kind: 'externalExchange' } },
            },
          },
        },
      },
      { catalog: new InMemoryCatalog([wrapper(), api]) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'ambiguous_nested_connector_binding' }),
      );
  });
  it('rejects missing or unsupported nested account profiles', () => {
    const input = manifest();
    input.connectors.selected.binding.profile = 'unsupported';
    const result = compileManifest(input, { catalog: new InMemoryCatalog([wrapper(), api]) });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: 'unsupported_credential_profile' }),
      );
  });
  it('refuses inconsistent call hashes and cycles in supplied catalog metadata', () => {
    const drift = compileManifest(manifest(), {
      catalog: new InMemoryCatalog([wrapper([{ ...child, signatureHash: 'invalid' }]), api]),
    });
    expect(drift.ok).toBe(false);
    const cycle = compileManifest(manifest(), {
      catalog: new InMemoryCatalog([
        wrapper([
          {
            connectorId: 'wrapper',
            connectorVersion: '1.0.0',
            operation: 'execute',
            signatureHash: computeSignatureHash('execute', signature),
          },
        ]),
        api,
      ]),
    });
    expect(cycle.ok).toBe(false);
  });
});
