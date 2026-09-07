import { openActivityContent, openRecordContent } from './cipher.js';
import type {
  BusinessGrant,
  BusinessInvitation,
  BusinessRole,
  InstallationScope,
  ManagedRequestActivity,
  ManagedRequestActivityKind,
  ManagedRequestOrigin,
  ManagedRequestRecord,
  ManagedRequestStatus,
  PayloadCipher,
  SolutionDefinitionSnapshot,
  SolutionInstallation,
} from './contracts.js';
import { builtInDefinitionAtRelease, isBuiltInProfileKey } from './profiles.js';
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
  readonly intake_active: boolean;
  readonly application_generation: string | null;
  readonly revision: string;
  readonly create_fingerprint: string;
  readonly created_at: Date;
  readonly created_by_subject: string;
  readonly updated_at: Date;
  readonly updated_by_subject: string;
  readonly definition_snapshot: unknown | null;
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

export interface InvitationRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly installation_id: string;
  readonly invitation_id: string;
  readonly email: string;
  readonly role: string;
  readonly token_digest: string;
  readonly idempotency_digest: string;
  readonly create_fingerprint: string;
  readonly revision: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly created_by_subject: string;
  readonly accepted_at: Date | null;
  readonly accepted_by_subject: string | null;
  readonly revoked_at: Date | null;
  readonly revoked_by_subject: string | null;
}

export interface RequestRow {
  readonly original_schema_identity?: unknown;
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
  readonly status: string | null;
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
  readonly status: string | null;
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
  const profileKey = row.profile_key;
  const definition = definitionFromRow(row.definition_snapshot, profileKey, row.profile_version);
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
    definition,
    retentionDays,
    intakeActive: row.intake_active,
    ...(row.application_generation == null
      ? {}
      : { applicationGeneration: row.application_generation }),
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

export function invitationFromRow(row: InvitationRow): BusinessInvitation {
  return {
    scope: scopeFromRow(row),
    invitationId: row.invitation_id,
    email: validateEmail(row.email),
    role: roleFrom(row.role),
    tokenDigest: row.token_digest,
    idempotencyDigest: row.idempotency_digest,
    createFingerprint: row.create_fingerprint,
    revision: safeRevision(row.revision),
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
    createdBySubject: row.created_by_subject,
    ...(row.accepted_at === null ? {} : { acceptedAt: timestamp(row.accepted_at) }),
    ...(row.accepted_by_subject === null ? {} : { acceptedBySubject: row.accepted_by_subject }),
    ...(row.revoked_at === null ? {} : { revokedAt: timestamp(row.revoked_at) }),
    ...(row.revoked_by_subject === null ? {} : { revokedBySubject: row.revoked_by_subject }),
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
    profileKey: row.profile_key,
    profileVersion: row.profile_version,
    schemaVersion: row.schema_version,
    schemaDigest: row.schema_digest,
    ...originalSchemaFromRow(row.original_schema_identity),
    ...(row.status === null ? {} : { status: statusFrom(row.status) }),
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
    ...(row.status === null ? {} : { status: statusFrom(row.status) }),
    ...(row.assignee_subject === null ? {} : { assigneeSubject: row.assignee_subject }),
    occurredAt: timestamp(row.occurred_at),
    actorSubject: row.actor_subject,
    ...(content === undefined ? {} : { content }),
  };
}

function definitionFromRow(
  value: unknown,
  profileKey: string,
  profileVersion: number,
): SolutionDefinitionSnapshot {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return structuredClone(value) as SolutionDefinitionSnapshot;
  }
  if (!isBuiltInProfileKey(profileKey)) {
    throw new Error('stored private installation is missing its definition snapshot');
  }
  return builtInDefinitionAtRelease(profileKey, profileVersion);
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
    value === 'schema_migrated' ||
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

function originalSchemaFromRow(value: unknown): {
  originalSchema?: NonNullable<ManagedRequestRecord['originalSchema']>;
} {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('stored original schema identity is invalid');
  const schema = value as Record<string, unknown>;
  if (
    typeof schema.profileVersion !== 'number' ||
    !Number.isSafeInteger(schema.profileVersion) ||
    schema.profileVersion < 1 ||
    typeof schema.schemaVersion !== 'number' ||
    !Number.isSafeInteger(schema.schemaVersion) ||
    schema.schemaVersion < 1 ||
    typeof schema.schemaDigest !== 'string' ||
    !/^(?:sha256:)?[a-f0-9]{64}$/.test(schema.schemaDigest)
  )
    throw new Error('stored original schema identity is invalid');
  return {
    originalSchema: {
      profileVersion: schema.profileVersion,
      schemaVersion: schema.schemaVersion,
      schemaDigest: schema.schemaDigest,
    },
  };
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
