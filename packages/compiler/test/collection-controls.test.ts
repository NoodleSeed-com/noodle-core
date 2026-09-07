import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';

function compileCollection(overrides: Record<string, unknown> = {}) {
  return compileManifest({
    manifestVersion: '2',
    server: {
      name: 'app',
      title: 'App',
      version: '1',
      collections: [
        {
          name: 'tickets',
          title: 'Tickets',
          description: 'Customer tickets',
          schemaVersion: 1,
          recordSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['summary', 'stage'],
            properties: {
              summary: { type: 'string', maxLength: 500 },
              stage: { type: 'string', enum: ['open', 'waiting', 'done'], default: 'open' },
              internal: { type: 'string', maxLength: 100 },
            },
          },
          publicFields: ['summary'],
          editableFields: ['summary', 'stage'],
          management: { notes: true },
          fields: { stage: { label: 'Progress' } },
          filterFields: ['stage'],
          sortFields: ['summary'],
          ...overrides,
        },
      ],
    },
    tools: [
      {
        name: 'health',
        description: 'Check.',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}
describe('lightweight native collection intent', () => {
  it('projects independent controls, safe public fields and ordinary status choices', () => {
    const result = compileCollection();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.managedCollections?.[0]).toMatchObject({
      management: { notes: true },
      publicFields: ['summary'],
      editableFields: ['summary', 'stage'],
      fields: { stage: { label: 'Progress' } },
      filterFields: ['stage'],
      sortFields: ['summary'],
    });
    expect(result.artifact.server.managedCollections?.[0]).not.toHaveProperty('behavior');
  });
  it.each([
    ['unknown public field', { publicFields: ['private_missing'] }],
    ['unknown label', { fields: { unknown: { label: 'No' } } }],
    ['unsafe markup', { fields: { summary: { label: '<script>bad</script>' } } }],
    ['required private field without default', { publicFields: ['stage'] }],
    [
      'unsupported filter type',
      {
        filterFields: ['internal'],
        recordSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { internal: { type: 'array', items: { type: 'string' }, maxItems: 10 } },
        },
      },
    ],
  ])('rejects %s', (_name, overrides) => expect(compileCollection(overrides).ok).toBe(false));
});
