import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';
import { InMemoryCatalog } from '../src/index.js';

describe('intent capture reserved input', () => {
  it('rejects new authored tools that collide with the serve-time adapter field', () => {
    const result = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'collision', title: 'Collision', version: '1.0.0' },
        tools: [
          {
            name: 'search',
            description: 'Search.',
            inputSchema: {
              type: 'object',
              properties: { __noodleIntent: { type: 'string' } },
              additionalProperties: false,
            },
            fulfilment: { steps: [], output: { ok: true } },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: 'reserved_name',
          path: 'tools.0.inputSchema.properties.__noodleIntent',
        },
      ],
    });
  });
});
