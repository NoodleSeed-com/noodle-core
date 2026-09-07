import { z } from 'zod';

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
const scalar = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`)
    .refine((value) => !hasControlCharacters(value), `${label} cannot contain control characters`);
const CHECKSUM = z.string().regex(/^[0-9a-f]{64}$/, 'checksum must be lowercase SHA-256');
const RELEASE_SHA = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'service release must be a full lowercase Git SHA');
const INSTANT = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const BILLING_ENFORCEMENT_PROFILE_SCHEMA_VERSION = 1;
export const BILLING_ENFORCEMENT_COHORT_KIND = 'legacy_internal_v1' as const;
export const LEGACY_INTERNAL_ENFORCEMENT_PROFILE = 'legacy_internal_exempt' as const;
export const POST_SEAL_ENFORCEMENT_PROFILE = 'enforced' as const;
export type BillingEnforcementProfileMode =
  | typeof LEGACY_INTERNAL_ENFORCEMENT_PROFILE
  | typeof POST_SEAL_ENFORCEMENT_PROFILE;
export type BillingEnforcementCohortKind = typeof BILLING_ENFORCEMENT_COHORT_KIND;
export type BillingEnforcementProfileSource = 'legacy_cohort_seal' | 'post_seal_account';
const cohortShape = {
  schemaVersion: z.literal(BILLING_ENFORCEMENT_PROFILE_SCHEMA_VERSION),
  cohortKind: z.literal(BILLING_ENFORCEMENT_COHORT_KIND),
  legacyAccountProfile: z.literal(LEGACY_INTERNAL_ENFORCEMENT_PROFILE),
  postSealAccountProfile: z.literal(POST_SEAL_ENFORCEMENT_PROFILE),
  billingAccountCount: z.number().int().nonnegative(),
  profiledAccountCount: z.number().int().nonnegative(),
  legacyInternalExemptAccountCount: z.number().int().nonnegative(),
  enforcedAccountCount: z.number().int().nonnegative(),
  unprofiledAccountCount: z.number().int().nonnegative(),
} as const;
export const BillingEnforcementCohortSealRequestSchema = z.strictObject({
  schemaVersion: cohortShape.schemaVersion,
  cohortKind: cohortShape.cohortKind,
  legacyAccountProfile: cohortShape.legacyAccountProfile,
  postSealAccountProfile: cohortShape.postSealAccountProfile,
  reason: scalar('reason', 512),
  idempotencyKey: scalar('idempotencyKey', 256),
  confirmed: z.literal(true),
});
const validateAggregateCounts = (
  response: z.infer<ReturnType<typeof cohortResponseBase>>,
  context: z.RefinementCtx,
) => {
  if (
    response.billingAccountCount !==
    response.legacyInternalExemptAccountCount +
      response.enforcedAccountCount +
      response.unprofiledAccountCount
  ) {
    context.addIssue({
      code: 'custom',
      path: ['billingAccountCount'],
      message: 'billingAccountCount must equal the enforcement profile classification counts',
    });
  }
  if (
    response.profiledAccountCount !==
    response.legacyInternalExemptAccountCount + response.enforcedAccountCount
  ) {
    context.addIssue({
      code: 'custom',
      path: ['profiledAccountCount'],
      message: 'profiledAccountCount must equal the active enforcement profile counts',
    });
  }
};
function cohortResponseBase(loose = false) {
  const object = loose ? z.object : z.strictObject;
  return object(cohortShape);
}
const sealResponse = (loose = false) =>
  (loose ? z.object : z.strictObject)({
    ...cohortShape,
    state: z.literal('sealed'),
    replayed: z.boolean(),
    sealId: scalar('sealId', 128),
    sealedAt: z.iso.datetime({ offset: true }),
    billingAttributionComplete: z.literal(true),
    attributionBlockerCount: z.literal(0),
    activationState: z.literal('not_active'),
  }).superRefine((response, context) => {
    validateAggregateCounts(response, context);
    if (response.unprofiledAccountCount !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['unprofiledAccountCount'],
        message: 'a sealed cohort cannot contain an unprofiled billing account',
      });
    }
    if (response.profiledAccountCount !== response.billingAccountCount) {
      context.addIssue({
        code: 'custom',
        path: ['profiledAccountCount'],
        message: 'every billing account must be profiled when the cohort is sealed',
      });
    }
    if (response.legacyInternalExemptAccountCount !== response.billingAccountCount) {
      context.addIssue({
        code: 'custom',
        path: ['legacyInternalExemptAccountCount'],
        message: 'every account in the sealed launch cohort must be legacy internal exempt',
      });
    }
    if (response.enforcedAccountCount !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['enforcedAccountCount'],
        message: 'the immutable seal result cannot contain a post-seal enforced account',
      });
    }
  });
const statusResponse = (loose = false) =>
  (loose ? z.object : z.strictObject)({
    ...cohortShape,
    state: z.enum(['unsealed', 'sealed']),
    sealId: z.union([scalar('sealId', 128), z.null()]),
    sealedAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
    billingAttributionComplete: z.boolean(),
    attributionBlockerCount: z.number().int().nonnegative(),
  }).superRefine((response, context) => {
    const hasSealIdentity = response.sealedAt !== null && response.sealId !== null;
    const hasNoSealIdentity = response.sealedAt === null && response.sealId === null;
    if (
      (response.state === 'sealed' && !hasSealIdentity) ||
      (response.state === 'unsealed' && !hasNoSealIdentity)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sealedAt'],
        message: 'sealId and sealedAt must be present exactly when the cohort is sealed',
      });
    }
    validateAggregateCounts(response, context);
    if (response.billingAttributionComplete !== (response.attributionBlockerCount === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['billingAttributionComplete'],
        message: 'billingAttributionComplete must match attributionBlockerCount',
      });
    }
  });
export const BillingEnforcementCohortSealResponseSchema = sealResponse();
export const BillingEnforcementCohortSealClientResponseSchema = sealResponse(true);
export const BillingEnforcementCohortStatusResponseSchema = statusResponse();
export const BillingEnforcementCohortStatusClientResponseSchema = statusResponse(true);
export const BillingEnforcementCohortSealEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  data: BillingEnforcementCohortSealResponseSchema,
});
export const BillingEnforcementCohortSealClientEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: BillingEnforcementCohortSealClientResponseSchema,
});
export const BillingEnforcementCohortStatusEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  data: BillingEnforcementCohortStatusResponseSchema,
});
export const BillingEnforcementCohortStatusClientEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: BillingEnforcementCohortStatusClientResponseSchema,
});
export type BillingEnforcementCohortSealRequest = z.infer<
  typeof BillingEnforcementCohortSealRequestSchema
>;
export type BillingEnforcementCohortSealResponse = z.infer<
  typeof BillingEnforcementCohortSealResponseSchema
>;
export type BillingEnforcementCohortStatusResponse = z.infer<
  typeof BillingEnforcementCohortStatusResponseSchema
>;
export function parseBillingEnforcementCohortSealRequest(
  value: unknown,
): BillingEnforcementCohortSealRequest {
  const result = BillingEnforcementCohortSealRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid billing enforcement cohort seal: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const BILLING_ENFORCEMENT_ACTIVATION_SCHEMA_VERSION = 1 as const;
export const BILLING_AUTHORITATIVE_ADMISSION_CONTRACT_VERSION = 1 as const;
export const BILLING_ENFORCEMENT_COMMERCIAL_SCOPE = 'free_v1' as const;
export const BILLING_ENFORCEMENT_PAID_PLANS = false as const;
export function normalizeActivationServiceUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('billing enforcement activation service must be an HTTP(S) origin');
  }
  return parsed.origin;
}
const SERVICE = z.string().transform((value, context) => {
  try {
    return normalizeActivationServiceUrl(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'service must be an HTTP(S) origin',
    });
    return z.NEVER;
  }
});
const releaseEvidence = z.strictObject({
  serviceReleaseSha: RELEASE_SHA,
  verifiedAt: INSTANT,
  checksum: CHECKSUM,
});
export const BillingEnforcementActivationApprovalSchema = z
  .strictObject({
    schemaVersion: z.literal(BILLING_ENFORCEMENT_ACTIVATION_SCHEMA_VERSION),
    targetEnvironment: z.literal('production'),
    commercialScope: z.literal(BILLING_ENFORCEMENT_COMMERCIAL_SCOPE),
    paidPlans: z.literal(BILLING_ENFORCEMENT_PAID_PLANS),
    service: SERVICE,
    expectedState: z.enum(['not_activated', 'rolled_back']),
    expectedGeneration: z.number().int().nonnegative(),
    expectedCohortSealId: scalar('expectedCohortSealId', 128),
    expectedValidationEpochId: scalar('expectedValidationEpochId', 128),
    expectedServiceReleaseSha: RELEASE_SHA,
    evidence: z.strictObject({
      trafficFleetConvergence: releaseEvidence,
      planVolumeCapacity: z.strictObject({
        serviceReleaseSha: RELEASE_SHA,
        topology: z.literal('production'),
        approvedAt: INSTANT,
        checksum: CHECKSUM,
      }),
      nonproductionFailClosedDrill: z.strictObject({
        serviceReleaseSha: RELEASE_SHA,
        environment: z.literal('staging'),
        verifiedAt: INSTANT,
        checksum: CHECKSUM,
      }),
      protectedProductionApproval: z.strictObject({
        serviceReleaseSha: RELEASE_SHA,
        systemReleaseId: z.string().regex(/^r[1-9][0-9]*$/),
        approvedAt: INSTANT,
        checksum: CHECKSUM,
      }),
    }),
  })
  .superRefine((approval, context) => {
    for (const [name, evidence] of Object.entries(approval.evidence)) {
      if (evidence.serviceReleaseSha !== approval.expectedServiceReleaseSha) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', name, 'serviceReleaseSha'],
          message: 'activation evidence must match the expected service release',
        });
      }
    }
    if (approval.expectedState === 'not_activated' && approval.expectedGeneration !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['expectedGeneration'],
        message: 'the first activation must expect generation zero',
      });
    }
    if (approval.expectedState === 'rolled_back' && approval.expectedGeneration < 1) {
      context.addIssue({
        code: 'custom',
        path: ['expectedGeneration'],
        message: 'reactivation must expect a prior activation generation',
      });
    }
  });
export type BillingEnforcementActivationApproval = z.infer<
  typeof BillingEnforcementActivationApprovalSchema
>;

const statusShape = {
  schemaVersion: z.literal(BILLING_ENFORCEMENT_ACTIVATION_SCHEMA_VERSION),
  state: z.enum(['not_activated', 'active', 'rolled_back']),
  generation: z.number().int().nonnegative(),
  cohortSealId: scalar('cohortSealId', 128),
  activeEpochId: z.union([scalar('activeEpochId', 128), z.null()]),
  lastEpochId: z.union([scalar('lastEpochId', 128), z.null()]),
  activatedAt: z.union([INSTANT, z.null()]),
  rolledBackAt: z.union([INSTANT, z.null()]),
  activationServiceReleaseSha: z.union([RELEASE_SHA, z.null()]),
  admissionContractVersion: z.union([z.number().int().positive(), z.null()]),
  approvalChecksum: z.union([CHECKSUM, z.null()]),
} as const;
const validateStatus = (
  status: z.infer<ReturnType<typeof activationStatus>>,
  context: z.RefinementCtx,
) => {
  const hasProvenance =
    status.lastEpochId !== null &&
    status.activatedAt !== null &&
    status.activationServiceReleaseSha !== null &&
    status.admissionContractVersion !== null &&
    status.approvalChecksum !== null;
  if (status.state === 'not_activated') {
    if (
      status.generation !== 0 ||
      status.activeEpochId !== null ||
      status.lastEpochId !== null ||
      status.activatedAt !== null ||
      status.rolledBackAt !== null ||
      status.activationServiceReleaseSha !== null ||
      status.admissionContractVersion !== null ||
      status.approvalChecksum !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'not-activated state cannot contain activation history',
      });
    }
    return;
  }
  if (status.generation < 1 || !hasProvenance)
    context.addIssue({
      code: 'custom',
      path: ['generation'],
      message: 'activated state requires complete provenance',
    });
  if (
    status.state === 'active' &&
    (status.activeEpochId === null ||
      status.activeEpochId !== status.lastEpochId ||
      status.rolledBackAt !== null)
  )
    context.addIssue({
      code: 'custom',
      path: ['activeEpochId'],
      message: 'active state is invalid',
    });
  if (
    status.state === 'rolled_back' &&
    (status.activeEpochId !== null || status.rolledBackAt === null)
  )
    context.addIssue({
      code: 'custom',
      path: ['rolledBackAt'],
      message: 'rolled-back state is invalid',
    });
  if (
    status.rolledBackAt !== null &&
    status.activatedAt !== null &&
    Date.parse(status.rolledBackAt) < Date.parse(status.activatedAt)
  )
    context.addIssue({
      code: 'custom',
      path: ['rolledBackAt'],
      message: 'rollback cannot predate activation',
    });
};
function activationStatus(loose = false) {
  return (loose ? z.object : z.strictObject)(statusShape);
}
export const BillingEnforcementActivationStatusSchema =
  activationStatus().superRefine(validateStatus);
export const BillingEnforcementActivationStatusClientSchema =
  activationStatus(true).superRefine(validateStatus);
export const BillingEnforcementActivationStatusResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: BillingEnforcementActivationStatusSchema,
});
export const BillingEnforcementActivationStatusClientResponseSchema = z.object({
  ok: z.literal(true),
  data: BillingEnforcementActivationStatusClientSchema,
});
export type BillingEnforcementActivationStatus = z.infer<
  typeof BillingEnforcementActivationStatusSchema
>;

export const BILLING_ENFORCEMENT_ACTIVATION_BLOCKER_CODES = [
  'cohort_not_sealed',
  'cohort_seal_mismatch',
  'billing_attribution_incomplete',
  'unprofiled_billing_accounts',
  'activation_state_mismatch',
  'activation_generation_mismatch',
  'active_epoch_exists',
  'prepared_validation_epoch_mismatch',
  'service_origin_mismatch',
  'service_release_mismatch',
  'admission_contract_mismatch',
  'approval_evidence_not_current',
  'technical_readiness_blocked',
  'production_preflight_unavailable',
  'invalid_enforced_entitlements',
  'enforced_account_not_free_v1',
  'enforced_account_over_capacity',
] as const;
const activationPreview = (loose = false) => {
  const object = loose ? z.object : z.strictObject;
  return object({
    schemaVersion: z.literal(BILLING_ENFORCEMENT_ACTIVATION_SCHEMA_VERSION),
    ready: z.boolean(),
    commercialScope: z.literal(BILLING_ENFORCEMENT_COMMERCIAL_SCOPE),
    paidPlans: z.literal(BILLING_ENFORCEMENT_PAID_PLANS),
    checkedAt: INSTANT,
    approvalChecksum: CHECKSUM,
    previewChecksum: CHECKSUM,
    blockers: z.array(object({ code: z.enum(BILLING_ENFORCEMENT_ACTIVATION_BLOCKER_CODES) })),
    effects: object({
      profileScope: z.literal('enforced'),
      commercialScope: z.literal(BILLING_ENFORCEMENT_COMMERCIAL_SCOPE),
      paidPlans: z.literal(BILLING_ENFORCEMENT_PAID_PLANS),
      startsFreshAuthoritativeEpochAtZero: z.literal(true),
      productionAppEnforcement: z.literal(true),
      legacyInternalExemptBypass: z.literal(true),
      stripe: z.literal(false),
      migrationGrants: z.literal(false),
      invoiceEvidence: z.literal(false),
    }),
  });
};
export const BillingEnforcementActivationPreviewSchema = activationPreview();
export const BillingEnforcementActivationPreviewClientSchema = activationPreview(true);
export const BillingEnforcementActivationPreviewResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: BillingEnforcementActivationPreviewSchema,
});
export const BillingEnforcementActivationPreviewClientResponseSchema = z.object({
  ok: z.literal(true),
  data: BillingEnforcementActivationPreviewClientSchema,
});
export type BillingEnforcementActivationPreview = z.infer<
  typeof BillingEnforcementActivationPreviewSchema
>;

export const BillingEnforcementActivateRequestSchema = z.strictObject({
  schemaVersion: z.literal(BILLING_ENFORCEMENT_ACTIVATION_SCHEMA_VERSION),
  approval: BillingEnforcementActivationApprovalSchema,
  expectedPreviewChecksum: CHECKSUM,
  reason: scalar('reason', 512),
  idempotencyKey: scalar('idempotencyKey', 256),
  confirmed: z.literal(true),
});
export const BillingEnforcementRollbackRequestSchema = z.strictObject({
  schemaVersion: z.literal(BILLING_ENFORCEMENT_ACTIVATION_SCHEMA_VERSION),
  expectedState: z.literal('active'),
  expectedGeneration: z.number().int().positive(),
  expectedEpochId: scalar('expectedEpochId', 128),
  reason: scalar('reason', 512),
  idempotencyKey: scalar('idempotencyKey', 256),
  confirmed: z.literal(true),
});
export type BillingEnforcementActivateRequest = z.infer<
  typeof BillingEnforcementActivateRequestSchema
>;
export type BillingEnforcementRollbackRequest = z.infer<
  typeof BillingEnforcementRollbackRequestSchema
>;
export function parseBillingEnforcementActivateRequest(
  value: unknown,
): BillingEnforcementActivateRequest {
  const parsed = BillingEnforcementActivateRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`invalid billing enforcement activation: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
