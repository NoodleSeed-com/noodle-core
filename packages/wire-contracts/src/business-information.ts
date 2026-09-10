import { z } from 'zod';
import { BusinessNoticeSchema } from './solution-onboarding.js';

/** Public Noodle-authored profiles. B2B SaaS uses the private-definition path. */
export const MANAGED_SOLUTION_PROFILE_IDS = ['travel', 'ecommerce', 'restaurant'] as const;
export const LEGACY_SOLUTION_PROFILE_IDS = ['b2b_saas'] as const;
export const SOLUTION_PROFILE_IDS = [
  ...MANAGED_SOLUTION_PROFILE_IDS,
  ...LEGACY_SOLUTION_PROFILE_IDS,
] as const;
export const ManagedSolutionProfileIdSchema = z.enum(MANAGED_SOLUTION_PROFILE_IDS);
export const LegacySolutionProfileIdSchema = z.enum(LEGACY_SOLUTION_PROFILE_IDS);
/** Read compatibility for persisted identifiers; never use this schema for new catalog entries. */
export const SolutionProfileIdSchema = z.enum(SOLUTION_PROFILE_IDS);
export type ManagedSolutionProfileId = z.infer<typeof ManagedSolutionProfileIdSchema>;
export type LegacySolutionProfileId = z.infer<typeof LegacySolutionProfileIdSchema>;
export type SolutionProfileId = z.infer<typeof SolutionProfileIdSchema>;

export const MANAGED_RECORD_RETENTION_DAYS = [7, 30, 90] as const;
export const ManagedRecordRetentionDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
]);
export type ManagedRecordRetentionDays = z.infer<typeof ManagedRecordRetentionDaysSchema>;

/** Optional request-application behavior; not a universal collection lifecycle. */
export const MANAGED_RECORD_STATUSES = ['new', 'in_progress', 'resolved', 'closed'] as const;
export const ManagedRecordStatusSchema = z.enum(MANAGED_RECORD_STATUSES);
export type ManagedRecordStatus = z.infer<typeof ManagedRecordStatusSchema>;

export const BUSINESS_GRANT_ROLES = ['administrator', 'manager', 'operator', 'viewer'] as const;
export const BusinessGrantRoleSchema = z.enum(BUSINESS_GRANT_ROLES);
export type BusinessGrantRole = z.infer<typeof BusinessGrantRoleSchema>;

export const MANAGED_RECORD_ORIGIN_SURFACES = ['public', 'portal', 'mcp', 'api'] as const;
export const ManagedRecordOriginSurfaceSchema = z.enum(MANAGED_RECORD_ORIGIN_SURFACES);
export type ManagedRecordOriginSurface = z.infer<typeof ManagedRecordOriginSurfaceSchema>;

export const COLLECTION_SOURCE_HEALTH_STATES = [
  'pending',
  'healthy',
  'degraded',
  'unavailable',
  'authorization_required',
  'paused',
] as const;
export const CollectionSourceHealthSchema = z.enum(COLLECTION_SOURCE_HEALTH_STATES);
export type CollectionSourceHealth = z.infer<typeof CollectionSourceHealthSchema>;

export const COLLECTION_SOURCE_COMPLETENESS_STATES = [
  'unknown',
  'partial',
  'complete',
  'rebuilding',
] as const;
export const CollectionSourceCompletenessSchema = z.enum(COLLECTION_SOURCE_COMPLETENESS_STATES);
export type CollectionSourceCompleteness = z.infer<typeof CollectionSourceCompletenessSchema>;

const id = z.string().min(1).max(128);
const slug = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(63);
const collectionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);
const operationName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);
const instant = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.unknown());
const positiveRevision = z.number().int().positive();

const collectionProfileShape = {
  key: collectionKey,
  title: z.string().min(1).max(120),
  singularTitle: z.string().min(1).max(120),
  schemaVersion: z.number().int().positive(),
  schemaDigest: digest,
  recordSchema: jsonObject,
  summaryFields: z.array(z.string().min(1).max(64)).max(128),
  fields: z
    .record(
      z.string().min(1).max(64),
      z.strictObject({
        label: z.string().min(1).max(120).optional(),
        help: z.string().max(1000).optional(),
      }),
    )
    .optional(),
  filterFields: z.array(z.string().min(1).max(64)).max(128).optional(),
  sortFields: z.array(z.string().min(1).max(64)).max(128).optional(),
};

