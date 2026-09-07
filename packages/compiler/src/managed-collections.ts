import { canonicalJson, sha256Canonical } from '@noodle-borg/app-package';
import { z } from 'zod';
import type { ArtifactManagedCollection, JsonSchema, OperationRef } from './artifact/types.js';
import { computeSignatureHash } from './catalog/signature.js';
import type { ConnectorCatalog, OperationSignature } from './catalog/types.js';
import type { CompileError } from './errors.js';
import { computeConnectionConfigRevision, type DeclaredConnectorRef } from './fulfilment-emit.js';
import {
  managedCollectionControlFields,
  projectManagedCollectionControls,
  validateManagedCollectionControls,
} from './managed-collection-controls.js';

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
const sourceSchema = z
  .object({
    connector: collectionNameSchema,
    scan: collectionNameSchema,
  })
  .strict();

export const managedCollectionManifestSchema = z
  .object({
    name: collectionNameSchema,
    title: z.string().trim().min(1).max(MAX_MANAGED_COLLECTION_TITLE_LENGTH),
    description: z.string().trim().min(1).max(MAX_MANAGED_COLLECTION_DESCRIPTION_LENGTH),
    schemaVersion: z.number().int().positive().max(MAX_MANAGED_COLLECTION_SCHEMA_VERSION),
    recordSchema: jsonSchemaSchema,
    behavior: z
      .object({ kind: z.literal('request') })
      .strict()
      .optional(),
    source: sourceSchema.optional(),
    ...managedCollectionControlFields,
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
  options: {
    readonly catalog?: ConnectorCatalog;
    readonly declared?: Readonly<Record<string, DeclaredConnectorRef>>;
  } = {},
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
    validateManagedCollectionControls(
      projectManagedCollectionControls(collection),
      collection.recordSchema,
      collection.source !== undefined,
      path,
      errors,
    );
    if (errors.length !== schemaErrorsBefore) return;

    const source = compileCollectionSource(collection, path, errors, options);
    if (collection.source !== undefined && source === undefined) return;
    compiled.push({
      name: collection.name,
      title: collection.title,
      description: collection.description,
      schemaVersion: collection.schemaVersion,
      schemaDigest: sha256Canonical(collection.recordSchema),
      recordSchema: collection.recordSchema,
      ...projectManagedCollectionControls(collection),
      ...(collection.behavior === undefined ? {} : { behavior: collection.behavior }),
      source: source ?? { authority: 'native' },
    });
  });

  return compiled;
}

function compileCollectionSource(
  collection: ManagedCollectionManifest,
  path: string,
  errors: CompileError[],
  options: {
    readonly catalog?: ConnectorCatalog;
    readonly declared?: Readonly<Record<string, DeclaredConnectorRef>>;
  },
): ArtifactManagedCollection['source'] | undefined {
  if (collection.source === undefined) return { authority: 'native' };
  const declared = options.declared?.[collection.source.connector];
  if (declared === undefined) {
    sourceError(
      errors,
      `${path}.source.connector`,
      `connector alias "${collection.source.connector}" is not declared`,
    );
    return undefined;
  }
  if (declared.binding === undefined) {
    sourceError(
      errors,
      `${path}.source.connector`,
      'external collection sources require an operator-bound connector',
    );
    return undefined;
  }

  const connector = options.catalog?.get(declared.id, declared.version);
  if (options.catalog !== undefined && connector === undefined) {
    sourceError(
      errors,
      `${path}.source.connector`,
      `connector "${declared.id}" version "${declared.version}" is not in the catalog`,
    );
    return undefined;
  }
  const scan = resolveSourceOperation({
    alias: collection.source.connector,
    name: collection.source.scan,
    connector,
    declared,
    recordSchema: collection.recordSchema,
    path: `${path}.source.scan`,
    errors,
  });
  if (scan === undefined) return undefined;
  return {
    authority: 'external',
    connectorAlias: collection.source.connector,
    connectorId: declared.id,
    connectorVersion: declared.version,
    scan,
  };
}

