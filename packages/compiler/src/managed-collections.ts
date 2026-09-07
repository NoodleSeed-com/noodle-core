import { canonicalJson, sha256Canonical } from '@noodle-borg/app-package';
import { z } from 'zod';
import type { ArtifactManagedCollection, JsonSchema } from './artifact/types.js';
import type { CompileError } from './errors.js';

export const MAX_MANAGED_COLLECTIONS = 16;
export const MAX_MANAGED_COLLECTION_NAME_LENGTH = 64;
export const MAX_MANAGED_COLLECTION_TITLE_LENGTH = 120;
export const MAX_MANAGED_COLLECTION_DESCRIPTION_LENGTH = 1_000;
export const MAX_MANAGED_COLLECTION_SCHEMA_VERSION = 2_147_483_647;
export const MAX_MANAGED_COLLECTION_RECORD_SCHEMA_BYTES = 64 * 1024;
export const MAX_MANAGED_COLLECTION_RECORD_SCHEMA_DEPTH = 12;
export const MAX_MANAGED_COLLECTION_RECORD_FIELDS = 128;

const collectionNameSchema = z
  .string()
  .min(1)
  .max(MAX_MANAGED_COLLECTION_NAME_LENGTH)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'must start with a letter and use lowercase letters, numbers, and underscores',
  );

const jsonSchemaSchema = z.record(z.string(), z.unknown());

export const managedCollectionManifestSchema = z
  .object({
    name: collectionNameSchema,
    title: z.string().trim().min(1).max(MAX_MANAGED_COLLECTION_TITLE_LENGTH),
    description: z.string().trim().min(1).max(MAX_MANAGED_COLLECTION_DESCRIPTION_LENGTH),
    schemaVersion: z.number().int().positive().max(MAX_MANAGED_COLLECTION_SCHEMA_VERSION),
    recordSchema: jsonSchemaSchema,
  })
  .strict();

export type ManagedCollectionManifest = z.infer<typeof managedCollectionManifestSchema>;

const PROHIBITED_FIELD_NAME =
  /(?:card|cvv|cvc|password|passcode|token|secret|passport|governmentid|nationalid|socialsecurity|health|biometric)/i;
const SUBSCHEMA_MAP_KEYS = [
  'properties',
  'patternProperties',
  '$defs',
  'dependentSchemas',
] as const;
const SUBSCHEMA_KEYS = [
  'items',
  'additionalProperties',
  'propertyNames',
  'not',
  'contains',
  'if',
  'then',
  'else',
] as const;
const SUBSCHEMA_LIST_KEYS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'] as const;

/**
 * Validate and lower reusable collection intent. Operator lifecycle, grants, residency, and
 * retention deliberately do not enter this compiled definition.
 */
export function compileManagedCollections(
  collections: readonly ManagedCollectionManifest[],
  toolNames: readonly string[],
  errors: CompileError[],
): readonly ArtifactManagedCollection[] {
  const compiled: ArtifactManagedCollection[] = [];
  const seen = new Set<string>();

  collections.forEach((collection, index) => {
    const path = `server.collections.${index}`;
    if (seen.has(collection.name)) {
      errors.push({
        code: 'invalid_managed_collection',
        path: `${path}.name`,
        message: `duplicate managed collection name "${collection.name}"`,
      });
      return;
    }
    seen.add(collection.name);

    const futureToolName = `submit_${collection.name}`;
    const collision = toolNames.indexOf(futureToolName);
    if (collision >= 0) {
      errors.push({
        code: 'reserved_name',
        path: `tools.${collision}.name`,
        message: `tool name "${futureToolName}" is reserved for managed collection "${collection.name}"`,
      });
    }

    const schemaErrorsBefore = errors.length;
    validateRecordSchema(collection.recordSchema, `${path}.recordSchema`, errors);
    if (errors.length !== schemaErrorsBefore) return;

    compiled.push({
      name: collection.name,
      title: collection.title,
      description: collection.description,
      schemaVersion: collection.schemaVersion,
      schemaDigest: sha256Canonical(collection.recordSchema),
      recordSchema: collection.recordSchema,
    });
  });

  return compiled;
}

function validateRecordSchema(schema: JsonSchema, path: string, errors: CompileError[]): void {
  const bytes = new TextEncoder().encode(canonicalJson(schema)).byteLength;
  if (bytes > MAX_MANAGED_COLLECTION_RECORD_SCHEMA_BYTES) {
    errors.push({
      code: 'invalid_managed_collection',
      path,
      message: `record schema is ${bytes} UTF-8 bytes; the limit is ${MAX_MANAGED_COLLECTION_RECORD_SCHEMA_BYTES} bytes`,
    });
    return;
  }
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    errors.push({
      code: 'invalid_managed_collection',
      path,
      message: 'record schema must be a closed object with additionalProperties false',
    });
    return;
  }

  const state = { fields: 0, failure: undefined as CompileError | undefined };
  inspectSchema(schema, path, 1, state);
  if (state.failure !== undefined) errors.push(state.failure);
}

function inspectSchema(
  node: unknown,
  path: string,
  depth: number,
  state: { fields: number; failure: CompileError | undefined },
): void {
  if (
    state.failure !== undefined ||
    node === null ||
    typeof node !== 'object' ||
    Array.isArray(node)
  ) {
    return;
  }
  if (depth > MAX_MANAGED_COLLECTION_RECORD_SCHEMA_DEPTH) {
    state.failure = {
      code: 'invalid_managed_collection',
      path,
      message: `record schema depth exceeds ${MAX_MANAGED_COLLECTION_RECORD_SCHEMA_DEPTH}`,
    };
    return;
  }

  const schema = node as Record<string, unknown>;
  if (schema.type === 'object' && schema.additionalProperties !== false) {
    state.failure = {
      code: 'invalid_managed_collection',
      path,
      message: 'every record object must set additionalProperties to false',
    };
    return;
  }

  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      state.fields += 1;
      if (state.fields > MAX_MANAGED_COLLECTION_RECORD_FIELDS) {
        state.failure = {
          code: 'invalid_managed_collection',
          path,
          message: `record schema declares more than ${MAX_MANAGED_COLLECTION_RECORD_FIELDS} fields`,
        };
        return;
      }
      if (PROHIBITED_FIELD_NAME.test(name.replace(/[^a-z0-9]/giu, ''))) {
        state.failure = {
          code: 'invalid_managed_collection',
          path: `${path}.properties.${name}`,
          message: 'managed collection record schemas cannot declare prohibited sensitive fields',
        };
        return;
      }
      inspectSchema(child, `${path}.properties.${name}`, depth + 1, state);
    }
  }

  for (const key of SUBSCHEMA_MAP_KEYS) {
    if (key === 'properties') continue;
    const map = schema[key];
    if (!isRecord(map)) continue;
    for (const [name, child] of Object.entries(map)) {
      inspectSchema(child, `${path}.${key}.${name}`, depth + 1, state);
    }
  }
  for (const key of SUBSCHEMA_KEYS) {
    const child = schema[key];
    if (child !== undefined && typeof child !== 'boolean') {
      inspectSchema(child, `${path}.${key}`, depth + 1, state);
    }
  }
  for (const key of SUBSCHEMA_LIST_KEYS) {
    const children = schema[key];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      inspectSchema(child, `${path}.${key}.${index}`, depth + 1, state);
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