export const ManagedRequestBehaviorSchema = z.strictObject({
  statuses: z.array(ManagedRecordStatusSchema).min(1).max(MANAGED_RECORD_STATUSES.length),
  assignment: z.boolean(),
  notes: z.boolean(),
});
export type ManagedRequestBehavior = z.infer<typeof ManagedRequestBehaviorSchema>;

export const NativeManagedCollectionProfileSchema = z.strictObject({
  authority: z.literal('native'),
  ...collectionProfileShape,
  management: z
    .strictObject({ assignment: z.literal(true).optional(), notes: z.literal(true).optional() })
    .optional(),
  publicFields: z.array(z.string().min(1).max(64)).max(128).optional(),
  editableFields: z.array(z.string().min(1).max(64)).max(128).optional(),
  capabilities: z.strictObject({
    read: z.literal(true),
    create: z.literal(true),
    update: z.literal(true),
    erase: z.literal(true),
    sourceControls: z.literal(false),
  }),
  requestBehavior: ManagedRequestBehaviorSchema.optional(),
});
export type NativeManagedCollectionProfile = z.infer<typeof NativeManagedCollectionProfileSchema>;

export const ExternalManagedCollectionProfileSchema = z.strictObject({
  authority: z.literal('external'),
  ...collectionProfileShape,
  capabilities: z.strictObject({
    read: z.literal(true),
    create: z.literal(false),
    update: z.literal(false),
    erase: z.literal(true),
    sourceControls: z.literal(true),
  }),
  source: z.strictObject({
    connector: id,
    scanOperation: operationName,
  }),
});
export type ExternalManagedCollectionProfile = z.infer<
  typeof ExternalManagedCollectionProfileSchema
>;

export const ManagedCollectionProfileSchema = z.discriminatedUnion('authority', [
  NativeManagedCollectionProfileSchema,
  ExternalManagedCollectionProfileSchema,
]);
export type ManagedCollectionProfile = z.infer<typeof ManagedCollectionProfileSchema>;

export const SolutionProfileSchema = z.strictObject({
  id: ManagedSolutionProfileIdSchema,
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  collections: z.array(ManagedCollectionProfileSchema).min(1).max(12),
});
export type SolutionProfile = z.infer<typeof SolutionProfileSchema>;

export const SolutionCatalogResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    profiles: z.array(SolutionProfileSchema).max(MANAGED_SOLUTION_PROFILE_IDS.length),
  }),
});
export type SolutionCatalogResponse = z.infer<typeof SolutionCatalogResponseSchema>;

export const ManagedSolutionDefinitionSelectorSchema = z.strictObject({
  kind: z.literal('managed'),
  profileId: ManagedSolutionProfileIdSchema,
});
export const PrivateSolutionDefinitionReferenceSchema = z.strictObject({
  kind: z.literal('private'),
  publisherOrg: id,
  app: slug,
  environment: z.string().min(1).max(63),
  deploymentId: id,
});
export const InstallableSolutionDefinitionSchema = z.discriminatedUnion('kind', [
  ManagedSolutionDefinitionSelectorSchema,
  PrivateSolutionDefinitionReferenceSchema,
]);
export type InstallableSolutionDefinition = z.infer<typeof InstallableSolutionDefinitionSchema>;

export const SolutionInstallationCreateRequestSchema = z.strictObject({
  businessNotice: BusinessNoticeSchema.optional(),
  definition: InstallableSolutionDefinitionSchema,
  appSlug: slug,
  environment: z.string().min(1).max(63),
  retentionDays: ManagedRecordRetentionDaysSchema,
});
export type SolutionInstallationCreateRequest = z.infer<
  typeof SolutionInstallationCreateRequestSchema
>;

export const SolutionInstallationIntakeRequestSchema = z.strictObject({
  active: z.boolean(),
  expectedRevision: positiveRevision,
});
export type SolutionInstallationIntakeRequest = z.infer<
  typeof SolutionInstallationIntakeRequestSchema
>;

export const SolutionInstallationActivateRequestSchema = z.strictObject({});
export const SolutionInstallationActivationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pending'), canRetry: z.boolean() }),
  z.strictObject({ state: z.enum(['ready', 'unavailable']), canRetry: z.literal(false) }),
]);
export type SolutionInstallationActivation = z.infer<typeof SolutionInstallationActivationSchema>;

