import { createHash } from 'node:crypto';
import {
  projectManagedCollectionControls,
  validateJsonSchema,
  validateManagedCollectionControls,
} from '@noodle-borg/compiler';
import {
  collectionControlEnabled,
  creationPayload,
  patchedPayload,
} from './collection-controls.js';
import type {
  BusinessGrant,
  BusinessPermission,
  BusinessRole,
  InstallationScope,
  InstalledCollectionDefinition,
  ManagedRequestActivity,
  ManagedRequestContent,
  ManagedRequestOperation,
  ManagedRequestRecord,
  ManagedRequestStatus,
  SolutionDefinitionSnapshot,
  SolutionInstallation,
} from './contracts.js';
import {
  collectionForStoredRecord,
  type ManagedDefinitionResolver,
  resolveManagedInstallation,
} from './managed-releases.js';
import { builtInDefinition } from './profiles.js';
import {
  PayloadValidationError,
  validateEmail,
  validateManagedPayload,
  validateRetentionDays,
  validateRevision,
  validateScalar,
  validateScope,
} from './validation.js';

const ROLE_PERMISSIONS: Readonly<Record<BusinessRole, readonly BusinessPermission[]>> = {
  administrator: [
    'installation:administer',
    'grants:manage',
    'records:create',
    'records:read',
    'records:update',
    'records:assign',
    'records:status',
    'records:note',
    'records:delete',
    'records:export',
  ],
  manager: [
    'records:create',
    'records:read',
    'records:update',
    'records:assign',
    'records:status',
    'records:note',
    'records:export',
  ],
  operator: [
    'records:create',
    'records:read',
    'records:update',
    'records:assign',
    'records:status',
    'records:note',
  ],
  viewer: ['records:read'],
};

export function permissionsForBusinessRole(role: BusinessRole): readonly BusinessPermission[] {
  const permissions = ROLE_PERMISSIONS[role];
  if (permissions === undefined) throw new Error(`unknown business role "${String(role)}"`);
  return permissions;
}

export function businessGrantAllows(
  grant: BusinessGrant | undefined,
  permission: BusinessPermission,
): boolean {
  return (
    grant !== undefined &&
    grant.revokedAt === undefined &&
    permissionsForBusinessRole(grant.role).includes(permission)
  );
}

export function normalizeInstallationInput(input: {
  scope: InstallationScope;
  profileKey?: SolutionInstallation['profileKey'];
  definition?: SolutionDefinitionSnapshot;
  managedCollections: readonly string[];
  retentionDays?: number;
  actorSubject: string;
  actorEmail?: string;
}): {
  scope: InstallationScope;
  profileKey: SolutionInstallation['profileKey'];
  profileVersion: number;
  definition: SolutionDefinitionSnapshot;
  managedCollections: readonly string[];
  retentionDays: 7 | 30 | 90;
  actorSubject: string;
  actorEmail?: string;
} {
  const scope = { ...validateScope(input.scope) };
  if ((input.profileKey === undefined) === (input.definition === undefined)) {
    throw new Error('installation requires exactly one managed profile or private definition');
  }
  const definition =
    input.definition ??
    builtInDefinition(input.profileKey as Parameters<typeof builtInDefinition>[0]);
  validateDefinition(definition);
  const managedCollections = [...new Set(input.managedCollections)].sort();
  for (const collectionKey of managedCollections) {
    if (!definition.collections.some((collection) => collection.key === collectionKey)) {
      throw new Error(`collection "${collectionKey}" is not declared by the installed definition`);
    }
  }
  const profileKey =
    input.profileKey ??
    (definition.reference.kind === 'private'
      ? definition.reference.app
      : definition.reference.definitionId);
  const profileVersion =
    definition.reference.kind === 'private'
      ? parseDefinitionVersion(definition.reference.version)
      : definition.reference.release;
  return {
    scope,
    profileKey,
    profileVersion,
    definition: structuredClone(definition),
    managedCollections,
    retentionDays: validateRetentionDays(input.retentionDays),
    actorSubject: validateScalar('actor subject', input.actorSubject, 256),
    ...(input.actorEmail === undefined ? {} : { actorEmail: validateEmail(input.actorEmail) }),
  };
}

