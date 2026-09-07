import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeSignatureHash } from '../src/catalog/signature.js';
import { compile } from '../src/compile.js';
import type { CompileErrorCode } from '../src/errors.js';
import { getOrderSignature, testCatalog } from './catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

function read(rel: string): string {
  return readFileSync(join(fixtures, rel), 'utf8');
}

describe('compile (resolved against a catalog)', () => {
  it('resolves the minimal manifest to the golden resolved artifact', () => {
    const result = compile(read('valid/minimal.manifest.yaml'), { catalog: testCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const golden = JSON.parse(read('valid/minimal.resolved.artifact.json'));
    expect(result.artifact).toEqual(golden);
  });

  it('emits a fully resolved operation reference (SPEC Runtime Invariants)', () => {
    const result = compile(read('valid/minimal.manifest.yaml'), { catalog: testCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resolution).toBe('resolved');
    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind).toBe('operation');
    if (fulfilment?.kind === 'operation') {
      expect(fulfilment.operationRef).toEqual({
        alias: 'acme',
        connectorId: 'acme_orders',
        connectorVersion: '1.2.0',
        operation: 'get_order',
        signatureHash: computeSignatureHash('get_order', getOrderSignature),
        resolved: true,
      });
    }
  });

  it('produces a sha256 signature hash that is stable across compiles', () => {
    const src = read('valid/minimal.manifest.yaml');
    const a = compile(src, { catalog: testCatalog });
    const b = compile(src, { catalog: testCatalog });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const fa = a.artifact.tools[0]?.fulfilment;
    const fb = b.artifact.tools[0]?.fulfilment;
    const refA = fa?.kind === 'operation' ? fa.operationRef : undefined;
    const refB = fb?.kind === 'operation' ? fb.operationRef : undefined;
    expect(refA).toEqual(refB);
    if (refA?.resolved) expect(refA.signatureHash).toMatch(/^sha256v2:[0-9a-f]{64}$/);
  });

  it('produces identical signature hashes regardless of key declaration order in input/output schemas', () => {
    const sig1 = {
      type: 'read' as const,
      input: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { x: { type: 'boolean' }, y: { type: 'object' } },
        additionalProperties: false,
      },
    };
    const sig2 = {
      type: 'read' as const,
      input: {
        additionalProperties: false,
        properties: { b: { type: 'number' }, a: { type: 'string' } },
        type: 'object',
      },
      output: {
        additionalProperties: false,
        properties: { y: { type: 'object' }, x: { type: 'boolean' } },
        type: 'object',
      },
    };
    const h1 = computeSignatureHash('get_something', sig1);
    const h2 = computeSignatureHash('get_something', sig2);
    expect(h1).toBe(h2);
  });

  it('falls back to a shape-only artifact when no catalog is supplied', () => {
    const result = compile(read('valid/minimal.manifest.yaml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resolution).toBe('shape-only');
    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind === 'operation' && fulfilment.operationRef.resolved).toBe(false);
  });
});

const cases: ReadonlyArray<{ file: string; code: CompileErrorCode; path: string }> = [
  {
    file: 'unknown-connector-alias.yaml',
    code: 'unknown_connector_alias',
    path: 'tools.0.fulfilment.use',
  },
  {
    file: 'connector-not-in-catalog.yaml',
    code: 'connector_not_in_catalog',
    path: 'connectors.acme',
  },
  { file: 'unknown-operation.yaml', code: 'unknown_operation', path: 'tools.0.fulfilment.use' },
  { file: 'unused-connector-alias.yaml', code: 'unused_connector_alias', path: 'connectors.spare' },
  { file: 'arg-mismatch.yaml', code: 'arg_mismatch', path: 'tools.0.fulfilment.args.bogus' },
  {
    file: 'arg-type-mismatch.yaml',
    code: 'arg_type_mismatch',
    path: 'tools.0.fulfilment.args.id',
  },
];

describe('compile (resolution failures)', () => {
  for (const testCase of cases) {
    it(`${testCase.file} -> ${testCase.code} at "${testCase.path}"`, () => {
      const result = compile(read(join('invalid', testCase.file)), { catalog: testCatalog });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: testCase.code, path: testCase.path }),
      );
    });
  }

  it('requires the missing argument when a tool omits a required input', () => {
    const result = compile(read('invalid/arg-mismatch.yaml'), { catalog: testCatalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'arg_mismatch', path: 'tools.0.fulfilment.args.id' }),
    );
  });

  it('enriches an unknown argument key with got + expected + docAnchor', () => {
    const result = compile(read('invalid/arg-mismatch.yaml'), { catalog: testCatalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'arg_mismatch',
        path: 'tools.0.fulfilment.args.bogus',
        got: 'bogus',
        expected: 'id',
        docAnchor: 'compile-errors#arg-mismatch',
      }),
    );
  });

  it('enriches a missing required argument with expected + docAnchor', () => {
    const result = compile(read('invalid/arg-mismatch.yaml'), { catalog: testCatalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'arg_mismatch',
        path: 'tools.0.fulfilment.args.id',
        expected: 'id',
        docAnchor: 'compile-errors#arg-mismatch',
      }),
    );
  });

  it('enriches an argument type mismatch with structured expected/got + docAnchor', () => {
    const result = compile(read('invalid/arg-type-mismatch.yaml'), { catalog: testCatalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'arg_type_mismatch',
        path: 'tools.0.fulfilment.args.id',
        expected: 'string',
        got: 'number',
        docAnchor: 'compile-errors#arg-type-mismatch',
      }),
    );
  });
});
