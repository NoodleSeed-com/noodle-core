import { z } from 'zod';

const BillingEntitlementValueSchema = z.union([z.boolean(), z.number(), z.string(), z.null()]);

function createBillingReadSchemas(loose: boolean) {
  const object = loose ? z.object : z.strictObject;
  const entitlements = z.record(z.string(), BillingEntitlementValueSchema);
  const planSummary = object({ code: z.string(), version: z.number().int().positive() });
  const enforcement = z.discriminatedUnion('state', [
    object({ state: z.literal('legacy_unchanged') }),
    object({ state: z.literal('exempt'), reason: z.literal('legacy_internal') }),
    object({ state: z.literal('inactive'), reason: z.enum(['not_activated', 'rolled_back']) }),
    object({ state: z.literal('active'), mode: z.literal('authoritative') }),
    object({ state: z.literal('unavailable') }),
  ]);
  const meteringSummary = z.union([
    object({ state: z.literal('not_started') }),
    object({
      state: z.literal('reporting'),
      mode: z.literal('shadow'),
      coverage: z.literal('partial'),
    }),
    object({
      state: z.literal('reporting'),
      mode: z.literal('authoritative'),
      coverage: z.literal('complete'),
    }),
    object({ state: z.literal('unavailable') }),
  ]);
  const meteringReportingFields = {
    state: z.literal('reporting'),
    mode: z.literal('shadow'),
    observedCalls: z.number().int().nonnegative(),
    coverage: z.literal('partial'),
    observedSince: z.string(),
    windowStart: z.string(),
    windowEnd: z.string(),
  } as const;
  const meteringUnavailableFields = {
    state: z.literal('unavailable'),
    reason: z.enum(['billing_setup_incomplete', 'observation_not_started', 'counter_unavailable']),
    observedCalls: z.null(),
    coverage: z.literal('unavailable'),
    observedSince: z.string().nullable(),
    windowStart: z.string().nullable(),
    windowEnd: z.string().nullable(),
  } as const;
  const accountMeteringDetail = z.union([
    object({
      state: z.literal('not_started'),
      usedMcpCalls: z.null(),
      remainingMcpCalls: z.null(),
      resetAt: z.null(),
    }),
    object({ ...meteringReportingFields, remainingMcpCalls: z.null() }),
    object({
      state: z.literal('reporting'),
      mode: z.literal('authoritative'),
      coverage: z.literal('complete'),
      usedMcpCalls: z.number().int().nonnegative(),
      includedUsedMcpCalls: z.number().int().nonnegative(),
      overageUsedMcpCalls: z.number().int().nonnegative(),
      remainingMcpCalls: z.number().int().nonnegative(),
      countingSince: z.string(),
      windowStart: z.string(),
      windowEnd: z.string(),
      resetAt: z.string(),
    }),
    object({ ...meteringUnavailableFields, remainingMcpCalls: z.null() }),
  ]);
  const orgMeteringDetail = z.union([
    object({ state: z.literal('not_started') }),
    object(meteringReportingFields),
    object({
      state: z.literal('reporting'),
      mode: z.literal('authoritative'),
      coverage: z.literal('complete'),
      attributedMcpCalls: z.number().int().nonnegative(),
      includedAttributedMcpCalls: z.number().int().nonnegative(),
      overageAttributedMcpCalls: z.number().int().nonnegative(),
      countingSince: z.string(),
      windowStart: z.string(),
      windowEnd: z.string(),
      resetAt: z.string(),
    }),
    object(meteringUnavailableFields),
  ]);
  const productionApps = z.discriminatedUnion('state', [
    object({
      state: z.literal('reporting'),
      active: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative().nullable(),
    }),
    object({
      state: z.literal('unavailable'),
      active: z.null(),
      limit: z.number().int().nonnegative().nullable(),
    }),
  ]);
  const accountSummary = object({
    id: z.string(),
    displayName: z.string(),
    state: z.enum(['active', 'draft', 'inactive']),
    createdAt: z.string(),
    role: z.enum(['owner', 'admin', 'viewer']),
    isDefault: z.boolean(),
    plan: planSummary.nullable(),
    linkedOrganizationCount: z.number().int().nonnegative(),
    enforcement,
    metering: meteringSummary,
  });
  const accountReference = z.discriminatedUnion('relationship', [
    object({ relationship: z.literal('current') }),
    object({ relationship: z.literal('member'), billingAccountId: z.string() }),
    object({ relationship: z.literal('external') }),
  ]);
  const entitlementSnapshot = object({
    snapshotId: z.string(),
    version: z.number().int().positive(),
    plan: planSummary,
    verificationStatus: z.literal('verified'),
    effectiveFrom: z.string(),
    monthlyUsageAnchor: z.string(),
    entitlements,
  });
  const linkedOrganization = object({
    org: z.string(),
    linkVersion: z.number().int().positive(),
    linkedAt: z.string(),
    homeFreeBillingAccount: accountReference,
    fallbackBillingAccount: accountReference,
  });
  const legacyMigration = z.discriminatedUnion('state', [
    object({ state: z.literal('not_applicable') }),
    object({
      state: z.literal('prepared'),
      preparedAt: z.string(),
      organizationsAtPreparation: z.number().int().nonnegative(),
      productionAppsAtPreparation: z.number().int().nonnegative(),
      productionCapacityAtPreparation: z.number().int().nonnegative(),
      grant: z.discriminatedUnion('state', [
        object({ state: z.literal('not_required') }),
        object({
          state: z.literal('pending_activation'),
          durationDays: z.literal(90),
          startsAt: z.null(),
          expiresAt: z.null(),
        }),
      ]),
    }),
  ]);
  const commerce = z.discriminatedUnion('state', [
    object({ state: z.literal('unavailable') }),
    object({ state: z.literal('available'), provider: z.literal('stripe') }),
  ]);
  const accountsListResponse = object({
    ok: z.literal(true),
    data: object({ accounts: z.array(accountSummary) }),
  });
  const accountResponse = object({
    ok: z.literal(true),
    data: object({
      account: accountSummary,
      entitlement: entitlementSnapshot.nullable(),
      linkedOrganizations: z.array(linkedOrganization),
      enforcement,
      metering: accountMeteringDetail,
      productionApps,
      commerce,
      legacyMigration,
    }),
  });
  const orgResponse = object({
    ok: z.literal(true),
    data: object({
      org: z.string(),
      state: z.literal('linked'),
      plan: object({
        code: z.string(),
        version: z.number().int().positive(),
        effectiveFrom: z.string(),
      }),
      entitlements,
      enforcement,
      metering: orgMeteringDetail,
      productionApps,
    }),
  });
  return {
    entitlements,
    planSummary,
    enforcement,
    meteringSummary,
    accountMeteringDetail,
    orgMeteringDetail,
    productionApps,
    accountSummary,
    accountReference,
    entitlementSnapshot,
    linkedOrganization,
    legacyMigration,
    commerce,
    accountsListResponse,
    accountResponse,
    orgResponse,
  };
}