export function installationFingerprint(
  input: ReturnType<typeof normalizeInstallationInput>,
): string {
  const definitionIntent =
    input.definition.reference.kind === 'managed'
      ? { managedDefinitionId: input.definition.reference.definitionId }
      : { profileVersion: input.profileVersion, definition: input.definition };
  return digest({
    scope: input.scope,
    profileKey: input.profileKey,
    ...definitionIntent,
    managedCollections: input.managedCollections,
    retentionDays: input.retentionDays,
    actorSubject: input.actorSubject,
    ...(input.definition.reference.kind === 'managed' ? {} : { actorEmail: input.actorEmail }),
  });
}

/** Compatibility for rows whose pre-update fingerprint included the resolved managed release. */
export function managedInstallationIntentMatches(
  existing: SolutionInstallation,
  input: ReturnType<typeof normalizeInstallationInput>,
): boolean {
  const existingReference = existing.definition.reference;
  const inputReference = input.definition.reference;
  return (
    existingReference.kind === 'managed' &&
    inputReference.kind === 'managed' &&
    existingReference.definitionId === inputReference.definitionId &&
    digest(existing.scope) === digest(input.scope) &&
    existing.profileKey === input.profileKey &&
    digest([...existing.managedCollections].sort()) === digest(input.managedCollections) &&
    existing.retentionDays === input.retentionDays &&
    existing.createdBySubject === input.actorSubject
  );
}

export function requestFingerprint(input: {
  collectionKey: string;
  payload: unknown;
  origin: ManagedRequestRecord['origin'];
  actorSubject: string;
}): string {
  return digest(input);
}

export function idempotencyDigest(value: string): string {
  return digest(validateScalar('idempotency key', value, 128));
}

export function validateCollectionEnabled(
  installation: SolutionInstallation,
  collectionKey: string,
): InstalledCollectionDefinition {
  const normalized = validateScalar('collection key', collectionKey, 64);
  if (!installation.managedCollections.includes(normalized)) {
    throw new Error(`managed collection "${normalized}" is not enabled for this installation`);
  }
  const collection = installation.definition.collections.find(
    (candidate) => candidate.key === normalized,
  );
  if (collection === undefined)
    throw new Error(`managed collection "${normalized}" is missing from the installed definition`);
  return collection;
}

