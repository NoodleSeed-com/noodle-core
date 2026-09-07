import { z } from 'zod';

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const CHECKSUM = z.string().regex(/^[0-9a-f]{64}$/);
const BOUNDED_TEXT = z.string().trim().min(1).max(256);
const CLIENT_IDS = z
  .array(BOUNDED_TEXT)
  .max(100)
  .transform((values) => [...new Set(values)].sort());
const STAGE = z.union([z.literal(1), z.literal(10), z.literal(50), z.literal(100)]);

export const PlatformAuthRolloutAccelerationApprovalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    exception: z.literal('exact_three_legacy_cutover'),
    targetEnvironment: z.literal('production'),
    releaseSha: SHA,
    expectedGeneration: z.number().int().nonnegative(),
    fromPercentage: STAGE,
    toPercentage: STAGE,
    approvedAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString()),
    evidence: z.strictObject({
      stageVolumeChecksum: CHECKSUM,
      criticalSmokesChecksum: CHECKSUM,
      rollbackSmokeChecksum: CHECKSUM,
    }),
  })
  .superRefine((approval, context) => {
    const next = new Map<number, number>([
      [1, 10],
      [10, 50],
      [50, 100],
    ]).get(approval.fromPercentage);
    if (approval.toPercentage !== next) {
      context.addIssue({
        code: 'custom',
        path: ['toPercentage'],
        message: 'acceleration approval must target the next approved rollout stage',
      });
    }
  });
export type PlatformAuthRolloutAccelerationApproval = z.infer<
  typeof PlatformAuthRolloutAccelerationApprovalSchema
>;

export const PlatformAuthInventoryBlockerCodeSchema = z.enum([
  'missing_verified_email',
  'multiple_current_verified_emails',
  'shared_verified_email',
  'external_id_too_long',
  'conflicting_workos_user',
  'ambiguous_platform_customer_evidence',
]);
export const PlatformAuthOperationBlockerCodeSchema = z.enum([
  ...PlatformAuthInventoryBlockerCodeSchema.options,
  'inventory_unavailable',
  'inventory_blocked',
  'import_already_started',
  'import_not_started',
  'unresolved_imports',
  'pending_outbox',
  'active_import_leases',
  'outbox_processor_not_configured',
  'outbox_recovery_not_configured',
  'events_processor_not_configured',
  'outbox_reconciliation_pending',
  'events_reconciliation_pending',
  'remote_verification_incomplete',
  'rollout_transition_invalid',
  'finalize_precondition_failed',
]);
const ProcessorStatusSchema = z.enum(['ready', 'pending', 'not_configured']);

