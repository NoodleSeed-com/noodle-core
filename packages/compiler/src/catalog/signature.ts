import { createHash } from 'node:crypto';
import { normalizeOperationIoSchema } from './io-schema.js';
import type { OperationSignature } from './types.js';

/**
 * JSON Schema keywords that annotate but never constrain (2020-12 §9): stripped before hashing so
 * a documentation edit never reads as a compatibility break (ADR 0139).
 */
const ANNOTATION_KEYWORDS = new Set([
  '$comment',
  'default',
  'deprecated',
  'description',
  'examples',
  'title',
]);

/** Keywords whose string-array values carry set semantics and are sorted before hashing. */
const SET_KEYWORDS = new Set(['required', 'type']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Normalize a schema tree for hashing (ADR 0139): strip `$schema` and annotation keywords, sort
 * `required`/`type` string arrays (dropping an empty `required`), collapse a single-element `type`
 * array to its scalar, and drop an empty `properties` — so semantically identical schemas authored
 * via Zod, raw JSON Schema, the importer, or legacy field maps hash identically.
 */
function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$schema' || ANNOTATION_KEYWORDS.has(key)) continue;
    if (SET_KEYWORDS.has(key) && isStringArray(entry)) {
      if (key === 'required' && entry.length === 0) continue;
      const sorted = [...entry].sort();
      out[key] = key === 'type' && sorted.length === 1 ? sorted[0] : sorted;
      continue;
    }
    if (
      key === 'properties' &&
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 0
    ) {
      continue;
    }
    out[key] = normalizeForHash(entry);
  }
  return out;
}

/**
 * Recursively sort object keys so that semantically identical signatures serialize to identical
 * JSON regardless of authoring key order. Arrays preserve their order (it is significant); plain
 * objects are reordered by key. Primitives pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compute the stable signature hash for a connector operation (docs/SPEC.md "Versioning",
 * ADR 0002 as amended by ADR 0139).
 *
 * The hash covers the operation name and its signature (kind + input/output JSON Schemas after
 * hash normalization) but NOT the connector version: two connector versions that expose the same
 * operation signature are compatible and share a hash, while any constraint-affecting schema
 * change yields a new hash. The `sha256v2:` prefix marks the ADR 0139 hash-input definition.
 * Deterministic for the same inputs.
 */
export function computeSignatureHash(operation: string, signature: OperationSignature): string {
  const normalized = {
    type: signature.type,
    input: normalizeForHash(normalizeOperationIoSchema(signature.input)),
    output: normalizeForHash(normalizeOperationIoSchema(signature.output)),
  };
  const canonical = JSON.stringify(canonicalize({ operation, signature: normalized }));
  return `sha256v2:${createHash('sha256').update(canonical).digest('hex')}`;
}
