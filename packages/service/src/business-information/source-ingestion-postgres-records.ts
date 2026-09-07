import type { Pool } from 'pg';
import { postgresQueryExecutor } from '../store/postgres-transaction.js';
import type { PayloadCipher } from './contracts.js';
import { SOURCE_REFRESH_REPLAY_MS } from './source-custody-budget.js';
import { sourceTransaction } from './source-custody-postgres.js';
import type {
  ExternalRecord,
  ExternalRecordListRequest,
  ExternalRecordLookup,
  ExternalRecordPage,
} from './source-ingestion-contracts.js';
import {
  decodeExternalRecordCursor,
  encodeExternalRecordCursor,
  externalRecordPageLimit,
} from './source-ingestion-pagination.js';
import {
  type ExternalSourceRow,
  externalSourceFromRow,
} from './source-ingestion-postgres-codec.js';
import { sourceBindingValues, sourceDigest } from './source-ingestion-validation.js';
import { prunePostgresRefreshReceipts } from './source-refresh-retention.js';
import { validateScalar } from './validation.js';

export async function listPostgresExternalRecords(
  pool: Pool,
  cipher: PayloadCipher,
  input: ExternalRecordListRequest,
): Promise<ExternalRecordPage> {
  const cursor = decodeExternalRecordCursor(input.cursor, input);
  const limit = externalRecordPageLimit(input.limit);
  const result = await postgresQueryExecutor(pool).query<ExternalSourceRow>(
    `SELECT records.* FROM business_external_records AS records
     JOIN business_source_bindings AS bindings ON ${bindingJoin()}
     WHERE ${recordBindingWhere(1)} AND records.binding_generation=$7
       AND bindings.state<>'revoked' AND bindings.health<>'reauth_required'
       AND records.deleted_at IS NULL AND records.retention_expires_at>clock_timestamp()
       AND ($8::text IS NULL OR records.source_identity_digest>$8)
     ORDER BY records.source_identity_digest LIMIT $9`,
    [...sourceBindingValues(input), input.generation, cursor ?? null, limit + 1],
  );
  const selected = result.rows.slice(0, limit);
  const records = await Promise.all(selected.map((row) => externalSourceFromRow(row, cipher)));
  records.sort((left, right) => left.source.id.localeCompare(right.source.id));
  const last = selected.at(-1);
  return {
    records,
    ...(result.rows.length > limit && last !== undefined
      ? {
          nextCursor: encodeExternalRecordCursor(
            input,
            sourceDigest('source identity digest', last.source_identity_digest),
          ),
        }
      : {}),
  };
}

export async function getPostgresExternalRecord(
  pool: Pool,
  cipher: PayloadCipher,
  input: ExternalRecordLookup,
): Promise<ExternalRecord | undefined> {
  const result = await postgresQueryExecutor(pool).query<ExternalSourceRow>(
    `SELECT records.* FROM business_external_records AS records
     JOIN business_source_bindings AS bindings ON ${bindingJoin()}
     WHERE ${recordBindingWhere(1)} AND records.binding_generation=$7
       AND records.record_id=$8 AND records.deleted_at IS NULL
       AND records.retention_expires_at>clock_timestamp()
       AND bindings.state<>'revoked' AND bindings.health<>'reauth_required'
     LIMIT 2`,
    [
      ...sourceBindingValues(input),
      input.generation,
      validateScalar('external record id', input.recordId, 128),
    ],
  );
  if (result.rows.length > 1) throw new Error('external record identity collision');
  const row = result.rows[0];
  return row === undefined ? undefined : externalSourceFromRow(row, cipher);
}

export async function purgePostgresExternalRecords(pool: Pool, limit: number): Promise<number> {
  const candidates = await postgresQueryExecutor(pool).query<{ org_slug: string }>(
    `SELECT DISTINCT org_slug FROM (
    (SELECT org_slug FROM business_external_records WHERE deleted_at IS NULL AND retention_expires_at<=clock_timestamp()
      ORDER BY retention_expires_at LIMIT $1)
    UNION ALL (SELECT org_slug FROM business_source_refresh_requests WHERE state IN ('completed','superseded')
      AND terminal_at<=clock_timestamp()-($2 * interval '1 millisecond') ORDER BY terminal_at LIMIT $1)
  ) expired`,
    [limit, SOURCE_REFRESH_REPLAY_MS],
  );
  const organizations = candidates.rows.map((row) => row.org_slug);
  if (organizations.length === 0) return 0;
  return sourceTransaction(
    pool,
    async (client) => {
      const result = await client.query(
        `WITH expired AS (
       SELECT org_slug, app_slug, environment, installation_id, collection_key,
         binding_id, binding_generation, source_identity_digest
       FROM business_external_records
       WHERE org_slug=ANY($2::text[]) AND deleted_at IS NULL AND retention_expires_at <= clock_timestamp()
       ORDER BY retention_expires_at, source_identity_digest
       LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE business_external_records AS records SET
       revision=records.revision+1, completeness='complete',
       observed_at=clock_timestamp(), updated_at=clock_timestamp(),
       deleted_at=clock_timestamp(), content_ciphertext=NULL
     FROM expired
     WHERE records.org_slug=expired.org_slug
       AND records.app_slug=expired.app_slug
       AND records.environment=expired.environment
       AND records.installation_id=expired.installation_id
       AND records.collection_key=expired.collection_key
       AND records.binding_id=expired.binding_id
       AND records.binding_generation=expired.binding_generation
       AND records.source_identity_digest=expired.source_identity_digest`,
        [limit, organizations],
      );
      const records = result.rowCount ?? 0;
      return records + (await prunePostgresRefreshReceipts(client, organizations, limit - records));
    },
    organizations,
  );
}

function bindingJoin(): string {
  return `bindings.org_slug=records.org_slug AND bindings.app_slug=records.app_slug
    AND bindings.environment=records.environment
    AND bindings.installation_id=records.installation_id
    AND bindings.collection_key=records.collection_key AND bindings.binding_id=records.binding_id
    AND bindings.binding_generation=records.binding_generation`;
}

function recordBindingWhere(offset: number): string {
  return `records.org_slug=$${offset} AND records.app_slug=$${offset + 1}
    AND records.environment=$${offset + 2} AND records.installation_id=$${offset + 3}
    AND records.collection_key=$${offset + 4} AND records.binding_id=$${offset + 5}`;
}
