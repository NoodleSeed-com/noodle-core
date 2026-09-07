import { createHash, randomUUID } from 'node:crypto';
import { insertAuditEvent } from '@noodle-borg/module-audit';
import {
  APP_PURGE_RECONCILIATION_PREVIEW_TTL_MS,
  APP_PURGE_RECONCILIATION_SCHEMA_VERSION,
  AppPurgeReconciliationApplyRequestSchema,
  type AppPurgeReconciliationApplyRequestV1,
  AppPurgeReconciliationApplyResponseSchema,
  type AppPurgeReconciliationApplyResponseV1,
  AppPurgeReconciliationApplyResultSchema,
  type AppPurgeReconciliationApplyResultV1,
  type AppPurgeReconciliationCandidateV1,
  AppPurgeReconciliationPreviewArtifactSchema,
  type AppPurgeReconciliationPreviewArtifactV1,
  AppPurgeReconciliationPreviewRequestSchema,
  type AppPurgeReconciliationUnsignedPreviewArtifactV1,
  appPurgeReconciliationChecksumPayload,
} from '@noodle-borg/wire-contracts';
import type { Pool, PoolClient } from 'pg';
import { computeAppPurgeReconciliationChecksum } from './app-purge-reconciliation.js';
import {
  type AppPurgeReconciliationActor,
  AppPurgeReconciliationError,
  type AppPurgeReconciliationOperator,
} from './app-purge-reconciliation-port.js';

interface PreviewCandidateRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly created_at: Date | string;
  readonly purge_audit_id: string;
}

interface AppAnchorRow {
  readonly created_at: Date | string;
}

interface EnvironmentRow {
  readonly name: string;
  readonly is_production: boolean;
  readonly created_at: Date | string;
}

interface AuditIdentityRow {
  readonly id: string;
}

interface ReceiptRow {
  readonly request_fingerprint: string;
  readonly actor_subject_hash: string;
  readonly safe_result: unknown;
}

/** PostgreSQL-authoritative exact-set repair defined by ADR 0225. */
export class PostgresAppPurgeReconciliationOperator implements AppPurgeReconciliationOperator {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async preview(input: {
    readonly releaseSha: string;
    readonly limit: number;
    readonly now: Date;
  }): Promise<AppPurgeReconciliationPreviewArtifactV1> {
    const parsed = AppPurgeReconciliationPreviewRequestSchema.parse({
      schemaVersion: APP_PURGE_RECONCILIATION_SCHEMA_VERSION,
      limit: input.limit,
    });
    const limit = parsed.limit;
    if (limit === undefined) throw new Error('app purge reconciliation limit is required');
    const { rows } = await this.#pool.query<PreviewCandidateRow>(
      `SELECT app.org_slug, app.slug AS app_slug, app.created_at,
              purge_audit.id AS purge_audit_id
       FROM apps app
       CROSS JOIN LATERAL (
         SELECT audit.id
         FROM audit_events audit
         WHERE audit.org_slug = app.org_slug
           AND audit.app_slug = app.slug
           AND audit.event_type = 'app.purged'
           AND audit.decision = 'allow'
           AND audit.reason_code = 'retention_elapsed'
           AND audit.created_at >= app.created_at
         ORDER BY audit.created_at DESC, audit.seq DESC
         LIMIT 1
       ) purge_audit
       WHERE NOT EXISTS (
         SELECT 1 FROM deploy_records deployment
         WHERE deployment.org_slug = app.org_slug
           AND deployment.app_slug = app.slug
       )
         AND NOT EXISTS (
           SELECT 1 FROM audit_events reconciliation
           WHERE reconciliation.org_slug = app.org_slug
             AND reconciliation.app_slug = app.slug
             AND reconciliation.event_type = 'app.anchor_reconciled'
             AND reconciliation.details ->> 'purgeAuditId' = purge_audit.id::text
         )
       ORDER BY app.org_slug COLLATE "C", app.slug COLLATE "C"
       LIMIT $1`,
      [limit + 1],
    );
    const truncated = rows.length > limit;
    const selected = rows.slice(0, limit);
    const candidates: AppPurgeReconciliationCandidateV1[] = [];
    for (const row of selected) {
      const environments = await this.loadEnvironments(this.#pool, row.org_slug, row.app_slug);
      candidates.push({
        org: row.org_slug,
        app: row.app_slug,
        anchorCreatedAt: toIso(row.created_at),
        purgeAuditId: row.purge_audit_id,
        environments,
      });
    }
    const unsignedArtifact: AppPurgeReconciliationUnsignedPreviewArtifactV1 = {
      schemaVersion: APP_PURGE_RECONCILIATION_SCHEMA_VERSION,
      releaseSha: input.releaseSha,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(
        input.now.getTime() + APP_PURGE_RECONCILIATION_PREVIEW_TTL_MS,
      ).toISOString(),
      candidateCount: candidates.length,
      truncated,
      candidates,
    };
    return AppPurgeReconciliationPreviewArtifactSchema.parse({
      ...unsignedArtifact,
      checksum: computeAppPurgeReconciliationChecksum(unsignedArtifact),
    });
  }