const installationShape = {
  activation: SolutionInstallationActivationSchema.optional(),
  id,
  organizationId: id,
  appSlug: slug,
  environment: z.string().min(1).max(63),
  retentionDays: ManagedRecordRetentionDaysSchema,
  publicId: id,
  active: z.boolean(),
  currentRole: BusinessGrantRoleSchema,
  revision: positiveRevision,
  createdAt: instant,
  updatedAt: instant,
  createdBySubject: id,
};

export const ResolvedManagedSolutionDefinitionSchema = z.strictObject({
  kind: z.literal('managed'),
  definitionId: ManagedSolutionProfileIdSchema,
  release: z.number().int().positive(),
  digest,
});
export const ResolvedPrivateSolutionDefinitionSchema = z.strictObject({
  kind: z.literal('private'),
  publisherOrg: id,
  app: slug,
  environment: z.string().min(1).max(63),
  deploymentId: id,
  version: z.string().min(1).max(128),
  digest,
});
export const ResolvedLegacySolutionDefinitionSchema = z.strictObject({
  kind: z.literal('legacy'),
  definitionId: LegacySolutionProfileIdSchema,
  release: z.number().int().positive(),
  digest,
});
export const ResolvedSolutionDefinitionSchema = z.discriminatedUnion('kind', [
  ResolvedManagedSolutionDefinitionSchema,
  ResolvedPrivateSolutionDefinitionSchema,
  ResolvedLegacySolutionDefinitionSchema,
]);
export type ResolvedSolutionDefinition = z.infer<typeof ResolvedSolutionDefinitionSchema>;

export const SolutionInstallationSchema = z.strictObject({
  ...installationShape,
  definition: ResolvedSolutionDefinitionSchema,
  collections: z.array(ManagedCollectionProfileSchema).max(16),
  /** Historical persisted key retained only while legacy installations are backfilled. */
  profileId: LegacySolutionProfileIdSchema.optional(),
});
export type SolutionInstallation = z.infer<typeof SolutionInstallationSchema>;

export const SolutionInstallationResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ installation: SolutionInstallationSchema }),
});
export type SolutionInstallationResponse = z.infer<typeof SolutionInstallationResponseSchema>;

export const SolutionInstallationListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    installations: z.array(SolutionInstallationSchema).max(100),
    nextCursor: z.string().min(1).max(1024).optional(),
  }),
});
export type SolutionInstallationListResponse = z.infer<
  typeof SolutionInstallationListResponseSchema
>;

export const BusinessGrantCreateRequestSchema = z.strictObject({
  subject: id,
  email: z.email().max(254),
  role: BusinessGrantRoleSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type BusinessGrantCreateRequest = z.infer<typeof BusinessGrantCreateRequestSchema>;

export const BusinessGrantSchema = z.strictObject({
  installationId: id,
  subject: id,
  email: z.email().max(254),
  role: BusinessGrantRoleSchema,
  revision: positiveRevision,
  createdAt: instant,
  createdBySubject: id,
  revokedAt: instant.optional(),
});
export type BusinessGrant = z.infer<typeof BusinessGrantSchema>;

export const BusinessGrantResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ grant: BusinessGrantSchema }),
});
export type BusinessGrantResponse = z.infer<typeof BusinessGrantResponseSchema>;

export const BusinessGrantListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ grants: z.array(BusinessGrantSchema).max(100) }),
});
export type BusinessGrantListResponse = z.infer<typeof BusinessGrantListResponseSchema>;

export const BUSINESS_INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export const BusinessInvitationStatusSchema = z.enum(BUSINESS_INVITATION_STATUSES);
export type BusinessInvitationStatus = z.infer<typeof BusinessInvitationStatusSchema>;

/** The raw token is supplied by the trusted client and is never persisted by the service. */
export const BusinessInvitationCreateRequestSchema = z.strictObject({
  email: z.email().max(254),
  role: BusinessGrantRoleSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  idempotencyKey: z.string().min(1).max(128),
  expiresInHours: z.number().int().min(1).max(168).default(168),
});
export type BusinessInvitationCreateRequest = z.infer<typeof BusinessInvitationCreateRequestSchema>;

export const BusinessInvitationRevokeRequestSchema = z.strictObject({
  expectedRevision: positiveRevision,
});
export type BusinessInvitationRevokeRequest = z.infer<typeof BusinessInvitationRevokeRequestSchema>;

