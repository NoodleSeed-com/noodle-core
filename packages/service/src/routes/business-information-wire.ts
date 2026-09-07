import type {
  ManagedRecord,
  ManagedRecordActivity,
  ManagedRecordTombstone,
  SolutionProfile,
  BusinessGrant as WireBusinessGrant,
  ManagedCollectionProfile as WireCollection,
  SolutionInstallation as WireInstallation,
} from '@noodle-borg/wire-contracts';
import type {
  BuiltInSolutionProfile,
  BusinessGrant,
  ManagedCollectionProfile,
  ManagedRequestActivity,
  ManagedRequestRecord,
  SolutionInstallation,
} from '../business-information/portable.js';

export function profileToWire(profile: BuiltInSolutionProfile): SolutionProfile {
  const collection = profile.collections[0];
  if (collection === undefined)
    throw new Error(`solution profile "${profile.key}" has no collection`);
  return {
    id: profile.key,
    title: profile.label,
    description: `Receive and operate ${collection.labels.plural.toLowerCase()}.`,
    collection: collectionToWire(collection),
  };
}

export function collectionToWire(collection: ManagedCollectionProfile): WireCollection {
  return {
    key: collection.key,
    title: collection.labels.plural,
    singularTitle: collection.labels.singular,
    schemaVersion: collection.schemaVersion,
    schemaDigest: collection.schemaDigest.replace(/^sha256:/, ''),
    recordSchema: { ...collection.schema },
    summaryFields: collection.schema.required.slice(0, 6),
  };
}

export function installationToWire(
  installation: SolutionInstallation,
  profile: BuiltInSolutionProfile,
  currentRole: BusinessGrant['role'],
): WireInstallation {
  const collection = profile.collections.find((candidate) =>
    installation.managedCollections.includes(candidate.key),
  );
  if (collection === undefined) throw new Error('solution installation has no active collection');
  return {
    id: installation.scope.installationId,
    organizationId: installation.scope.org,
    profileId: installation.profileKey,
    appSlug: installation.scope.app,
    environment: installation.scope.env,
    retentionDays: installation.retentionDays,
    publicId: installation.publicId,
    active: true,
    currentRole,
    revision: installation.revision,
    collection: collectionToWire(collection),
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
    createdBySubject: installation.createdBySubject,
  };
}

export function grantToWire(grant: BusinessGrant): WireBusinessGrant {
  if (grant.email === undefined) throw new Error('business grant has no email');
  return {
    installationId: grant.scope.installationId,
    subject: grant.subject,
    email: grant.email,
    role: grant.role,
    revision: grant.revision,
    createdAt: grant.createdAt,
    createdBySubject: grant.createdBySubject,
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
  };
}

export function recordToWire(record: ManagedRequestRecord): ManagedRecord | ManagedRecordTombstone {
  if (record.deletedAt !== undefined || record.content === undefined) {
    if (record.deletedAt === undefined || record.deletionReason === undefined) {
      throw new Error('managed record tombstone is incomplete');
    }
    return {
      id: record.id,
      installationId: record.scope.installationId,
      collection: record.collectionKey,
      status: record.status,
      revision: record.revision,
      deletedAt: record.deletedAt,
      deletionReason: record.deletionReason,
    };
  }
  return {
    id: record.id,
    installationId: record.scope.installationId,
    collection: record.collectionKey,
    schemaVersion: record.schemaVersion,
    schemaDigest: record.schemaDigest.replace(/^sha256:/, ''),
    payload: record.content.payload,
    status: record.status,
    ...(record.assigneeSubject === undefined ? {} : { assigneeSubject: record.assigneeSubject }),
    revision: record.revision,
    origin: {
      surface:
        record.origin.kind === 'embedded'
          ? 'public'
          : record.origin.kind === 'import'
            ? 'api'
            : record.origin.kind,
      ...(record.createdBySubject === 'anonymous' ? {} : { subject: record.createdBySubject }),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    retentionExpiresAt: record.retentionExpiresAt,
  };
}

const ACTIVITY_OPERATION = {
  created: 'create',
  updated: 'update',
  assigned: 'assign',
  status_changed: 'set-status',
  note_added: 'add-note',
  deleted: 'delete',
  retention_expired: 'delete',
} as const;

export function activityToWire(activity: ManagedRequestActivity): ManagedRecordActivity {
  const note = activity.kind === 'note_added' ? activity.content?.notes.at(-1)?.text : undefined;
  return {
    id: `${activity.recordId}:${activity.revision}`,
    recordId: activity.recordId,
    revision: activity.revision,
    operation: ACTIVITY_OPERATION[activity.kind],
    actorSubject: activity.actorSubject,
    createdAt: activity.occurredAt,
    ...(note === undefined ? {} : { note }),
  };
}
