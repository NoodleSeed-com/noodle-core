/**
 * Canonical normalization for operation input/output JSON Schemas (ADR 0139), plus detection of
 * the retired flat field-map language so parse/author boundaries can reject it with a precise
 * error. The upgrade path (`fieldMapToJsonSchema`) was removed when field-map acceptance ended;
 * only the detector remains, for error reporting.
 */

import type { JsonSchema } from './types.js';

/** Top-level keys that mark a value as a JSON Schema document rather than a legacy field map. */
const JSON_SCHEMA_MARKERS = new Set([
  '$schema',
  '$defs',
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'prefixItems',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
]);

function isLegacyField(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || record.type.length === 0) return false;
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'type') continue;
    if (key === 'required') {
      if (typeof entry !== 'boolean') return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Whether a declared operation `input`/`output` value uses the retired field-map language
 * (`{ field: { type, required? } }`). Used only to produce a precise rejection at parse/author
 * boundaries — the shape is no longer accepted anywhere.
 */
export function isLegacyFieldMap(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  for (const [key, entry] of entries) {
    if (JSON_SCHEMA_MARKERS.has(key)) return false;
    if (!isLegacyField(entry)) return false;
  }
  return true;
}

/**
 * Normalize a declared operation I/O schema to its canonical form (ADR 0139): omitted schemas
 * become the closed-empty object, and an absent top-level `additionalProperties` defaults to
 * `false` (operation I/O is closed by default; authors opt out with an explicit `true`).
 */
export function normalizeOperationIoSchema(value: unknown): JsonSchema {
  if (value === undefined || value === null) {
    return { type: 'object', additionalProperties: false };
  }
  const schema = { ...(value as JsonSchema) };
  if (schema.type === undefined) schema.type = 'object';
  if (schema.additionalProperties === undefined) schema.additionalProperties = false;
  return schema;
}
