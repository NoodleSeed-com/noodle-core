import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';

const declaration = {
  name: 'DAYS',
  schemaVersion: 1,
  valueSchema: { type: 'array', maxItems: 7, items: { type: 'string', enum: ['mon', 'tue'] } },
  default: ['mon'],
  portal: { label: 'Available days' },
  requiredFor: ['book'],
};
function compileVariables(variables: readonly unknown[]) {
  return compileManifest({
    manifestVersion: '2',
    server: { name: 'app', title: 'App', version: '1', variables },
    tools: [
      {
        name: 'book',
        description: 'Book.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}
describe('business-variable compilation', () => {
  it('deduplicates identical declarations and produces deterministic definition digests', () => {
    const result = compileVariables([declaration, declaration]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.variables).toHaveLength(1);
    expect(result.artifact.server.variables?.[0]).toMatchObject({
      ...declaration,
      schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it.each([
    ['conflict', [declaration, { ...declaration, default: ['tue'] }]],
    ['unknown capability', [{ ...declaration, requiredFor: ['missing'] }]],
    ['invalid default', [{ ...declaration, default: ['wed'] }]],
    [
      'unbounded array',
      [{ ...declaration, valueSchema: { type: 'array', items: { type: 'boolean' } } }],
    ],
    ['open object', [{ ...declaration, valueSchema: { type: 'object', properties: {} } }]],
    [
      'external reference',
      [{ ...declaration, valueSchema: { $ref: 'https://example.com/schema' } }],
    ],
    [
      'unsupported schema keyword',
      [{ ...declaration, valueSchema: { type: 'string', maxLength: 20, pattern: '.*' } }],
    ],
    ['unsafe metadata', [{ ...declaration, portal: { label: '<script>bad</script>' } }]],
    ['future revision', [{ ...declaration, schemaVersion: 2 }]],
    ['unsafe key', [{ ...declaration, name: '__proto__' }]],
    [
      'impossible number',
      [{ ...declaration, valueSchema: { type: 'number', minimum: 10, maximum: 1 } }],
    ],
    [
      'impossible list',
      [
        {
          ...declaration,
          valueSchema: { type: 'array', minItems: 8, maxItems: 7, items: { type: 'boolean' } },
        },
      ],
    ],
  ])('rejects %s', (_name, variables) => {
    expect(compileVariables(variables).ok).toBe(false);
  });
  it('allows missing operator values and technical typed declarations without Portal exposure', () => {
    const { default: _default, portal: _portal, ...withoutValue } = declaration;
    const result = compileVariables([withoutValue]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.variables?.[0]).not.toHaveProperty('portal');
    expect(result.artifact.server.variables?.[0]).not.toHaveProperty('default');
  });
});
