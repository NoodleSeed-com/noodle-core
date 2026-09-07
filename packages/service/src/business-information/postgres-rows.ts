import { openActivityContent, openRecordContent } from './cipher.js';
import type {
  BuiltInProfileKey,
  BusinessGrant,
  BusinessRole,
  InstallationScope,
  ManagedRequestActivity,
  ManagedRequestActivityKind,
  ManagedRequestOrigin,
  ManagedRequestRecord,
  ManagedRequestStatus,
  PayloadCipher,
  SolutionInstallation,
} from './contracts.js';
import { builtInProfile } from './profiles.js';
import { validateEmail } from './validation.js';

export interface InstallationRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly installation_id: string;
  readonly public_id: string;
  readonly profile_key: string;
  readonly profile_version: number;
  readonly managed_collections: string[];
  readonly retention_days: number;
  readonly revision: string;
  readonly create_fingerprint: string;
  readonly created_at: Date;
  readonly created_by_subject: string;
  readonly updated_at: Date;
  readonly updated_by_subject: string;
}

export interface GrantRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly installation_id: string;
  readonly subject: string;
  readonly email: string | null;
  readonly role: string;
  readonly revision: string;
  readonly created_at: Date;
  readonly created_by_subject: string;
  readonly updated_at: Date;
  readonly updated_by_subject: string;
  readonly revoked_at: Date | null;
}

export interface RequestRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly installation_id: string;
  readonly collection_key: string;
  readonly record_id: string;
  readonly profile_key: string;
  readonly profile_version: number;
  readonly schema_version: number;
  readonly schema_digest: string;
  readonly status: string;
  readonly assignee_subject: string | null;
  readonly origin_kind: string;
  readonly revision: string;
  readonly retention_expires_at: Date;
  readonly created_at: Date;
  readonly created_by_subject: string;
  readonly updated_at: Date;
  readonly updated_by_subject: string;
  readonly deleted_at: Date | null;
  readonly deletion_reason: string | null;
  readonly content_ciphertext: unknown | null;
  readonly idempotency_digest: string;
  readonly create_fingerprint: string;
}

export interface ActivityRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly installation_id: string;
  readonly collection_key: string;
  readonly record_id: string;
  readonly revision: string;
  readonly kind: string;
  readonly status: string;
  readonly assignee_subject: string | null;
  readonly occurred_at: Date;
  readonly actor_subject: string;
  readonly content_ciphertext: unknown | null;
}

export function scopeFromRow(row: {
  org_slug: string;
  app_slug: string;
  environment: string;
  installation_id: string;
}): InstallationScope {
  return {
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    installationId: row.installation_id,
  };
}

export function installationFromRow(row: InstallationRow): SolutionInstallation {
  const profileKey = profileKeyFrom(row.profile_key);
  builtInProfile(profileKey);
  const retentionDays = row.retention_days;
  if (retentionDays !== 7 && retentionDays !== 30 && retentionDays !== 90) {
    throw new Error('stored installation retention is invalid');
  }
  return {
    scope: scopeFromRow(row),
    publicId: row.public_id,
    profileKey,
    profileVersion: row.profile_version,
    managedCollections: [...row.managed_collections],
    retentionDays,
    revision: safeRevision(row.revision),
    createdAt: timestamp(row.created_at),
    createdBySubject: row.created_by_subject,
    updatedAt: timestamp(row.updated_at),
    updatedBySubject: row.updated_by_subject,
  };
}

export function grantFromRow(row: GrantRow): BusinessGrant {
  return {
    scope: scopeFromRow(row),
    subject: row.subject,
    ...(row.email === null ? {} : { email: validateEmail(row.email) }),
    role: roleFrom(row.role),
    revision: safeRevision(row.revision),
    createdAt: timestamp(row.created_at),
    createdBySubject: row.created_by_subject,
    updatedAt: timestamp(row.updated_at),
    updatedBySubject: row.updated_by_subject,
    ...(row.revoked_at === null ? {} : { revokedAt: timestamp(row.revoked_at) }),
  };
}

