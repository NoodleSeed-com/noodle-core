import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';
import type { CompileError } from '../src/errors.js';

/** A structurally valid `0.2` manifest; individual fields are corrupted per-test. */
function baseManifest(): Record<string, unknown> {
  return {
    manifestVersion: '1',
    server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
    tools: [
      {
        name: 't',
        description: 'demo',
        inputSchema: { type: 'object' },
        fulfilment: { use: 'acme.do_thing', args: {} },
      },
    ],
  };
}

function errorsFor(raw: unknown): readonly CompileError[] {
  const result = compileManifest(raw);
  if (result.ok) throw new Error('expected compileManifest to fail');
  return result.errors;
}

/** The full set of keys a flat CompileError may carry — used to prove no nested payload leaks. */
const ALLOWED_KEYS = new Set([
  'code',
  'path',
  'message',
  'didYouMean',
  'suggestions',
  'expected',
  'got',
  'docAnchor',
]);

describe('translateIssue enrichment (Zod -> CompileError)', () => {
  it('invalid_type carries expected/got/docAnchor', () => {
    const raw = baseManifest();
    (raw.server as Record<string, unknown>).name = 123;
    const error = errorsFor(raw).find((e) => e.path === 'server.name');
    expect(error).toMatchObject({
      code: 'invalid_name',
      expected: 'string',
      got: 'number',
      docAnchor: 'compile-errors#invalid-name',
    });
  });

  it('invalid_value (literal mismatch) carries expected/got/docAnchor', () => {
    const raw = baseManifest();
    raw.manifestVersion = '0.9';
    const error = errorsFor(raw).find((e) => e.path === 'manifestVersion');
    expect(error).toMatchObject({
      code: 'unsupported_manifest_version',
      expected: '1 | 2',
      got: '0.9',
      docAnchor: 'compile-errors#unsupported-manifest-version',
    });
  });

  it('a union mismatch stays a single flat error (no nested unionErrors explosion)', () => {
    const raw = baseManifest();
    // A fulfilment that matches no variant forces a union failure at tools.0.fulfilment.
    (raw.tools as Record<string, unknown>[])[0].fulfilment = { bogus: true };
    const errors = errorsFor(raw);
    const fulfilmentError = errors.find((e) => e.path.startsWith('tools.0.fulfilment'));
    expect(fulfilmentError).toBeDefined();
    // No nested `errors`/`unionErrors` arrays may leak into the flat CompileError shape.
    for (const key of Object.keys(fulfilmentError as object)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
    // The serialized error stays bounded even for deeply malformed unions.
    expect(JSON.stringify(fulfilmentError).length).toBeLessThan(4000);
  });

  it('every translated shape error carries a stable docAnchor', () => {
    const raw = baseManifest();
    (raw.server as Record<string, unknown>).name = 123;
    for (const error of errorsFor(raw)) {
      expect(typeof error.docAnchor).toBe('string');
      expect(error.docAnchor).toMatch(/^compile-errors#/);
    }
  });
});
