import type { Pool, PoolClient } from 'pg';
import { postgresQueryExecutor } from '../store/postgres-transaction.js';
import type { PayloadCipher } from './contracts.js';
import { sourceTransaction as inTransaction } from './source-custody-postgres.js';
import type {
  ExternalRecord,
  ExternalRecordListRequest,
  ExternalRecordLookup,
  ExternalRecordPage,
  SourceBindingCreate,
  SourceBindingKey,
  SourceBindingMutationResult,
  SourceBindingRecord,
  SourceIngestionLease,
  SourceIngestionStore,
  SourcePageCommitResult,
  SourceRefreshRequestResult,
  SourceScanPage,
  SourceScanRecord,
  SourceSuppressionRecord,
} from './source-ingestion-contracts.js';
import { sourceFailureHealth } from './source-ingestion-failures.js';
import {
  type ExternalSourceRow,
  type SourceBindingRow,
  sealExternalSourceContent,
  sealSourceBindingContent,
  sourceBindingFromRow,
} from './source-ingestion-postgres-codec.js';
import {
  getPostgresExternalRecord,
  listPostgresExternalRecords,
  purgePostgresExternalRecords,
} from './source-ingestion-postgres-records.js';
import {
  externalRecordId,
  replaceSourceBinding,
  requestSourceRefresh,
  setSourceRefreshJobState,
} from './source-ingestion-postgres-refresh.js';
import { ensureSourceIngestionSchema } from './source-ingestion-postgres-schema.js';
import {
  bindingContent,
  bindingWhere,
  leaseFrom,
  ownsLease,
  requiredCursor,
  requiredMode,
  requiredRow,
  type SuppressionRow,
  selectBindingForUpdate,
  selectBindingWithClock,
  suppressionFromRow,
  suppressionReason,
  validatePage,
} from './source-ingestion-postgres-state.js';
import {
  normalizeSourceBindingCreate,
  normalizeSourceSuppression,
  sourceBindingFingerprint,
  sourceBindingValues,
  sourceIdentityDigest,
  sourceInteger,
  sourceJsonDigest,
  sourceToken,
} from './source-ingestion-validation.js';
import { validateManagedPayload, validateScalar } from './validation.js';

export interface PostgresSourceIngestionStoreOptions {
  readonly identityKey: string;
}

/** Portable production adapter. PostgreSQL is authoritative for replicas and ingestion coordination. */
export class PostgresSourceIngestionStore implements SourceIngestionStore {
  readonly #pool: Pool;
  readonly #cipher: PayloadCipher;
  readonly #identityKey: string;

  constructor(pool: Pool, cipher: PayloadCipher, options: PostgresSourceIngestionStoreOptions) {
    if (typeof cipher?.seal !== 'function' || typeof cipher.open !== 'function') {
      throw new Error('Postgres source ingestion persistence requires a payload cipher');
    }
    if (Buffer.byteLength(options.identityKey, 'utf8') < 32) {
      throw new Error('source identity key must contain at least 32 bytes');
    }
    this.#pool = pool;
    this.#cipher = cipher;
    this.#identityKey = options.identityKey;
  }

