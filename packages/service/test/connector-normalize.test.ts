import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { normalizePersistedConnectorsForCompile } from '../src/connector-normalize.js';

describe('normalizePersistedConnectorsForCompile', () => {
  it('losslessly upgrades legacy required fields and permissive unknown fields', () => {
    const source = JSON.stringify({
      connectors: [
        {
          id: 'legacy',
          version: '1.0.0',
          operations: {
            lookup: {
              type: 'read',
              input: {
                id: { type: 'string', required: true },
                payload: { type: 'unknown' },
              },
              output: { result: { type: 'custom-pre-schema-type', required: true } },
              code: '(input) => ({ result: input })',
            },
          },
        },
      ],
    });

    const normalized = parseYaml(normalizePersistedConnectorsForCompile(source));
    const operation = normalized.connectors[0].operations.lookup;
    expect(operation.input).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, payload: {} },
      required: ['id'],
      additionalProperties: false,
    });
    expect(operation.output).toEqual({
      type: 'object',
      properties: { result: {} },
      required: ['result'],
      additionalProperties: false,
    });
  });

  it('leaves canonical JSON Schema connector definitions unchanged', () => {
    const source = JSON.stringify({
      connectors: [
        {
          id: 'current',
          version: '1.0.0',
          operations: {
            lookup: {
              type: 'read',
              input: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
                additionalProperties: false,
              },
              output: { type: 'object', additionalProperties: true },
              code: '(input) => input',
            },
          },
        },
      ],
    });

    expect(normalizePersistedConnectorsForCompile(source)).toBe(source);
  });
});