export function initialRecord(input: {
  publicInput?: true;
  installation: SolutionInstallation;
  collectionKey: string;
  id: string;
  payload: unknown;
  origin: ManagedRequestRecord['origin'];
  actorSubject: string;
  now: Date;
}): ManagedRequestRecord {
  const collection = validateCollectionEnabled(input.installation, input.collectionKey);
  if (collection.authority.authority !== 'native') {
    throw new Error(
      `managed collection "${collection.key}" is externally authoritative and read-only`,
    );
  }
  const payload = creationPayload(
    collection,
    input.payload,
    input.publicInput === true || input.origin.kind === 'embedded',
  );
  const actor = validateScalar('actor subject', input.actorSubject, 256);
  const id = validateScalar('record id', input.id, 128);
  const createdAt = input.now.toISOString();
  return {
    scope: { ...input.installation.scope },
    collectionKey: collection.key,
    id,
    profileKey: input.installation.profileKey,
    profileVersion: input.installation.profileVersion,
    schemaVersion: collection.schemaVersion,
    schemaDigest: collection.schemaDigest,
    ...(collection.behavior?.kind === 'request' ? { status: 'new' as const } : {}),
    origin: normalizeOrigin(input.origin),
    revision: 1,
    retentionExpiresAt: new Date(
      input.now.getTime() + input.installation.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString(),
    createdAt,
    createdBySubject: actor,
    updatedAt: createdAt,
    updatedBySubject: actor,
    content: { payload, notes: [] },
  };
}

export function applyRequestOperation(
  current: ManagedRequestRecord,
  collection: InstalledCollectionDefinition,
  operation: ManagedRequestOperation,
  actorSubject: string,
  now: Date,
  noteId: () => string,
): { record: ManagedRequestRecord; activityKind: ManagedRequestActivity['kind'] } | undefined {
  if (current.deletedAt !== undefined || current.content === undefined) return undefined;
  if (collection.authority.authority !== 'native') return undefined;
  const actor = validateScalar('actor subject', actorSubject, 256);
  const revision = current.revision + 1;
  const updatedAt = now.toISOString();
  if (operation.kind === 'update') {
    const payload = validateCollectionPayload(
      collection,
      patchedPayload(collection, current.content.payload, operation.payload, operation.unset),
    );
    return {
      record: cloneRecord({
        ...current,
        revision,
        updatedAt,
        updatedBySubject: actor,
        content: { payload, notes: current.content.notes },
      }),
      activityKind: 'updated',
    };
  }
  if (operation.kind === 'assign') {
    if (!collectionControlEnabled(collection, 'assignment')) return undefined;
    const assignee =
      operation.assigneeSubject === undefined
        ? undefined
        : validateScalar('assignee subject', operation.assigneeSubject, 256);
    const { assigneeSubject: ignoredAssignee, ...withoutAssignee } = current;
    void ignoredAssignee;
    return {
      record: cloneRecord({
        ...withoutAssignee,
        ...(assignee === undefined ? {} : { assigneeSubject: assignee }),
        revision,
        updatedAt,
        updatedBySubject: actor,
      }),
      activityKind: 'assigned',
    };
  }
  if (operation.kind === 'set_status') {
    if (collection.behavior?.kind !== 'request' || current.status === undefined) return undefined;
    if (!validStatusTransition(current.status, operation.status)) return undefined;
    return {
      record: cloneRecord({
        ...current,
        status: operation.status,
        revision,
        updatedAt,
        updatedBySubject: actor,
      }),
      activityKind: 'status_changed',
    };
  }
  if (!collectionControlEnabled(collection, 'notes')) return undefined;
  const note = validateNote(operation.note);
  if (current.content.notes.length >= 50)
    throw new PayloadValidationError('array_too_large', 'A record cannot have more than 50 notes.');
  return {
    record: cloneRecord({
      ...current,
      revision,
      updatedAt,
      updatedBySubject: actor,
      content: {
        payload: current.content.payload,
        notes: [
          ...current.content.notes,
          {
            id: validateScalar('note id', noteId(), 128),
            text: note,
            createdAt: updatedAt,
            createdBySubject: actor,
          },
        ],
      },
    }),
    activityKind: 'note_added',
  };
}

export function validateStoredRecord(
  installation: SolutionInstallation,
  record: ManagedRequestRecord,
): InstalledCollectionDefinition {
  const collection = collectionForStoredRecord(installation, record);
  if (record.content !== undefined) validateCollectionPayload(collection, record.content.payload);
  return collection;
}

export function deletedRecord(
  current: ManagedRequestRecord,
  actorSubject: string,
  now: Date,
  reason: 'customer_request' | 'retention_expired',
): ManagedRequestRecord {
  const actor = validateScalar('actor subject', actorSubject, 256);
  const deletedAt = now.toISOString();
  const { content: ignoredContent, ...metadata } = current;
  void ignoredContent;
  return cloneRecord({
    ...metadata,
    origin: { kind: current.origin.kind },
    revision: current.revision + 1,
    updatedAt: deletedAt,
    updatedBySubject: actor,
    deletedAt,
    deletionReason: reason,
  });
}

export function activityFromRecord(
  record: ManagedRequestRecord,
  kind: ManagedRequestActivity['kind'],
): ManagedRequestActivity {
  return {
    scope: { ...record.scope },
    collectionKey: record.collectionKey,
    recordId: record.id,
    revision: record.revision,
    kind,
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.assigneeSubject === undefined ? {} : { assigneeSubject: record.assigneeSubject }),
    occurredAt: record.updatedAt,
    actorSubject: record.updatedBySubject,
    ...(record.content === undefined ? {} : { content: cloneContent(record.content) }),
  };
}

export function cloneRecord(record: ManagedRequestRecord): ManagedRequestRecord {
  return {
    ...record,
    ...(record.originalSchema === undefined
      ? {}
      : { originalSchema: { ...record.originalSchema } }),
    scope: { ...record.scope },
    origin: { ...record.origin },
    ...(record.content === undefined ? {} : { content: cloneContent(record.content) }),
  };
}

