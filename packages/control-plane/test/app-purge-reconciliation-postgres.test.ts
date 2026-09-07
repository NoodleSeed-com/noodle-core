import { createHash } from 'node:crypto';
import { ensureAuditSchema } from '@noodle-borg/module-audit';
import {
  type AppPurgeReconciliationApplyRequestV1,
  AppPurgeReconciliationPreviewArtifactSchema,
  type AppPurgeReconciliationPreviewArtifactV1,
  type AppPurgeReconciliationUnsignedPreviewArtifactV1,
  appPurgeReconciliationChecksumPayload,
} from '@noodle-borg/wire-contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AppPurgeReconciliationError,
  computeAppPurgeReconciliationChecksum,
  ensureAppPurgeReconciliationSchema,
  ensureOrganizationSchema,
  PostgresAppPurgeReconciliationOperator,
} from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `app_purge_reconciliation_${process.pid}`;
const RELEASE_SHA = 'a'.repeat(40);
const OTHER_RELEASE_SHA = 'b'.repeat(40);
const NOW = new Date('2026-09-02T12:00:00.000Z');
const ACTOR = { subject: 'operator-subject', email: 'operator@example.com' } as const;
const APPROVAL_REFERENCE = 'restricted-change-42';
const RECOVERY_CHECKPOINT = 'cloud-sql-pitr-20260902t1155z';
const REASON = 'remove reviewed historical purge anchors';
const IDEMPOTENCY_KEY = 'private-operation-key-0001';

type ConflictCode =
  | 'app_purge_preview_expired'
  | 'app_purge_release_mismatch'
  | 'app_purge_preview_mismatch'
  | 'app_purge_candidate_drift'
  | 'app_purge_idempotency_conflict';

