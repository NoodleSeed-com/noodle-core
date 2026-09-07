import { z } from 'zod';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const slug = z.string().regex(SLUG_PATTERN);
const timestamp = z.iso.datetime({ offset: true });
const releaseSha = z.string().regex(/^[0-9a-f]{40}$/);
const checksum = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const APP_PURGE_RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const APP_PURGE_RECONCILIATION_MAX_CANDIDATES = 100;
export const APP_PURGE_RECONCILIATION_PREVIEW_TTL_MS = 15 * 60 * 1000;

export const AppPurgeReconciliationEnvironmentSchema = z.strictObject({
  name: slug,
  isProduction: z.boolean(),
  createdAt: timestamp,
});
export type AppPurgeReconciliationEnvironmentV1 = z.infer<
  typeof AppPurgeReconciliationEnvironmentSchema
>;

export const AppPurgeReconciliationCandidateSchema = z.strictObject({
  org: slug,
  app: slug,
  anchorCreatedAt: timestamp,
  purgeAuditId: z.string().uuid(),
  environments: z.array(AppPurgeReconciliationEnvironmentSchema),
});
export type AppPurgeReconciliationCandidateV1 = z.infer<
  typeof AppPurgeReconciliationCandidateSchema
>;

export const AppPurgeReconciliationPreviewRequestSchema = z.strictObject({
  schemaVersion: z.literal(APP_PURGE_RECONCILIATION_SCHEMA_VERSION),
  limit: z.number().int().min(1).max(APP_PURGE_RECONCILIATION_MAX_CANDIDATES).optional(),
});
export type AppPurgeReconciliationPreviewRequestV1 = z.infer<
  typeof AppPurgeReconciliationPreviewRequestSchema
>;

function checkArtifactInvariants(
  artifact: {
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly candidateCount: number;
    readonly truncated: boolean;
    readonly candidates: readonly AppPurgeReconciliationCandidateV1[];
  },
  context: z.RefinementCtx,
): void {
  if (
    Date.parse(artifact.expiresAt) - Date.parse(artifact.createdAt) !==
    APP_PURGE_RECONCILIATION_PREVIEW_TTL_MS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'expiresAt must be exactly 15 minutes after createdAt',
    });
  }
  if (artifact.candidateCount !== artifact.candidates.length) {
    context.addIssue({
      code: 'custom',
      path: ['candidateCount'],
      message: 'candidateCount must equal candidates.length',
    });
  }
  if (artifact.candidateCount === 0 && artifact.truncated) {
    context.addIssue({
      code: 'custom',
      path: ['truncated'],
      message: 'a zero-candidate artifact cannot be truncated',
    });
  }

  let previousCandidateKey: string | undefined;
  for (const [candidateIndex, candidate] of artifact.candidates.entries()) {
    const candidateKey = `${candidate.org}\u0000${candidate.app}`;
    if (previousCandidateKey !== undefined && previousCandidateKey >= candidateKey) {
      context.addIssue({
        code: 'custom',
        path: ['candidates', candidateIndex],
        message: 'candidates must be unique and lexically ordered by org and app',
      });
    }
    previousCandidateKey = candidateKey;

    let previousEnvironmentName: string | undefined;
    for (const [environmentIndex, environment] of candidate.environments.entries()) {
      if (previousEnvironmentName !== undefined && previousEnvironmentName >= environment.name) {
        context.addIssue({
          code: 'custom',
          path: ['candidates', candidateIndex, 'environments', environmentIndex],
          message: 'environments must be unique and lexically ordered by name',
        });
      }
      previousEnvironmentName = environment.name;
    }
  }
}

const previewArtifactShape = {
  schemaVersion: z.literal(APP_PURGE_RECONCILIATION_SCHEMA_VERSION),
  releaseSha,
  createdAt: timestamp,
  expiresAt: timestamp,
  candidateCount: z.number().int().min(0).max(APP_PURGE_RECONCILIATION_MAX_CANDIDATES),
  truncated: z.boolean(),
  candidates: z.array(AppPurgeReconciliationCandidateSchema),
  checksum,
} as const;

export const AppPurgeReconciliationPreviewArtifactSchema = z
  .strictObject(previewArtifactShape)
  .superRefine(checkArtifactInvariants);
export type AppPurgeReconciliationPreviewArtifactV1 = z.infer<
  typeof AppPurgeReconciliationPreviewArtifactSchema
>;
type ReadonlyDeep<Value> = Value extends readonly (infer Item)[]
  ? readonly ReadonlyDeep<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: ReadonlyDeep<Value[Key]> }
    : Value;
export type AppPurgeReconciliationUnsignedPreviewArtifactV1 = Omit<
  ReadonlyDeep<AppPurgeReconciliationPreviewArtifactV1>,
  'checksum'
>;

export const AppPurgeReconciliationPreviewResponseSchema = z.strictObject({
  ok: z.literal(true),
  artifact: AppPurgeReconciliationPreviewArtifactSchema,
});
export type AppPurgeReconciliationPreviewResponseV1 = z.infer<
  typeof AppPurgeReconciliationPreviewResponseSchema
