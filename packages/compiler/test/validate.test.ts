import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { compile, compileManifest, manifestJsonSchema, validateManifest } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const read = (rel: string): string => readFileSync(join(fixtures, rel), 'utf8');
const obj = (rel: string): unknown => parseYaml(read(rel));

describe('validateManifest (GT-2 generation-target surface)', () => {
  it('accepts a catalog-using manifest WITHOUT a catalog (connector resolution deferred, not errored)', () => {
    const result = validateManifest(obj('valid/minimal.manifest.yaml'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports a shape error (unsupported manifest version)', () => {
    const result = validateManifest(obj('invalid/unknown-manifest-version.yaml'));
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('unsupported_manifest_version');
  });

  it('rejects the legacy "0.2" version with a typed error naming the accepted core versions', () => {
    const raw = obj('valid/minimal.manifest.yaml') as Record<string, unknown>;
    raw.manifestVersion = '0.2';
    const result = validateManifest(raw);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsupported_manifest_version',
        path: 'manifestVersion',
        expected: '1 | 2',
        got: '0.2',
      }),
    );
  });

  it.each([
    ['invalid/duplicate-tool-name.yaml', 'duplicate_name'],
    ['invalid/external-ref.yaml', 'external_ref'],
    ['invalid/flow-forward-step.yaml', 'forward_step_ref'],
    ['invalid/unknown-schema-ref.yaml', 'unknown_schema_ref'],
  ] as const)('surfaces the catalog-independent semantic error in %s', (file, code) => {
    const result = validateManifest(obj(file));
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(code);
  });

  it('does NOT emit connector-resolution errors (those require a catalog)', () => {
    // Without a catalog the connector alias is left unresolved, not errored — locking the
    // catalog-optional contract a generator relies on.
    const result = validateManifest(obj('invalid/unknown-connector-alias.yaml'));
    expect(result.ok).toBe(true);
    const codes = result.errors.map((e) => e.code);
    expect(codes).not.toContain('unknown_connector_alias');
    expect(codes).not.toContain('unknown_operation');
  });

  it('is a faithful projection of compileManifest(obj) with no catalog', () => {
    const source = obj('invalid/duplicate-tool-name.yaml');
    const viaValidate = validateManifest(source);
    const viaCompile = compileManifest(source);
    expect(viaValidate.ok).toBe(viaCompile.ok);
    if (!viaCompile.ok) {
      expect(viaValidate.errors).toEqual(viaCompile.errors);
    }
  });

  it('matches YAML-source compilation on a valid manifest', () => {
    const src = read('valid/minimal.manifest.yaml');
    expect(validateManifest(parseYaml(src)).ok).toBe(compile(src).ok);
  });
});

describe('manifestJsonSchema (GT-2 published contract)', () => {
  it('emits a stable JSON Schema 2020-12 document for the manifest', () => {
    const schema = manifestJsonSchema();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect(schema.oneOf).toHaveLength(2);
  });
});
