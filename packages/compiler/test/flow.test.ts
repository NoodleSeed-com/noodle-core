import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import { compile } from '../src/compile.js';
import { testCatalog } from './catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

function read(rel: string): string {
  return readFileSync(join(fixtures, rel), 'utf8');
}

function manifestWithFulfilment(fulfilment: string, connectors = true): string {
  return `manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
${connectors ? 'connectors:\n  acme:\n    id: acme_orders\n    version: 1.2.0\n' : ''}tools:
  - name: track_order
    description: Track an order.
    inputSchema:
      type: object
    fulfilment:
${fulfilment
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
`;
}

describe('single-operation fulfilment (args emitted as expression AST)', () => {
  it('compiles to the golden artifact', () => {
    const result = compile(read('valid/single-op-args.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toEqual(JSON.parse(read('valid/single-op-args.artifact.json')));
  });

  it('classifies path, template, and literal values', () => {
    const result = compile(read('valid/single-op-args.manifest.yaml'));
    if (!result.ok) throw new Error('expected ok');
    const f = result.artifact.tools[0]?.fulfilment;
    expect(f?.kind).toBe('operation');
    if (f?.kind !== 'operation') return;
    expect(f.args.a_path?.kind).toBe('path');
    expect(f.args.a_template?.kind).toBe('template');
    expect(f.args.a_number).toEqual({ kind: 'literal', value: 42 });
    expect(f.args.a_bool).toEqual({ kind: 'literal', value: true });
  });

  it('no longer carries operationRef at the tool top level', () => {
    const result = compile(read('valid/single-op-args.manifest.yaml'));
    if (!result.ok) throw new Error('expected ok');
    expect('operationRef' in (result.artifact.tools[0] ?? {})).toBe(false);
  });

  it('stamps artifactSchemaVersion 0.17.0', () => {
    const result = compile(read('valid/minimal.manifest.yaml'));
    if (!result.ok) throw new Error('expected ok');
    expect(result.artifact.artifactSchemaVersion).toBe('0.17.0');
  });
});

describe('flow fulfilment', () => {
  it('resolves to the golden artifact (per-step operation refs)', () => {
    const result = compile(read('valid/flow-basic.manifest.yaml'), { catalog: testCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toEqual(JSON.parse(read('valid/flow-basic.artifact.json')));
  });

  it('emits an ordered flow with operation/map steps and an output mapping', () => {
    const result = compile(read('valid/flow-basic.manifest.yaml'), { catalog: testCatalog });
    if (!result.ok) throw new Error('expected ok');
    const f = result.artifact.tools[0]?.fulfilment;
    expect(f?.kind).toBe('flow');
    if (f?.kind !== 'flow') return;
    expect(f.steps.map((s) => `${s.id}:${s.kind}`)).toEqual([
      'lookup:operation',
      'confirm:map',
      'track:operation',
      'shaped:map',
    ]);
    // Every operation step carries its own resolved operation reference.
    for (const step of f.steps) {
      if (step.kind === 'operation') expect(step.operationRef.resolved).toBe(true);
    }
    expect(Object.keys(f.output)).toEqual(['url', 'label']);
  });

  it('parses if conditions as boolean nodes (equality and truthiness)', () => {
    const result = compile(read('valid/flow-basic.manifest.yaml'), { catalog: testCatalog });
    if (!result.ok) throw new Error('expected ok');
    const f = result.artifact.tools[0]?.fulfilment;
    if (f?.kind !== 'flow') return;
    const confirm = f.steps.find((s) => s.id === 'confirm');
    const track = f.steps.find((s) => s.id === 'track');
    expect(confirm?.if).toMatchObject({ kind: 'cond', op: 'eq' });
    expect(track?.if).toMatchObject({ kind: 'truthy' });
  });

  it('reports oversized flow-step if conditions at the step if path', () => {
    const condition = `\${input.${'a'.repeat(16_376)}}`;
    expect(condition.length).toBe(16_385);
    const result = compile(
      manifestWithFulfilment(`steps:
  - id: lookup
    if: ${condition}
    use: acme.get_order
    args:
      id: \${input.order_id}
output:
  id: \${steps.lookup.id}`),
      { catalog: testCatalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_expression',
        path: 'tools.0.fulfilment.steps.0.if',
      }),
    );
  });

  it('is deterministic across compiles', () => {
    const src = read('valid/flow-basic.manifest.yaml');
    const a = compile(src, { catalog: testCatalog });
    const b = compile(src, { catalog: testCatalog });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(JSON.stringify(a.artifact)).toBe(JSON.stringify(b.artifact));
  });

  it('rejects args on non-operation flow steps', () => {
    const cases = [
      {
        fulfilment: `steps:
  - id: shape
    map:
      ok: true
    args:
      id: \${input.order_id}
output:
  ok: \${steps.shape.ok}`,
        path: 'tools.0.fulfilment.steps.0.args',
      },
    ] as const;

    for (const testCase of cases) {
      const result = compile(manifestWithFulfilment(testCase.fulfilment));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid_fulfilment',
          path: testCase.path,
        }),
      );
    }
  });

  it('reports connector and argument failures at flow operation step paths', () => {
    const cases = [
      {
        fulfilment: `steps:
  - id: lookup
    use: missing.get_order
    args:
      id: \${input.order_id}
output:
  id: \${steps.lookup.id}`,
        code: 'unknown_connector_alias',
        path: 'tools.0.fulfilment.steps.0.use',
      },
      {
        fulfilment: `steps:
  - id: lookup
    use: acme.missing
    args:
      id: \${input.order_id}
output:
  id: \${steps.lookup.id}`,
        code: 'unknown_operation',
        path: 'tools.0.fulfilment.steps.0.use',
      },
      {
        fulfilment: `steps:
  - id: lookup
    use: acme.get_order
    args:
      bogus: \${input.order_id}
output:
  id: \${steps.lookup.id}`,
        code: 'arg_mismatch',
        path: 'tools.0.fulfilment.steps.0.args.bogus',
      },
      {
        fulfilment: `steps:
  - id: lookup
    use: acme.get_order
output:
  id: \${steps.lookup.id}`,
        code: 'arg_mismatch',
        path: 'tools.0.fulfilment.steps.0.args.id',
      },
      {
        fulfilment: `steps:
  - id: lookup
    use: acme.get_order
    args:
      id: 7
output:
  id: \${steps.lookup.id}`,
        code: 'arg_type_mismatch',
        path: 'tools.0.fulfilment.steps.0.args.id',
      },
    ] as const;

    for (const testCase of cases) {
      const result = compile(manifestWithFulfilment(testCase.fulfilment), {
        catalog: testCatalog,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: testCase.code, path: testCase.path }),
      );
    }
  });
});

