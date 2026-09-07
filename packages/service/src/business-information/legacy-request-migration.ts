import { canonicalJson, validateJsonSchema } from '@noodle-borg/compiler';
import type {
  InstalledCollectionDefinition,
  ManagedRequestRecord,
  SolutionInstallation,
} from './contracts.js';
import { validateManagedPayload, validateScalar } from './validation.js';

/** Exact, bounded historical request-bundle conversion; not a generic workflow/status alias. */
export function isLegacyRequestUpgrade(
  previous: InstalledCollectionDefinition,
  next: InstalledCollectionDefinition,
): boolean {
  const properties = next.recordSchema.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties))
    return false;
  const status = (properties as Record<string, unknown>).status;
  if (status === null || typeof status !== 'object' || Array.isArray(status)) return false;
  const oldProperties = previous.recordSchema.properties;
  return (
    previous.behavior?.kind === 'request' &&
    next.behavior === undefined &&
    next.management?.assignment === true &&
    next.management.notes === true &&
    oldProperties !== null &&
    typeof oldProperties === 'object' &&
    !Array.isArray(oldProperties) &&
    !Object.hasOwn(oldProperties, 'status') &&
    (status as Record<string, unknown>).type === 'string' &&
    (status as Record<string, unknown>).default === 'new' &&
    canonicalJson((status as Record<string, unknown>).enum) ===
      canonicalJson(['new', 'in_progress', 'resolved', 'closed']) &&
    !next.publicFields?.includes('status') &&
    Object.keys(oldProperties).every((field) => next.publicFields?.includes(field))
  );
}

export function migrateLegacyRequestRecord(
  current: ManagedRequestRecord,
  previous: InstalledCollectionDefinition,
  installation: SolutionInstallation,
  actorSubject: string,
  now: Date,
): ManagedRequestRecord | undefined {
  if (current.deletedAt !== undefined || current.content === undefined) return undefined;
  const next = installation.definition.collections.find(
    (collection) => collection.key === current.collectionKey,
  );
  if (
    next === undefined ||
    next.authority.authority !== 'native' ||
    previous.authority.authority !== 'native'
  )
    return undefined;
  if (current.status === undefined) return current;
  if (!isLegacyRequestUpgrade(previous, next)) return undefined;
  const payload = validateManagedPayload({ ...current.content.payload, status: current.status });
  if (validateJsonSchema(next.recordSchema, payload).length > 0) return undefined;
  const { status: ignoredStatus, ...record } = current;
  void ignoredStatus;
  return {
    ...record,
    profileVersion: installation.profileVersion,
    schemaVersion: next.schemaVersion,
    schemaDigest: next.schemaDigest,
    originalSchema: current.originalSchema ?? {
      profileVersion: current.profileVersion,
      schemaVersion: current.schemaVersion,
      schemaDigest: current.schemaDigest,
    },
    revision: current.revision + 1,
    updatedAt: now.toISOString(),
    updatedBySubject: validateScalar('migration actor', actorSubject, 256),
    content: { payload, notes: structuredClone(current.content.notes) },
  };
}