describe.skipIf(!URL)('Postgres app purge reconciliation operator', () => {
  let admin: Pool;
  let pool: Pool;
  let operator: PostgresAppPurgeReconciliationOperator;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 6, options: `-c search_path=${SCHEMA}` });
    await ensureReconciliationTestSchema(pool);
    await ensureReconciliationTestSchema(pool);
    operator = new PostgresAppPurgeReconciliationOperator(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE app_purge_reconciliation_operations, audit_events, orgs RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.end();
    }
  });

  it('previews only exact audit-backed zero-deployment anchors in stable bounded order', async () => {
    await seedAnchor(pool, {
      org: 'beta',
      app: 'zulu',
      createdAt: '2026-09-02T09:00:00.000Z',
    });
    await seedPurgeAudit(pool, 'beta', 'zulu', auditId(1), '2026-09-02T10:00:00.000Z');
    await seedAnchor(pool, {
      org: 'alpha',
      app: 'eligible',
      createdAt: '2026-09-02T09:00:00.000Z',
      environments: [
        { name: 'stage', isProduction: false, createdAt: '2026-09-02T09:02:00.000Z' },
        { name: 'prod', isProduction: true, createdAt: '2026-09-02T09:01:00.000Z' },
      ],
    });
    await seedPurgeAudit(pool, 'alpha', 'eligible', auditId(2), '2026-09-02T10:00:00.000Z');
    await seedPurgeAudit(pool, 'alpha', 'eligible', auditId(3), '2026-09-02T11:00:00.000Z');

    await seedAnchor(pool, { org: 'alpha', app: 'deployed' });
    await seedPurgeAudit(pool, 'alpha', 'deployed', auditId(4));
    await seedDeployment(pool, 'alpha', 'deployed');
    await seedAnchor(pool, { org: 'alpha', app: 'missing-audit' });
    await seedAnchor(pool, { org: 'alpha', app: 'wrong-audit' });
    await seedAudit(pool, {
      id: auditId(5),
      eventType: 'app.purged',
      org: 'alpha',
      app: 'wrong-audit',
      decision: 'deny',
      reasonCode: 'retention_elapsed',
    });
    await seedAudit(pool, {
      id: auditId(6),
      eventType: 'app.archived',
      org: 'alpha',
      app: 'wrong-audit',
      decision: 'allow',
      reasonCode: 'retention_elapsed',
    });
    await seedAudit(pool, {
      id: auditId(7),
      eventType: 'app.purged',
      org: 'alpha',
      app: 'wrong-audit',
      decision: 'allow',
      reasonCode: 'operator_request',
    });
    await seedAnchor(pool, {
      org: 'alpha',
      app: 'older-audit',
      createdAt: '2026-09-02T10:00:00.000Z',
    });
    await seedPurgeAudit(pool, 'alpha', 'older-audit', auditId(8), '2026-09-02T09:59:59.000Z');
    await seedAnchor(pool, { org: 'alpha', app: 'already-reconciled' });
    await seedPurgeAudit(pool, 'alpha', 'already-reconciled', auditId(9));
    await seedAudit(pool, {
      id: auditId(10),
      eventType: 'app.anchor_reconciled',
      org: 'alpha',
      app: 'already-reconciled',
      details: { purgeAuditId: auditId(9) },
    });

    const artifact = await operator.preview({ releaseSha: RELEASE_SHA, limit: 100, now: NOW });

    expect(artifact.candidates).toEqual([
      {
        org: 'alpha',
        app: 'eligible',
        anchorCreatedAt: '2026-09-02T09:00:00.000Z',
        purgeAuditId: auditId(3),
        environments: [
          { name: 'prod', isProduction: true, createdAt: '2026-09-02T09:01:00.000Z' },
          { name: 'stage', isProduction: false, createdAt: '2026-09-02T09:02:00.000Z' },
        ],
      },
      {
        org: 'beta',
        app: 'zulu',
        anchorCreatedAt: '2026-09-02T09:00:00.000Z',
        purgeAuditId: auditId(1),
        environments: [{ name: 'prod', isProduction: true, createdAt: '2026-09-02T09:01:00.000Z' }],
      },
    ]);
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      releaseSha: RELEASE_SHA,
      createdAt: '2026-09-02T12:00:00.000Z',
      expiresAt: '2026-09-02T12:15:00.000Z',
      candidateCount: 2,
      truncated: false,
    });
    expect(AppPurgeReconciliationPreviewArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(artifact.checksum).toBe(independentChecksum(artifact));
    expect(computeAppPurgeReconciliationChecksum(unsignedArtifact(artifact))).toBe(
      artifact.checksum,
    );

    const capped = await operator.preview({ releaseSha: RELEASE_SHA, limit: 1, now: NOW });
    expect(capped.candidates.map(({ org, app }) => `${org}/${app}`)).toEqual(['alpha/eligible']);
    expect(capped).toMatchObject({ candidateCount: 1, truncated: true });
    expect(capped.checksum).toBe(independentChecksum(capped));
  });

  it('returns a complete checksummed zero-candidate preview', async () => {
    await seedAnchor(pool, { org: 'alpha', app: 'deliberate-empty' });

    const artifact = await operator.preview({ releaseSha: RELEASE_SHA, limit: 100, now: NOW });
    const expected: AppPurgeReconciliationUnsignedPreviewArtifactV1 = {
      schemaVersion: 1,
      releaseSha: RELEASE_SHA,
      createdAt: '2026-09-02T12:00:00.000Z',
      expiresAt: '2026-09-02T12:15:00.000Z',
      candidateCount: 0,
      truncated: false,
      candidates: [],
    };
    expect(artifact).toEqual({ ...expected, checksum: independentChecksum(expected) });
  });

  it('rejects expired, release-mismatched, and checksum-mismatched previews with exact codes', async () => {
    const preview = await seedPreview(pool, operator);
    const request = requestFor(preview);

    await expectConflict(
      operator.apply({
        request,
        actor: ACTOR,
        currentReleaseSha: RELEASE_SHA,
        now: new Date(preview.expiresAt),
      }),
      'app_purge_preview_expired',
    );
    await expectConflict(
      operator.apply({ request, actor: ACTOR, currentReleaseSha: OTHER_RELEASE_SHA, now: NOW }),
      'app_purge_release_mismatch',
    );
    await expectConflict(
      operator.apply({
        request: { ...request, releaseSha: OTHER_RELEASE_SHA },
        actor: ACTOR,
        currentReleaseSha: RELEASE_SHA,
        now: NOW,
      }),
      'app_purge_release_mismatch',
    );
    await expectConflict(
      operator.apply({
        request: {
          ...request,
          preview: { ...preview, checksum: differentChecksum(preview.checksum) },
        },
        actor: ACTOR,
        currentReleaseSha: RELEASE_SHA,
        now: NOW,
      }),
      'app_purge_preview_mismatch',
    );
    await expect(rowCount(pool, 'app_purge_reconciliation_operations')).resolves.toBe(0);
  });

  it('rejects a validly checksummed preview created in the future', async () => {
    const preview = await seedPreview(pool, operator);
    const createdAt = new Date(NOW.getTime() + 60_000);
    const unsignedFuturePreview: AppPurgeReconciliationUnsignedPreviewArtifactV1 = {
      ...unsignedArtifact(preview),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1000).toISOString(),
    };
    const futurePreview = AppPurgeReconciliationPreviewArtifactSchema.parse({
      ...unsignedFuturePreview,
      checksum: independentChecksum(unsignedFuturePreview),
    });

    await expectConflict(
      operator.apply({
        request: requestFor(futurePreview),
        actor: ACTOR,
        currentReleaseSha: RELEASE_SHA,
        now: NOW,
      }),
      'app_purge_preview_mismatch',
    );
    await expect(rowCount(pool, 'app_purge_reconciliation_operations')).resolves.toBe(0);
    await expect(rowCount(pool, 'apps')).resolves.toBe(1);
  });

  it.each([
    [
      'anchor timestamp',
      async (database: Pool) =>
        database.query(
          `UPDATE apps SET created_at = '2026-09-02T09:00:01.000Z'
           WHERE org_slug = 'alpha' AND slug = 'candidate'`,
        ),
    ],
    [
      'environment metadata',
      async (database: Pool) =>
        database.query(
          `UPDATE environments SET created_at = '2026-09-02T09:01:01.000Z'
           WHERE org_slug = 'alpha' AND app_slug = 'candidate' AND name = 'prod'`,
        ),
    ],
    [
      'qualifying purge audit',
      async (database: Pool) =>
        database.query(`UPDATE audit_events SET decision = 'deny' WHERE id = $1`, [auditId(50)]),
    ],
    [
      'deployment presence',
      async (database: Pool) => seedDeployment(database, 'alpha', 'candidate'),
    ],
    [
      'reconciliation audit reuse',
      async (database: Pool) =>
        seedAudit(database, {
          id: auditId(51),
          eventType: 'app.anchor_reconciled',
          org: 'alpha',
          app: 'candidate',
          details: { purgeAuditId: auditId(50) },
        }),
    ],
  ])('rejects changed %s as candidate drift', async (_label, mutate) => {
    const preview = await seedPreview(pool, operator, auditId(50));
    await mutate(pool);
    const auditCountBeforeApply = await reconciliationAuditCount(pool);

    await expectConflict(apply(operator, requestFor(preview)), 'app_purge_candidate_drift');
    await expect(rowCount(pool, 'app_purge_reconciliation_operations')).resolves.toBe(0);
    await expect(reconciliationAuditCount(pool)).resolves.toBe(auditCountBeforeApply);
  });

  it('rolls the entire batch back when a later candidate has count/member drift', async () => {
    await seedAnchor(pool, { org: 'alpha', app: 'first' });
    await seedPurgeAudit(pool, 'alpha', 'first', auditId(60));
    await seedAnchor(pool, { org: 'alpha', app: 'second' });
    await seedPurgeAudit(pool, 'alpha', 'second', auditId(61));
    const preview = await operator.preview({ releaseSha: RELEASE_SHA, limit: 100, now: NOW });
    await pool.query(`DELETE FROM apps WHERE org_slug = 'alpha' AND slug = 'second'`);

    await expectConflict(apply(operator, requestFor(preview)), 'app_purge_candidate_drift');

    await expect(anchorKeys(pool)).resolves.toEqual(['alpha/first']);
    await expect(rowCount(pool, 'app_purge_reconciliation_operations')).resolves.toBe(0);
    await expect(reconciliationAuditCount(pool)).resolves.toBe(0);
  });

  it('deletes an unchanged anchor whose stored timestamp has sub-millisecond precision', async () => {
    await seedAnchor(pool, {
      org: 'alpha',
      app: 'candidate',
      createdAt: '2026-09-02T09:00:00.000123Z',
    });
    await seedPurgeAudit(pool, 'alpha', 'candidate', auditId(65));
    const preview = await operator.preview({ releaseSha: RELEASE_SHA, limit: 100, now: NOW });

    const response = await apply(operator, requestFor(preview));

    expect(response.result).toMatchObject({ candidateCount: 1, deletedCount: 1 });
    await expect(anchorKeys(pool)).resolves.toEqual([]);
  });

  it('deletes only approved anchors and atomically stores hashed evidence plus one audit per app', async () => {
    await seedAnchor(pool, { org: 'alpha', app: 'first' });
    await seedPurgeAudit(pool, 'alpha', 'first', auditId(70));
    await seedAnchor(pool, { org: 'beta', app: 'second' });
    await seedPurgeAudit(pool, 'beta', 'second', auditId(71));
    await seedAnchor(pool, { org: 'gamma', app: 'unrelated' });
    const preview = await operator.preview({ releaseSha: RELEASE_SHA, limit: 100, now: NOW });

    const response = await apply(operator, requestFor(preview));

    expect(response).toMatchObject({
      ok: true,
      replayed: false,
      result: {
        previewChecksum: preview.checksum,
        releaseSha: RELEASE_SHA,
        candidateCount: 2,
        deletedCount: 2,
        appliedAt: NOW.toISOString(),
      },
    });
    expect(response.result.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(anchorKeys(pool)).resolves.toEqual(['gamma/unrelated']);
    await expect(environmentKeys(pool)).resolves.toEqual(['gamma/unrelated/prod']);

    const receipt = await pool.query<ReceiptRow>(
      'SELECT * FROM app_purge_reconciliation_operations',
    );
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]).toMatchObject({
      preview_checksum: preview.checksum,
      release_sha: RELEASE_SHA,
      operation_id: response.result.operationId,
      candidate_count: 2,
      deleted_count: 2,
      safe_result: response.result,
    });
    const stored = receipt.rows[0];
    expect(stored?.idempotency_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.actor_subject_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.approval_reference_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.recovery_checkpoint_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.reason_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.idempotency_key_hash).toBe(sha256(IDEMPOTENCY_KEY));
    expect(stored?.actor_subject_hash).toBe(sha256(ACTOR.subject));
    expect(stored?.approval_reference_hash).toBe(sha256(APPROVAL_REFERENCE));
    expect(stored?.recovery_checkpoint_hash).toBe(sha256(RECOVERY_CHECKPOINT));
    expect(stored?.reason_hash).toBe(sha256(REASON));
    const serializedReceipt = JSON.stringify(stored);
    for (const privateValue of [
      IDEMPOTENCY_KEY,
      ACTOR.subject,
      APPROVAL_REFERENCE,
      RECOVERY_CHECKPOINT,
      REASON,
    ]) {
      expect(serializedReceipt).not.toContain(privateValue);
    }

    const audits = await reconciliationAudits(pool);
    expect(audits).toEqual([
      {
        org_slug: 'alpha',
        app_slug: 'first',
        actor_subject: ACTOR.subject,
        actor_email: ACTOR.email,
        details: {
          operationId: response.result.operationId,
          previewChecksum: preview.checksum,
          purgeAuditId: auditId(70),
        },
      },
      {
        org_slug: 'beta',
        app_slug: 'second',
        actor_subject: ACTOR.subject,
        actor_email: ACTOR.email,
        details: {
          operationId: response.result.operationId,
          previewChecksum: preview.checksum,
          purgeAuditId: auditId(71),
        },
      },
    ]);
  });

  it('rolls anchor deletion and earlier audit inserts back when a later audit insert fails', async () => {
    await seedAnchor(pool, { org: 'alpha', app: 'first' });
    await seedPurgeAudit(pool, 'alpha', 'first', auditId(80));
    await seedAnchor(pool, { org: 'alpha', app: 'second' });
    await seedPurgeAudit(pool, 'alpha', 'second', auditId(81));
    const preview = await operator.preview({ releaseSha: RELEASE_SHA, limit: 100, now: NOW });
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_second_anchor_reconciliation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'app.anchor_reconciled' AND NEW.app_slug = 'second' THEN
          RAISE EXCEPTION 'forced reconciliation audit failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await pool.query(`
      CREATE TRIGGER reject_second_anchor_reconciliation
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_second_anchor_reconciliation()
    `);

    try {
      await expect(apply(operator, requestFor(preview))).rejects.toThrow(
        'forced reconciliation audit failure',
      );
    } finally {
      await pool.query('DROP TRIGGER reject_second_anchor_reconciliation ON audit_events');
      await pool.query('DROP FUNCTION reject_second_anchor_reconciliation()');
    }

    await expect(anchorKeys(pool)).resolves.toEqual(['alpha/first', 'alpha/second']);
    await expect(reconciliationAuditCount(pool)).resolves.toBe(0);
    await expect(rowCount(pool, 'app_purge_reconciliation_operations')).resolves.toBe(0);
  });

  it.each([
    [
      'after preview expiry',
      { currentReleaseSha: RELEASE_SHA, now: new Date('2026-09-02T12:15:00.000Z') },
    ],
    ['after release rollout', { currentReleaseSha: OTHER_RELEASE_SHA, now: NOW }],
  ])('returns the stored result without duplicate audits for exact replay %s', async (_label, replayAt) => {
    const preview = await seedPreview(pool, operator, auditId(90));
    const request = requestFor(preview);
    const first = await apply(operator, request);

    const replay = await operator.apply({
      request: structuredClone(request),
      actor: ACTOR,
      ...replayAt,
    });

    expect(replay).toEqual({ ...first, replayed: true });
    await expect(reconciliationAuditCount(pool)).resolves.toBe(1);
    await expect(rowCount(pool, 'app_purge_reconciliation_operations')).resolves.toBe(1);
  });

  it('rejects idempotency-key reuse for changed request evidence or actor identity', async () => {
    const preview = await seedPreview(pool, operator, auditId(100));
    const request = requestFor(preview);
    await apply(operator, request);

    for (const changed of [
      { ...request, approvalReference: 'restricted-change-43' },
      { ...request, recoveryCheckpoint: 'cloud-sql-pitr-20260902t1156z' },
      { ...request, reason: 'a different bounded reason' },
    ]) {
      await expectConflict(apply(operator, changed), 'app_purge_idempotency_conflict');
    }
    await expectConflict(
      operator.apply({
        request,
        actor: { subject: 'different-operator', email: ACTOR.email },
        currentReleaseSha: RELEASE_SHA,
        now: NOW,
      }),
      'app_purge_idempotency_conflict',
    );
    await expect(reconciliationAuditCount(pool)).resolves.toBe(1);
    await expect(rowCount(pool, 'app_purge_reconciliation_operations')).resolves.toBe(1);
  });
});

async function ensureReconciliationTestSchema(pool: Pool): Promise<void> {
  await ensureAuditSchema(pool);
  await ensureOrganizationSchema(pool);
  await ensureAppPurgeReconciliationSchema(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS apps (
      org_slug text NOT NULL REFERENCES orgs(slug) ON DELETE CASCADE,
      slug text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_slug, slug)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS environments (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      name text NOT NULL,
      is_production boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_slug, app_slug, name),
      FOREIGN KEY (org_slug, app_slug) REFERENCES apps(org_slug, slug) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deploy_records (
      deployment_id text PRIMARY KEY,
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      deployment_version bigint NOT NULL,
      active boolean NOT NULL,
      server_name text NOT NULL,
      created_at timestamptz NOT NULL,
      access_mode text NOT NULL,
      manifest text NOT NULL,
      secrets jsonb NOT NULL,
      schema_version integer NOT NULL,
      FOREIGN KEY (org_slug, app_slug, environment)
        REFERENCES environments(org_slug, app_slug, name) ON DELETE CASCADE
    )
  `);
}