function resolveSourceOperation(input: {
  alias: string;
  name: string;
  connector: ReturnType<ConnectorCatalog['get']>;
  declared: DeclaredConnectorRef;
  recordSchema: JsonSchema;
  path: string;
  errors: CompileError[];
}): OperationRef | undefined {
  if (input.connector === undefined) {
    return { resolved: false, connector: input.alias, operation: input.name };
  }
  const operation = input.connector.operations[input.name];
  if (operation === undefined) {
    sourceError(
      input.errors,
      input.path,
      `operation "${input.name}" does not exist on connector "${input.connector.id}"`,
    );
    return undefined;
  }
  if (operation.type !== 'read') {
    sourceError(
      input.errors,
      input.path,
      `source operation "${input.name}" must be classified as read`,
    );
    return undefined;
  }
  const contractError = validateScanSignature(operation, input.recordSchema);
  if (contractError !== undefined) {
    sourceError(input.errors, input.path, contractError);
    return undefined;
  }
  const binding = input.declared.binding;
  const credentialPresentation =
    binding === undefined ? undefined : input.connector.credentialProfiles?.[binding.profile];
  if (binding === undefined || credentialPresentation === undefined) {
    sourceError(
      input.errors,
      input.path,
      `source operation "${input.name}" requires a valid bound credential profile`,
    );
    return undefined;
  }
  const credentialRequirement = input.connector.operationCredentials?.[input.name];
  if (
    credentialRequirement !== undefined &&
    !credentialRequirement.profiles.includes(binding.profile)
  ) {
    sourceError(
      input.errors,
      input.path,
      `source operation "${input.name}" does not permit credential profile "${binding.profile}"`,
    );
    return undefined;
  }
  return {
    resolved: true,
    alias: input.alias,
    connectorId: input.declared.id,
    connectorVersion: input.declared.version,
    operation: input.name,
    signatureHash: computeSignatureHash(input.name, operation),
    credentialBinding: {
      bindingId: input.alias,
      connectionId: binding.connection.id,
      connectionConfigRevision: computeConnectionConfigRevision(binding.connection),
      profile: binding.profile,
      presentation: credentialPresentation,
      requiredScopes: [...(credentialRequirement?.scopes ?? [])],
      ...(credentialRequirement?.audience === undefined
        ? {}
        : { requiredAudience: credentialRequirement.audience }),
    },
  };
}

function validateScanSignature(
  operation: OperationSignature,
  recordSchema: JsonSchema,
): string | undefined {
  const input = operation.input;
  if (!isClosedObjectWithKeys(input, ['mode', 'cursor', 'checkpoint', 'limit'])) {
    return 'scan input must be a closed object containing only mode, cursor, checkpoint and limit';
  }
  const inputProperties = input.properties as Record<string, JsonSchema>;
  if (
    !hasTypes(inputProperties, {
      mode: 'string',
      cursor: 'string',
      checkpoint: 'string',
      limit: 'integer',
    })
  ) {
    return 'scan input fields do not match the normalized source contract';
  }
  if (!sameStrings(input.required, ['mode', 'limit']))
    return 'scan input must require mode and limit only';
  const modeEnum = inputProperties.mode?.enum;
  if (!sameStrings(modeEnum, ['snapshot', 'changes']))
    return 'scan mode must allow snapshot and changes';

  const output = operation.output;
  if (
    !isClosedObjectWithKeys(output, [
      'records',
      'deletedIds',
      'nextCursor',
      'checkpoint',
      'complete',
      'resetRequired',
    ])
  ) {
    return 'scan output must match the normalized source page envelope';
  }
  if (!sameStrings(output.required, ['records', 'deletedIds', 'complete'])) {
    return 'scan output must require records, deletedIds and complete only';
  }
  const properties = output.properties as Record<string, JsonSchema>;
  if (
    !hasTypes(properties, {
      records: 'array',
      deletedIds: 'array',
      nextCursor: 'string',
      checkpoint: 'string',
      complete: 'boolean',
      resetRequired: 'boolean',
    })
  ) {
    return 'scan output fields do not match the normalized source page contract';
  }
  const item = properties.records?.items;
  if (!isRecord(item) || !isClosedObjectWithKeys(item, ['id', 'version', 'record'])) {
    return 'scan records must contain closed id, optional version and record objects';
  }
  if (!sameStrings(item.required, ['id', 'record']))
    return 'scan records must require id and record only';
  const itemProperties = item.properties as Record<string, JsonSchema>;
  if (itemProperties.id?.type !== 'string' || itemProperties.version?.type !== 'string') {
    return 'scan record id and version must be strings';
  }
  if (sha256Canonical(itemProperties.record) !== sha256Canonical(recordSchema)) {
    return 'scan record schema must exactly match the managed collection record schema';
  }
  const deletedItems = properties.deletedIds?.items;
  if (!isRecord(deletedItems) || deletedItems.type !== 'string')
    return 'deletedIds must be an array of strings';
  return undefined;
}

function isClosedObjectWithKeys(value: unknown, keys: readonly string[]): value is JsonSchema {
  if (
    !isRecord(value) ||
    value.type !== 'object' ||
    value.additionalProperties !== false ||
    !isRecord(value.properties)
  )
    return false;
  return sameStrings(Object.keys(value.properties), keys);
}

function hasTypes(
  properties: Record<string, JsonSchema>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([key, type]) => properties[key]?.type === type);
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    [...value].sort().join('\u0000') === [...expected].sort().join('\u0000')
  );
}

function sourceError(errors: CompileError[], path: string, message: string): void {
  errors.push({ code: 'invalid_managed_collection_source', path, message });
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
