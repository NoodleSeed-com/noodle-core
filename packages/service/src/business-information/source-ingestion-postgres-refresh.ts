import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { PayloadCipher } from './contracts.js';
import { sourceTransaction as inTransaction } from './source-custody-postgres.js';
import type {
  SourceBindingCreate,
  SourceBindingKey,
  SourceBindingMutationResult,
  SourceBindingRecord,
  SourceRefreshReceipt,
  SourceRefreshRequestResult,
} from './source-ingestion-contracts.js';
import {
  type SourceBindingContent,
  type SourceBindingRow,
  sealSourceBindingContent,
  sourceBindingFromRow,
} from './source-ingestion-postgres-codec.js';
import {
  normalizeSourceBindingCreate,
  sourceBindingFingerprint,
  sourceBindingValues,
} from './source-ingestion-validation.js';
import { refreshReplayExpiresAt } from './source-refresh-retention.js';
import { validateScalar } from './validation.js';

interface SuppressionRow extends QueryResultRow {
  source_identity_digest: string;
  reason: string;
  erased_at: Date | string;
}

interface RefreshRequestRow extends QueryResultRow {
  job_id: string;
  state: SourceRefreshReceipt['state'];
  requested_at: Date | string;
  terminal_at: Date | string | null;
}

export function replaceSourceBinding(
  pool: Pool,
  cipher: PayloadCipher,
  input: SourceBindingCreate & { readonly expectedRevision: number; readonly now: Date },
): Promise<SourceBindingMutationResult> {
  return inTransaction(
    pool,
    async (client) => {
      const normalized = normalizeSourceBindingCreate(input);
      const row = await selectBindingForUpdate(client, normalized);
      if (row === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      const current = await sourceBindingFromRow(row, cipher);
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      if (normalized.generation <= current.generation) {
        return { ok: false, reason: 'invalid_state', currentRevision: current.revision };
      }
      const carried =
        normalized.bindingReference === current.bindingReference &&
        normalized.credentialIdentity?.account === current.credentialIdentity?.account
          ? await client.query<SuppressionRow>(
              `SELECT source_identity_digest, reason, erased_at
             FROM business_source_suppressions
             WHERE ${bindingWhere(1)} AND binding_generation=$7`,
              [...sourceBindingValues(current), current.generation],
            )
          : undefined;
      await client.query(
        `DELETE FROM business_external_records WHERE ${bindingWhere(1)}`,
        sourceBindingValues(current),
      );
      await client.query(
        `DELETE FROM business_source_suppressions WHERE ${bindingWhere(1)}`,
        sourceBindingValues(current),
      );
      const sealed = await sealSourceBindingContent(cipher, normalized, bindingContent(normalized));
      const updated = await client.query<SourceBindingRow>(
        `UPDATE business_source_bindings SET
        binding_generation=$7, schema_version=$8, schema_digest=$9,
        query_fingerprint=$10, retention_days=$11, poll_interval_ms=$12,
        state='active', health='initializing', completeness='incomplete',
        fence=fence+1, scan_generation=0, scan_mode=NULL,
        lease_owner=NULL, lease_expires_at=NULL, last_successful_sync_at=NULL,
        next_attempt_at=clock_timestamp(), error_code=NULL,
        content_ciphertext=$13::jsonb, create_fingerprint=$14,
        revision=revision+1, updated_at=clock_timestamp()
      WHERE ${bindingWhere(1)} RETURNING *`,
        [
          ...sourceBindingValues(current),
          normalized.generation,
          normalized.schemaVersion,
          normalized.schemaDigest,
          normalized.queryFingerprint,
          normalized.retentionDays,
          normalized.pollIntervalMs,
          JSON.stringify(sealed),
          sourceBindingFingerprint(normalized),
        ],
      );
      for (const suppression of carried?.rows ?? []) {
        await client.query(
          `INSERT INTO business_source_suppressions (
          org_slug, app_slug, environment, installation_id, collection_key, binding_id,
          binding_generation, source_identity_digest, reason, erased_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ...sourceBindingValues(normalized),
            normalized.generation,
            suppression.source_identity_digest,
            suppression.reason,
            suppression.erased_at,
          ],
        );
      }
      await client.query(
        `UPDATE business_source_refresh_requests SET state='superseded',terminal_at=clock_timestamp()
       WHERE ${bindingWhere(1)} AND binding_generation=$7 AND state IN ('queued','running')`,
        [...sourceBindingValues(current), current.generation],
      );
      return {
        ok: true,
        binding: await sourceBindingFromRow(requiredRow(updated.rows[0]), cipher),
      };
    },
    input.scope.org,
  );
}

export function requestSourceRefresh(
  pool: Pool,
  cipher: PayloadCipher,
  input: SourceBindingKey & {
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly now: Date;
  },
): Promise<SourceRefreshRequestResult> {
  return inTransaction(
    pool,
    async (client) => {
      const row = await selectBindingForUpdate(client, input);
      if (row === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      const current = await sourceBindingFromRow(row, cipher);
      const idempotencyDigest = refreshIdempotencyDigest(input.idempotencyKey);
      const replay = await client.query<RefreshRequestRow>(
        `SELECT * FROM business_source_refresh_requests
       WHERE ${bindingWhere(1)} AND binding_generation=$7 AND idempotency_digest=$8`,
        [...sourceBindingValues(current), current.generation, idempotencyDigest],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        return { ok: true, binding: current, receipt: refreshReceipt(replayRow, true) };
      }
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      if (current.state !== 'active') {
        return { ok: false, reason: 'invalid_state', currentRevision: current.revision };
      }
      const targetScanGeneration = current.scanGeneration + 1;
      const pending = await client.query<RefreshRequestRow>(
        `SELECT * FROM business_source_refresh_requests
       WHERE ${bindingWhere(1)} AND binding_generation=$7 AND target_scan_generation=$8 AND state IN ('queued','running')
       ORDER BY requested_at LIMIT 1`,
        [...sourceBindingValues(current), current.generation, targetScanGeneration],
      );
      const pendingRow = pending.rows[0];
      const jobId =
        pendingRow?.job_id ??
        refreshJobId(current, current.generation, idempotencyDigest, targetScanGeneration);
      const state = pendingRow?.state ?? 'queued';
      const requestedAt = pendingRow?.requested_at ?? input.now;
      const inserted = await client.query<RefreshRequestRow>(
        `INSERT INTO business_source_refresh_requests (
        org_slug, app_slug, environment, installation_id, collection_key, binding_id,
        binding_generation, idempotency_digest, job_id, state, requested_at, target_scan_generation
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          ...sourceBindingValues(current),
          current.generation,
          idempotencyDigest,
          jobId,
          state,
          requestedAt,
          targetScanGeneration,
        ],
      );
      const updated = await client.query<SourceBindingRow>(
        `UPDATE business_source_bindings SET
        next_attempt_at=clock_timestamp(), revision=revision+1, updated_at=clock_timestamp()
      WHERE ${bindingWhere(1)} RETURNING *`,
        sourceBindingValues(input),
      );
      return {
        ok: true,
        binding: await sourceBindingFromRow(requiredRow(updated.rows[0]), cipher),
        receipt: refreshReceipt(requiredRow(inserted.rows[0]), pendingRow !== undefined),
      };
    },
    input.scope.org,
  );
}

export async function setSourceRefreshJobState(
  client: PoolClient,
  binding: SourceBindingRecord,
  state: SourceRefreshReceipt['state'],
): Promise<void> {
  await client.query(
    `UPDATE business_source_refresh_requests SET state=$8,
      terminal_at=CASE WHEN $8='completed' THEN clock_timestamp() ELSE NULL END
     WHERE ${bindingWhere(1)} AND binding_generation=$7 AND target_scan_generation<=$9 AND state IN ('queued','running')`,
    [...sourceBindingValues(binding), binding.generation, state, binding.scanGeneration],
  );
}

export function externalRecordId(binding: SourceBindingRecord, digest: string): string {
  return `ext_${createHash('sha256')
    .update(digest)
    .update('\0')
    .update(String(binding.generation))
    .digest('hex')
    .slice(0, 32)}`;
}

async function selectBindingForUpdate(
  client: PoolClient,
  input: SourceBindingKey,
): Promise<SourceBindingRow | undefined> {
  const result = await client.query<SourceBindingRow>(
    `SELECT * FROM business_source_bindings WHERE ${bindingWhere(1)} FOR UPDATE`,
    sourceBindingValues(input),
  );
  return result.rows[0];
}

function bindingWhere(offset: number): string {
  return `org_slug=$${offset} AND app_slug=$${offset + 1} AND environment=$${offset + 2}
    AND installation_id=$${offset + 3} AND collection_key=$${offset + 4} AND binding_id=$${offset + 5}`;
}

function bindingContent(binding: SourceBindingCreate): SourceBindingContent {
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
  };
}

function refreshIdempotencyDigest(value: string): string {
  return createHash('sha256')
    .update(validateScalar('source refresh idempotency key', value, 256))
    .digest('hex');
}

function refreshJobId(
  binding: SourceBindingKey,
  generation: number,
  digest: string,
  scanGeneration: number,
): string {
  return `sync_${createHash('sha256')
    .update(sourceBindingValues(binding).join('\0'))
    .update('\0')
    .update(String(generation))
    .update('\0')
    .update(digest)
    .update('\0')
    .update(String(scanGeneration))
    .digest('hex')
    .slice(0, 24)}`;
}

function refreshReceipt(row: RefreshRequestRow, coalesced: boolean): SourceRefreshReceipt {
  return {
    id: validateScalar('source refresh job id', row.job_id, 128),
    state: refreshState(row.state),
    coalesced,
    requestedAt: new Date(row.requested_at).toISOString(),
    ...(row.terminal_at == null
      ? {}
      : { replayExpiresAt: refreshReplayExpiresAt(new Date(row.terminal_at).toISOString()) }),
  };
}

function refreshState(value: string): SourceRefreshReceipt['state'] {
  if (
    value !== 'queued' &&
    value !== 'running' &&
    value !== 'completed' &&
    value !== 'superseded'
  ) {
    throw new Error('stored source refresh state is invalid');
  }
  return value;
}

function requiredRow<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('source binding mutation returned no row');
  return value;
}
