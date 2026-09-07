import { describe, expect, it } from 'vitest';

import {
  createPluginCompatibility,
  DEVELOPMENT_CONTENT_HASH,
  parsePluginCompatibility,
  renderPluginCompatibilityJson,
} from '../src/plugin-compatibility.js';

const release = {
  mode: 'release' as const,
  version: '2.3.4',
  cliVersion: '5.6.7',
  developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
  developerMcpCapabilityVersion: '1',
};

describe('plugin compatibility manifest', () => {
  it('uses explicit non-shippable development compatibility defaults', () => {
    expect(createPluginCompatibility({ pluginVersion: '0.22.0' })).toEqual({
      schemaVersion: 2,
      pluginVersion: '0.22.0',
      agentKitVersion: '0.22.0',
      pluginContentHash: DEVELOPMENT_CONTENT_HASH,
      cliVersion: '0.0.0',
      developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
      developerMcpCapabilityVersion: '0.0.0',
    });
  });

  it('requires every compatibility-set input in release mode', () => {
    expect(() => createPluginCompatibility({ mode: 'release', pluginVersion: '1.0.0' })).toThrow(
      /agentKitVersion/,
    );
    expect(() =>
      createPluginCompatibility({
        mode: 'release',
        pluginVersion: '1.0.0',
        agentKitVersion: '1.0.0',
      }),
    ).toThrow(/pluginContentHash/);
    expect(() =>
      createPluginCompatibility({
        mode: 'release',
        pluginVersion: '1.0.0',
        agentKitVersion: '1.0.0',
        pluginContentHash: `sha256:${'a'.repeat(64)}`,
      }),
    ).toThrow(/cliVersion/);
    expect(
      createPluginCompatibility({
        mode: release.mode,
        pluginVersion: release.version,
        agentKitVersion: '8.9.0',
        pluginContentHash: `sha256:${'a'.repeat(64)}`,
        cliVersion: release.cliVersion,
        developerMcpUrl: release.developerMcpUrl,
        developerMcpCapabilityVersion: release.developerMcpCapabilityVersion,
      }),
    ).toMatchObject({
      pluginVersion: '2.3.4',
      agentKitVersion: '8.9.0',
      pluginContentHash: `sha256:${'a'.repeat(64)}`,
      cliVersion: '5.6.7',
      developerMcpCapabilityVersion: '1',
    });
  });

  it.each([
    ['pluginVersion', 'latest'],
    ['pluginVersion', '^1.2.3'],
    ['cliVersion', '1.2'],
    ['cliVersion', '>=1.0.0'],
  ])('rejects non-exact semver for %s', (field, value) => {
    expect(() =>
      parsePluginCompatibility({
        schemaVersion: 1,
        pluginVersion: '1.2.3',
        cliVersion: '4.5.6',
        developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
        developerMcpCapabilityVersion: '1',
        [field]: value,
      }),
    ).toThrow(new RegExp(field));
  });

  it.each([
    'http://cloud.noodleseed.dev/developer/mcp',
    'https://user:password@cloud.noodleseed.dev/developer/mcp',
    'https://cloud.noodleseed.dev/developer/mcp?token=x',
    'https://cloud.noodleseed.dev/developer/mcp#secret',
    'https://cloud.noodleseed.dev/other',
  ])('rejects unsafe or non-canonical production URL %s', (developerMcpUrl) => {
    expect(() =>
      parsePluginCompatibility({
        schemaVersion: 1,
        pluginVersion: '1.2.3',
        cliVersion: '4.5.6',
        developerMcpUrl,
        developerMcpCapabilityVersion: '1',
      }),
    ).toThrow(/developerMcpUrl/);
  });

  it('rejects missing capability versions and unknown fields', () => {
    const valid = {
      schemaVersion: 1,
      pluginVersion: '1.2.3',
      cliVersion: '4.5.6',
      developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
      developerMcpCapabilityVersion: '1',
    };
    const { developerMcpCapabilityVersion: _missing, ...missing } = valid;
    expect(() => parsePluginCompatibility(missing)).toThrow(/developerMcpCapabilityVersion/);
    expect(() => parsePluginCompatibility({ ...valid, extra: true })).toThrow(
      /unknown field.*extra/,
    );
  });

  it('keeps schema v1 manifests readable while requiring provenance in schema v2', () => {
    const legacy = {
      schemaVersion: 1,
      pluginVersion: '1.2.3',
      cliVersion: '4.5.6',
      developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
      developerMcpCapabilityVersion: '1',
    };
    expect(parsePluginCompatibility(legacy)).toEqual(legacy);
    expect(() => parsePluginCompatibility({ ...legacy, schemaVersion: 2 })).toThrow(
      /agentKitVersion|pluginContentHash/i,
    );
  });

  it('renders canonical sorted JSON with one trailing newline', () => {
    const rendered = renderPluginCompatibilityJson(
      createPluginCompatibility({
        mode: release.mode,
        pluginVersion: release.version,
        agentKitVersion: '8.9.0',
        pluginContentHash: `sha256:${'a'.repeat(64)}`,
        cliVersion: release.cliVersion,
        developerMcpUrl: release.developerMcpUrl,
        developerMcpCapabilityVersion: release.developerMcpCapabilityVersion,
      }),
    );
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(false);
    expect(Object.keys(JSON.parse(rendered))).toEqual([
      'agentKitVersion',
      'cliVersion',
      'developerMcpCapabilityVersion',
      'developerMcpUrl',
      'pluginVersion',
      'pluginContentHash',
      'schemaVersion',
    ]);
  });
});
