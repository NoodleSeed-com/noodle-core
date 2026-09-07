import { createHash } from 'node:crypto';
import type {
  BusinessGrant,
  BusinessPermission,
  BusinessRole,
  InstallationScope,
  ManagedRequestActivity,
  ManagedRequestContent,
  ManagedRequestOperation,
  ManagedRequestRecord,
  ManagedRequestStatus,
  SolutionInstallation,
} from './contracts.js';
import { builtInCollection, builtInProfile, validateProfilePayload } from './profiles.js';
import {
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
  profileKey: SolutionInstallation['profileKey'];
  managedCollections: readonly string[];
  retentionDays?: number;
  actorSubject: string;
  actorEmail?: string;
}): {
  scope: InstallationScope;
  profileKey: SolutionInstallation['profileKey'];
  profileVersion: number;
  managedCollections: readonly string[];
  retentionDays: 7 | 30 | 90;
  actorSubject: string;
  actorEmail?: string;
} {
  const scope = { ...validateScope(input.scope) };
  const profile = builtInProfile(input.profileKey);
  const managedCollections = [...new Set(input.managedCollections)].sort();
  if (managedCollections.length === 0)
    throw new Error('at least one managed collection must be enabled');
  for (const collectionKey of managedCollections) builtInCollection(profile.key, collectionKey);
  return {
    scope,
    profileKey: profile.key,
    profileVersion: profile.version,
    managedCollections,
    retentionDays: validateRetentionDays(input.retentionDays),
    actorSubject: validateScalar('actor subject', input.actorSubject, 256),
    ...(input.actorEmail === undefined ? {} : { actorEmail: validateEmail(input.actorEmail) }),
  };
}

export function installationFingerprint(
  input: ReturnType<typeof normalizeInstallationInput>,
): string {
  return digest({
    scope: input.scope,
    profileKey: input.profileKey,
    profileVersion: input.profileVersion,
    managedCollections: input.managedCollections,
    retentionDays: input.retentionDays,
    actorSubject: input.actorSubject,
    actorEmail: input.actorEmail,
  });
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
): ReturnType<typeof builtInCollection> {
  const normalized = validateScalar('collection key', collectionKey, 64);
  if (!installation.managedCollections.includes(normalized)) {
    throw new Error(`managed collection "${normalized}" is not enabled for this installation`);
  }
  return builtInCollection(installation.profileKey, normalized);
}

export function initialRecord(input: {
  installation: SolutionInstallation;
  collectionKey: string;
  id: string;
  payload: unknown;
  origin: ManagedRequestRecord['origin'];
  actorSubject: string;
  now: Date;
}): ManagedRequestRecord {
  const profile = validateCollectionEnabled(input.installation, input.collectionKey);
  const payload = validateProfilePayload(
    input.installation.profileKey,
    input.collectionKey,
    input.payload,
  );
  const actor = validateScalar('actor subject', input.actorSubject, 256);
  const id = validateScalar('record id', input.id, 128);
  const createdAt = input.now.toISOString();
  return {
    scope: { ...input.installation.scope },
    collectionKey: profile.key,
    id,
    profileKey: input.installation.profileKey,
    profileVersion: input.installation.profileVersion,
    schemaVersion: profile.schemaVersion,
    schemaDigest: profile.schemaDigest,
    status: 'new',
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
  operation: ManagedRequestOperation,
  actorSubject: string,
  now: Date,
  noteId: () => string,
): { record: ManagedRequestRecord; activityKind: ManagedRequestActivity['kind'] } | undefined {
  if (current.deletedAt !== undefined || current.content === undefined) return undefined;
  const actor = validateScalar('actor subject', actorSubject, 256);
  const revision = current.revision + 1;
  const updatedAt = now.toISOString();
  if (operation.kind === 'update') {
    const payload = validateProfilePayload(
      current.profileKey,
      current.collectionKey,
      operation.payload,
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
  const note = validateNote(operation.note);
  if (current.content.notes.length >= 50) throw new Error('managed request cannot exceed 50 notes');
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
    status: record.status,
    ...(record.assigneeSubject === undefined ? {} : { assigneeSubject: record.assigneeSubject }),
    occurredAt: record.updatedAt,
    actorSubject: record.updatedBySubject,
    ...(record.content === undefined ? {} : { content: cloneContent(record.content) }),
  };
}

export function cloneRecord(record: ManagedRequestRecord): ManagedRequestRecord {
  return {
    ...record,
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
  };
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
  const normalized = validateScalar('note', note, 4096);
  validateManagedPayload({ note: normalized });
  return normalized;
}

function validStatusTransition(from: ManagedRequestStatus, to: ManagedRequestStatus): boolean {
  if (from === to) return true;
  if (from === 'closed') return false;
  if (from === 'resolved') return to === 'in_progress' || to === 'closed';
  return to === 'new' || to === 'in_progress' || to === 'resolved' || to === 'closed';
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
