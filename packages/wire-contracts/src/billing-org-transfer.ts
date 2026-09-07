import { z } from 'zod';
import { BillingPlanSummarySchema } from './billing-read.js';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(['deploy', 'healthz', 'readyz', 'v1', 'o', 'mcp']);
const BILLING_ACCOUNT_ID_PATTERN = /^ba_[0-9a-f-]{36}$/;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

const organizationSlug = z
  .string()
  .trim()
  .refine(
    (value) => SLUG_PATTERN.test(value) && !RESERVED_SLUGS.has(value),
    'invalid organization slug',
  );
const billingAccountId = z.string().trim().regex(BILLING_ACCOUNT_ID_PATTERN);
const previewChecksum = z.string().regex(CHECKSUM_PATTERN);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const opaqueCursor = z.string().max(512);
const paginationLimit = z.number().int().min(1).max(100).default(50);
const customerQuery = z.string().trim().min(1).max(100);
const administratorQuery = z.string().trim().min(2).max(100);
const idempotencyKey = z.string().min(8).max(256);
const administrativeReason = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => !/\p{Cc}/u.test(value),
    'administrative reason cannot contain control characters',
  );

export const BILLING_ORGANIZATION_TRANSFER_CANDIDATE_STATES = [
  'available',
  'already_linked',
  'blocked',
] as const;
export const BILLING_ORGANIZATION_TRANSFER_WARNING_CODES = [
  'currently_paid_elsewhere',
  'lower_plan',
  'capability_loss',
] as const;
export const BILLING_ORGANIZATION_TRANSFER_BLOCKER_CODES = [
  'already_linked',
  'billing_setup_incomplete',
  'destination_ineligible',
  'destination_capacity_exceeded',
] as const;
export const BILLING_ORGANIZATION_TRANSFER_ERROR_CODES = [
  'identity_required',
  'super_admin_required',
  'billing_transfer_target_not_found',
  'billing_setup_incomplete',
  'billing_destination_ineligible',
  'billing_destination_capacity_exceeded',
  'billing_transfer_already_linked',
  'billing_link_version_conflict',
  'billing_transfer_preview_stale',
  'billing_transfer_idempotency_conflict',
] as const;

export type BillingOrganizationTransferCandidateState =
  (typeof BILLING_ORGANIZATION_TRANSFER_CANDIDATE_STATES)[number];
export type BillingOrganizationTransferWarningCode =
  (typeof BILLING_ORGANIZATION_TRANSFER_WARNING_CODES)[number];
export type BillingOrganizationTransferBlockerCode =
  (typeof BILLING_ORGANIZATION_TRANSFER_BLOCKER_CODES)[number];

export const BillingOrganizationTransferCandidatesRequestSchema = z.strictObject({
  query: customerQuery.optional(),
  cursor: opaqueCursor.optional(),
  limit: paginationLimit,
});
export type BillingOrganizationTransferCandidatesRequest = z.infer<
  typeof BillingOrganizationTransferCandidatesRequestSchema
>;

export const BillingOrganizationTransferPreviewRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  destinationBillingAccountId: billingAccountId,
});
export type BillingOrganizationTransferPreviewRequest = z.infer<
  typeof BillingOrganizationTransferPreviewRequestSchema
>;

export const BillingOrganizationTransferApplyRequestSchema = z.strictObject({
  ...BillingOrganizationTransferPreviewRequestSchema.shape,
  expectedLinkVersion: positiveSafeInteger,
  previewChecksum,
  idempotencyKey,
  confirmed: z.literal(true),
});
export type BillingOrganizationTransferApplyRequest = z.infer<
  typeof BillingOrganizationTransferApplyRequestSchema
>;

export const BillingAdministrationOrganizationSearchRequestSchema = z.strictObject({
  query: administratorQuery,
  cursor: opaqueCursor.optional(),
  limit: paginationLimit,
});
export type BillingAdministrationOrganizationSearchRequest = z.infer<
  typeof BillingAdministrationOrganizationSearchRequestSchema
>;

export const BillingAdministrationTransferPreviewRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  organizationSlug,
  destinationBillingAccountId: billingAccountId,
  administrativeReason,
});
export type BillingAdministrationTransferPreviewRequest = z.infer<
  typeof BillingAdministrationTransferPreviewRequestSchema
>;

export const BillingAdministrationTransferApplyRequestSchema = z.strictObject({
  ...BillingAdministrationTransferPreviewRequestSchema.shape,
  expectedLinkVersion: positiveSafeInteger,
  previewChecksum,
  idempotencyKey,
  confirmed: z.literal(true),
});
export type BillingAdministrationTransferApplyRequest = z.infer<
  typeof BillingAdministrationTransferApplyRequestSchema
>;

/** Builds strict service-output schemas or deeply additive client response readers. */
export function createBillingOrganizationTransferSchemas(loose: boolean) {
  const object = loose ? z.object : z.strictObject;
  const organization = object({ slug: organizationSlug, displayName: z.string().min(1) });
  const plan = loose
    ? z.object({ code: z.string().min(1), version: positiveSafeInteger })
    : BillingPlanSummarySchema;
  const destination = object({
    id: billingAccountId,
    displayName: z.string().min(1),
    state: z.enum(['active', 'draft', 'inactive']),
    plan: plan.nullable(),
    linkedOrganizationCount: z.number().int().nonnegative(),
  });
  const productionCapacity = object({
    current: z.number().int().nonnegative(),
    organizationContribution: z.number().int().nonnegative(),
    prospective: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
  });
  const candidate = object({
    organization,
    state: z.enum(BILLING_ORGANIZATION_TRANSFER_CANDIDATE_STATES),
    warnings: z.array(z.enum(BILLING_ORGANIZATION_TRANSFER_WARNING_CODES)),
    blockers: z.array(z.enum(BILLING_ORGANIZATION_TRANSFER_BLOCKER_CODES)),
  });
  const candidatesResponse = object({
    ok: z.literal(true),
    data: object({
      schemaVersion: z.literal(1),
      items: z.array(candidate),
      nextCursor: opaqueCursor.nullable(),
    }),
  });
  const previewResponse = object({
    ok: z.literal(true),
    data: object({
      schemaVersion: z.literal(1),
      organization,
      destination,
      currentPlan: plan.nullable(),
      resultingPlan: plan.nullable(),
      linkedOrganizationCounts: object({
        current: z.number().int().nonnegative(),
        prospective: z.number().int().nonnegative(),
      }),
      productionCapacity,
      lostCapabilityIds: z.array(z.string().min(1)),
      fallback: z.literal('home_free'),
      warnings: z.array(z.enum(BILLING_ORGANIZATION_TRANSFER_WARNING_CODES)),
      blockers: z.array(z.enum(BILLING_ORGANIZATION_TRANSFER_BLOCKER_CODES)),
      expectedLinkVersion: positiveSafeInteger,
      previewChecksum,
      previewedAt: z.string(),
    }),
  }).superRefine((value, context) => {
    const incomplete = value.data.blockers.includes('billing_setup_incomplete');
    if ((value.data.currentPlan === null || value.data.resultingPlan === null) && !incomplete) {
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: 'null preview plans require a billing_setup_incomplete blocker',
      });
    }
  });
  const applyResponse = object({
    ok: z.literal(true),
    data: object({
      schemaVersion: z.literal(1),
      operationId: z.string().min(1),
      organization,
      destination,
      resultingPlan: plan,
      productionCapacity,
      fallback: z.literal('home_free'),
      resultingLinkVersion: positiveSafeInteger,
      effectiveAt: z.string(),
      recordedAt: z.string(),
      warnings: z.array(z.enum(BILLING_ORGANIZATION_TRANSFER_WARNING_CODES)),
      replayed: z.boolean(),
    }),
  });
  const administrationOrganizationsResponse = object({
    ok: z.literal(true),
    data: object({
      schemaVersion: z.literal(1),
      items: z.array(object({ organization })),
      nextCursor: opaqueCursor.nullable(),
    }),
  });

  return {
    candidatesResponse,
    previewResponse,
    applyResponse,
    administrationOrganizationsResponse,
  };
}