  async apply(input: {
    readonly request: AppPurgeReconciliationApplyRequestV1;
    readonly actor: AppPurgeReconciliationActor;
    readonly currentReleaseSha: string;
    readonly now: Date;
  }): Promise<AppPurgeReconciliationApplyResponseV1> {
    const request = AppPurgeReconciliationApplyRequestSchema.parse(input.request);
    assertPreviewChecksum(request.preview);
    const idempotencyKeyHash = sha256(request.idempotencyKey);
    const requestFingerprint = reconciliationRequestFingerprint(request);
    const actorSubjectHash = sha256(input.actor.subject);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        idempotencyKeyHash,
      ]);
      const replay = await loadReceipt(client, idempotencyKeyHash);
      if (replay !== undefined) {
        if (
          replay.request_fingerprint !== requestFingerprint ||
          replay.actor_subject_hash !== actorSubjectHash
        ) {
          throw conflict(
            'app_purge_idempotency_conflict',
            'idempotency key was already used by different reconciliation input',
          );
        }
        const result = AppPurgeReconciliationApplyResultSchema.parse(replay.safe_result);
        const response = AppPurgeReconciliationApplyResponseSchema.parse({
          ok: true,
          replayed: true,
          result,
        });
        await client.query('COMMIT');
        return response;
      }

      if (Date.parse(request.preview.createdAt) > input.now.getTime()) {
        throw conflict(
          'app_purge_preview_mismatch',
          'approved reconciliation preview was created in the future',
        );
      }
      if (input.now.getTime() >= Date.parse(request.preview.expiresAt)) {
        throw conflict('app_purge_preview_expired', 'approved reconciliation preview has expired');
      }
      if (
        request.releaseSha !== input.currentReleaseSha ||
        request.preview.releaseSha !== input.currentReleaseSha
      ) {
        throw conflict(
          'app_purge_release_mismatch',
          'approved reconciliation release is not current',
        );
      }

      await lockCandidateAnchors(client, request.preview.candidates);
      for (const candidate of request.preview.candidates) {
        await assertCandidateUnchanged(client, candidate);
      }
      const operationId = randomUUID();
      const result = AppPurgeReconciliationApplyResultSchema.parse({
        operationId,
        previewChecksum: request.preview.checksum,
        releaseSha: request.releaseSha,
        candidateCount: request.preview.candidateCount,
        deletedCount: await deleteCandidateAnchors(client, request.preview.candidates),
        appliedAt: input.now.toISOString(),
      });
      if (result.deletedCount !== result.candidateCount) {
        throw conflict(
          'app_purge_candidate_drift',
          'approved reconciliation candidate set changed',
        );
      }
      for (const candidate of request.preview.candidates) {
        await insertAuditEvent(
          client,
          {
            eventType: 'app.anchor_reconciled',
            org: candidate.org,
            app: candidate.app,
            actorSubject: input.actor.subject,
            ...(input.actor.email === undefined ? {} : { actorEmail: input.actor.email }),
            details: {
              operationId,
              previewChecksum: request.preview.checksum,
              purgeAuditId: candidate.purgeAuditId,
            },
          },
          { now: () => input.now },
        );
      }
      await insertReceipt(client, {
        idempotencyKeyHash,
        requestFingerprint,
        request,
        actorSubjectHash,
        operationId,
        result,
        now: input.now,
      });
      const response = AppPurgeReconciliationApplyResponseSchema.parse({
        ok: true,
        replayed: false,
        result,
      });
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadEnvironments(
    queryable: Pick<Pool, 'query'>,
    org: string,
    app: string,
  ): Promise<AppPurgeReconciliationCandidateV1['environments']> {
    const { rows } = await queryable.query<EnvironmentRow>(
      `SELECT name, is_production, created_at
       FROM environments
       WHERE org_slug = $1 AND app_slug = $2
       ORDER BY name COLLATE "C"`,
      [org, app],
    );
    return rows.map((row) => ({
      name: row.name,
      isProduction: row.is_production,
      createdAt: toIso(row.created_at),
    }));
  }
}

