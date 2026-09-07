import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import type { OperationSignature } from '../src/catalog/types.js';

/** The `get_order` read operation referenced by the minimal manifest fixture. */
export const getOrderSignature: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { order: { type: 'object' } },
    additionalProperties: false,
  },
};

/** The `get_tracking` read operation referenced by the flow-basic fixture. */
const getTrackingSignature: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { order_id: { type: 'string' } },
    required: ['order_id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { url: { type: 'string' } },
    additionalProperties: false,
  },
};

const stateOutput: OperationSignature['output'] = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    handle: { type: 'string' },
    key: { type: 'string' },
    value: { type: 'object' },
    revision: { type: 'integer' },
    status: { type: 'string' },
    expiresAt: { type: 'string' },
  },
  required: ['ok', 'handle', 'key', 'value', 'revision', 'status'],
  additionalProperties: false,
};

/**
 * Catalog used across resolution tests: one connector (`acme_orders` v1.2.0) exposing the
 * `get_order` and `get_tracking` read operations, matching the `minimal` and `flow-basic` fixtures.
 */
export const testCatalog = new InMemoryCatalog([
  {
    id: 'acme_orders',
    version: '1.2.0',
    kind: 'catalog',
    operations: { get_order: getOrderSignature, get_tracking: getTrackingSignature },
  },
  {
    id: 'noodle_state',
    version: '1.0.0',
    kind: 'builtin',
    operations: {
      read_state: {
        type: 'read',
        input: {
          type: 'object',
          properties: { handle: { type: 'string' }, key: { type: 'string' } },
          required: ['handle'],
          additionalProperties: false,
        },
        output: stateOutput,
      },
      patch_state: {
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
      },
      complete_state: {
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
      },
    },
  },
]);