export const BusinessInvitationSchema = z.strictObject({
  invitationId: id,
  installationId: id,
  email: z.email().max(254),
  role: BusinessGrantRoleSchema,
  status: BusinessInvitationStatusSchema,
  revision: positiveRevision,
  createdAt: instant,
  expiresAt: instant,
  createdBySubject: id,
  acceptedAt: instant.optional(),
  revokedAt: instant.optional(),
});
export type BusinessInvitation = z.infer<typeof BusinessInvitationSchema>;

export const BusinessInvitationResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ invitation: BusinessInvitationSchema }),
});
export type BusinessInvitationResponse = z.infer<typeof BusinessInvitationResponseSchema>;

export const BusinessInvitationCreateResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    invitation: BusinessInvitationSchema,
    acceptPath: z.string().startsWith('/portal-invitations/').max(512),
    replayed: z.boolean(),
  }),
});
export type BusinessInvitationCreateResponse = z.infer<
  typeof BusinessInvitationCreateResponseSchema
>;

export const BusinessInvitationListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ invitations: z.array(BusinessInvitationSchema).max(100) }),
});
export type BusinessInvitationListResponse = z.infer<typeof BusinessInvitationListResponseSchema>;

export const BusinessInvitationAcceptResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    installation: SolutionInstallationSchema,
    grant: BusinessGrantSchema,
  }),
});
export type BusinessInvitationAcceptResponse = z.infer<
  typeof BusinessInvitationAcceptResponseSchema
>;

export const EligibleBusinessAssigneeSchema = z.strictObject({
  subject: id,
  email: z.email().max(254),
  role: z.enum(['administrator', 'manager', 'operator']),
});
export type EligibleBusinessAssignee = z.infer<typeof EligibleBusinessAssigneeSchema>;

export const EligibleBusinessAssigneeListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ assignees: z.array(EligibleBusinessAssigneeSchema).max(100) }),
});
export type EligibleBusinessAssigneeListResponse = z.infer<
  typeof EligibleBusinessAssigneeListResponseSchema
>;

export const ManagedRecordCreateRequestSchema = z.strictObject({ payload: jsonObject });
export type ManagedRecordCreateRequest = z.infer<typeof ManagedRecordCreateRequestSchema>;

export const ManagedRecordOriginSchema = z.strictObject({
  surface: ManagedRecordOriginSurfaceSchema,
  subject: id.optional(),
});
export type ManagedRecordOrigin = z.infer<typeof ManagedRecordOriginSchema>;

export const ManagedRecordRequestStateSchema = z.strictObject({
  status: ManagedRecordStatusSchema,
  assigneeSubject: id.optional(),
});
export type ManagedRecordRequestState = z.infer<typeof ManagedRecordRequestStateSchema>;

const recordShape = {
  id,
  organizationId: id,
  appSlug: slug,
  environment: z.string().min(1).max(63),
  installationId: id,
  collection: collectionKey,
  schemaVersion: z.number().int().positive(),
  schemaDigest: digest,
  payload: jsonObject,
  revision: positiveRevision,
  createdAt: instant,
  updatedAt: instant,
  retentionExpiresAt: instant,
};

export const NativeManagedRecordSchema = z.strictObject({
  authority: z.literal('native'),
  ...recordShape,
  origin: ManagedRecordOriginSchema,
  assigneeSubject: id.optional(),
  request: ManagedRecordRequestStateSchema.optional(),
});
export type NativeManagedRecord = z.infer<typeof NativeManagedRecordSchema>;

export const ExternalManagedRecordSourceSchema = z.strictObject({
  bindingReference: id,
  bindingGeneration: z.number().int().positive(),
  sourceRecordId: id,
  sourceVersion: z.string().min(1).max(512).optional(),
  observedAt: instant,
  lastCompletedSyncAt: instant,
  health: CollectionSourceHealthSchema,
  completeness: CollectionSourceCompletenessSchema,
});
export const ExternalManagedRecordSchema = z.strictObject({
  authority: z.literal('external'),
  ...recordShape,
  source: ExternalManagedRecordSourceSchema,
});
export type ExternalManagedRecord = z.infer<typeof ExternalManagedRecordSchema>;

export const ManagedRecordSchema = z.discriminatedUnion('authority', [
  NativeManagedRecordSchema,
  ExternalManagedRecordSchema,
]);
export type ManagedRecord = z.infer<typeof ManagedRecordSchema>;