function assertPreviewChecksum(preview: AppPurgeReconciliationPreviewArtifactV1): void {
  const unsigned = unsignedPreview(preview);
  if (computeAppPurgeReconciliationChecksum(unsigned) !== preview.checksum) {
    throw conflict('app_purge_preview_mismatch', 'approved reconciliation checksum is invalid');
  }
}

async function loadReceipt(
  client: PoolClient,
  idempotencyKeyHash: string,
): Promise<ReceiptRow | undefined> {
  const { rows } = await client.query<ReceiptRow>(
    `SELECT request_fingerprint, actor_subject_hash, safe_result
     FROM app_purge_reconciliation_operations
     WHERE idempotency_key_hash = $1
     FOR UPDATE`,
    [idempotencyKeyHash],
  );
  return rows[0];
}

async function lockCandidateAnchors(
  client: PoolClient,
  candidates: readonly AppPurgeReconciliationCandidateV1[],
): Promise<void> {
  for (const candidate of candidates) {
    const { rows } = await client.query<AppAnchorRow>(
      `SELECT created_at FROM apps
       WHERE org_slug = $1 AND slug = $2
       FOR UPDATE`,
      [candidate.org, candidate.app],
    );
    const anchor = rows[0];
    if (anchor === undefined || toIso(anchor.created_at) !== candidate.anchorCreatedAt) {
      throw conflict('app_purge_candidate_drift', 'approved reconciliation candidate set changed');
    }
  }
}

async function assertCandidateUnchanged(
  client: PoolClient,
  candidate: AppPurgeReconciliationCandidateV1,
): Promise<void> {
  const deployment = await client.query(
    `SELECT deployment_id FROM deploy_records
     WHERE org_slug = $1 AND app_slug = $2
     LIMIT 1
     FOR UPDATE`,
    [candidate.org, candidate.app],
  );
  if (deployment.rows[0] !== undefined) {
    throw conflict(
      'app_purge_candidate_drift',
      'approved reconciliation candidate gained a deployment',
    );
  }
  const { rows: environmentRows } = await client.query<EnvironmentRow>(
    `SELECT name, is_production, created_at
     FROM environments
     WHERE org_slug = $1 AND app_slug = $2
     ORDER BY name COLLATE "C"
     FOR UPDATE`,
    [candidate.org, candidate.app],
  );
  if (!sameEnvironments(environmentRows, candidate.environments)) {
    throw conflict(
      'app_purge_candidate_drift',
      'approved reconciliation environment metadata changed',
    );
  }
  const { rows: auditRows } = await client.query<AuditIdentityRow>(
    `SELECT id FROM audit_events
     WHERE org_slug = $1
       AND app_slug = $2
       AND event_type = 'app.purged'
       AND decision = 'allow'
       AND reason_code = 'retention_elapsed'
       AND created_at >= $3::timestamptz
     ORDER BY created_at DESC, seq DESC
     LIMIT 1`,
    [candidate.org, candidate.app, candidate.anchorCreatedAt],
  );
  if (auditRows[0]?.id !== candidate.purgeAuditId) {
    throw conflict('app_purge_candidate_drift', 'approved reconciliation purge evidence changed');
  }
  const reconciliation = await client.query(
    `SELECT 1 FROM audit_events
     WHERE org_slug = $1
       AND app_slug = $2
       AND event_type = 'app.anchor_reconciled'
       AND details ->> 'purgeAuditId' = $3
     LIMIT 1`,
    [candidate.org, candidate.app, candidate.purgeAuditId],
  );
  if (reconciliation.rows[0] !== undefined) {
    throw conflict(
      'app_purge_candidate_drift',
      'approved reconciliation purge evidence was already used',
    );
  }
}

