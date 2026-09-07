/**
 * Row shapes + row↔record mapping for the relational store (extracted verbatim from `postgres.ts`
 * to keep that file under the size gate). Pure mapping/validation and the metadata column projection.
 */

import type { HostedPackagedAsset } from '@noodle-borg/compiler';
import type { OrgMembershipSource } from '@noodle-borg/module';
import type { SecretBox } from '@noodle-borg/runtime';
import { parseAppPackageSnapshot } from '../app-package-snapshot.js';
import { isTenantAuthConfig } from '../customer-auth-audience-binding.js';
import type {
  ConfigScope,
  ConfigValueMetadata,
  DeploymentSummary,
  DeployRecord,
  ManagedConfigKind,
  SecretEnvelope,
} from '../store.js';
import type { PostgresStoreOptions } from './postgres.js';
import { type DeploymentMetadata, deploymentSummary } from './records.js';

export { isTenantAuthConfig };

/** The on-disk-equivalent row shape. `created_at` comes back as a `Date`; `secrets` is parsed `jsonb`. */
export interface DeployRow {
  readonly deployment_id: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly server_version: string | null;
  // `bigint` (int8) comes back from `pg` as a string to avoid precision loss; coerced in rowToRecord.
  readonly deployment_version: string | number;
  readonly active: boolean;
  readonly server_name: string;
  readonly created_at: Date;
  readonly created_by_subject: string | null;
  readonly created_by_email: string | null;
  readonly access_mode: string | null;
  readonly org_membership_sources?: readonly string[] | null;
  readonly server_auth: unknown | null;
  readonly caller_key_hash: string | null;
  readonly manifest: string;
  readonly connectors: string | null;
  readonly hosted_assets: readonly HostedPackagedAsset[] | null;
  readonly secrets: SecretEnvelope;
  readonly schema_version: number;
  /** App soft-delete stamp (ADR 0117); `NULL` for live records. */
  readonly archived_at: Date | null;
  readonly deployment_source: string | null;
  /** Optional while reading rows from pre-lock fixtures or a rolling-upgrade replica. */
  readonly deployment_locked_at?: Date | null;
  readonly deployment_locked_by_subject?: string | null;
  readonly deployment_locked_by_email?: string | null;
  readonly app_package_snapshot?: unknown | null;
  readonly owner_subject?: string | null;
}

export interface ConfigRow {
  readonly kind: ManagedConfigKind;
  readonly scope_level: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly name: string;
  readonly secret_value: SecretEnvelope | null;
  readonly variable_value: string | null;
  readonly updated_at: Date;
  readonly updated_by_subject: string | null;
  readonly updated_by_email: string | null;
}

// Summary reads must not transfer historical manifests, widgets, snapshots, or credentials from PG.
const SUMMARY_FIELDS = [
  'deployment_id',
  'org_slug',
  'app_slug',
  'environment',
  'server_version',
  'deployment_version',
  'active',
  'server_name',
  'created_at',
  'created_by_subject',
  'created_by_email',
  'owner_subject',
  'access_mode',
  'org_membership_sources',
  'schema_version',
  'archived_at',
  'deployment_source',
  'deployment_locked_at',
  'deployment_locked_by_subject',
  'deployment_locked_by_email',
] as const satisfies readonly (keyof DeployRow)[];
export const DEPLOY_SUMMARY_COLUMNS = SUMMARY_FIELDS.join(', ');
export type DeploySummaryRow = Pick<DeployRow, (typeof SUMMARY_FIELDS)[number]>;

export function rowToDeploymentSummary(row: DeploySummaryRow): DeploymentSummary {
  return deploymentSummary(rowToMetadata(row));
}

/** Ordered bind values for the deploy-record upsert in {@link PostgresArtifactStore}. */
export function deployRecordParams(record: DeployRecord): unknown[] {
  return [
    record.deploymentId,
    record.orgSlug,
    record.appSlug,
    record.environment,
    record.serverVersion ?? null,
    record.deploymentVersion,
    record.active,
    record.serverName,
    record.createdAt,
    record.createdBySubject ?? null,
    record.createdByEmail ?? null,
    record.accessMode ?? 'owner-only',
    record.serverAuth !== undefined ? JSON.stringify(record.serverAuth) : null,
    null,
    record.manifest,
    record.connectors ?? null,
    // `pg` does not auto-serialize objects for a jsonb bind — stringify explicitly.
    record.hostedAssets !== undefined && record.hostedAssets.length > 0
      ? JSON.stringify(record.hostedAssets)
      : null,
    JSON.stringify(record.secrets),
    record.schemaVersion,
    record.archivedAt ?? null,
    record.deploymentSource ?? null,
    // Kept after every pre-lock bind so adding lock metadata does not shift existing placeholders.
    record.orgMembershipSources ?? null,
    record.deploymentLock?.lockedAt ?? null,
    record.deploymentLock?.lockedBySubject ?? null,
    record.deploymentLock?.lockedByEmail ?? null,
    // Appended after every existing bind so rolling migrations do not shift historical positions.
    record.appPackageSnapshot !== undefined ? JSON.stringify(record.appPackageSnapshot) : null,
    record.ownerSubject ?? null,
  ];
}

export function rowToRecord(row: DeployRow): DeployRecord {
  const appPackageSnapshot = parseAppPackageSnapshot(row.app_package_snapshot);
  return {
    ...rowToMetadata(row),
    ...(isTenantAuthConfig(row.server_auth) ? { serverAuth: row.server_auth } : {}),
    manifest: row.manifest,
    ...(row.connectors !== null ? { connectors: row.connectors } : {}),
    ...(row.hosted_assets !== null ? { hostedAssets: row.hosted_assets } : {}),
    secrets: row.secrets,
    ...(appPackageSnapshot !== undefined ? { appPackageSnapshot } : {}),
  };
}