const tombstoneShape = {
  id,
  organizationId: id,
  appSlug: slug,
  environment: z.string().min(1).max(63),
  installationId: id,
  collection: collectionKey,
  revision: positiveRevision,
  deletedAt: instant,
};
export const NativeManagedRecordTombstoneSchema = z.strictObject({
  authority: z.literal('native'),
  ...tombstoneShape,
  deletionReason: z.enum(['customer_request', 'retention_expired']),
});
export const ExternalManagedRecordSuppressionSchema = z.strictObject({
  authority: z.literal('external'),
  ...tombstoneShape,
  deletionReason: z.literal('customer_request'),
  source: z.strictObject({
    bindingReference: id,
    bindingGeneration: z.number().int().positive(),
    sourceRecordId: id,
  }),
});
export const ManagedRecordTombstoneSchema = z.discriminatedUnion('authority', [
  NativeManagedRecordTombstoneSchema,
  ExternalManagedRecordSuppressionSchema,
]);
export type ManagedRecordTombstone = z.infer<typeof ManagedRecordTombstoneSchema>;

export const ManagedRecordResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    record: ManagedRecordSchema,
    collection: ManagedCollectionProfileSchema.optional(),
  }),
});
export type ManagedRecordResponse = z.infer<typeof ManagedRecordResponseSchema>;

const managedRecordOrTombstone = z.union([ManagedRecordSchema, ManagedRecordTombstoneSchema]);
export const ManagedRecordListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    records: z.array(managedRecordOrTombstone).max(100),
    nextCursor: z.string().min(1).optional(),
  }),
});
export type ManagedRecordListResponse = z.infer<typeof ManagedRecordListResponseSchema>;

export const ManagedRecordMutationRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('migrate-schema'), expectedRevision: positiveRevision }),
  z.strictObject({
    operation: z.literal('update'),
    expectedRevision: positiveRevision,
    patch: jsonObject,
    unset: z
      .array(z.string().min(1).max(64))
      .max(128)
      .refine((keys) => new Set(keys).size === keys.length)
      .optional(),
  }),
  z.strictObject({
    operation: z.literal('assign'),
    expectedRevision: positiveRevision,
    assigneeSubject: id.nullable(),
  }),
  z.strictObject({
    operation: z.literal('set-status'),
    expectedRevision: positiveRevision,
    status: ManagedRecordStatusSchema,
  }),
  z.strictObject({
    operation: z.literal('add-note'),
    expectedRevision: positiveRevision,
    note: z.string().min(1).max(4_000),
  }),
]);
export type ManagedRecordMutationRequest = z.infer<typeof ManagedRecordMutationRequestSchema>;

export const BusinessApiAdmissionErrorSchema = z.discriminatedUnion('code', [
  z.strictObject({
    code: z.literal('business_api_rate_limited'),
    error: z.string().min(1).max(500),
    category: z.enum(['read', 'mutation', 'recovery']),
    resetAt: z.iso.datetime(),
    limits: z.strictObject({
      subject: z.number().int().positive(),
      installation: z.number().int().positive(),
      org: z.number().int().positive(),
    }),
  }),
  z.strictObject({
    code: z.literal('business_api_admission_unavailable'),
    error: z.string().min(1).max(500),
  }),
]);
export type BusinessApiAdmissionError = z.infer<typeof BusinessApiAdmissionErrorSchema>;
export const SolutionInstallationCapacityErrorSchema = z.strictObject({
  code: z.literal('installation_capacity_exceeded'),
  error: z.string().min(1).max(500),
});
export type SolutionInstallationCapacityError = z.infer<
  typeof SolutionInstallationCapacityErrorSchema
>;

export const ManagedRecordOperationNotSupportedErrorSchema = z.strictObject({
  ok: z.literal(false),
  error: z.string().min(1).max(500),
  code: z.literal('operation_not_supported'),
  details: z.strictObject({
    authority: z.literal('external'),
    operation: z.enum(['create', 'update', 'assign', 'set-status', 'add-note', 'migrate-schema']),
  }),
});
export type ManagedRecordOperationNotSupportedError = z.infer<
  typeof ManagedRecordOperationNotSupportedErrorSchema
>;

export const ManagedRecordActivitySchema = z.strictObject({
  id,
  recordId: id,
  revision: positiveRevision,
  operation: z.enum([
    'create',
    'update',
    'assign',
    'set-status',
    'add-note',
    'delete',
    'source-import',
    'schema-migrated',
    'source-delete',
    'suppress',
  ]),
  actorSubject: id.optional(),
  createdAt: instant,
  note: z.string().max(4_000).optional(),
});
export type ManagedRecordActivity = z.infer<typeof ManagedRecordActivitySchema>;