function sameEnvironments(
  rows: readonly EnvironmentRow[],
  expected: AppPurgeReconciliationCandidateV1['environments'],
): boolean {
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      const environment = expected[index];
      return (
        environment !== undefined &&
        row.name === environment.name &&
        row.is_production === environment.isProduction &&
        toIso(row.created_at) === environment.createdAt
      );
    })
  );
}

async function deleteCandidateAnchors(
  client: PoolClient,
  candidates: readonly AppPurgeReconciliationCandidateV1[],
): Promise<number> {
  let deletedCount = 0;
  for (const candidate of candidates) {
    const result = await client.query(
      `DELETE FROM apps
       WHERE org_slug = $1 AND slug = $2`,
      [candidate.org, candidate.app],
    );
    deletedCount += result.rowCount ?? 0;
  }
  return deletedCount;
}

async function insertReceipt(
  client: PoolClient,
  input: {
    readonly idempotencyKeyHash: string;
    readonly requestFingerprint: string;
    readonly request: AppPurgeReconciliationApplyRequestV1;
    readonly actorSubjectHash: string;
    readonly operationId: string;
    readonly result: AppPurgeReconciliationApplyResultV1;
    readonly now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO app_purge_reconciliation_operations
       (idempotency_key_hash, request_fingerprint, preview_checksum, release_sha,
        actor_subject_hash, approval_reference_hash, recovery_checkpoint_hash, reason_hash,
        operation_id, candidate_count, deleted_count, applied_at, safe_result, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $12)`,
    [
      input.idempotencyKeyHash,
      input.requestFingerprint,
      input.request.preview.checksum,
      input.request.releaseSha,
      input.actorSubjectHash,
      sha256(input.request.approvalReference),
      sha256(input.request.recoveryCheckpoint),
      sha256(input.request.reason),
      input.operationId,
      input.result.candidateCount,
      input.result.deletedCount,
      input.now,
      JSON.stringify(input.result),
    ],
  );
}

function reconciliationRequestFingerprint(request: AppPurgeReconciliationApplyRequestV1): string {
  return sha256(
    JSON.stringify({
      schemaVersion: request.schemaVersion,
      previewPayload: appPurgeReconciliationChecksumPayload(unsignedPreview(request.preview)),
      previewChecksum: request.preview.checksum,
      releaseSha: request.releaseSha,
      approvalReference: request.approvalReference,
      recoveryCheckpoint: request.recoveryCheckpoint,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      confirmed: request.confirmed,
    }),
  );
}

function unsignedPreview(
  preview: AppPurgeReconciliationPreviewArtifactV1,
): AppPurgeReconciliationUnsignedPreviewArtifactV1 {
  return {
    schemaVersion: preview.schemaVersion,
    releaseSha: preview.releaseSha,
    createdAt: preview.createdAt,
    expiresAt: preview.expiresAt,
    candidateCount: preview.candidateCount,
    truncated: preview.truncated,
    candidates: preview.candidates,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid reconciliation timestamp');
  return date.toISOString();
}

function conflict(
  code: ConstructorParameters<typeof AppPurgeReconciliationError>[0],
  message: string,
): AppPurgeReconciliationError {
  return new AppPurgeReconciliationError(code, message);
}