function rowToMetadata(row: DeploySummaryRow): DeploymentMetadata {
  return {
    schemaVersion: row.schema_version,
    deploymentId: row.deployment_id,
    orgSlug: row.org_slug,
    appSlug: row.app_slug,
    environment: row.environment,
    ...(row.server_version !== null ? { serverVersion: row.server_version } : {}),
    // `Date.now()` ms timestamps fit JS's safe-integer range, so the bigint string coerces losslessly.
    deploymentVersion: Number(row.deployment_version),
    active: row.active,
    serverName: row.server_name,
    // timestamptz → the canonical ISO-8601 string the rest of the system uses.
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.created_by_subject !== null ? { createdBySubject: row.created_by_subject } : {}),
    ...(row.created_by_email !== null ? { createdByEmail: row.created_by_email } : {}),
    ...(row.owner_subject !== null && row.owner_subject !== undefined
      ? { ownerSubject: row.owner_subject }
      : {}),
    ...(row.access_mode === 'owner-only' ||
    row.access_mode === 'org-members' ||
    row.access_mode === 'public' ||
    row.access_mode === 'mixed' ||
    row.access_mode === 'authenticated' ||
    row.access_mode === 'customers'
      ? { accessMode: row.access_mode }
      : {}),
    ...orgMembershipSourcesOf(row.org_membership_sources),
    ...(row.archived_at !== null && row.archived_at !== undefined
      ? { archivedAt: new Date(row.archived_at).toISOString() }
      : {}),
    ...(row.deployment_source === 'console-example' ||
    row.deployment_source === 'cli' ||
    row.deployment_source === 'github' ||
    row.deployment_source === 'api'
      ? { deploymentSource: row.deployment_source }
      : {}),
    ...(row.deployment_locked_at !== null &&
    row.deployment_locked_at !== undefined &&
    row.deployment_locked_by_subject !== null &&
    row.deployment_locked_by_subject !== undefined
      ? {
          deploymentLock: {
            lockedAt: new Date(row.deployment_locked_at).toISOString(),
            lockedBySubject: row.deployment_locked_by_subject,
            ...(row.deployment_locked_by_email !== null &&
            row.deployment_locked_by_email !== undefined
              ? { lockedByEmail: row.deployment_locked_by_email }
              : {}),
          },
        }
      : {}),
  };
}

export function configRowToMetadata(row: ConfigRow): ConfigValueMetadata {
  return {
    kind: validateConfigKind(row.kind),
    scope: rowToScope(row),
    name: row.name,
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.updated_by_subject !== null ? { updatedBySubject: row.updated_by_subject } : {}),
    ...(row.updated_by_email !== null ? { updatedByEmail: row.updated_by_email } : {}),
    ...(row.kind === 'variable' && row.variable_value !== null
      ? { value: row.variable_value }
      : {}),
  };
}

export function validateConfigKind(kind: ManagedConfigKind): ManagedConfigKind {
  if (kind !== 'secret' && kind !== 'variable') throw new Error(`invalid config kind: ${kind}`);
  return kind;
}

export function scopeParts(scope: ConfigScope): {
  readonly level: ConfigScope['level'];
  readonly org: string;
  readonly app: string;
  readonly env: string;
} {
  if (scope.level === 'org') return { level: 'org', org: scope.org, app: '', env: '' };
  if (scope.level === 'app') return { level: 'app', org: scope.org, app: scope.app, env: '' };
  return { level: 'env', org: scope.org, app: scope.app, env: scope.env };
}

function rowToScope(row: ConfigRow): ConfigScope {
  if (row.scope_level === 'org') return { level: 'org', org: row.org_slug };
  if (row.scope_level === 'app') return { level: 'app', org: row.org_slug, app: row.app_slug };
  if (row.scope_level === 'env') {
    return { level: 'env', org: row.org_slug, app: row.app_slug, env: row.environment };
  }
  throw new Error(`invalid config scope_level: ${row.scope_level}`);
}

export async function sealConfigSecret(
  value: string,
  secretBox: SecretBox | undefined,
): Promise<SecretEnvelope> {
  if (secretBox === undefined) {
    throw new Error('durable secret config requires a secret master-key custodian');
  }
  return { enc: 'aes-256-gcm', sealed: await secretBox.seal(value) };
}

export async function openConfigSecret(
  envelope: SecretEnvelope | null,
  secretBox: SecretBox | undefined,
): Promise<string> {
  if (envelope === null) throw new Error('secret config row has no encrypted value');
  if (envelope.enc === 'none') {
    const value = envelope.values.value;
    if (typeof value !== 'string') throw new Error('legacy secret config row has no value');
    return value;
  }
  if (secretBox === undefined) {
    throw new Error('cannot resolve encrypted config without a secret master-key custodian');
  }
  return secretBox.open(envelope.sealed);
}

export function isPostgresStoreOptions(
  value: SecretBox | PostgresStoreOptions | undefined,
): value is PostgresStoreOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('secretBox' in value ||
      'now' in value ||
      'deploymentActivation' in value ||
      'organizationProvisioning' in value)
  );
}

/**
 * A stored list that filters to empty stays `[]` (deny-all) rather than becoming `undefined` (admit-all).
 * Rolling a deployment back past a source this build does not know must never re-open it (ADR 0183).
 */
function orgMembershipSourcesOf(raw: readonly string[] | null | undefined): {
  orgMembershipSources?: readonly OrgMembershipSource[];
} {
  // A row read before the column existed has no property at all, not `null`.
  if (raw === null || raw === undefined) return {};
  const known = raw.filter((v): v is OrgMembershipSource => v === 'explicit' || v === 'domain');
  return { orgMembershipSources: known };
}