describe('integer argument validation', () => {
  const integerCatalog = new InMemoryCatalog([
    {
      id: 'acme_orders',
      version: '1.2.0',
      kind: 'catalog',
      operations: {
        set_count: {
          type: 'action',
          input: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
            additionalProperties: false,
          },
          output: {},
        },
      },
    },
  ]);

  it('accepts integer literals for integer fields', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  count: 2`),
      { catalog: integerCatalog },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects decimal literals for integer fields', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  count: 1.5`),
      { catalog: integerCatalog },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'arg_type_mismatch',
        path: 'tools.0.fulfilment.args.count',
      }),
    );
  });
});

describe('JSON Schema argument validation (ADR 0139)', () => {
  function catalogWith(input: Record<string, unknown>): InMemoryCatalog {
    return new InMemoryCatalog([
      {
        id: 'acme_orders',
        version: '1.2.0',
        kind: 'catalog',
        operations: { set_count: { type: 'action', input, output: {} } },
      },
    ]);
  }

  it('accepts a matching member of a nullable type array', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  note: hello`),
      {
        catalog: catalogWith({
          type: 'object',
          properties: { note: { type: ['string', 'null'] } },
          additionalProperties: false,
        }),
      },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a literal outside a nullable type array', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  note: 7`),
      {
        catalog: catalogWith({
          type: 'object',
          properties: { note: { type: ['string', 'null'] } },
          additionalProperties: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'arg_type_mismatch', expected: 'string | null' }),
    );
  });

  it('checks literal args against a shallow enum', () => {
    const catalog = catalogWith({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
      additionalProperties: false,
    });
    const ok = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  mode: fast`),
      { catalog },
    );
    expect(ok.ok).toBe(true);
    const bad = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  mode: warp`),
      { catalog },
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors).toContainEqual(expect.objectContaining({ code: 'arg_type_mismatch' }));
  });

  it('checks literal args against a shallow const', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  version: 3`),
      {
        catalog: catalogWith({
          type: 'object',
          properties: { version: { const: 2 } },
          additionalProperties: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'arg_type_mismatch' }));
  });

  it('permits undeclared args when the schema is explicitly open', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  anything: goes`),
      { catalog: catalogWith({ type: 'object', additionalProperties: true }) },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects args passed to an operation with no declared input', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  stray: value`),
      { catalog: catalogWith({ type: 'object', additionalProperties: false }) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'arg_mismatch', got: 'stray' }),
    );
  });

  it('treats a boolean false property schema as not accepted', () => {
    const result = compile(
      manifestWithFulfilment(`use: acme.set_count
args:
  blocked: yes`),
      {
        catalog: catalogWith({
          type: 'object',
          properties: { blocked: false },
          additionalProperties: false,
        }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'arg_mismatch', got: 'blocked' }),
    );
  });
});