export function cloneContent(content: ManagedRequestContent): ManagedRequestContent {
  return {
    payload: structuredClone(content.payload),
    notes: content.notes.map((note) => ({ ...note })),
  };
}

export function cloneInstallation(installation: SolutionInstallation): SolutionInstallation {
  return {
    ...installation,
    scope: { ...installation.scope },
    managedCollections: [...installation.managedCollections],
    definition: structuredClone(installation.definition),
  };
}

/**
 * Managed verticals are one centrally released application definition. Existing installations keep
 * identity, grants, records and retention while compatible catalog releases update their effective
 * collections for every customer on the next read. Private and legacy definitions stay pinned.
 */
export function effectiveInstallation(
  installation: SolutionInstallation,
  resolveCurrent?: ManagedDefinitionResolver,
): SolutionInstallation {
  return resolveManagedInstallation(installation, resolveCurrent);
}

export function cloneGrant(grant: BusinessGrant): BusinessGrant {
  return { ...grant, scope: { ...grant.scope } };
}

export function cloneActivity(activity: ManagedRequestActivity): ManagedRequestActivity {
  return {
    ...activity,
    scope: { ...activity.scope },
    ...(activity.content === undefined ? {} : { content: cloneContent(activity.content) }),
  };
}

export function validateExpectedRevision(value: number): number {
  return validateRevision(value);
}

function normalizeOrigin(origin: ManagedRequestRecord['origin']): ManagedRequestRecord['origin'] {
  const kinds = ['embedded', 'mcp', 'portal', 'api', 'import'];
  if (!kinds.includes(origin.kind)) throw new Error('unsupported managed request origin');
  return {
    kind: origin.kind,
    ...(origin.reference === undefined
      ? {}
      : { reference: validateScalar('origin reference', origin.reference, 256) }),
  };
}

function validateNote(note: string): string {
  const normalized = note.trim();
  if (!normalized || normalized.length > 4_000 || normalized.includes('\0'))
    throw new PayloadValidationError(
      'string_too_long',
      'A note must contain 1 to 4,000 characters.',
    );
  validateManagedPayload({ note: normalized });
  return normalized;
}

function validStatusTransition(from: ManagedRequestStatus, to: ManagedRequestStatus): boolean {
  if (from === to) return true;
  if (from === 'closed') return false;
  if (from === 'resolved') return to === 'in_progress' || to === 'closed';
  return to === 'new' || to === 'in_progress' || to === 'resolved' || to === 'closed';
}

export function validateCollectionPayload(
  collection: InstalledCollectionDefinition,
  value: unknown,
): ReturnType<typeof validateManagedPayload> {
  const payload = validateManagedPayload(value);
  const issues = validateJsonSchema(collection.recordSchema, payload);
  if (issues.length > 0) {
    throw new PayloadValidationError(
      'invalid_json',
      `managed payload does not match collection schema: ${issues[0]?.message ?? 'invalid value'}`,
    );
  }
  return payload;
}

function validateDefinition(definition: SolutionDefinitionSnapshot): void {
  validateScalar('definition title', definition.title, 120);
  validateScalar('definition description', definition.description, 1000);
  if (definition.collections.length > 16) {
    throw new Error('definition may declare at most sixteen collections');
  }
  const keys = new Set<string>();
  for (const collection of definition.collections) {
    const issues: import('@noodle-borg/compiler').CompileError[] = [];
    validateManagedCollectionControls(
      projectManagedCollectionControls(collection),
      collection.recordSchema,
      collection.authority.authority === 'external',
      `collections.${collection.key}`,
      issues,
    );
    if (issues.length > 0) throw new Error(issues[0]?.message ?? 'invalid collection controls');
    validateScalar('collection key', collection.key, 64);
    if (keys.has(collection.key)) throw new Error(`duplicate collection "${collection.key}"`);
    keys.add(collection.key);
    if (!/^[a-f0-9]{64}$/.test(collection.schemaDigest.replace(/^sha256:/, ''))) {
      throw new Error(`collection "${collection.key}" has an invalid schema digest`);
    }
  }
}

function parseDefinitionVersion(version: string): number {
  const [major] = version.split('.');
  const parsed = Number(major);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
