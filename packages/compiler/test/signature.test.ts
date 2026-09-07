import { describe, expect, it } from 'vitest';
import type { OperationSignature } from '../src/index.js';
import { computeSignatureHash, normalizeOperationIoSchema } from '../src/index.js';

/** Convenience: a read signature over raw JSON Schema input/output. */
function sig(
  input: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
): OperationSignature {
  return {
    type: 'read',
    input: normalizeOperationIoSchema(input),
    output: normalizeOperationIoSchema(output),
  };
}

const HASH_SHAPE = /^sha256v2:[0-9a-f]{64}$/;

describe('computeSignatureHash over JSON Schema signatures', () => {
  it('emits the sha256v2 prefix (ADR 0139 amends ADR 0002)', () => {
    expect(computeSignatureHash('get', sig(undefined, undefined))).toMatch(HASH_SHAPE);
  });

  it('is invariant under object key order', () => {
    const a = sig(
      {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a'],
      },
      undefined,
    );
    const b = sig(
      {
        required: ['a'],
        properties: { b: { type: 'number' }, a: { type: 'string' } },
        type: 'object',
      },
      undefined,
    );
    expect(computeSignatureHash('get', a)).toBe(computeSignatureHash('get', b));
  });

  it('is invariant under `required` array order (set semantics)', () => {
    const a = sig(
      {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a', 'b'],
      },
      undefined,
    );
    const b = sig(
      {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['b', 'a'],
      },
      undefined,
    );
    expect(computeSignatureHash('get', a)).toBe(computeSignatureHash('get', b));
  });

  it('is invariant under string `type` array order and single-element collapse', () => {
    const arr = sig({ type: 'object', properties: { a: { type: ['null', 'string'] } } }, undefined);
    const arr2 = sig(
      { type: 'object', properties: { a: { type: ['string', 'null'] } } },
      undefined,
    );
    expect(computeSignatureHash('get', arr)).toBe(computeSignatureHash('get', arr2));

    const single = sig({ type: 'object', properties: { a: { type: ['string'] } } }, undefined);
    const scalar = sig({ type: 'object', properties: { a: { type: 'string' } } }, undefined);
    expect(computeSignatureHash('get', single)).toBe(computeSignatureHash('get', scalar));
  });

  it('ignores annotation-only keywords: description, title, examples, deprecated, $comment, default', () => {
    const plain = sig({ type: 'object', properties: { a: { type: 'string' } } }, undefined);
    const annotated = sig(
      {
        type: 'object',
        title: 'Input',
        description: 'documented input',
        examples: [{ a: 'x' }],
        deprecated: false,
        $comment: 'internal note',
        properties: {
          a: { type: 'string', description: 'field doc', default: 'x', title: 'A' },
        },
      },
      undefined,
    );
    expect(computeSignatureHash('get', plain)).toBe(computeSignatureHash('get', annotated));
  });

  it('ignores a $schema dialect marker', () => {
    const plain = sig({ type: 'object', properties: { a: { type: 'string' } } }, undefined);
    const marked = sig(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { a: { type: 'string' } },
      },
      undefined,
    );
    expect(computeSignatureHash('get', plain)).toBe(computeSignatureHash('get', marked));
  });

  it('treats omitted, {}, and explicit closed-empty object schemas as identical', () => {
    const omitted = sig(undefined, undefined);
    const empty = sig({}, undefined);
    const explicit = sig(
      { type: 'object', properties: {}, required: [], additionalProperties: false },
      undefined,
    );
    expect(computeSignatureHash('get', omitted)).toBe(computeSignatureHash('get', empty));
    expect(computeSignatureHash('get', omitted)).toBe(computeSignatureHash('get', explicit));
  });

  it('changes when a nested schema detail changes (visible below one level)', () => {
    const a = sig(undefined, {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: { type: 'object', properties: { n: { type: 'string' } } },
        },
      },
    });
    const b = sig(undefined, {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: { type: 'object', properties: { n: { type: 'number' } } },
        },
      },
    });
    expect(computeSignatureHash('get', a)).not.toBe(computeSignatureHash('get', b));
  });

  it('changes when the operation name or type changes', () => {
    const s = sig({ type: 'object', properties: { a: { type: 'string' } } }, undefined);
    expect(computeSignatureHash('get', s)).not.toBe(computeSignatureHash('list', s));
    const action: OperationSignature = { ...s, type: 'action' };
    expect(computeSignatureHash('get', s)).not.toBe(computeSignatureHash('get', action));
  });

  it('is deterministic across calls', () => {
    const s = sig({ type: 'object', properties: { a: { type: 'string' } } }, undefined);
    expect(computeSignatureHash('get', s)).toBe(computeSignatureHash('get', s));
  });
});

describe('normalizeOperationIoSchema', () => {
  it('defaults omitted schemas to a closed object', () => {
    expect(normalizeOperationIoSchema(undefined)).toEqual({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('closes an open top level by default while preserving an explicit true', () => {
    expect(
      normalizeOperationIoSchema({ type: 'object', properties: { a: { type: 'string' } } }),
    ).toMatchObject({ additionalProperties: false });
    expect(
      normalizeOperationIoSchema({ type: 'object', additionalProperties: true }),
    ).toMatchObject({ additionalProperties: true });
  });
});