>;

export const AppPurgeReconciliationApplyRequestSchema = z.strictObject({
  schemaVersion: z.literal(APP_PURGE_RECONCILIATION_SCHEMA_VERSION),
  preview: AppPurgeReconciliationPreviewArtifactSchema,
  releaseSha,
  approvalReference: z.string().trim().min(1).max(256),
  recoveryCheckpoint: z.string().trim().min(1).max(256),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().min(8).max(256),
  confirmed: z.literal(true),
});
export type AppPurgeReconciliationApplyRequestV1 = z.infer<
  typeof AppPurgeReconciliationApplyRequestSchema
>;

export const AppPurgeReconciliationApplyResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  previewChecksum: checksum,
  releaseSha,
  candidateCount: z.number().int().min(0).max(APP_PURGE_RECONCILIATION_MAX_CANDIDATES),
  deletedCount: z.number().int().min(0).max(APP_PURGE_RECONCILIATION_MAX_CANDIDATES),
  appliedAt: timestamp,
});
export type AppPurgeReconciliationApplyResultV1 = z.infer<
  typeof AppPurgeReconciliationApplyResultSchema
>;

export const AppPurgeReconciliationApplyResponseSchema = z.strictObject({
  ok: z.literal(true),
  replayed: z.boolean(),
  result: AppPurgeReconciliationApplyResultSchema,
});
export type AppPurgeReconciliationApplyResponseV1 = z.infer<
  typeof AppPurgeReconciliationApplyResponseSchema
>;

const ClientEnvironmentSchema = z.object({
  name: slug,
  isProduction: z.boolean(),
  createdAt: timestamp,
});
const ClientCandidateSchema = z.object({
  org: slug,
  app: slug,
  anchorCreatedAt: timestamp,
  purgeAuditId: z.string().uuid(),
  environments: z.array(ClientEnvironmentSchema),
});
const ClientPreviewArtifactSchema = z
  .object({
    schemaVersion: z.literal(APP_PURGE_RECONCILIATION_SCHEMA_VERSION),
    releaseSha,
    createdAt: timestamp,
    expiresAt: timestamp,
    candidateCount: z.number().int().min(0).max(APP_PURGE_RECONCILIATION_MAX_CANDIDATES),
    truncated: z.boolean(),
    candidates: z.array(ClientCandidateSchema),
    checksum,
  })
  .superRefine(checkArtifactInvariants);
const ClientPreviewResponseSchema = z.object({
  ok: z.literal(true),
  artifact: ClientPreviewArtifactSchema,
});
const ClientApplyResultSchema = z.object({
  operationId: z.string().uuid(),
  previewChecksum: checksum,
  releaseSha,
  candidateCount: z.number().int().min(0).max(APP_PURGE_RECONCILIATION_MAX_CANDIDATES),
  deletedCount: z.number().int().min(0).max(APP_PURGE_RECONCILIATION_MAX_CANDIDATES),
  appliedAt: timestamp,
});
const ClientApplyResponseSchema = z.object({
  ok: z.literal(true),
  replayed: z.boolean(),
  result: ClientApplyResultSchema,
});

/** Client reader strips additive fields at every response layer while service output stays strict. */
export const AppPurgeReconciliationClientResponseSchema = z.union([
  ClientPreviewResponseSchema,
  ClientApplyResponseSchema,
]);
export type AppPurgeReconciliationClientResponseV1 = z.infer<
  typeof AppPurgeReconciliationClientResponseSchema
>;

export const AppPurgeReconciliationErrorCodeSchema = z.enum([
  'app_purge_preview_expired',
  'app_purge_release_mismatch',
  'app_purge_preview_mismatch',
  'app_purge_candidate_drift',
  'app_purge_idempotency_conflict',
  'app_purge_reconciliation_unavailable',
]);
export type AppPurgeReconciliationErrorCodeV1 = z.infer<
  typeof AppPurgeReconciliationErrorCodeSchema
>;

/** Exact unsigned bytes hashed for a preview checksum. */
export function appPurgeReconciliationChecksumPayload(
  unsignedArtifact: AppPurgeReconciliationUnsignedPreviewArtifactV1,
): string {
  return JSON.stringify({
    schemaVersion: unsignedArtifact.schemaVersion,
    releaseSha: unsignedArtifact.releaseSha,
    createdAt: unsignedArtifact.createdAt,
    expiresAt: unsignedArtifact.expiresAt,
    candidateCount: unsignedArtifact.candidateCount,
    truncated: unsignedArtifact.truncated,
    candidates: unsignedArtifact.candidates.map((candidate) => ({
      org: candidate.org,
      app: candidate.app,
      anchorCreatedAt: candidate.anchorCreatedAt,
      purgeAuditId: candidate.purgeAuditId,
      environments: candidate.environments.map((environment) => ({
        name: environment.name,
        isProduction: environment.isProduction,
        createdAt: environment.createdAt,
      })),
    })),
  });
}