const strict = createBillingOrganizationTransferSchemas(false);
const client = createBillingOrganizationTransferSchemas(true);

export const BillingOrganizationTransferCandidatesResponseSchema = strict.candidatesResponse;
export const BillingOrganizationTransferPreviewResponseSchema = strict.previewResponse;
export const BillingOrganizationTransferApplyResponseSchema = strict.applyResponse;
export const BillingAdministrationOrganizationsResponseSchema =
  strict.administrationOrganizationsResponse;

export const BillingOrganizationTransferCandidatesClientResponseSchema = client.candidatesResponse;
export const BillingOrganizationTransferPreviewClientResponseSchema = client.previewResponse;
export const BillingOrganizationTransferApplyClientResponseSchema = client.applyResponse;
export const BillingAdministrationOrganizationsClientResponseSchema =
  client.administrationOrganizationsResponse;

/** Canonicalize the control-plane URL carried by local exact-review evidence. */
export function normalizeBillingOrganizationTransferServiceOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname !== '/'
  ) {
    throw new Error('invalid service origin');
  }
  return url.origin;
}

const normalizedServiceOriginSchema = z.string().superRefine((value, context) => {
  try {
    if (normalizeBillingOrganizationTransferServiceOrigin(value) !== value) {
      context.addIssue({ code: 'custom', message: 'service origin is not normalized' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'service origin is invalid' });
  }
});
const customerReviewedRequestSchema = BillingAdministrationTransferPreviewRequestSchema.omit({
  administrativeReason: true,
});
const transferPreviewSchema = BillingOrganizationTransferPreviewResponseSchema.shape.data;

const customerArtifactSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    serviceOrigin: normalizedServiceOriginSchema,
    authorityPath: z.literal('customer'),
    request: customerReviewedRequestSchema,
    preview: transferPreviewSchema,
  })
  .superRefine(validateReviewedTransfer);

const superAdminArtifactSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    serviceOrigin: normalizedServiceOriginSchema,
    authorityPath: z.literal('super_admin'),
    request: BillingAdministrationTransferPreviewRequestSchema,
    preview: transferPreviewSchema,
  })
  .superRefine(validateReviewedTransfer);

export const BillingOrganizationTransferArtifactSchema = z.discriminatedUnion('authorityPath', [
  customerArtifactSchema,
  superAdminArtifactSchema,
]);
export type BillingOrganizationTransferArtifact = z.infer<
  typeof BillingOrganizationTransferArtifactSchema
>;
export type BillingOrganizationTransferAuthorityPath =
  BillingOrganizationTransferArtifact['authorityPath'];

function validateReviewedTransfer(
  value: {
    readonly request: {
      readonly organizationSlug: string;
      readonly destinationBillingAccountId: string;
    };
    readonly preview: {
      readonly organization: { readonly slug: string };
      readonly destination: { readonly id: string };
    };
  },
  context: z.RefinementCtx,
): void {
  if (value.request.organizationSlug !== value.preview.organization.slug) {
    context.addIssue({
      code: 'custom',
      path: ['request', 'organizationSlug'],
      message: 'reviewed organization does not match preview',
    });
  }
  if (value.request.destinationBillingAccountId !== value.preview.destination.id) {
    context.addIssue({
      code: 'custom',
      path: ['request', 'destinationBillingAccountId'],
      message: 'reviewed destination does not match preview',
    });
  }
}

export type BillingOrganizationTransferCandidatesResponse = z.infer<
  typeof BillingOrganizationTransferCandidatesResponseSchema
>;
export type BillingOrganizationTransferPreviewResponse = z.infer<
  typeof BillingOrganizationTransferPreviewResponseSchema
>;
export type BillingOrganizationTransferApplyResponse = z.infer<
  typeof BillingOrganizationTransferApplyResponseSchema
>;
export type BillingAdministrationOrganizationsResponse = z.infer<
  typeof BillingAdministrationOrganizationsResponseSchema
>;