export async function requestFromRow(
  row: RequestRow,
  cipher: PayloadCipher,
): Promise<ManagedRequestRecord> {
  const scope = scopeFromRow(row);
  const revision = safeRevision(row.revision);
  const opened =
    row.content_ciphertext === null
      ? undefined
      : await openRecordContent(
          cipher,
          { ...scope, collectionKey: row.collection_key, recordId: row.record_id, revision },
          row.content_ciphertext,
        );
  return {
    scope,
    collectionKey: row.collection_key,
    id: row.record_id,
    profileKey: profileKeyFrom(row.profile_key),
    profileVersion: row.profile_version,
    schemaVersion: row.schema_version,
    schemaDigest: row.schema_digest,
    status: statusFrom(row.status),
    ...(row.assignee_subject === null ? {} : { assigneeSubject: row.assignee_subject }),
    origin: {
      kind: originFrom(row.origin_kind),
      ...(opened?.originReference === undefined ? {} : { reference: opened.originReference }),
    },
    revision,
    retentionExpiresAt: timestamp(row.retention_expires_at),
    createdAt: timestamp(row.created_at),
    createdBySubject: row.created_by_subject,
    updatedAt: timestamp(row.updated_at),
    updatedBySubject: row.updated_by_subject,
    ...(row.deleted_at === null ? {} : { deletedAt: timestamp(row.deleted_at) }),
    ...(row.deletion_reason === null
      ? {}
      : { deletionReason: deletionReasonFrom(row.deletion_reason) }),
    ...(opened === undefined ? {} : { content: opened.content }),
  };
}

export async function activityFromRow(
  row: ActivityRow,
  cipher: PayloadCipher,
): Promise<ManagedRequestActivity> {
  const scope = scopeFromRow(row);
  const revision = safeRevision(row.revision);
  const content =
    row.content_ciphertext === null
      ? undefined
      : await openActivityContent(
          cipher,
          { ...scope, collectionKey: row.collection_key, recordId: row.record_id, revision },
          row.content_ciphertext,
        );
  return {
    scope,
    collectionKey: row.collection_key,
    recordId: row.record_id,
    revision,
    kind: activityKindFrom(row.kind),
    status: statusFrom(row.status),
    ...(row.assignee_subject === null ? {} : { assigneeSubject: row.assignee_subject }),
    occurredAt: timestamp(row.occurred_at),
    actorSubject: row.actor_subject,
    ...(content === undefined ? {} : { content }),
  };
}

function profileKeyFrom(value: string): BuiltInProfileKey {
  if (
    value === 'travel' ||
    value === 'b2b_saas' ||
    value === 'ecommerce' ||
    value === 'restaurant'
  ) {
    return value;
  }
  throw new Error('stored solution profile is invalid');
}

function roleFrom(value: string): BusinessRole {
  if (
    value === 'administrator' ||
    value === 'manager' ||
    value === 'operator' ||
    value === 'viewer'
  ) {
    return value;
  }
  throw new Error('stored business role is invalid');
}

function statusFrom(value: string): ManagedRequestStatus {
  if (value === 'new' || value === 'in_progress' || value === 'resolved' || value === 'closed')
    return value;
  throw new Error('stored managed request status is invalid');
}

function originFrom(value: string): ManagedRequestOrigin['kind'] {
  if (
    value === 'embedded' ||
    value === 'mcp' ||
    value === 'portal' ||
    value === 'api' ||
    value === 'import'
  ) {
    return value;
  }
  throw new Error('stored managed request origin is invalid');
}

function activityKindFrom(value: string): ManagedRequestActivityKind {
  if (
    value === 'created' ||
    value === 'updated' ||
    value === 'assigned' ||
    value === 'status_changed' ||
    value === 'note_added' ||
    value === 'deleted' ||
    value === 'retention_expired'
  ) {
    return value;
  }
  throw new Error('stored managed request activity kind is invalid');
}

function deletionReasonFrom(value: string): 'customer_request' | 'retention_expired' {
  if (value === 'customer_request' || value === 'retention_expired') return value;
  throw new Error('stored managed request deletion reason is invalid');
}

function safeRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error('stored revision is invalid');
  return revision;
}

function timestamp(value: Date): string {
  const result = new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new Error('stored timestamp is invalid');
  return result;
}