async function seedPreview(
  pool: Pool,
  operator: PostgresAppPurgeReconciliationOperator,
  purgeAuditId = auditId(40),
): Promise<AppPurgeReconciliationPreviewArtifactV1> {
  await seedAnchor(pool, { org: 'alpha', app: 'candidate' });
  await seedPurgeAudit(pool, 'alpha', 'candidate', purgeAuditId);
  return operator.preview({ releaseSha: RELEASE_SHA, limit: 100, now: NOW });
}

function requestFor(
  preview: AppPurgeReconciliationPreviewArtifactV1,
): AppPurgeReconciliationApplyRequestV1 {
  return {
    schemaVersion: 1,
    preview,
    releaseSha: RELEASE_SHA,
    approvalReference: APPROVAL_REFERENCE,
    recoveryCheckpoint: RECOVERY_CHECKPOINT,
    reason: REASON,
    idempotencyKey: IDEMPOTENCY_KEY,
    confirmed: true,
  };
}

function apply(
  operator: PostgresAppPurgeReconciliationOperator,
  request: AppPurgeReconciliationApplyRequestV1,
) {
  return operator.apply({ request, actor: ACTOR, currentReleaseSha: RELEASE_SHA, now: NOW });
}

async function expectConflict(promise: Promise<unknown>, code: ConflictCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(AppPurgeReconciliationError);
  expect(error).toMatchObject({ code });
}

