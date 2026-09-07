import { projectManagedCollectionControls } from '@noodle-borg/compiler';
import type {
  ExternalManagedRecord,
  ManagedRecord,
  ManagedRecordActivity,
  ManagedRecordResponse,
  ManagedRecordTombstone,
  SolutionProfile,
  BusinessGrant as WireBusinessGrant,
  ManagedCollectionProfile as WireCollection,
  SolutionInstallation as WireInstallation,
} from '@noodle-borg/wire-contracts';
import { collectionPublicFields } from '../business-information/collection-controls.js';
import { invitationStatus } from '../business-information/invitations.js';
import { collectionForStoredRecord } from '../business-information/managed-releases.js';
import { validateCollectionEnabled } from '../business-information/model.js';
import type {
  BuiltInSolutionProfile,
  BusinessGrant,
  BusinessInvitation,
  ExternalRecord,
  InstalledCollectionDefinition,
  ManagedRequestActivity,
  ManagedRequestRecord,
  SolutionDefinitionReference,
  SolutionInstallation,
  SourceBindingRecord,
} from '../business-information/portable.js';
import { builtInDefinitionAtRelease } from '../business-information/profiles.js';

/** Exact accepted schema with current presentation and operator edit restrictions. */
export function recordDetailToWire(
  installation: SolutionInstallation,
  record: ManagedRequestRecord,
): ManagedRecordResponse['data'] {
  const accepted = collectionForStoredRecord(installation, record);
  const current = validateCollectionEnabled(installation, record.collectionKey);
  const projected = recordToWire(record);
  if (!('payload' in projected)) throw new Error('deleted records have no editable detail');
  const names = new Set(Object.keys(accepted.recordSchema.properties as object));
  const select = (fields: readonly string[]) => fields.filter((name) => names.has(name));
  return {
    record: projected,
    collection: collectionToWire({
      ...current,
      schemaVersion: accepted.schemaVersion,
      schemaDigest: accepted.schemaDigest,
      recordSchema: accepted.recordSchema,
      summaryFields: select(current.summaryFields),
      editableFields: select(current.editableFields ?? [...names]),
      ...(current.publicFields === undefined ? {} : { publicFields: select(current.publicFields) }),
      ...(current.filterFields === undefined ? {} : { filterFields: select(current.filterFields) }),
      ...(current.sortFields === undefined ? {} : { sortFields: select(current.sortFields) }),
      ...(current.fields === undefined
        ? {}
        : {
            fields: Object.fromEntries(
              Object.entries(current.fields).filter(([name]) => names.has(name)),
            ),
          }),
    }),
  };
}

export function profileToWire(profile: BuiltInSolutionProfile): SolutionProfile {
  return {
    id: managedProfileId(profile.key),
    title: profile.label,
    description: `Receive and operate ${profile.collections[0]?.labels.plural.toLowerCase() ?? 'business records'}.`,
    collections: builtInDefinitionAtRelease(profile.key, profile.version).collections.map(
      collectionToWire,
    ),
  };
}

export function collectionToWire(collection: InstalledCollectionDefinition): WireCollection {
  const common = {
    key: collection.key,
    title: collection.title,
    singularTitle: collection.singularTitle,
    schemaVersion: collection.schemaVersion,
    schemaDigest: collection.schemaDigest.replace(/^sha256:/, ''),
    recordSchema: { ...collection.recordSchema },
    ...projectManagedCollectionControls(collection),
    summaryFields: [...collection.summaryFields],
  };
  if (collection.authority.authority === 'external') {
    return {
      authority: 'external',
      ...common,
      capabilities: {
        read: true,
        create: false,
        update: false,
        erase: true,
        sourceControls: true,
      },
      source: {
        connector: collection.authority.connectorAlias,
        scanOperation: collection.authority.scanOperation,
      },
    };
  }
  return {
    authority: 'native',
    ...common,
    capabilities: {
      read: true,
      create: true,
      update: true,
      erase: true,
      sourceControls: false,
    },
    ...(collection.behavior?.kind === 'request'
      ? {
          requestBehavior: {
            statuses: ['new', 'in_progress', 'resolved', 'closed'] as const,
            assignment: true,
            notes: true,
          },
        }
      : {}),
  };
}

