import {
  canonicalJson,
  sensitiveContentFinding,
  sha256Canonical,
  validateJsonSchema,
} from '@noodle-borg/app-package';
import { z } from 'zod';
import type { CompileError } from './errors.js';

export const MAX_VARIABLE_DECLARATIONS = 64;
export const MAX_VARIABLE_SCHEMA_BYTES = 16 * 1024;
export const MAX_VARIABLE_VALUE_BYTES = 16 * 1024;
export const MAX_VARIABLE_SCHEMA_DEPTH = 6;

const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^<>\p{Cc}]+$/u, 'must be plain text without markup or control characters');
export const variableDeclarationManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_]+$/),
    schemaVersion: z.literal(1),
    valueSchema: z.record(z.string(), z.unknown()),
    default: z.unknown().optional(),
    portal: z
      .object({
        label: plainText(120),
        help: plainText(1000).optional(),
        group: plainText(80).optional(),
      })
      .strict()
      .optional(),
    requiredFor: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(128),
  })
  .strict();

export type VariableDeclarationManifest = z.infer<typeof variableDeclarationManifestSchema>;
export interface ArtifactVariableDeclaration extends VariableDeclarationManifest {
  /** Hash of the complete declaration; metadata, default and capability changes are revision-visible. */
  readonly schemaDigest: string;
}

/** The one declaration validator used by TypeScript authoring, compilation and activation. */
export function validateVariableDeclaration(
  declaration: VariableDeclarationManifest,
): readonly CompileError[] {
  const errors: CompileError[] = [];
  const parsed = variableDeclarationManifestSchema.safeParse(declaration);
  if (!parsed.success)
    return [
      {
        code: 'invalid_variable_declaration',
        path: '',
        message: 'invalid variable declaration metadata or version',
      },
    ];
  const fail = (path: string, message: string) =>
    errors.push({ code: 'invalid_variable_declaration', path, message });
  if (!isBoundedJson(declaration.valueSchema, MAX_VARIABLE_SCHEMA_BYTES)) {
    fail('valueSchema', 'value schema must be bounded JSON');
    return errors;
  }
  validateValueSchema(declaration.valueSchema, 'valueSchema', 0, { fields: 0 }, fail);
  if (errors.length > 0) return errors;
  const schemaIssues = validateJsonSchema(declaration.valueSchema, undefined);
  if (schemaIssues.some((issue) => issue.keyword === 'schema'))
    fail('valueSchema', 'invalid JSON Schema');
  if (Object.hasOwn(declaration, 'default')) {
    if (!isBoundedJson(declaration.default, MAX_VARIABLE_VALUE_BYTES))
      fail('default', 'default must be bounded JSON');
    else if (validateJsonSchema(declaration.valueSchema, declaration.default).length > 0)
      fail('default', 'default does not match the declared value schema');
  }
  if (
    sensitiveContentFinding({ portal: declaration.portal, default: declaration.default }) !==
    undefined
  ) {
    fail('', 'variable metadata/default must not contain credentials');
  }
  return errors;
}