function unsignedArtifact(artifact: AppPurgeReconciliationPreviewArtifactV1) {
  return {
    schemaVersion: artifact.schemaVersion,
    releaseSha: artifact.releaseSha,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    candidateCount: artifact.candidateCount,
    truncated: artifact.truncated,
    candidates: artifact.candidates,
  };
}

function independentChecksum(artifact: AppPurgeReconciliationUnsignedPreviewArtifactV1): string {
  return `sha256:${createHash('sha256')
    .update(appPurgeReconciliationChecksumPayload(artifact))
    .digest('hex')}`;
}

function differentChecksum(checksum: string): string {
  return `${checksum.slice(0, -1)}${checksum.endsWith('0') ? '1' : '0'}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function auditId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

interface EnvironmentSeed {
  readonly name: string;
  readonly isProduction: boolean;
  readonly createdAt: string;
}

async function seedAnchor(
  pool: Pool,
  input: {
    readonly org: string;
    readonly app: string;
    readonly createdAt?: string;
    readonly environments?: readonly EnvironmentSeed[];
  },
): Promise<void> {
  await pool.query('INSERT INTO orgs (slug) VALUES ($1) ON CONFLICT (slug) DO NOTHING', [
    input.org,
  ]);
  await pool.query('INSERT INTO apps (org_slug, slug, created_at) VALUES ($1, $2, $3)', [
    input.org,
    input.app,
    input.createdAt ?? '2026-09-02T09:00:00.000Z',
  ]);
  const environments = input.environments ?? [
    { name: 'prod', isProduction: true, createdAt: '2026-09-02T09:01:00.000Z' },
  ];
  for (const environment of environments) {
    await pool.query(
      `INSERT INTO environments (org_slug, app_slug, name, is_production, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.org, input.app, environment.name, environment.isProduction, environment.createdAt],
    );
  }
}