function createPlatformAuthResponseSchemas(loose: boolean) {
  const object = loose ? z.object : z.strictObject;
  const blocker = object({
    code: PlatformAuthOperationBlockerCodeSchema,
    count: z.number().int().nonnegative(),
  });
  const rollout = object({
    generation: z.number().int().nonnegative(),
    workosPercentage: z.number().int().min(0).max(100),
    lifecycle: z.enum(['google', 'workos', 'finalized']),
    canaryClientSetHash: CHECKSUM,
    canaryClientCount: z.number().int().nonnegative(),
    recoveryClientSetHash: CHECKSUM,
    recoveryClientCount: z.number().int().nonnegative(),
    workosDefaultSince: z.string().datetime().nullable(),
  });
  const inventory = object({
    state: z.enum(['unavailable', 'running', 'ready', 'blocked']),
    phase: z.enum(['remote', 'local', 'completed']).nullable().default(null),
    remotePages: z.number().int().nonnegative().default(0),
    remoteUsers: z.number().int().nonnegative().default(0),
    localSubjects: z.number().int().nonnegative().default(0),
    candidateCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    checksum: CHECKSUM.nullable(),
    blockers: z.array(blocker),
  });
  const importState = object({
    state: z.enum(['not_started', 'running', 'completed', 'failed']),
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    reconcileRequired: z.number().int().nonnegative(),
    linked: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    activeLeases: z.number().int().nonnegative(),
    nextRetryAt: z.string().datetime().nullable(),
  });
  const synchronization = object({
    outbox: object({
      status: ProcessorStatusSchema,
      pending: z.number().int().nonnegative(),
      lastSuccessAgeSeconds: z.number().int().nonnegative().nullable(),
    }),
    events: object({
      status: ProcessorStatusSchema,
      lastSuccessAgeSeconds: z.number().int().nonnegative().nullable(),
    }),
  });
  const remoteVerification = object({
    state: z.enum(['not_configured', 'not_started', 'running', 'ready', 'blocked']),
    checkedCount: z.number().int().nonnegative(),
    candidateCount: z.number().int().nonnegative(),
    verifiedCount: z.number().int().nonnegative(),
    retryAt: z.string().datetime().nullable(),
  }).refine(
    (progress) =>
      progress.verifiedCount <= progress.checkedCount &&
      progress.checkedCount <= progress.candidateCount,
  );
  const snapshotShape = {
    schemaVersion: z.literal(1),
    releaseSha: SHA,
    rollout,
    inventory,
    import: importState,
    synchronization,
    remoteVerification,
  } as const;
  const snapshot = object(snapshotShape);
  const previewTarget = object({
    percentage: z.number().int().min(0).max(100).nullable(),
    batchSize: z.number().int().min(1).max(100).nullable(),
    cohortMode: z.enum(['preserve', 'replace']).nullable(),
    canaryClientSetHash: CHECKSUM,
    canaryClientCount: z.number().int().nonnegative(),
    recoveryClientSetHash: CHECKSUM,
    recoveryClientCount: z.number().int().nonnegative(),
  });
  const recoveryPreviewTarget = object({
    batchSize: z.number().int().min(1).max(100),
    terminalCount: z.number().int().nonnegative(),
    terminalSetHash: CHECKSUM,
  }).refine((target) => target.terminalCount <= target.batchSize);
  const operationPreviewShape = {
    ...snapshotShape,
    ready: z.boolean(),
    previewChecksum: CHECKSUM.nullable(),
    blockers: z.array(blocker),
  } as const;
  const operationPreview = z.union([
    object({
      ...operationPreviewShape,
      operation: z.enum(['start_import', 'reconcile', 'activate', 'rollback', 'finalize']),
      target: previewTarget,
    }),
    object({
      ...operationPreviewShape,
      operation: z.literal('recover_outbox'),
      target: recoveryPreviewTarget,
    }),
  ]);
  const batch = object({
    attempted: z.number().int().nonnegative(),
    linked: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    retryRequired: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    outbox: object({
      status: ProcessorStatusSchema,
      attempted: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
      retryRequired: z.number().int().nonnegative(),
    }),
    events: object({
      status: ProcessorStatusSchema,
      processed: z.number().int().nonnegative(),
    }),
  });
  const recoveryBatch = object({
    attempted: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }).refine((value) => value.attempted === value.recovered + value.rejected);
  const resultShape = { ...snapshotShape, replayed: z.boolean() } as const;
  const operationResult = z.union([
    object({
      ...resultShape,
      operation: z.enum(['start_import', 'reconcile', 'activate', 'rollback', 'finalize']),
      batch: batch.nullable(),
    }),
    object({ ...resultShape, operation: z.literal('recover_outbox'), batch: recoveryBatch }),
  ]);
  return {
    snapshot,
    operatorResponse: object({ ok: z.literal(true), data: snapshot }),
    operationPreview,
    previewResponse: object({ ok: z.literal(true), data: operationPreview }),
    operationResult,
    resultResponse: object({ ok: z.literal(true), data: operationResult }),
  };
}

const strict = createPlatformAuthResponseSchemas(false);
const client = createPlatformAuthResponseSchemas(true);
export const PlatformAuthOperatorSnapshotSchema = strict.snapshot;
export type PlatformAuthOperatorSnapshot = z.infer<typeof PlatformAuthOperatorSnapshotSchema>;
export const PlatformAuthOperatorResponseSchema = strict.operatorResponse;
export const PlatformAuthOperatorClientResponseSchema = client.operatorResponse;

const ActivatePreviewPreserveSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('activate'),
  percentage: z.number().int().min(1).max(100),
  cohortMode: z.literal('preserve'),
  accelerationApproval: PlatformAuthRolloutAccelerationApprovalSchema.optional(),
});
const ActivatePreviewReplaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('activate'),
  percentage: z.number().int().min(1).max(100),
  cohortMode: z.literal('replace'),
  canaryClientIds: CLIENT_IDS,
  recoveryClientIds: CLIENT_IDS,
  accelerationApproval: PlatformAuthRolloutAccelerationApprovalSchema.optional(),
});
const FinalizationEvidenceShape = {
  rollbackRehearsalChecksum: CHECKSUM,
  stagingWorkosOnlySmokeChecksum: CHECKSUM,
} as const;
export const PlatformAuthPreviewRequestSchema = z.union([
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('start_import') }),
  z.strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal('recover_outbox'),
    batchSize: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal('reconcile'),
    batchSize: z.number().int().min(1).max(100),
  }),
  ActivatePreviewPreserveSchema,
  ActivatePreviewReplaceSchema,
  z.strictObject({ schemaVersion: z.literal(1), operation: z.literal('rollback') }),
  z.strictObject({
    schemaVersion: z.literal(1),
    operation: z.literal('finalize'),
    ...FinalizationEvidenceShape,
  }),
]);
export type PlatformAuthPreviewRequest = z.infer<typeof PlatformAuthPreviewRequestSchema>;

