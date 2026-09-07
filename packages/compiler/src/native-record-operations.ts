import type { CatalogConnector, JsonSchema, OperationSignature } from './catalog/types.js';

export const RECORD_CONNECTOR_ID = 'noodle_records';
export const RECORD_CONNECTOR_VERSION = '1.0.0';
const collection = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 64 };
const id = { type: 'string', minLength: 1, maxLength: 128 };
const revision = { type: 'integer', minimum: 1 };
const payload = { type: 'object', maxProperties: 128, additionalProperties: true };
const record = { type: 'object', additionalProperties: true };
function object(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
const receipt = object({ ok: { const: true }, recordId: id, revision });
const recordResult = object({ ok: { const: true }, record });

/** Reusable operation signatures only. Applications must explicitly author their own tools. */
export const RECORD_OPERATION_SIGNATURES: Readonly<Record<string, OperationSignature>> = {
  submit_record: { type: 'action', input: object({ collection, payload }), output: receipt },
  create_record: { type: 'action', input: object({ collection, payload }), output: recordResult },
  get_record: { type: 'read', input: object({ collection, id }), output: recordResult },
  list_records: {
    type: 'read',
    input: object(
      {
        collection,
        cursor: { type: 'string', maxLength: 2048 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['collection'],
    ),
    output: object(
      {
        ok: { const: true },
        records: { type: 'array', items: record, maxItems: 100 },
        nextCursor: { type: 'string', maxLength: 2048 },
      },
      ['ok', 'records'],
    ),
  },
  update_record: {
    type: 'action',
    input: object(
      {
        collection,
        id,
        expectedRevision: revision,
        patch: payload,
        unset: {
          type: 'array',
          maxItems: 128,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
      ['collection', 'id', 'expectedRevision', 'patch'],
    ),
    output: recordResult,
  },
  delete_record: {
    type: 'action',
    input: object({ collection, id, expectedRevision: revision }),
    output: receipt,
  },
};
export const BUILTIN_RECORD_CATALOG_CONNECTOR: CatalogConnector = {
  id: RECORD_CONNECTOR_ID,
  version: RECORD_CONNECTOR_VERSION,
  kind: 'builtin',
  operations: RECORD_OPERATION_SIGNATURES,
};
