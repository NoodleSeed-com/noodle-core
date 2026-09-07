import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../src/artifact/types.js';
import { compile } from '../src/compile.js';
import type { CompileErrorCode } from '../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

function read(rel: string): string {
  return readFileSync(join(fixtures, rel), 'utf8');
}

describe('compile ($use schema resolution)', () => {
  it('resolves $use to local $ref + bundled $defs (golden)', () => {
    const result = compile(read('valid/schemas-basic.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const golden = JSON.parse(read('valid/schemas-basic.artifact.json'));
    expect(result.artifact).toEqual(golden);
  });

  it('bundles only referenced schemas, with $defs keys sorted, and is deterministic', () => {
    const src = read('valid/schemas-basic.manifest.yaml');
    const a = compile(src);
    const b = compile(src);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const defs = (a.artifact.tools[0]?.inputSchema.$defs ?? {}) as Record<string, unknown>;
    // `unused_thing` is declared but never referenced — it must not be bundled.
    expect(Object.keys(defs)).toEqual(['address', 'order']);
    expect(JSON.stringify(a.artifact)).toBe(JSON.stringify(b.artifact));
  });

  it('runs in shape-only mode (no catalog) and still resolves $use', () => {
    const result = compile(read('valid/schemas-basic.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resolution).toBe('shape-only');
    const props = result.artifact.tools[0]?.inputSchema.properties as Record<string, JsonSchema>;
    expect(props.order).toEqual({ $ref: '#/$defs/order' });
  });

  it('resolves $use at an outputSchema root into a standalone schema document', () => {
    const result = compile(read('valid/schemas-basic.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.artifact.tools[0]?.outputSchema as JsonSchema;
    expect(output).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/order',
    });
    expect(Object.keys((output.$defs ?? {}) as Record<string, unknown>)).toEqual([
      'address',
      'order',
    ]);
  });

  it('rejects external refs inside outputSchema, including through $use', () => {
    const direct = compile(`manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
tools:
  - name: get_order
    description: Look up an order.
    inputSchema:
      type: object
    outputSchema:
      $ref: https://example.com/order.schema.json
    fulfilment:
      use: acme.get_order
`);
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.errors).toContainEqual(
        expect.objectContaining({ code: 'external_ref', path: 'tools.0.outputSchema.$ref' }),
      );
    }

    const throughUse = compile(`manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
schemas:
  order:
    type: object
    properties:
      x:
        $ref: https://example.com/order.schema.json
tools:
  - name: get_order
    description: Look up an order.
    inputSchema:
      type: object
    outputSchema:
      $use: order
    fulfilment:
      use: acme.get_order
`);
    expect(throughUse.ok).toBe(false);
    if (!throughUse.ok) {
      expect(throughUse.errors).toContainEqual(
        expect.objectContaining({
          code: 'external_ref',
          path: 'tools.0.outputSchema.$defs.order.properties.x.$ref',
        }),
      );
    }
  });

  it('terminates on self-reference and mutual cycles, bundling each member once', () => {
    const result = compile(read('valid/schemas-cycle.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const input = result.artifact.tools[0]?.inputSchema as JsonSchema;
    const defs = (input.$defs ?? {}) as Record<string, JsonSchema>;
    expect(Object.keys(defs)).toEqual(['node', 'ping', 'pong']);
    // The cycle is preserved as internal $refs rather than inlined.
    expect((defs.node?.properties as Record<string, JsonSchema>).next).toEqual({
      $ref: '#/$defs/node',
    });
    expect((defs.ping?.properties as Record<string, JsonSchema>).pong).toEqual({
      $ref: '#/$defs/pong',
    });
    expect((defs.pong?.properties as Record<string, JsonSchema>).ping).toEqual({
      $ref: '#/$defs/ping',
    });
  });

  it('leaves schemas without $use byte-identical (no stray $defs)', () => {
    const result = compile(read('valid/minimal.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]?.inputSchema.$defs).toBeUndefined();
  });
});

const cases: ReadonlyArray<{ file: string; code: CompileErrorCode; path: string }> = [
  {
    file: 'unknown-schema-ref.yaml',
    code: 'unknown_schema_ref',
    path: 'tools.0.inputSchema.properties.x.anyOf.1.$use',
  },
  {
    file: 'schema-use-not-string.yaml',
    code: 'invalid_schema_ref',
    path: 'tools.0.inputSchema.properties.x.$use',
  },
  {
    file: 'schema-use-siblings.yaml',
    code: 'invalid_schema_ref',
    path: 'tools.0.inputSchema.properties.x.$use',
  },
  {
    file: 'schema-use-bad-name.yaml',
    code: 'invalid_name',
    path: 'tools.0.inputSchema.properties.x.$use',
  },
  {
    file: 'schema-ref-conflict.yaml',
    code: 'schema_ref_conflict',
    path: 'tools.0.inputSchema.$defs.address',
  },
  {
    file: 'schema-use-external-ref.yaml',
    code: 'external_ref',
    path: 'tools.0.inputSchema.$defs.order.properties.x.$ref',
  },
];

describe('compile ($use resolution failures)', () => {
  for (const testCase of cases) {
    it(`${testCase.file} -> ${testCase.code} at "${testCase.path}"`, () => {
      const result = compile(read(join('invalid', testCase.file)));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: testCase.code, path: testCase.path }),
      );
    });
  }
});