export const ManagedRecordActivityListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    activities: z.array(ManagedRecordActivitySchema).max(100),
    nextCursor: z.string().max(2048).optional(),
  }),
});
export type ManagedRecordActivityListResponse = z.infer<
  typeof ManagedRecordActivityListResponseSchema
>;

export const ManagedRecordDeleteResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    recordId: id,
    authority: z.enum(['native', 'external']),
    disposition: z.enum(['deleted', 'suppressed']),
    deletedAt: instant,
  }),
});
export type ManagedRecordDeleteResponse = z.infer<typeof ManagedRecordDeleteResponseSchema>;

export const ManagedRecordNoteSchema = z.strictObject({
  id,
  text: z.string().max(4_000),
  createdAt: instant,
  createdBySubject: id,
});
export const ManagedRecordExportResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    records: z
      .array(
        z.union([
          NativeManagedRecordSchema.extend({
            notes: z.array(ManagedRecordNoteSchema).max(50).optional(),
          }),
          ExternalManagedRecordSchema,
          ManagedRecordTombstoneSchema,
        ]),
      )
      .max(500),
    nextCursor: z.string().min(1).optional(),
  }),
});
export type ManagedRecordExportResponse = z.infer<typeof ManagedRecordExportResponseSchema>;

const sourceScopeShape = {
  installationId: id,
  collection: collectionKey,
  authority: z.literal('external'),
  revision: positiveRevision,
};
const sourceError = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
});
export const UnconfiguredCollectionSourceSchema = z.strictObject({
  ...sourceScopeShape,
  state: z.literal('unconfigured'),
});
export const ConfiguredCollectionSourceSchema = z.strictObject({
  ...sourceScopeShape,
  state: z.enum(['active', 'paused', 'error']),
  binding: z.strictObject({ reference: id, generation: z.number().int().positive() }),
  configurationReference: id,
  enabled: z.literal(true),
  health: CollectionSourceHealthSchema,
  completeness: CollectionSourceCompletenessSchema,
  lastCompletedSyncAt: instant.optional(),
  nextRefreshAt: instant.optional(),
  error: sourceError.optional(),
});
export const CollectionSourceSchema = z.discriminatedUnion('state', [
  UnconfiguredCollectionSourceSchema,
  ConfiguredCollectionSourceSchema,
]);
export type CollectionSource = z.infer<typeof CollectionSourceSchema>;

export const CollectionSourceConfigureRequestSchema = z.strictObject({
  expectedRevision: positiveRevision,
  binding: z.strictObject({ reference: id, generation: z.number().int().positive() }),
  configurationReference: id,
  enable: z.literal(true),
  replace: z.literal(true).optional(),
});
export type CollectionSourceConfigureRequest = z.infer<
  typeof CollectionSourceConfigureRequestSchema
>;
export const CollectionSourceRevisionRequestSchema = z.strictObject({
  expectedRevision: positiveRevision,
});
export type CollectionSourceRevisionRequest = z.infer<typeof CollectionSourceRevisionRequestSchema>;
export const CollectionSourceRefreshRequestSchema = z.strictObject({
  expectedRevision: positiveRevision,
  idempotencyKey: z.string().min(1).max(256),
});
export type CollectionSourceRefreshRequest = z.infer<typeof CollectionSourceRefreshRequestSchema>;

export const CollectionSourceResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ source: CollectionSourceSchema }),
});
export type CollectionSourceResponse = z.infer<typeof CollectionSourceResponseSchema>;
export const CollectionSourceRefreshResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    source: CollectionSourceSchema,
    job: z.strictObject({
      id,
      state: z.enum(['queued', 'running', 'completed', 'superseded']),
      coalesced: z.boolean(),
      requestedAt: instant,
      replayExpiresAt: instant.optional(),
    }),
  }),
});
export type CollectionSourceRefreshResponse = z.infer<typeof CollectionSourceRefreshResponseSchema>;

export const PublicSolutionIntakeResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    publicId: id,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(240),
    collection: NativeManagedCollectionProfileSchema,
  }),
});
export type PublicSolutionIntakeResponse = z.infer<typeof PublicSolutionIntakeResponseSchema>;

export const PublicSolutionIntakeReceiptResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ recordId: id, receivedAt: instant }),
});
export type PublicSolutionIntakeReceiptResponse = z.infer<
  typeof PublicSolutionIntakeReceiptResponseSchema
>;
