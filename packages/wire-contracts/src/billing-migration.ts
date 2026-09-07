import { z } from 'zod';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(['deploy', 'healthz', 'readyz', 'v1', 'o', 'mcp']);
const slug = (label: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) => SLUG_PATTERN.test(value) && !RESERVED_SLUGS.has(value),
      `invalid ${label} slug`,
    );
const billingAccountId = z
  .string()
  .trim()
  .regex(/^ba_[0-9a-f-]{36}$/);
const checksum = z.string().regex(/^[0-9a-f]{64}$/);
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
const serviceOrigin = z
  .string()
  .url()
  .max(2048)
  .transform((value, context) => {
    try {
      return normalizeBillingMigrationServiceUrl(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'service must be an HTTP(S) origin',
      });
      return z.NEVER;
    }
  });

export interface BillingIdentityRef {
  readonly identityIssuer: string;
  readonly subject: string;
}
export const GOOGLE_CONTROL_PLANE_ISSUER = 'https://accounts.google.com' as const;
export interface LegacyProductionAppIdentity {
  readonly app: string;
  readonly createdAt: string;
}
export interface LegacyUnlinkedOrganizationMapping {
  readonly org: string;
  readonly linkState: 'unlinked';
  readonly defaultBillingOwnerSubject: string;
  readonly productionApps: readonly LegacyProductionAppIdentity[];
}
export interface LegacyLinkedOrganizationMapping {
  readonly org: string;
  readonly linkState: 'linked';
  readonly expectedBillingAccountId: string;
  readonly expectedLinkVersion: number;
  readonly productionApps: readonly LegacyProductionAppIdentity[];
}
export type LegacyBillingMigrationMapping =
  | LegacyUnlinkedOrganizationMapping
  | LegacyLinkedOrganizationMapping;
