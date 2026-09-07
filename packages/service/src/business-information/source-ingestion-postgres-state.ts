import type { PoolClient, QueryResultRow } from 'pg';
import type {
  SourceBindingCreate,
  SourceBindingKey,
  SourceBindingRecord,
  SourceIngestionLease,
  SourceScanPage,
  SourceSuppressionRecord,
} from './source-ingestion-contracts.js';
import type { SourceBindingContent, SourceBindingRow } from './source-ingestion-postgres-codec.js';
import {
  normalizeSourceSuppression,
  sourceBindingValues,
  sourceToken,
} from './source-ingestion-validation.js';

interface DatabaseClockRow extends QueryResultRow {
  database_now: Date | string;
}

export interface SuppressionRow extends QueryResultRow {
  org_slug: string;
  app_slug: string;
  environment: string;
  installation_id: string;
  collection_key: string;
  binding_id: string;
  binding_generation: string | number;
  source_identity_digest: string;
  reason: string;
  erased_at: Date | string;
}

export async function selectBindingForUpdate(
  client: PoolClient,
  input: SourceBindingKey,
): Promise<SourceBindingRow | undefined> {
  const result = await client.query<SourceBindingRow>(
    `SELECT * FROM business_source_bindings WHERE ${bindingWhere(1)} FOR UPDATE`,
    sourceBindingValues(input),
  );
  return result.rows[0];
}

export async function selectBindingWithClock(
  client: PoolClient,
  input: SourceBindingKey,
): Promise<(SourceBindingRow & DatabaseClockRow) | undefined> {
  const result = await client.query<SourceBindingRow & DatabaseClockRow>(
    `SELECT *, clock_timestamp() AS database_now FROM business_source_bindings
     WHERE ${bindingWhere(1)} FOR UPDATE`,
    sourceBindingValues(input),
  );
  return result.rows[0];
}

export function bindingWhere(offset: number): string {
  return `org_slug=$${offset} AND app_slug=$${offset + 1} AND environment=$${offset + 2}
    AND installation_id=$${offset + 3} AND collection_key=$${offset + 4} AND binding_id=$${offset + 5}`;
}

export function bindingContent(
  binding: SourceBindingCreate,
  cursor?: string,
  checkpoint?: string,
): SourceBindingContent {
  return {
    ...(binding.credentialIdentity === undefined
      ? {}
      : { credentialIdentity: binding.credentialIdentity }),
    ...(binding.bindingReference === undefined
      ? {}
      : { bindingReference: binding.bindingReference }),
    ...(binding.configurationReference === undefined
      ? {}
      : { configurationReference: binding.configurationReference }),
    scan: binding.scan,
    ...(cursor === undefined ? {} : { cursor }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

export function leaseFrom(
  binding: SourceBindingRecord,
  owner: string,
  leaseMs: number,
): SourceIngestionLease {
  return {
    binding,
    owner,
    fence: binding.fence,
    scanGeneration: binding.scanGeneration,
    mode: requiredMode(binding.scanMode),
    ...(binding.cursor === undefined ? {} : { cursor: binding.cursor }),
    ...(binding.checkpoint === undefined ? {} : { checkpoint: binding.checkpoint }),
    expiresAt: requiredCursor(binding.leaseExpiresAt),
    leaseMs,
  };
}

export function ownsLease(
  row: SourceBindingRow & DatabaseClockRow,
  lease: SourceIngestionLease,
  allowExpired: boolean,
): boolean {
  const expiry =
    row.lease_expires_at === null ? Number.NaN : new Date(row.lease_expires_at).getTime();
  const databaseNow = new Date(row.database_now).getTime();
  return (
    row.state === 'active' &&
    Number(row.fence) === lease.fence &&
    Number(row.scan_generation) === lease.scanGeneration &&
    row.lease_owner === lease.owner &&
    (allowExpired || expiry > databaseNow)
  );
}

export function validatePage(page: SourceScanPage): void {
  if (page.resetRequired === true) throw new Error('source reset page must not be committed');
  if (page.records.length > 100 || page.deletedIds.length > 100) {
    throw new Error('source page exceeds the record limit');
  }
  if (page.complete && page.nextCursor !== undefined) {
    throw new Error('complete source page cannot include a next cursor');
  }
  if (!page.complete && page.nextCursor === undefined) {
    throw new Error('incomplete source page requires a next cursor');
  }
  const ids = new Set<string>();
  for (const item of page.records) {
    const id = sourceToken('source record id', item.id);
    if (ids.has(id)) throw new Error('source page contains duplicate record ids');
    ids.add(id);
  }
  for (const raw of page.deletedIds) {
    const id = sourceToken('deleted source id', raw);
    if (ids.has(id)) throw new Error('source page records and deletions overlap');
    ids.add(id);
  }
}

export function suppressionFromRow(row: SuppressionRow): SourceSuppressionRecord {
  return normalizeSourceSuppression({
    scope: {
      org: row.org_slug,
      app: row.app_slug,
      env: row.environment,
      installationId: row.installation_id,
    },
    collectionKey: row.collection_key,
    id: row.binding_id,
    bindingGeneration: Number(row.binding_generation),
    sourceIdentityDigest: row.source_identity_digest,
    reason: suppressionReason(row.reason),
    erasedAt: new Date(row.erased_at).toISOString(),
  });
}

export function suppressionReason(value: string): SourceSuppressionRecord['reason'] {
  if (value !== 'customer_request' && value !== 'source_access_revoked') {
    throw new Error('source suppression reason is invalid');
  }
  return value;
}

export function requiredMode(value: SourceBindingRecord['scanMode']): 'snapshot' | 'changes' {
  if (value !== 'snapshot' && value !== 'changes') throw new Error('source scan mode is missing');
  return value;
}

export function requiredCursor(value: string | undefined): string {
  if (value === undefined) throw new Error('source continuation is missing');
  return value;
}

export function requiredRow<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('source binding mutation returned no row');
  return value;
}
