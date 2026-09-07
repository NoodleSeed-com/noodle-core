/**
 * The single Zod -> JSON Schema conversion seam for the authoring SDK (ADR 0139). Tools, prompts,
 * state handles, and connector operation signatures all convert through here so every emitted
 * shape follows the same dialect, `io` projection, and closed-object rules.
 */

import { z } from 'zod';

/** A JSON Schema 2020-12 document. */
export type JsonSchema = Record<string, unknown>;

/**
 * Emit a JSON Schema from a Zod schema (or pass a raw JSON Schema through). `io` selects Zod's
 * projection: `'output'` (the default) is the result/return shape, where a `ZodDefault` field is still
 * `required`; `'input'` is the call/argument shape, where `.default()`/`.optional()` fields correctly
 * drop out of `required` (so a supplied `default` is honoured, not contradicted). We emit tool/prompt
 * INPUT schemas with `io:'input'` so they match the prompt-argument path, which already treats
 * `.default()` as optional. Zod only forces `additionalProperties:false` under `io:'output'`, so for
 * `io:'input'` we re-assert it on every emitted object node to keep input objects closed.
 */
export function toJsonSchema(
  schema: JsonSchema | z.ZodType,
  io: 'input' | 'output' = 'output',
  rejectRuntimeChecks = false,
): JsonSchema {
  if (schema instanceof z.ZodType) {
    const json = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      io,
      ...(rejectRuntimeChecks
        ? {
            override: ({ zodSchema }) => {
              const definition = zodSchema._zod.def;
              if (
                definition.checks?.some((check) =>
                  ['custom', 'overwrite'].includes(check._zod.def.check),
                )
              ) {
                throw new Error(
                  'business variable schemas cannot contain runtime refinements or transforms',
                );
              }
            },
          }
        : {}),
    }) as JsonSchema;
    if (io === 'input') closeObjectSchemas(json);
    return json;
  }
  return schema;
}

// Subschema-bearing keywords `z.toJSONSchema` emits: maps of subschemas (values are schemas), single
// subschemas, and arrays of subschemas. Deliberately excludes value keywords (`default`/`const`/
// `examples`/`enum`) so a literal object *value* is never walked and mutated.
const SUBSCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs'] as const;
const SUBSCHEMA_KEYS = [
  'items',
  'additionalProperties',
  'propertyNames',
  'not',
  'contains',
] as const;
const SUBSCHEMA_LIST_KEYS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'] as const;

/**
 * Recursively set `additionalProperties:false` on every object node that does not already declare it,
 * restoring the closed-object shape Zod emits under `io:'output'` but drops under `io:'input'`. Only
 * fills the absent case, so an explicit `additionalProperties` (e.g. a passthrough/catchall) is
 * preserved. Recurses only through subschema-bearing keywords — never through value keywords like
 * `default`/`const`, so an object *value* held as a default is never mutated.
 */
function closeObjectSchemas(node: unknown): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  if (record.type === 'object' && !('additionalProperties' in record)) {
    record.additionalProperties = false;
  }
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = record[key];
    if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
      for (const value of Object.values(map)) closeObjectSchemas(value);
    }
  }
  for (const key of SUBSCHEMA_KEYS) closeObjectSchemas(record[key]);
  for (const key of SUBSCHEMA_LIST_KEYS) {
    const list = record[key];
    if (Array.isArray(list)) for (const value of list) closeObjectSchemas(value);
  }
}
