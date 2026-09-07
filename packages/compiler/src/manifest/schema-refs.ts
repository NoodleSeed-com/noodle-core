import type { JsonSchema } from '../artifact/types.js';
import type { CompileError } from '../errors.js';
import { suggestionFields } from '../suggest.js';
import { NAME_PATTERN } from './naming.js';

/** Map of reusable schema fragments declared in the manifest `schemas` block, keyed by name. */
export type SchemasMap = Readonly<Record<string, JsonSchema>>;

export interface ResolveSchemaResult {
  /** The schema with every `$use` rewritten to a local `$ref` and referenced definitions bundled. */
  readonly schema: JsonSchema;
  readonly errors: readonly CompileError[];
}

/**
 * Resolve `$use` references in an authored JSON Schema (docs/SPEC.md "Schemas").
 *
 * Every `{ $use: "<name>" }` node is rewritten to a local `{ $ref: "#/$defs/<name>" }`, and the
 * referenced definitions from `schemasMap` are bundled into the schema's `$defs` so each tool's
 * schema document stays self-contained. Resolution is transitive (a referenced schema may itself
 * use `$use`) and cycle-safe (definitions are bundled by `$ref`, never inlined). `$defs` keys are
 * sorted for deterministic output, and `$defs` is only attached when at least one `$use` was
 * resolved — so schemas without `$use` pass through byte-for-byte.
 *
 * `$use` must be the sole key of its object. External `$ref` rejection is handled downstream by the
 * caller on the resolved schema (so it also scans bundled definitions).
 */
export function resolveSchemaUses(
  schema: JsonSchema,
  schemasMap: SchemasMap,
  path: string,
): ResolveSchemaResult {
  const errors: CompileError[] = [];
  const usedAtRoot = new Set<string>();
  const rewrittenRoot = rewriteNode(schema, path, schemasMap, usedAtRoot, errors) as JsonSchema;

  // Transitively resolve every referenced definition, guarding against cycles with `visited`.
  const bundled: Record<string, JsonSchema> = {};
  const visited = new Set<string>();
  const queue = [...usedAtRoot];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);
    const definition = schemasMap[name];
    // `name` is only enqueued after rewriteNode confirmed it exists in schemasMap.
    if (definition === undefined) continue;
    const usedHere = new Set<string>();
    bundled[name] = rewriteNode(
      definition,
      `schemas.${name}`,
      schemasMap,
      usedHere,
      errors,
    ) as JsonSchema;
    for (const next of usedHere) if (!visited.has(next)) queue.push(next);
  }

  if (errors.length > 0) return { schema: rewrittenRoot, errors };
  // No `$use` anywhere: pass the (structurally identical) schema through untouched.
  if (visited.size === 0) return { schema: rewrittenRoot, errors };

  const mergedDefs = mergeDefs(rewrittenRoot, bundled, path, errors);
  if (errors.length > 0) return { schema: rewrittenRoot, errors };

  return { schema: withDefs(rewrittenRoot, mergedDefs), errors };
}

/**
 * Recursively rewrite `$use` nodes to local `$ref`s. Records each referenced name in `used` and
 * pushes a CompileError for malformed references. Returns a new value; never mutates the input.
 */
function rewriteNode(
  value: unknown,
  path: string,
  schemasMap: SchemasMap,
  used: Set<string>,
  errors: CompileError[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => rewriteNode(item, `${path}.${i}`, schemasMap, used, errors));
  }
  if (value === null || typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  if ('$use' in obj) {
    const refPath = `${path}.$use`;
    const target = obj.$use;
    if (Object.keys(obj).length !== 1) {
      errors.push({
        code: 'invalid_schema_ref',
        path: refPath,
        message: '$use must be the only key in its object',
      });
      return value;
    }
    if (typeof target !== 'string') {
      errors.push({
        code: 'invalid_schema_ref',
        path: refPath,
        message: '$use must reference a schema name as a string',
      });
      return value;
    }
    if (!NAME_PATTERN.test(target)) {
      errors.push({
        code: 'invalid_name',
        path: refPath,
        message: `$use target "${target}" must use lowercase letters, numbers, and underscores`,
      });
      return value;
    }
    if (!(target in schemasMap)) {
      errors.push({
        code: 'unknown_schema_ref',
        path: refPath,
        message: `$use references schema "${target}", which is not declared in "schemas"`,
        got: target,
        ...suggestionFields('unknown_schema_ref', target, Object.keys(schemasMap)),
      });
      return value;
    }
    used.add(target);
    return { $ref: `#/$defs/${target}` };
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = rewriteNode(val, `${path}.${key}`, schemasMap, used, errors);
  }
  return out;
}

/**
 * Merge bundled definitions into any tenant-authored `$defs`, sort the keys for determinism, and
 * reject a collision where an authored `$defs.<name>` differs from a bundled definition of the same
 * name.
 */
function mergeDefs(
  root: JsonSchema,
  bundled: Record<string, JsonSchema>,
  path: string,
  errors: CompileError[],
): Record<string, unknown> {
  const authored =
    root.$defs !== null && typeof root.$defs === 'object' && !Array.isArray(root.$defs)
      ? (root.$defs as Record<string, unknown>)
      : {};

  const merged: Record<string, unknown> = { ...authored };
  for (const [name, definition] of Object.entries(bundled)) {
    if (name in authored && JSON.stringify(authored[name]) !== JSON.stringify(definition)) {
      errors.push({
        code: 'schema_ref_conflict',
        path: `${path}.$defs.${name}`,
        message: `$use target "${name}" conflicts with an existing $defs entry of the same name`,
      });
      continue;
    }
    merged[name] = definition;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(merged).sort()) sorted[key] = merged[key];
  return sorted;
}

/** Return a copy of `root` with `$defs` set, replacing it in place or appending it at the end. */
function withDefs(root: JsonSchema, defs: Record<string, unknown>): JsonSchema {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, val] of Object.entries(root)) {
    if (key === '$defs') {
      out[key] = defs;
      placed = true;
    } else {
      out[key] = val;
    }
  }
  if (!placed) out.$defs = defs;
  return out;
}
