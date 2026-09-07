import type { CatalogConnector, JsonSchema } from '@noodle-borg/compiler';
import { connector } from './connectors.js';

/** Every state operation returns the same envelope (JSON Schema 2020-12, ADR 0139). */
const stateOutput: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    handle: { type: 'string' },
    value: { type: 'object' },
    revision: { type: 'integer' },
    status: { type: 'string' },
    expiresAt: { type: 'string' },
  },
  required: ['ok', 'handle', 'value', 'revision', 'status'],
  additionalProperties: false,
};

const state = connector('noodle_state')
  .version('1.0.0')
  .operation('read_state', {
    type: 'read',
    input: {
      type: 'object',
      properties: { handle: { type: 'string' }, key: { type: 'string' } },
      required: ['handle'],
      additionalProperties: false,
    },
    output: stateOutput,
  })
  .operation('patch_state', {
    type: 'action',
    input: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        key: { type: 'string' },
        expectedRevision: { type: 'integer' },
        value: { type: 'object' },
      },
      required: ['handle', 'expectedRevision', 'value'],
      additionalProperties: false,
    },
    output: stateOutput,
  })
  .operation('complete_state', {
    type: 'action',
    input: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        key: { type: 'string' },
        expectedRevision: { type: 'integer' },
      },
      required: ['handle', 'expectedRevision'],
      additionalProperties: false,
    },
    output: stateOutput,
  });

export const noodlePlatform = {
  state: {
    v1: state,
  },
} as const;

export const noodlePlatformCatalog: readonly CatalogConnector[] = [
  {
    id: state.id,
    version: state.version,
    kind: 'builtin',
    operations: state.operations,
  },
];