export function compileVariableDeclarations(
  declarations: readonly VariableDeclarationManifest[],
  toolNames: readonly string[],
  errors: CompileError[],
): readonly ArtifactVariableDeclaration[] {
  const seen = new Map<string, ArtifactVariableDeclaration>();
  for (const [index, declaration] of declarations.entries()) {
    const path = `server.variables.${index}`;
    const issues = validateVariableDeclaration(declaration);
    if (issues.length > 0) {
      errors.push(
        ...issues.map((issue) => ({ ...issue, path: issue.path ? `${path}.${issue.path}` : path })),
      );
      continue;
    }
    const normalized = {
      ...declaration,
      requiredFor: [...new Set(declaration.requiredFor)].sort(),
    };
    const schemaDigest = sha256Canonical(normalized);
    const previous = seen.get(declaration.name);
    if (previous !== undefined && previous.schemaDigest !== schemaDigest) {
      errors.push({
        code: 'invalid_variable_declaration',
        path,
        message: 'conflicting duplicate variable declaration',
      });
      continue;
    }
    for (const name of normalized.requiredFor) {
      if (!toolNames.includes(name))
        errors.push({
          code: 'invalid_variable_declaration',
          path: `${path}.requiredFor`,
          message: `required capability "${name}" is not a declared tool`,
        });
    }
    seen.set(declaration.name, { ...normalized, schemaDigest });
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

type Fail = (path: string, message: string) => void;
const commonKeys = ['$schema', 'type', 'title', 'description'] as const;
const typeKeys: Readonly<Record<string, readonly string[]>> = {
  string: ['minLength', 'maxLength', 'enum', 'format'],
  boolean: [],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  integer: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'],
  array: ['items', 'minItems', 'maxItems', 'uniqueItems'],
  object: ['properties', 'required', 'additionalProperties'],
};
function validateValueSchema(
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  count: { fields: number },
  fail: Fail,
): void {
  if (depth > MAX_VARIABLE_SCHEMA_DEPTH) {
    fail(path, 'value schema exceeds maximum nesting depth');
    return;
  }
  const type = schema.type;
  if (typeof type !== 'string' || !Object.hasOwn(typeKeys, type)) {
    fail(path, 'unsupported setting value type');
    return;
  }
  const allowed = new Set<string>([...commonKeys, ...(typeKeys[type] ?? [])]);
  for (const key of Object.keys(schema))
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unsupported setting schema keyword');
  for (const key of ['title', 'description']) {
    if (schema[key] !== undefined && !plainText(1000).safeParse(schema[key]).success)
      fail(`${path}.${key}`, 'schema metadata must be bounded plain text');
  }
  if (
    schema.$schema !== undefined &&
    schema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
  )
    fail(`${path}.$schema`, 'unsupported JSON Schema dialect');
  if (type === 'string') validateStringSchema(schema, path, fail);
  if (type === 'number' || type === 'integer') {
    if (
      !finiteBound(schema.minimum ?? schema.exclusiveMinimum) ||
      !finiteBound(schema.maximum ?? schema.exclusiveMaximum)
    )
      fail(path, 'numbers require finite minimum and maximum');
    const lower = schema.minimum ?? schema.exclusiveMinimum;
    const upper = schema.maximum ?? schema.exclusiveMaximum;
    if (
      typeof lower === 'number' &&
      typeof upper === 'number' &&
      (lower > upper ||
        (lower === upper &&
          (schema.exclusiveMinimum !== undefined || schema.exclusiveMaximum !== undefined)))
    )
      fail(path, 'numeric bounds must permit at least one value');
  }
  if (type === 'array') {
    if (!boundedCount(schema.maxItems, 100))
      fail(`${path}.maxItems`, 'arrays require maxItems between 0 and 100');
    if (
      typeof schema.minItems === 'number' &&
      typeof schema.maxItems === 'number' &&
      schema.minItems > schema.maxItems
    )
      fail(path, 'array bounds must permit at least one value');
    if (!isObject(schema.items)) fail(`${path}.items`, 'arrays require one item schema');
    else validateValueSchema(schema.items, `${path}.items`, depth + 1, count, fail);
  }
  if (type === 'object') {
    if (schema.additionalProperties !== false)
      fail(`${path}.additionalProperties`, 'objects must be closed');
    if (!isObject(schema.properties)) {
      fail(`${path}.properties`, 'objects require explicit properties');
      return;
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      count.fields++;
      if (count.fields > 128) {
        fail(path, 'value schema exceeds 128 total properties');
        return;
      }
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        ['__proto__', 'prototype', 'constructor'].includes(key)
      )
        fail(`${path}.properties`, 'unsafe property name');
      if (!isObject(child)) fail(`${path}.properties.${key}`, 'property requires a value schema');
      else validateValueSchema(child, `${path}.properties.${key}`, depth + 1, count, fail);
    }
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (key) => typeof key !== 'string' || !Object.hasOwn(schema.properties as object, key),
        ))
    )
      fail(`${path}.required`, 'required must name declared properties');
  }
}
function validateStringSchema(schema: Record<string, unknown>, path: string, fail: Fail): void {
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.length > 100 ||
      schema.enum.some(
        (item) => typeof item !== 'string' || item.length > 200 || /[\p{Cc}<>]/u.test(item),
      )
    )
      fail(`${path}.enum`, 'enums require 1 to 100 bounded plain string choices');
  } else if (!boundedCount(schema.maxLength, 4096))
    fail(`${path}.maxLength`, 'strings require maxLength between 0 and 4096');
  if (
    schema.format !== undefined &&
    !['email', 'date', 'date-time', 'time', 'uuid'].includes(String(schema.format))
  )
    fail(`${path}.format`, 'unsupported setting string format');
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function boundedCount(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}
function finiteBound(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
  );
}
function isBoundedJson(value: unknown, maxBytes: number): boolean {
  try {
    const rejectUndefined = (node: unknown, depth: number): boolean => {
      if (node === undefined || depth > 16) return false;
      if (Array.isArray(node))
        return Array.from(node).every((child) => rejectUndefined(child, depth + 1));
      if (node !== null && typeof node === 'object')
        return Object.values(node).every((child) => rejectUndefined(child, depth + 1));
      return true;
    };
    return rejectUndefined(value, 0) && Buffer.byteLength(canonicalJson(value)) <= maxBytes;
  } catch {
    return false;
  }
}
