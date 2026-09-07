import { describe, expect, it } from 'vitest';
import { normalizePersistedManifestForCompile } from '../src/manifest-normalize.js';

describe('normalizePersistedManifestForCompile — legacy manifestVersion (ADR 0150)', () => {
  const legacyManifest = (version: string): string =>
    JSON.stringify({
      manifestVersion: version,
      server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
      tools: [
        {
          name: 'get_order',
          description: 'Look up an order.',
          inputSchema: { type: 'object' },
          fulfilment: { use: 'acme.get_order', args: {} },
        },
      ],
    });

  it('upgrades a persisted "0.2" record to the Core v1 version "1"', () => {
    const normalized = normalizePersistedManifestForCompile(legacyManifest('0.2'));
    expect((JSON.parse(normalized) as { manifestVersion: string }).manifestVersion).toBe('1');
  });

  it('returns a current "1" record byte-identical (no reserialization churn)', () => {
    const source = legacyManifest('1');
    expect(normalizePersistedManifestForCompile(source)).toBe(source);
  });

  it('does not touch versions other than the known legacy "0.2"', () => {
    const source = legacyManifest('0.9');
    expect(normalizePersistedManifestForCompile(source)).toBe(source);
  });

  it('leaves non-JSON (YAML) sources unchanged', () => {
    const source = 'manifestVersion: "0.2"\nserver:\n  name: acme_support\n';
    expect(normalizePersistedManifestForCompile(source)).toBe(source);
  });
});