const strict = createBillingReadSchemas(false);
const client = createBillingReadSchemas(true);

export const BillingEntitlementsSchema = strict.entitlements;
export const BillingPlanSummarySchema = strict.planSummary;
export const BillingEnforcementStateSchema = strict.enforcement;
export const BillingMeteringSummarySchema = strict.meteringSummary;
export const BillingAccountMeteringDetailSchema = strict.accountMeteringDetail;
export const BillingOrgMeteringDetailSchema = strict.orgMeteringDetail;
export const BillingProductionAppsSchema = strict.productionApps;
export const BillingAccountSummarySchema = strict.accountSummary;
export const BillingAccountReferenceSchema = strict.accountReference;
export const BillingEntitlementSnapshotSchema = strict.entitlementSnapshot;
export const BillingLinkedOrganizationSchema = strict.linkedOrganization;
export const BillingLegacyMigrationSchema = strict.legacyMigration;
export const BillingCommerceSchema = strict.commerce;
export const BillingAccountsListResponseSchema = strict.accountsListResponse;
export const BillingAccountResponseSchema = strict.accountResponse;
export const OrgBillingResponseSchema = strict.orgResponse;

export const BillingAccountsListClientResponseSchema = client.accountsListResponse;
export const BillingAccountClientResponseSchema = client.accountResponse;
export const OrgBillingClientResponseSchema = client.orgResponse;

export type BillingAccountSummary = z.infer<typeof BillingAccountSummarySchema>;
export type BillingAccountsListResponse = z.infer<typeof BillingAccountsListResponseSchema>;
export type BillingAccountResponse = z.infer<typeof BillingAccountResponseSchema>;
export type OrgBillingResponse = z.infer<typeof OrgBillingResponseSchema>;
