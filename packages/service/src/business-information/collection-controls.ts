import { validateJsonSchemaWithDefaults } from '@noodle-borg/compiler';
import type { InstalledCollectionDefinition, JsonObject } from './contracts.js';
import { PayloadValidationError, validateManagedPayload } from './validation.js';

export function collectionControlEnabled(
  collection: InstalledCollectionDefinition,
  control: 'assignment' | 'notes',
): boolean {
  if (collection.authority.authority !== 'native') return false;
  if (collection.management !== undefined) return collection.management[control] === true;
  return collection.behavior?.kind === 'request';
}

export function collectionPublicFields(
  collection: InstalledCollectionDefinition,
): readonly string[] {
  return (
    collection.publicFields ??
    (collection.behavior?.kind === 'request' ? Object.keys(recordProperties(collection)) : [])
  );
}

export function creationPayload(
  collection: InstalledCollectionDefinition,
  value: unknown,
  publicInput: boolean,
): JsonObject {
  const payload = validateManagedPayload(value);
  if (publicInput) assertFields(payload, collectionPublicFields(collection), 'public');
  const defaulted = validateJsonSchemaWithDefaults(collection.recordSchema, payload);
  if (defaulted.issues.length > 0)
    throw new PayloadValidationError(
      'invalid_json',
      'managed payload does not match collection schema',
    );
  return validateManagedPayload(defaulted.value);
}

export function patchedPayload(
  collection: InstalledCollectionDefinition,
  current: JsonObject,
  patch: unknown,
  unset: readonly string[] = [],
): JsonObject {
  const admitted = validateManagedPayload(patch);
  if (
    !Array.isArray(unset) ||
    unset.length > 128 ||
    new Set(unset).size !== unset.length ||
    unset.some(
      (name) =>
        typeof name !== 'string' ||
        name.length < 1 ||
        name.length > 64 ||
        Object.hasOwn(admitted, name) ||
        (Array.isArray(collection.recordSchema.required) &&
          collection.recordSchema.required.includes(name)),
    )
  )
    throw new PayloadValidationError(
      'invalid_json',
      'Removal keys must be unique optional fields outside the patch.',
    );
  assertFields(
    { ...admitted, ...Object.fromEntries(unset.map((name) => [name, null])) },
    collection.editableFields ?? Object.keys(recordProperties(collection)),
    'editable',
  );
  const result = { ...current, ...admitted };
  for (const name of unset) delete result[name];
  return validateManagedPayload(result);
}

function assertFields(payload: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(payload).some((name) => !allowed.includes(name)))
    throw new PayloadValidationError(
      'prohibited_field',
      `managed payload includes a field outside the ${label} field set`,
    );
}

function recordProperties(collection: InstalledCollectionDefinition): JsonObject {
  const properties = collection.recordSchema.properties;
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as JsonObject)
    : {};
}
