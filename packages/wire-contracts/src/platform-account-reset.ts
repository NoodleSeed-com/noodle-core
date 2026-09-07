import { z } from 'zod';

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const CHECKSUM = z.string().regex(/^[0-9a-f]{64}$/);
const containsControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
const PRINCIPAL_ID = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !value.includes('@') && !containsControlCharacter(value));
const OPAQUE_ID = z
  .string()
  .trim()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const PlatformAccountResetOperationIdSchema = OPAQUE_ID.refine((value) =>
  value.startsWith('reset-'),
);
export type PlatformAccountResetOperationId = z.infer<typeof PlatformAccountResetOperationIdSchema>;
const BOUNDED_REASON = z.string().trim().min(1).max(256);

export const PlatformAccountResetTargetSetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  principalIds: z
    .array(PRINCIPAL_ID)
    .length(3)
    .refine((ids) => new Set(ids).size === 3),
});
export type PlatformAccountResetTargetSet = z.infer<typeof PlatformAccountResetTargetSetSchema>;

export const PlatformAccountResetLifecycleSchema = z.enum([
  'previewed',
  'quarantined',
  'rolled_back',
  'finalizing',
  'finalization_blocked',
  'finalized',
]);
export type PlatformAccountResetLifecycle = z.infer<typeof PlatformAccountResetLifecycleSchema>;

const lifecycleTransitionAllowed = new Set([
  'previewed:quarantined',
  'quarantined:rolled_back',
  'quarantined:finalizing',
  'finalizing:finalization_blocked',
  'finalizing:finalized',
  'finalization_blocked:finalizing',
]);

export const PlatformAccountResetLifecycleTransitionSchema = z
  .strictObject({
    from: PlatformAccountResetLifecycleSchema,
    to: PlatformAccountResetLifecycleSchema,
  })
  .refine(({ from, to }) => lifecycleTransitionAllowed.has(`${from}:${to}`));
export type PlatformAccountResetLifecycleTransition = z.infer<
  typeof PlatformAccountResetLifecycleTransitionSchema
>;

export const PlatformAccountResetBlockerCodeSchema = z.enum([
  'target_count_invalid',
  'principal_not_active',
  'principal_not_legacy_google',
  'verified_email_evidence_present',
  'workos_link_present',
  'workos_import_present',
  'contact_hint_missing',
  'contact_hint_ambiguous',
  'workos_user_conflict',
  'synthetic_or_customer_identity',
  'personal_workspace_mismatch',
  'ownership_ambiguous',
  'shared_org_owner_required',
  'release_mismatch',
  'generation_mismatch',
  'source_epoch_mismatch',
  'operation_conflict',
  'provider_cleanup_pending',
]);
export type PlatformAccountResetBlockerCode = z.infer<typeof PlatformAccountResetBlockerCodeSchema>;

const BlockerSchema = z.strictObject({
  code: PlatformAccountResetBlockerCodeSchema,
  count: z.number().int().nonnegative(),
});
const ClientBlockerSchema = z.object({
  code: PlatformAccountResetBlockerCodeSchema,
  count: z.number().int().nonnegative(),
});
const AggregateCountsShape = {
  targetCount: z.number().int().nonnegative(),
  suspendedPrincipalCount: z.number().int().nonnegative(),
  personalOrganizationCount: z.number().int().nonnegative(),
  soleOwnedOrganizationCount: z.number().int().nonnegative(),
  ownerOnlyAppCount: z.number().int().nonnegative(),
  preservedSharedOrganizationCount: z.number().int().nonnegative(),
  membershipCount: z.number().int().nonnegative(),
  billingAccountCount: z.number().int().nonnegative(),
  credentialCount: z.number().int().nonnegative(),
  providerObjectCount: z.number().int().nonnegative(),
  cleanupPendingCount: z.number().int().nonnegative(),
} as const;
const AggregateCountsSchema = z.strictObject(AggregateCountsShape);

export const PlatformAccountResetPreviewRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetSet: PlatformAccountResetTargetSetSchema,
  releaseSha: SHA,
  expectedGeneration: z.number().int().nonnegative(),
  sourceEpoch: z.number().int().nonnegative(),
  workosRealm: z.string().trim().min(1).max(256),
});
export type PlatformAccountResetPreviewRequest = z.infer<
  typeof PlatformAccountResetPreviewRequestSchema
>;

export const PlatformAccountResetRollbackPreviewRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal('rollback'),
  operationId: PlatformAccountResetOperationIdSchema,
});
export type PlatformAccountResetRollbackPreviewRequest = z.infer<
  typeof PlatformAccountResetRollbackPreviewRequestSchema
>;

export const PlatformAccountResetOperatorPreviewRequestSchema = z.union([
  PlatformAccountResetPreviewRequestSchema,
  PlatformAccountResetRollbackPreviewRequestSchema,
]);
export type PlatformAccountResetOperatorPreviewRequest = z.infer<
  typeof PlatformAccountResetOperatorPreviewRequestSchema
>;

export const PlatformAccountResetExecuteRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(['quarantine', 'rollback', 'finalize']),
  operationId: PlatformAccountResetOperationIdSchema,
  expectedGeneration: z.number().int().nonnegative(),
  releaseSha: SHA,
  previewChecksum: CHECKSUM,
  idempotencyKey: OPAQUE_ID,
  reason: BOUNDED_REASON,
  confirmed: z.literal(true),
});
export type PlatformAccountResetExecuteRequest = z.infer<
  typeof PlatformAccountResetExecuteRequestSchema
>;

export const PlatformAccountResetStatusRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: PlatformAccountResetOperationIdSchema,
});
export type PlatformAccountResetStatusRequest = z.infer<
  typeof PlatformAccountResetStatusRequestSchema
>;

const ResultShape = {
  schemaVersion: z.literal(1),
  operationId: PlatformAccountResetOperationIdSchema,
  lifecycle: PlatformAccountResetLifecycleSchema,
  releaseSha: SHA,
  rolloutGeneration: z.number().int().nonnegative(),
  sourceEpoch: z.number().int().nonnegative(),
  previewChecksum: CHECKSUM.nullable(),
  targetSetFingerprint: CHECKSUM,
  requestFingerprint: CHECKSUM,
  counts: AggregateCountsSchema,
  blockers: z.array(BlockerSchema),
} as const;
export const PlatformAccountResetResultSchema = z.strictObject(ResultShape);
export type PlatformAccountResetResult = z.infer<typeof PlatformAccountResetResultSchema>;

export const PlatformAccountResetSafeResultSchema = PlatformAccountResetResultSchema.omit({
  targetSetFingerprint: true,
  requestFingerprint: true,
});
export type PlatformAccountResetSafeResult = z.infer<typeof PlatformAccountResetSafeResultSchema>;

export const PlatformAccountResetResultResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: PlatformAccountResetSafeResultSchema,
});
export const PlatformAccountResetResultClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    schemaVersion: ResultShape.schemaVersion,
    operationId: ResultShape.operationId,
    lifecycle: ResultShape.lifecycle,
    releaseSha: ResultShape.releaseSha,
    rolloutGeneration: ResultShape.rolloutGeneration,
    sourceEpoch: ResultShape.sourceEpoch,
    previewChecksum: ResultShape.previewChecksum,
    counts: z.object(AggregateCountsShape),
    blockers: z.array(ClientBlockerSchema),
  }),
});