async function seedDeployment(pool: Pool, org: string, app: string): Promise<void> {
  await pool.query(
    `INSERT INTO deploy_records
       (deployment_id, org_slug, app_slug, environment, deployment_version, active, server_name,
        created_at, access_mode, manifest, secrets, schema_version)
     VALUES ($1, $2, $3, 'prod', 1, true, $3, $4, 'owner-only', 'manifestVersion: "1"',
             '{"enc":"none","values":{}}'::jsonb, 1)`,
    [`${org}-${app}-deployment`, org, app, '2026-09-02T09:30:00.000Z'],
  );
}

async function seedPurgeAudit(
  pool: Pool,
  org: string,
  app: string,
  id: string,
  createdAt = '2026-09-02T10:00:00.000Z',
): Promise<void> {
  await seedAudit(pool, {
    id,
    eventType: 'app.purged',
    org,
    app,
    decision: 'allow',
    reasonCode: 'retention_elapsed',
    createdAt,
  });
}

async function seedAudit(
  pool: Pool,
  input: {
    readonly id: string;
    readonly eventType: string;
    readonly org: string;
    readonly app: string;
    readonly decision?: string;
    readonly reasonCode?: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly createdAt?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events
       (id, event_type, org_slug, app_slug, decision, reason_code, schema_version, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, $8)`,
    [
      input.id,
      input.eventType,
      input.org,
      input.app,
      input.decision ?? null,
      input.reasonCode ?? null,
      input.details === undefined ? null : JSON.stringify(input.details),
      input.createdAt ?? '2026-09-02T10:00:00.000Z',
    ],
  );
}

async function rowCount(pool: Pool, table: string): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return result.rows[0]?.count ?? -1;
}

async function anchorKeys(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ org_slug: string; slug: string }>(
    'SELECT org_slug, slug FROM apps ORDER BY org_slug, slug',
  );
  return result.rows.map((row) => `${row.org_slug}/${row.slug}`);
}

async function environmentKeys(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ org_slug: string; app_slug: string; name: string }>(
    'SELECT org_slug, app_slug, name FROM environments ORDER BY org_slug, app_slug, name',
  );
  return result.rows.map((row) => `${row.org_slug}/${row.app_slug}/${row.name}`);
}

async function reconciliationAuditCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'app.anchor_reconciled'`,
  );
  return result.rows[0]?.count ?? -1;
}

async function reconciliationAudits(pool: Pool): Promise<readonly ReconciliationAuditRow[]> {
  const result = await pool.query<ReconciliationAuditRow>(
    `SELECT org_slug, app_slug, actor_subject, actor_email, details
     FROM audit_events
     WHERE event_type = 'app.anchor_reconciled'
     ORDER BY org_slug, app_slug`,
  );
  return result.rows;
}

interface ReconciliationAuditRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly actor_subject: string;
  readonly actor_email: string;
  readonly details: Readonly<Record<string, unknown>>;
}

interface ReceiptRow {
  readonly idempotency_key_hash: string;
  readonly request_fingerprint: string;
  readonly preview_checksum: string;
  readonly release_sha: string;
  readonly actor_subject_hash: string;
  readonly approval_reference_hash: string;
  readonly recovery_checkpoint_hash: string;
  readonly reason_hash: string;
  readonly operation_id: string;
  readonly candidate_count: number;
  readonly deleted_count: number;
  readonly safe_result: Readonly<Record<string, unknown>>;
}