export interface LegacyBillingMigrationRequest {
  readonly schemaVersion: 1;
  readonly mappings?: readonly LegacyBillingMigrationMapping[];
}
export const LegacyBillingMigrationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mappings: z
    .array(
      z.discriminatedUnion('linkState', [
        z.strictObject({
          org: slug('organization'),
          linkState: z.literal('unlinked'),
          defaultBillingOwnerSubject: z.string().trim().min(1).max(512),
          productionApps: z.array(
            z.strictObject({
              app: slug('app'),
              createdAt: z.iso
                .datetime({ offset: true })
                .transform((value) => new Date(value).toISOString()),
            }),
          ),
        }),
        z.strictObject({
          org: slug('organization'),
          linkState: z.literal('linked'),
          expectedBillingAccountId: billingAccountId,
          expectedLinkVersion: z.number().int().positive(),
          productionApps: z.array(
            z.strictObject({
              app: slug('app'),
              createdAt: z.iso
                .datetime({ offset: true })
                .transform((value) => new Date(value).toISOString()),
            }),
          ),
        }),
      ]),
    )
    .optional(),
});
export function parseLegacyBillingMigrationRequest(value: unknown): LegacyBillingMigrationRequest {
  const result = LegacyBillingMigrationRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid billing migration preview: ${z.prettifyError(result.error)}`);
  }
  return {
    schemaVersion: result.data.schemaVersion,
    ...(result.data.mappings === undefined ? {} : { mappings: result.data.mappings }),
  };
}

export const LEGACY_BILLING_MIGRATION_BLOCKER_CODES = [
  'duplicate_org_mapping',
  'duplicate_production_app',
  'existing_link_conflict',
  'linked_organization_not_linked',
  'owner_mapping_required',
  'owner_billing_identity_invalid',
  'owner_billing_identity_conflict',
  'owner_not_org_owner',
  'owner_subject_unknown',
  'organization_not_found',
  'production_app_not_active',
  'production_app_not_found',
  'production_classification_required',
] as const;
export type LegacyBillingMigrationBlockerCode =
  (typeof LEGACY_BILLING_MIGRATION_BLOCKER_CODES)[number];
export interface LegacyBillingMigrationBlocker {
  readonly code: LegacyBillingMigrationBlockerCode;
  readonly org: string;
  readonly message: string;
}
export interface LegacyBillingMigrationPreview {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly organizations: readonly {
    readonly org: string;
    readonly ownerCandidates: readonly { readonly subject: string; readonly email: string }[];
    readonly mappedOwnerSubject?: string;
    readonly productionApps?: readonly LegacyProductionAppIdentity[];
  }[];
  readonly linkedOrganizations: readonly {
    readonly org: string;
    readonly billingAccountId: string;
    readonly homeFreeBillingAccountId: string;
    readonly homeOwner: BillingIdentityRef;
    readonly fallbackBillingAccountId: string;
    readonly version: number;
    readonly productionApps?: readonly LegacyProductionAppIdentity[];
  }[];
  readonly fundingSets: readonly {
    readonly destination:
      | { readonly kind: 'existing'; readonly billingAccountId: string }
      | {
          readonly kind: 'proposed_default';
          readonly identityIssuer: typeof GOOGLE_CONTROL_PLANE_ISSUER;
          readonly subject: string;
        };
    readonly organizations: readonly string[];
    readonly productionApps: readonly (LegacyProductionAppIdentity & { readonly org: string })[];
    readonly missingProductionClassifications: readonly string[];
  }[];
  readonly blockers: readonly LegacyBillingMigrationBlocker[];
  readonly grantPolicy: {
    readonly durationDays: 90;
    readonly startsAt: 'billing_enforcement_cutover';
    readonly expiresAt: null;
    readonly eligibility: 'account_cohort_above_capacity';
  };
  readonly previewChecksum: string;
}

function createPreviewSchema(loose = false) {
  const object = loose ? z.object : z.strictObject;
  const productionApp = object({ app: slug('app'), createdAt: z.string() });
  const blocker = object({
    code: z.enum(LEGACY_BILLING_MIGRATION_BLOCKER_CODES),
    org: z.string(),
    message: z.string(),
  });
  return object({
    schemaVersion: z.literal(1),
    ready: z.boolean(),
    organizations: z.array(
      object({
        org: z.string(),
        ownerCandidates: z.array(object({ subject: z.string(), email: z.string() })),
        mappedOwnerSubject: z.string().optional(),
        productionApps: z.array(productionApp).optional(),
      }),
    ),
    linkedOrganizations: z.array(
      object({
        org: z.string(),
        billingAccountId: z.string(),
        homeFreeBillingAccountId: z.string(),
        homeOwner: object({ identityIssuer: z.string(), subject: z.string() }),
        fallbackBillingAccountId: z.string(),
        version: z.number().int().positive(),
        productionApps: z.array(productionApp).optional(),
      }),
    ),
    fundingSets: z.array(
      object({
        destination: z.discriminatedUnion('kind', [
          object({ kind: z.literal('existing'), billingAccountId: z.string() }),
          object({
            kind: z.literal('proposed_default'),
            identityIssuer: z.literal(GOOGLE_CONTROL_PLANE_ISSUER),
            subject: z.string(),
          }),
        ]),
        organizations: z.array(z.string()),
        productionApps: z.array(
          object({ app: z.string(), createdAt: z.string(), org: z.string() }),
        ),
        missingProductionClassifications: z.array(z.string()),
      }),
    ),
    blockers: z.array(blocker),
    grantPolicy: object({
      durationDays: z.literal(90),
      startsAt: z.literal('billing_enforcement_cutover'),
      expiresAt: z.null(),
      eligibility: z.literal('account_cohort_above_capacity'),
    }),
    previewChecksum: checksum,
  });
}
export const LegacyBillingMigrationPreviewSchema = createPreviewSchema();
export const LegacyBillingMigrationClientPreviewSchema = createPreviewSchema(true);
export const LegacyBillingMigrationPreviewResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: LegacyBillingMigrationPreviewSchema,
});
export const LegacyBillingMigrationClientPreviewResponseSchema = z.object({
  ok: z.literal(true),
  data: LegacyBillingMigrationClientPreviewSchema,
});

const planProjection = z.strictObject({
  org: scalar('organization', 128),
  response: z.strictObject({
    ok: z.literal(true),
    service: serviceOrigin,
    plan: z.strictObject({
      org: scalar('plan organization', 128),
      plan: z.literal('free'),
      state: z.literal('active'),
      source: z.literal('default'),
    }),
  }),
});
export const LegacyBillingPlanEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  service: serviceOrigin,
  capturedAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  authoritativeOrganizationCount: z.number().int().nonnegative(),
  projections: z.array(planProjection),
  reconciliation: z.strictObject({
    complete: z.literal(true),
    treatment: z.literal('preserve_as_free'),
    counts: z.strictObject({
      freeActiveDefault: z.number().int().nonnegative(),
      exceptions: z.literal(0),
    }),
  }),
});
export type LegacyBillingPlanEvidence = z.infer<typeof LegacyBillingPlanEvidenceSchema>;
export function parseLegacyBillingMigrationPlanEvidence(value: unknown): LegacyBillingPlanEvidence {
  const result = LegacyBillingPlanEvidenceSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid billing migration plan evidence: ${z.prettifyError(result.error)}`);
  }
  const evidence = result.data;
  if (evidence.authoritativeOrganizationCount !== evidence.projections.length) {
    throw new Error(
      'invalid billing migration plan evidence: authoritativeOrganizationCount must equal projections length',
    );
  }
  if (evidence.reconciliation.counts.freeActiveDefault !== evidence.projections.length) {
    throw new Error(
      'invalid billing migration plan evidence: reconciliation counts do not match projections',
    );
  }
  const organizations = new Set<string>();
  for (const projection of evidence.projections) {
    if (organizations.has(projection.org)) {
      throw new Error(
        `invalid billing migration plan evidence: duplicate organization ${projection.org}`,
      );
    }
    organizations.add(projection.org);
    if (projection.response.plan.org !== projection.org) {
      throw new Error(
        `invalid billing migration plan evidence: plan organization does not match ${projection.org}`,
      );
    }
    if (projection.response.service !== evidence.service) {
      throw new Error(
        `invalid billing migration plan evidence: ${projection.org} is not default Free and active`,
      );
    }
  }
  return evidence;
}

export const LegacyBillingMigrationApplyRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('shadow'),
  mappings: LegacyBillingMigrationRequestSchema.shape.mappings.unwrap(),
  expectedPreviewChecksum: checksum,
  legacyPlanEvidence: LegacyBillingPlanEvidenceSchema,
  idempotencyKey: scalar('idempotencyKey', 256),
  reason: scalar('reason', 512),
  confirmed: z.literal(true),
});
export interface LegacyBillingMigrationApplyRequest {
  readonly schemaVersion: 1;
  readonly mode: 'shadow';
  readonly mappings: readonly LegacyBillingMigrationMapping[];
  readonly expectedPreviewChecksum: string;
  readonly legacyPlanEvidence: LegacyBillingPlanEvidence;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly confirmed: true;
}
export function parseLegacyBillingMigrationApplyRequest(
  value: unknown,
): LegacyBillingMigrationApplyRequest {
  const result = LegacyBillingMigrationApplyRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid billing migration apply: ${z.prettifyError(result.error)}`);
  }
  parseLegacyBillingMigrationPlanEvidence(result.data.legacyPlanEvidence);
  return result.data as LegacyBillingMigrationApplyRequest;
}

const applyResultShape = {
  schemaVersion: z.literal(1),
  migrationId: z.string(),
  mode: z.literal('shadow'),
  state: z.literal('prepared'),
  replayed: z.boolean(),
  preparedAt: z.string(),
  enforcementMode: z.literal('legacy_unchanged'),
  meteringMode: z.literal('not_started'),
  grantMode: z.literal('pending_activation'),
  mappingChecksum: checksum,
  previewChecksum: checksum,
  planEvidenceChecksum: checksum,
} as const;
const createApplyResultSchema = (loose = false) => {
  const object = loose ? z.object : z.strictObject;
  return object({
    ...applyResultShape,
    counts: object({
      organizations: z.number().int().nonnegative(),
      accountsCreated: z.number().int().nonnegative(),
      accountsReused: z.number().int().nonnegative(),
      linksCreated: z.number().int().nonnegative(),
      linksPreserved: z.number().int().nonnegative(),
      productionApps: z.number().int().nonnegative(),
      grantCandidateFundingSets: z.number().int().nonnegative(),
    }),
    fundingSets: z.array(
      object({
        billingAccountId: z.string(),
        accountDisposition: z.enum(['created', 'existing']),
        snapshotId: z.string(),
        organizations: z.number().int().nonnegative(),
        productionApps: z.number().int().nonnegative(),
        grantCandidate: z.boolean(),
      }),
    ),
    links: z.array(
      object({
        org: z.string(),
        billingAccountId: z.string(),
        version: z.number().int().positive(),
        disposition: z.enum(['created', 'preserved']),
      }),
    ),
  });
};
export const LegacyBillingMigrationApplyResultSchema = createApplyResultSchema();
export const LegacyBillingMigrationApplyClientResultSchema = createApplyResultSchema(true);
export type LegacyBillingMigrationApplyResult = z.infer<
  typeof LegacyBillingMigrationApplyResultSchema
>;
export const LegacyBillingMigrationApplyResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: LegacyBillingMigrationApplyResultSchema,
});
export const LegacyBillingMigrationApplyClientResponseSchema = z.object({
  ok: z.literal(true),
  data: LegacyBillingMigrationApplyClientResultSchema,
});

export function normalizeBillingMigrationServiceUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('billing migration service must be an HTTP(S) origin');
  }
  return parsed.origin;
}
