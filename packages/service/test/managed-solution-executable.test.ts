import {
  BUILTIN_RECORD_CATALOG_CONNECTOR,
  compileManifest,
  InMemoryCatalog,
} from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { managedSolutionManifest } from '../src/business-information/managed-solution-executable.js';
import {
  builtInDefinition,
  builtInDefinitionAtRelease,
} from '../src/business-information/profiles.js';

describe('curated managed solution executables', () => {
  it.each([
    'travel',
    'ecommerce',
    'restaurant',
  ] as const)('compiles %s with one explicit public submission and independently editable records', (profile) => {
    const definition = builtInDefinition(profile);
    const manifest = managedSolutionManifest(definition);
    const result = compileManifest(manifest, {
      catalog: new InMemoryCatalog([BUILTIN_RECORD_CATALOG_CONNECTOR]),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools).toHaveLength(1);
    expect(result.artifact.tools[0]?.annotations?.confirm).toBe(true);
    expect(result.artifact.server.interactions).toEqual({ confirmationFallback: 'host' });
    expect(result.artifact.tools[0]?.inputSchema.properties).not.toHaveProperty('status');
    expect(result.artifact.server.variables).toEqual(definition.variables);
    expect(result.artifact.server.variables?.[0]).toMatchObject({
      name: 'WEBSITE_ORIGIN',
      requiredFor: [],
      portal: { label: 'Website origin' },
    });
    expect(result.artifact.server.variables?.[0]).not.toHaveProperty('default');
    expect(
      result.artifact.server.managedCollections?.[0]?.schemaDigest.replace(/^sha256:/, ''),
    ).toBe(definition.collections[0]?.schemaDigest);
  });
  it('keeps published historical releases immutable and refuses inventing an executable for them', () => {
    const old = builtInDefinitionAtRelease('travel', 2);
    expect(old.variables).toBeUndefined();
    expect(() => managedSolutionManifest(old)).toThrow('executable');
  });
});