export function parseBillingEnforcementRollbackRequest(
  value: unknown,
): BillingEnforcementRollbackRequest {
  const parsed = BillingEnforcementRollbackRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`invalid billing enforcement rollback: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
const mutationShape = {
  schemaVersion: z.literal(BILLING_ENFORCEMENT_ACTIVATION_SCHEMA_VERSION),
  action: z.enum(['activate', 'rollback']),
  state: z.enum(['active', 'rolled_back']),
  generation: z.number().int().positive(),
  replayed: z.boolean(),
  cohortSealId: scalar('cohortSealId', 128),
  activeEpochId: z.union([scalar('activeEpochId', 128), z.null()]),
  lastEpochId: scalar('lastEpochId', 128),
  retiredValidationEpochId: z.union([scalar('retiredValidationEpochId', 128), z.null()]),
  activatedAt: INSTANT,
  rolledBackAt: z.union([INSTANT, z.null()]),
  activationServiceReleaseSha: RELEASE_SHA,
  admissionContractVersion: z.number().int().positive(),
  approvalChecksum: CHECKSUM,
  previewChecksum: z.union([CHECKSUM, z.null()]),
} as const;
const mutationResult = (loose = false) =>
  (loose ? z.object : z.strictObject)(mutationShape).superRefine((result, context) => {
    const activation = result.action === 'activate' && result.state === 'active';
    const rollback = result.action === 'rollback' && result.state === 'rolled_back';
    if (!activation && !rollback)
      context.addIssue({ code: 'custom', path: ['state'], message: 'action and state must match' });
    if (activation) {
      if (
        result.activeEpochId === null ||
        result.activeEpochId !== result.lastEpochId ||
        result.retiredValidationEpochId === null ||
        result.rolledBackAt !== null ||
        result.previewChecksum === null
      )
        context.addIssue({
          code: 'custom',
          path: ['activeEpochId'],
          message: 'activation result is incomplete',
        });
    } else if (
      result.activeEpochId !== null ||
      result.retiredValidationEpochId !== null ||
      result.rolledBackAt === null ||
      result.previewChecksum !== null
    )
      context.addIssue({
        code: 'custom',
        path: ['activeEpochId'],
        message: 'rollback result is inconsistent',
      });
  });
export const BillingEnforcementActivationMutationResultSchema = mutationResult();
export const BillingEnforcementActivationMutationClientResultSchema = mutationResult(true);
export const BillingEnforcementActivationMutationResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: BillingEnforcementActivationMutationResultSchema,
});
export const BillingEnforcementActivationMutationClientResponseSchema = z.object({
  ok: z.literal(true),
  data: BillingEnforcementActivationMutationClientResultSchema,
});
export type BillingEnforcementActivationMutationResult = z.infer<
  typeof BillingEnforcementActivationMutationResultSchema
>;