export function installationToWire(
  installation: SolutionInstallation,
  currentRole: BusinessGrant['role'],
): WireInstallation {
  return {
    id: installation.scope.installationId,
    organizationId: installation.scope.org,
    appSlug: installation.scope.app,
    environment: installation.scope.env,
    retentionDays: installation.retentionDays,
    publicId: installation.publicId,
    active: installation.intakeActive,
    currentRole,
    revision: installation.revision,
    definition: definitionToWire(installation.definition.reference),
    collections: installation.definition.collections
      .filter((collection) => installation.managedCollections.includes(collection.key))
      .map(collectionToWire),
    ...(installation.definition.reference.kind === 'legacy'
      ? { profileId: installation.definition.reference.definitionId }
      : {}),
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

export function invitationToWire(invitation: BusinessInvitation, now: Date) {
  return {
    invitationId: invitation.invitationId,
    installationId: invitation.scope.installationId,
    email: invitation.email,
    role: invitation.role,
    status: invitationStatus(invitation, now),
    revision: invitation.revision,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    createdBySubject: invitation.createdBySubject,
    ...(invitation.acceptedAt === undefined ? {} : { acceptedAt: invitation.acceptedAt }),
    ...(invitation.revokedAt === undefined ? {} : { revokedAt: invitation.revokedAt }),
  };
}

export function recordToWire(record: ManagedRequestRecord): ManagedRecord | ManagedRecordTombstone {
  const scope = wireRecordScope(record);
  if (record.deletedAt !== undefined || record.content === undefined) {
    if (record.deletedAt === undefined || record.deletionReason === undefined) {
      throw new Error('managed record tombstone is incomplete');
    }
    return {
      authority: 'native',
      ...scope,
      revision: record.revision,
      deletedAt: record.deletedAt,
      deletionReason: record.deletionReason,
    };
  }
  return {
    authority: 'native',
    ...scope,
    schemaVersion: record.schemaVersion,
    schemaDigest: record.schemaDigest.replace(/^sha256:/, ''),
    payload: record.content.payload,
    ...(record.assigneeSubject === undefined ? {} : { assigneeSubject: record.assigneeSubject }),
    ...(record.status === undefined
      ? {}
      : {
          request: {
            status: record.status,
            ...(record.assigneeSubject === undefined
              ? {}
              : { assigneeSubject: record.assigneeSubject }),
          },
        }),
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

export function externalRecordToWire(
  record: ExternalRecord,
  binding: SourceBindingRecord,
): ExternalManagedRecord {
  if (record.record === undefined || record.lastSuccessfulSyncAt === undefined) {
    throw new Error('incomplete external record cannot be projected');
  }
  return {
    authority: 'external',
    id: record.id,
    organizationId: record.scope.org,
    appSlug: record.scope.app,
    environment: record.scope.env,
    installationId: record.scope.installationId,
    collection: record.collectionKey,
    schemaVersion: record.schemaVersion,
    schemaDigest: record.schemaDigest.replace(/^sha256:/, ''),
    payload: record.record,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    retentionExpiresAt: record.retentionExpiresAt,
    source: {
      bindingReference: record.source.bindingId,
      bindingGeneration: record.source.bindingGeneration,
      sourceRecordId: record.source.id,
      ...(record.source.version === undefined ? {} : { sourceVersion: record.source.version }),
      observedAt: record.observedAt,
      lastCompletedSyncAt: record.lastSuccessfulSyncAt,
      health: sourceHealth(binding),
      completeness: binding.completeness === 'complete' ? 'complete' : 'partial',
    },
  };
}

const ACTIVITY_OPERATION = {
  created: 'create',
  updated: 'update',
  assigned: 'assign',
  status_changed: 'set-status',
  schema_migrated: 'schema-migrated',
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

function definitionToWire(reference: SolutionDefinitionReference): WireInstallation['definition'] {
  if (reference.kind !== 'private') return reference;
  return {
    kind: 'private',
    publisherOrg: reference.publisherOrg,
    app: reference.app,
    environment: reference.env,
    deploymentId: reference.deploymentId,
    version: reference.version,
    digest: reference.digest,
  };
}

function wireRecordScope(record: ManagedRequestRecord) {
  return {
    id: record.id,
    organizationId: record.scope.org,
    appSlug: record.scope.app,
    environment: record.scope.env,
    installationId: record.scope.installationId,
    collection: record.collectionKey,
  };
}

function sourceHealth(binding: SourceBindingRecord): ExternalManagedRecord['source']['health'] {
  if (binding.health === 'initializing') return 'pending';
  if (binding.health === 'current') return 'healthy';
  if (binding.health === 'stale') return 'degraded';
  if (binding.health === 'reauth_required') return 'authorization_required';
  if (binding.health === 'paused') return 'paused';
  return 'unavailable';
}

function managedProfileId(key: BuiltInSolutionProfile['key']): SolutionProfile['id'] {
  if (key === 'b2b_saas') throw new Error('legacy B2B SaaS profile is not in the managed catalog');
  return key;
}

export function collectionToPublicWire(collection: InstalledCollectionDefinition) {
  const wire = collectionToWire(collection);
  if (wire.authority !== 'native') throw new Error('public intake requires a native collection');
  const allowed = new Set(collectionPublicFields(collection));
  const {
    requestBehavior,
    management,
    editableFields,
    filterFields,
    sortFields,
    fields,
    ...publicWire
  } = wire;
  void requestBehavior;
  void management;
  void editableFields;
  void filterFields;
  void sortFields;
  const schema = collection.recordSchema;
  const properties = schema.properties;
  return {
    ...publicWire,
    ...(fields === undefined
      ? {}
      : {
          fields: Object.fromEntries(Object.entries(fields).filter(([name]) => allowed.has(name))),
        }),
    recordSchema: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(
          properties !== null && typeof properties === 'object' && !Array.isArray(properties)
            ? properties
            : {},
        ).filter(([name]) => allowed.has(name)),
      ),
      required: Array.isArray(schema.required)
        ? schema.required.filter((name) => typeof name === 'string' && allowed.has(name))
        : [],
    },
    summaryFields: wire.summaryFields.filter((name) => allowed.has(name)),
  };
}