  ensureSchema(): Promise<void> {
    return ensureSourceIngestionSchema(this.#pool);
  }

  async createBinding(input: SourceBindingCreate): Promise<SourceBindingRecord> {
    return inTransaction(
      this.#pool,
      async () => {
        const normalized = normalizeSourceBindingCreate(input);
        const fingerprint = sourceBindingFingerprint(normalized);
        const content = await sealSourceBindingContent(
          this.#cipher,
          normalized,
          bindingContent(normalized),
        );
        const values = sourceBindingValues(normalized);
        const inserted = await postgresQueryExecutor(this.#pool).query<SourceBindingRow>(
          `INSERT INTO business_source_bindings (
        org_slug, app_slug, environment, installation_id, collection_key, binding_id,
        binding_generation, schema_version, schema_digest, query_fingerprint,
        retention_days, poll_interval_ms, state, health, completeness, revision,
        fence, scan_generation, next_attempt_at, content_ciphertext, create_fingerprint,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        'active','initializing','incomplete',1,0,0,clock_timestamp(),$13::jsonb,$14,
        clock_timestamp(),clock_timestamp()
      ) ON CONFLICT DO NOTHING RETURNING *`,
          [
            ...values,
            normalized.generation,
            normalized.schemaVersion,
            normalized.schemaDigest,
            normalized.queryFingerprint,
            normalized.retentionDays,
            normalized.pollIntervalMs,
            JSON.stringify(content),
            fingerprint,
          ],
        );
        const row = inserted.rows[0];
        if (row !== undefined) return sourceBindingFromRow(row, this.#cipher);
        const existing = await this.#selectBinding(normalized);
        if (existing === undefined)
          throw new Error('source binding conflict could not be resolved');
        if (existing.create_fingerprint !== fingerprint) {
          throw new Error('source binding already exists with different immutable configuration');
        }
        return sourceBindingFromRow(existing, this.#cipher);
      },
      input.scope.org,
    );
  }

  async getBinding(input: SourceBindingKey): Promise<SourceBindingRecord | undefined> {
    const row = await this.#selectBinding(input);
    return row === undefined ? undefined : sourceBindingFromRow(row, this.#cipher);
  }

  replaceBinding(
    input: SourceBindingCreate & { readonly expectedRevision: number; readonly now: Date },
  ): Promise<SourceBindingMutationResult> {
    return replaceSourceBinding(this.#pool, this.#cipher, input);
  }

  setBindingState(
    input: SourceBindingKey & {
      readonly expectedRevision: number;
      readonly state: 'active' | 'paused';
      readonly now: Date;
    },
  ): Promise<SourceBindingMutationResult> {
    return inTransaction(
      this.#pool,
      async (client) => {
        const row = await selectBindingForUpdate(client, input);
        if (row === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
        const current = await sourceBindingFromRow(row, this.#cipher);
        if (current.revision !== input.expectedRevision) {
          return { ok: false, reason: 'conflict', currentRevision: current.revision };
        }
        if (current.state === 'revoked' || current.state === input.state) {
          return { ok: false, reason: 'invalid_state', currentRevision: current.revision };
        }
        const health =
          input.state === 'paused'
            ? 'paused'
            : current.lastSuccessfulSyncAt === undefined
              ? 'initializing'
              : 'stale';
        const updated = await client.query<SourceBindingRow>(
          `UPDATE business_source_bindings SET
          state=$7, health=$8, lease_owner=NULL, lease_expires_at=NULL,
          next_attempt_at=CASE WHEN $7='active' THEN clock_timestamp() ELSE next_attempt_at END,
          revision=revision+1, updated_at=clock_timestamp()
        WHERE ${bindingWhere(1)} RETURNING *`,
          [...sourceBindingValues(input), input.state, health],
        );
        return {
          ok: true,
          binding: await sourceBindingFromRow(requiredRow(updated.rows[0]), this.#cipher),
        };
      },
      input.scope.org,
    );
  }

  requestRefresh(
    input: SourceBindingKey & {
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
      readonly now: Date;
    },
  ): Promise<SourceRefreshRequestResult> {
    return requestSourceRefresh(this.#pool, this.#cipher, input);
  }

  async claimDue(input: {
    readonly now: Date;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<SourceIngestionLease | undefined> {
    const owner = validateScalar('source worker id', input.workerId, 128);
    const leaseMs = sourceInteger('source lease', input.leaseMs, 1_000, 15 * 60_000);
    const candidates = await postgresQueryExecutor(this.#pool).query<{
      org_slug: string;
    }>(`SELECT org_slug
      FROM business_source_bindings WHERE state='active' AND COALESCE(next_attempt_at,created_at)<=clock_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY COALESCE(next_attempt_at,created_at),updated_at LIMIT 1`);
    const org = candidates.rows[0]?.org_slug;
    if (org === undefined) return undefined;
    return inTransaction(
      this.#pool,
      async (client) => {
        const selected = await client.query<SourceBindingRow>(
          `
        SELECT * FROM business_source_bindings
        WHERE state='active' AND org_slug=$1
          AND COALESCE(next_attempt_at, created_at) <= clock_timestamp()
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY COALESCE(next_attempt_at, created_at), updated_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      `,
          [org],
        );
        const row = selected.rows[0];
        if (row === undefined) return undefined;
        const current = await sourceBindingFromRow(row, this.#cipher);
        const continuing = current.cursor !== undefined;
        const mode = continuing
          ? requiredMode(current.scanMode)
          : current.checkpoint === undefined
            ? 'snapshot'
            : 'changes';
        const scanGeneration = continuing ? current.scanGeneration : current.scanGeneration + 1;
        const updated = await client.query<SourceBindingRow>(
          `UPDATE business_source_bindings SET
          health=CASE WHEN last_successful_sync_at IS NULL THEN 'initializing' ELSE 'stale' END,
          completeness='incomplete', scan_mode=$7, scan_generation=$8, fence=fence+1,
          lease_owner=$9, lease_expires_at=clock_timestamp()+($10 * interval '1 millisecond'),
          revision=revision+1, updated_at=clock_timestamp()
        WHERE ${bindingWhere(1)} RETURNING *`,
          [...sourceBindingValues(current), mode, scanGeneration, owner, leaseMs],
        );
        const binding = await sourceBindingFromRow(requiredRow(updated.rows[0]), this.#cipher);
        await setSourceRefreshJobState(client, binding, 'running');
        return leaseFrom(binding, owner, leaseMs);
      },
      org,
    );
  }

  commitPage(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly page: SourceScanPage;
  }): Promise<SourcePageCommitResult> {
    validatePage(input.page);
    return inTransaction(
      this.#pool,
      async (client) => {
        const selected = await selectBindingWithClock(client, input.lease.binding);
        if (selected === undefined || !ownsLease(selected, input.lease, false)) {
          return { ok: false, reason: 'stale_fence' };
        }
        const current = await sourceBindingFromRow(selected, this.#cipher);
        if (current.cursor !== input.lease.cursor) return { ok: false, reason: 'stale_cursor' };
        for (const record of input.page.records) {
          await this.#upsertExternal(client, current, input.lease.scanGeneration, record);
        }
        for (const sourceId of input.page.deletedIds) {
          await this.#eraseExternal(
            client,
            current,
            sourceIdentityDigest(this.#identityKey, current, sourceId),
          );
        }
        if (input.page.complete) {
          return this.#completePage(client, current, input.lease, input.page);
        }
        const nextCursor = sourceToken('source cursor', requiredCursor(input.page.nextCursor));
        const sealed = await sealSourceBindingContent(
          this.#cipher,
          current,
          bindingContent(current, nextCursor, current.checkpoint),
        );
        const updated = await client.query<SourceBindingRow>(
          `UPDATE business_source_bindings SET
          lease_expires_at=clock_timestamp()+($7 * interval '1 millisecond'),
          content_ciphertext=$8::jsonb, revision=revision+1, updated_at=clock_timestamp()
        WHERE ${bindingWhere(1)} RETURNING *`,
          [...sourceBindingValues(current), input.lease.leaseMs, JSON.stringify(sealed)],
        );
        const binding = await sourceBindingFromRow(requiredRow(updated.rows[0]), this.#cipher);
        return {
          ok: true,
          binding,
          lease: leaseFrom(binding, input.lease.owner, input.lease.leaseMs),
        };
      },
      input.lease.binding.scope.org,
    );
  }

  resetCheckpoint(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly errorCode: string;
  }): Promise<boolean> {
    return inTransaction(
      this.#pool,
      async (client) => {
        const selected = await selectBindingWithClock(client, input.lease.binding);
        if (selected === undefined || !ownsLease(selected, input.lease, false)) return false;
        const current = await sourceBindingFromRow(selected, this.#cipher);
        const sealed = await sealSourceBindingContent(
          this.#cipher,
          current,
          bindingContent(current),
        );
        await client.query(
          `UPDATE business_source_bindings SET
          health=CASE WHEN last_successful_sync_at IS NULL THEN 'initializing' ELSE 'stale' END,
          completeness='incomplete', scan_mode=NULL, lease_owner=NULL, lease_expires_at=NULL,
          next_attempt_at=clock_timestamp(), error_code=$7, content_ciphertext=$8::jsonb,
          revision=revision+1, updated_at=clock_timestamp()
        WHERE ${bindingWhere(1)}`,
          [
            ...sourceBindingValues(current),
            validateScalar('source error code', input.errorCode, 80),
            JSON.stringify(sealed),
          ],
        );
        await setSourceRefreshJobState(client, current, 'queued');
        return true;
      },
      input.lease.binding.scope.org,
    );
  }

  failLease(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly errorCode: string;
    readonly retryAt: Date;
  }): Promise<boolean> {
    return inTransaction(
      this.#pool,
      async (client) => {
        const selected = await selectBindingWithClock(client, input.lease.binding);
        if (selected === undefined || !ownsLease(selected, input.lease, true)) return false;
        const delayMs = Math.max(1_000, input.retryAt.getTime() - input.now.getTime());
        sourceInteger('source retry delay', delayMs, 1_000, 86_400_000);
        await client.query(
          `UPDATE business_source_bindings SET
          health=$7, completeness='incomplete', lease_owner=NULL, lease_expires_at=NULL,
          error_code=$8, next_attempt_at=clock_timestamp()+($9 * interval '1 millisecond'),
          revision=revision+1, updated_at=clock_timestamp()
        WHERE ${bindingWhere(1)}`,
          [
            ...sourceBindingValues(input.lease.binding),
            sourceFailureHealth(input.errorCode),
            validateScalar('source error code', input.errorCode, 80),
            delayMs,
          ],
        );
        await setSourceRefreshJobState(client, input.lease.binding, 'queued');
        return true;
      },
      input.lease.binding.scope.org,
    );
  }

  async listExternalRecords(input: ExternalRecordListRequest): Promise<ExternalRecordPage> {
    return listPostgresExternalRecords(this.#pool, this.#cipher, input);
  }

  async getExternalRecord(input: ExternalRecordLookup): Promise<ExternalRecord | undefined> {
    return getPostgresExternalRecord(this.#pool, this.#cipher, input);
  }

  suppressExternalRecord(
    input: SourceBindingKey & {
      readonly sourceId: string;
      readonly reason: SourceSuppressionRecord['reason'];
      readonly now: Date;
    },
  ): Promise<void> {
    return inTransaction(
      this.#pool,
      async (client) => {
        const row = await selectBindingForUpdate(client, input);
        if (row === undefined) throw new Error('source binding not found');
        const binding = await sourceBindingFromRow(row, this.#cipher);
        const reason = suppressionReason(input.reason);
        const digest = sourceIdentityDigest(this.#identityKey, binding, input.sourceId);
        await client.query(
          `INSERT INTO business_source_suppressions (
          org_slug, app_slug, environment, installation_id, collection_key, binding_id,
          binding_generation, source_identity_digest, reason, erased_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
        ON CONFLICT DO NOTHING`,
          [...sourceBindingValues(binding), binding.generation, digest, reason],
        );
        await this.#eraseExternal(client, binding, digest);
      },
      input.scope.org,
    );
  }

  async listSuppressions(input: SourceBindingKey): Promise<readonly SourceSuppressionRecord[]> {
    const result = await postgresQueryExecutor(this.#pool).query<SuppressionRow>(
      `SELECT * FROM business_source_suppressions
       WHERE ${bindingWhere(1)} ORDER BY source_identity_digest`,
      sourceBindingValues(input),
    );
    return result.rows.map(suppressionFromRow);
  }

  restoreSuppressions(input: readonly SourceSuppressionRecord[]): Promise<void> {
    return inTransaction(
      this.#pool,
      async (client) => {
        for (const raw of input) {
          const item = normalizeSourceSuppression(raw);
          const row = await selectBindingForUpdate(client, item);
          if (row === undefined || Number(row.binding_generation) !== item.bindingGeneration) {
            throw new Error('source suppression does not match an active binding generation');
          }
          const binding = await sourceBindingFromRow(row, this.#cipher);
          await client.query(
            `INSERT INTO business_source_suppressions (
            org_slug, app_slug, environment, installation_id, collection_key, binding_id,
            binding_generation, source_identity_digest, reason, erased_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT DO NOTHING`,
            [
              ...sourceBindingValues(item),
              item.bindingGeneration,
              item.sourceIdentityDigest,
              item.reason,
              item.erasedAt,
            ],
          );
          await this.#eraseExternal(client, binding, item.sourceIdentityDigest);
        }
      },
      input.map((row) => row.scope.org),
    );
  }

  async purgeExpired(input: { readonly limit?: number }): Promise<number> {
    const limit = sourceInteger('source retention limit', input.limit ?? 100, 1, 100);
    return purgePostgresExternalRecords(this.#pool, limit);
  }

  async #selectBinding(
    input: SourceBindingKey,
  ): Promise<(SourceBindingRow & { create_fingerprint: string }) | undefined> {
    const result = await postgresQueryExecutor(this.#pool).query<
      SourceBindingRow & { create_fingerprint: string }
    >(
      `SELECT * FROM business_source_bindings WHERE ${bindingWhere(1)}`,
      sourceBindingValues(input),
    );
    return result.rows[0];
  }

  async #upsertExternal(
    client: PoolClient,
    binding: SourceBindingRecord,
    scanGeneration: number,
    source: SourceScanRecord,
  ): Promise<void> {
    const sourceId = sourceToken('source record id', source.id);
    const digest = sourceIdentityDigest(this.#identityKey, binding, sourceId);
    const suppressed = await client.query(
      `SELECT 1 FROM business_source_suppressions
       WHERE ${bindingWhere(1)} AND binding_generation=$7 AND source_identity_digest=$8`,
      [...sourceBindingValues(binding), binding.generation, digest],
    );
    if ((suppressed.rowCount ?? 0) > 0) return;
    const content = validateManagedPayload(source.record);
    const contentDigest = sourceJsonDigest({ record: content, version: source.version });
    const existing = await client.query<
      ExternalSourceRow & { content_digest: string; last_seen_generation: string | number }
    >(
      `SELECT * FROM business_external_records
       WHERE ${bindingWhere(1)} AND binding_generation=$7 AND source_identity_digest=$8
       FOR UPDATE`,
      [...sourceBindingValues(binding), binding.generation, digest],
    );
    const current = existing.rows[0];
    if (
      current !== undefined &&
      current.content_digest === contentDigest &&
      current.deleted_at === null
    ) {
      await client.query(
        `UPDATE business_external_records SET
          last_seen_generation=$9, observed_at=clock_timestamp(), updated_at=clock_timestamp(),
          retention_expires_at=clock_timestamp()+($10 * interval '1 day')
         WHERE ${bindingWhere(1)} AND binding_generation=$7 AND source_identity_digest=$8`,
        [
          ...sourceBindingValues(binding),
          binding.generation,
          digest,
          scanGeneration,
          binding.retentionDays,
        ],
      );
      return;
    }
    const revision = current === undefined ? 1 : Number(current.revision) + 1;
    const recordId = current?.record_id ?? externalRecordId(binding, digest);
    const sealed = await sealExternalSourceContent(
      this.#cipher,
      binding,
      recordId,
      revision,
      sourceId,
      source.version,
      content,
    );
    await client.query(
      `INSERT INTO business_external_records (
        org_slug, app_slug, environment, installation_id, collection_key, binding_id,
        binding_generation, source_identity_digest, record_id, schema_version, schema_digest,
        revision, content_digest, last_seen_generation, completeness, observed_at,
        retention_expires_at, created_at, updated_at, content_ciphertext
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'complete',clock_timestamp(),
        clock_timestamp()+($15 * interval '1 day'),clock_timestamp(),clock_timestamp(),$16::jsonb
      ) ON CONFLICT (
        org_slug, app_slug, environment, installation_id, collection_key,
        binding_id, binding_generation, source_identity_digest
      ) DO UPDATE SET
        schema_version=EXCLUDED.schema_version, schema_digest=EXCLUDED.schema_digest,
        revision=EXCLUDED.revision, content_digest=EXCLUDED.content_digest,
        last_seen_generation=EXCLUDED.last_seen_generation, completeness='complete',
        observed_at=clock_timestamp(), updated_at=clock_timestamp(), deleted_at=NULL,
        retention_expires_at=EXCLUDED.retention_expires_at,
        content_ciphertext=EXCLUDED.content_ciphertext`,
      [
        ...sourceBindingValues(binding),
        binding.generation,
        digest,
        recordId,
        binding.schemaVersion,
        binding.schemaDigest,
        revision,
        contentDigest,
        scanGeneration,
        binding.retentionDays,
        JSON.stringify(sealed),
      ],
    );
  }

  async #eraseExternal(
    client: PoolClient,
    binding: SourceBindingRecord,
    digest: string,
  ): Promise<void> {
    await client.query(
      `UPDATE business_external_records SET
        revision=revision+1, completeness='complete', observed_at=clock_timestamp(),
        updated_at=clock_timestamp(), deleted_at=clock_timestamp(), content_ciphertext=NULL
       WHERE ${bindingWhere(1)} AND binding_generation=$7 AND source_identity_digest=$8
         AND deleted_at IS NULL`,
      [...sourceBindingValues(binding), binding.generation, digest],
    );
  }

  async #completePage(
    client: PoolClient,
    binding: SourceBindingRecord,
    lease: SourceIngestionLease,
    page: SourceScanPage,
  ): Promise<SourcePageCommitResult> {
    if (lease.mode === 'snapshot') {
      await client.query(
        `UPDATE business_external_records SET
          revision=revision+1, completeness='complete', observed_at=clock_timestamp(),
          updated_at=clock_timestamp(), deleted_at=clock_timestamp(), content_ciphertext=NULL
         WHERE ${bindingWhere(1)} AND binding_generation=$7
           AND last_seen_generation<>$8 AND deleted_at IS NULL`,
        [...sourceBindingValues(binding), binding.generation, lease.scanGeneration],
      );
    }
    const checkpoint =
      page.checkpoint === undefined
        ? lease.mode === 'changes'
          ? binding.checkpoint
          : undefined
        : sourceToken('source checkpoint', page.checkpoint);
    const sealed = await sealSourceBindingContent(
      this.#cipher,
      binding,
      bindingContent(binding, undefined, checkpoint),
    );
    await setSourceRefreshJobState(client, binding, 'completed');
    const pending = await client.query(
      `SELECT 1 FROM business_source_refresh_requests
      WHERE ${bindingWhere(1)} AND binding_generation=$7 AND state IN ('queued','running') LIMIT 1`,
      [...sourceBindingValues(binding), binding.generation],
    );
    const updated = await client.query<SourceBindingRow>(
      `UPDATE business_source_bindings SET
        health=CASE WHEN $8 THEN 'stale' ELSE 'current' END, completeness='complete', scan_mode=NULL,
        lease_owner=NULL, lease_expires_at=NULL, error_code=NULL,
        last_successful_sync_at=clock_timestamp(),
        next_attempt_at=clock_timestamp()+((CASE WHEN $8 THEN 0 ELSE poll_interval_ms END) * interval '1 millisecond'),
        content_ciphertext=$7::jsonb, revision=revision+1, updated_at=clock_timestamp()
      WHERE ${bindingWhere(1)} RETURNING *`,
      [...sourceBindingValues(binding), JSON.stringify(sealed), (pending.rowCount ?? 0) > 0],
    );
    await client.query(
      `UPDATE business_external_records SET last_successful_sync_at=clock_timestamp()
       WHERE ${bindingWhere(1)} AND binding_generation=$7 AND deleted_at IS NULL`,
      [...sourceBindingValues(binding), binding.generation],
    );
    return {
      ok: true,
      binding: await sourceBindingFromRow(requiredRow(updated.rows[0]), this.#cipher),
    };
  }
}