const MutationShape = {
  schemaVersion: z.literal(1),
  expectedGeneration: z.number().int().nonnegative(),
  releaseSha: SHA,
  previewChecksum: CHECKSUM,
  idempotencyKey: z.string().min(8).max(256),
  reason: BOUNDED_TEXT,
  confirmed: z.literal(true),
} as const;
export const PlatformAuthStartImportRequestSchema = z.strictObject(MutationShape);
export const PlatformAuthReconcileRequestSchema = z.strictObject({
  ...MutationShape,
  batchSize: z.number().int().min(1).max(100),
});
export const PlatformAuthRecoverOutboxRequestSchema = z.strictObject({
  ...MutationShape,
  batchSize: z.number().int().min(1).max(100),
});
export const PlatformAuthActivateRequestSchema = z.discriminatedUnion('cohortMode', [
  z.strictObject({
    ...MutationShape,
    percentage: z.number().int().min(1).max(100),
    cohortMode: z.literal('preserve'),
    accelerationApproval: PlatformAuthRolloutAccelerationApprovalSchema.optional(),
  }),
  z.strictObject({
    ...MutationShape,
    percentage: z.number().int().min(1).max(100),
    cohortMode: z.literal('replace'),
    canaryClientIds: CLIENT_IDS,
    recoveryClientIds: CLIENT_IDS,
    accelerationApproval: PlatformAuthRolloutAccelerationApprovalSchema.optional(),
  }),
]);
export const PlatformAuthRollbackRequestSchema = z.strictObject(MutationShape);
export const PlatformAuthFinalizeRequestSchema = z.strictObject({
  ...MutationShape,
  ...FinalizationEvidenceShape,
});

export const PlatformAuthOperationPreviewSchema = strict.operationPreview;
export type PlatformAuthOperationPreview = z.infer<typeof PlatformAuthOperationPreviewSchema>;
export const PlatformAuthOperationPreviewResponseSchema = strict.previewResponse;
export const PlatformAuthOperationPreviewClientResponseSchema = client.previewResponse;
export const PlatformAuthOperationResultSchema = strict.operationResult;
export type PlatformAuthOperationResult = z.infer<typeof PlatformAuthOperationResultSchema>;
export const PlatformAuthOperationResultResponseSchema = strict.resultResponse;
export const PlatformAuthOperationResultClientResponseSchema = client.resultResponse;

type MutationEvidence = {
  readonly expectedGeneration: number;
  readonly releaseSha: string;
  readonly previewChecksum: string;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly confirmed: true;
  readonly actorFingerprint: string;
};
export type PlatformAuthExecuteInput = MutationEvidence &
  (
    | { readonly operation: 'start_import' }
    | { readonly operation: 'reconcile'; readonly batchSize: number }
    | { readonly operation: 'recover_outbox'; readonly batchSize: number }
    | {
        readonly operation: 'activate';
        readonly percentage: number;
        readonly cohortMode: 'preserve';
        readonly accelerationApproval?: PlatformAuthRolloutAccelerationApproval;
      }
    | {
        readonly operation: 'activate';
        readonly percentage: number;
        readonly cohortMode: 'replace';
        readonly canaryClientIds: readonly string[];
        readonly recoveryClientIds: readonly string[];
        readonly accelerationApproval?: PlatformAuthRolloutAccelerationApproval;
      }
    | { readonly operation: 'rollback' }
    | {
        readonly operation: 'finalize';
        readonly rollbackRehearsalChecksum: string;
        readonly stagingWorkosOnlySmokeChecksum: string;
      }
  );

export interface PlatformAuthOperator {
  inventory(input: {
    readonly actorFingerprint: string;
    readonly generation?: number;
  }): Promise<PlatformAuthOperatorSnapshot>;
  status(): Promise<PlatformAuthOperatorSnapshot>;
  preview(input: PlatformAuthPreviewRequest): Promise<PlatformAuthOperationPreview>;
  execute(input: PlatformAuthExecuteInput): Promise<PlatformAuthOperationResult>;
}

export type PlatformAuthSynchronizationComponent = 'outbox' | 'events';
