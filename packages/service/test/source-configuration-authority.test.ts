import { describe, expect, it, vi } from 'vitest';
import { fenceSourceStore } from '../src/business-information/source-credential-fence.js';
import { InMemorySourceIngestionStore } from '../src/business-information/source-ingestion-memory-store.js';
import { sourceConfigurationAuthority } from '../src/source-configuration-authority.js';
import { InMemoryConfigStore } from '../src/store/config-values.js';

import {
  sourceConfigurationFixture,
  sourceConnectorDocument,
} from './source-configuration-fixture.js';

describe('source configuration authority', () => {
  it('fences referenced hierarchical variables/secrets without invalidating unrelated settings or exposing values', async () => {
    const configStore = new InMemoryConfigStore();
    const { registry, declaration } = sourceConfigurationFixture(configStore);
    const scope = { level: 'env' as const, ...declaration.scope };
    const set = (kind: 'variable' | 'secret', name: string, value: string) =>
      configStore.setConfigValue({ kind, scope, name, value });
    await set('variable', 'SOURCE_ORIGIN', 'https://source.example');
    await set('variable', 'SOURCE_RESOURCE', 'store-one');
    const secret = await set('secret', 'SOURCE_TOKEN', 'private-test-token');
    expect(secret.generation).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(secret)).not.toContain('generation');
    expect(JSON.stringify(secret)).not.toContain('private-test-token');
    const raw = new InMemorySourceIngestionStore({ identityKey: 'x'.repeat(32) });
    const source = fenceSourceStore(
      raw,
      sourceConfigurationAuthority(() => registry),
    );
    let bound = await source.createBinding(declaration);
    expect(bound.credentialIdentity?.configuration).toBeTypeOf('string');
    const captured = JSON.stringify(bound.credentialIdentity);
    expect(captured).not.toContain('private-test-token');
    expect(captured).not.toContain('store-one');
    const metadata = vi.spyOn(configStore, 'resolveConfigValues');
    await set('variable', 'UNRELATED', 'changed');
    expect((await source.listExternalRecords(bound)).records).toEqual([]);
    await configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'org', org: scope.org },
      name: 'SOURCE_RESOURCE',
      value: 'shadowed',
    });
    expect((await source.listExternalRecords(bound)).records).toEqual([]);
    await set('variable', 'SOURCE_RESOURCE', 'store-two');
    const read = vi.spyOn(raw, 'listExternalRecords');
    await expect(source.listExternalRecords(bound)).rejects.toThrow('source_authorization_lost');
    expect(read).not.toHaveBeenCalled();
    const replaced = await source.replaceBinding({
      ...declaration,
      generation: 2,
      expectedRevision: bound.revision,
      now: new Date(),
    });
    if (!replaced.ok) throw new Error('Replacement failed');
    bound = replaced.binding;
    expect((await source.listExternalRecords(bound)).records).toEqual([]);
    const prior = await set('secret', 'SOURCE_TOKEN', 'second-private-token');
    await expect(source.listExternalRecords(bound)).rejects.toThrow('source_authorization_lost');
    expect(prior.generation).not.toBe(secret.generation);
    expect(metadata).not.toHaveBeenCalled(); // No secret decryption, even when evaluating current scope.
  });
  it('walks only declared source compute dependencies and ignores unrelated operations', async () => {
    const config = new InMemoryConfigStore();
    const { registry, declaration } = sourceConfigurationFixture(config);
    const file = JSON.parse(sourceConnectorDocument) as { connectors: unknown[] };
    file.connectors.push({
      id: 'aggregate',
      version: '1.0.0',
      operations: {
        scan: {
          type: 'read',
          input: { type: 'object' },
          output: { type: 'object' },
          code: 'async input => callOperation("read", input)',
          calls: { read: 'gmail.scan' },
        },
      },
    });
    registry.getDeploymentSource = async () => ({
      manifest: '{}',
      connectors: JSON.stringify(file),
    });
    const source = fenceSourceStore(
      new InMemorySourceIngestionStore({ identityKey: 'x'.repeat(32) }),
      sourceConfigurationAuthority(() => registry),
    );
    const bound = await source.createBinding({
      ...declaration,
      scan: { ...declaration.scan, connector: 'aggregate' },
    });
    await config.setConfigValue({
      kind: 'variable',
      scope: { level: 'env', ...declaration.scope },
      name: 'UNRELATED',
      value: 'safe',
    });
    expect((await source.listExternalRecords(bound)).records).toEqual([]);
    await config.setConfigValue({
      kind: 'variable',
      scope: { level: 'env', ...declaration.scope },
      name: 'SOURCE_RESOURCE',
      value: 'new-resource',
    });
    await expect(source.listExternalRecords(bound)).rejects.toThrow('source_authorization_lost');
  });
  it('gives same-timestamp writes independent generations and invalidates deletes without timestamp guesses', async () => {
    const configStore = new InMemoryConfigStore();
    const { registry, declaration } = sourceConfigurationFixture(configStore);
    const input = {
      kind: 'variable' as const,
      scope: { level: 'env' as const, ...declaration.scope },
      name: 'SOURCE_RESOURCE',
      value: 'one',
    };
    vi.useFakeTimers();
    try {
      const first = await configStore.setConfigValue(input);
      const second = await configStore.setConfigValue({ ...input, value: 'two' });
      expect(first.updatedAt).toBe(second.updatedAt);
      expect(first.generation).not.toBe(second.generation);
      const source = fenceSourceStore(
        new InMemorySourceIngestionStore({ identityKey: 'x'.repeat(32) }),
        sourceConfigurationAuthority(() => registry),
      );
      const bound = await source.createBinding(declaration);
      await configStore.deleteConfigValue(input.kind, input.scope, input.name);
      await expect(source.listExternalRecords(bound)).rejects.toThrow('source_authorization_lost');
    } finally {
      vi.useRealTimers();
    }
  });
});
