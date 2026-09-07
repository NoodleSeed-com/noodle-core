import { z } from 'zod';

/** Public, data-driven solution profiles shipped by the managed-record MVP. */
export const SOLUTION_PROFILE_IDS = ['travel', 'b2b_saas', 'ecommerce', 'restaurant'] as const;
export const SolutionProfileIdSchema = z.enum(SOLUTION_PROFILE_IDS);
export type SolutionProfileId = z.infer<typeof SolutionProfileIdSchema>;

export const MANAGED_RECORD_RETENTION_DAYS = [7, 30, 90] as const;
export const ManagedRecordRetentionDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
]);
export type ManagedRecordRetentionDays = z.infer<typeof ManagedRecordRetentionDaysSchema>;

export const MANAGED_RECORD_STATUSES = ['new', 'in_progress', 'resolved', 'closed'] as const;
export const ManagedRecordStatusSchema = z.enum(MANAGED_RECORD_STATUSES);
export type ManagedRecordStatus = z.infer<typeof ManagedRecordStatusSchema>;

export const BUSINESS_GRANT_ROLES = ['administrator', 'manager', 'operator', 'viewer'] as const;
export const BusinessGrantRoleSchema = z.enum(BUSINESS_GRANT_ROLES);
export type BusinessGrantRole = z.infer<typeof BusinessGrantRoleSchema>;

export const MANAGED_RECORD_ORIGIN_SURFACES = ['public', 'portal', 'mcp', 'api'] as const;
export const ManagedRecordOriginSurfaceSchema = z.enum(MANAGED_RECORD_ORIGIN_SURFACES);
export type ManagedRecordOriginSurface = z.infer<typeof ManagedRecordOriginSurfaceSchema>;

const id = z.string().min(1).max(128);
const slug = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(63);
const collectionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);
const instant = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.unknown());

export const ManagedCollectionProfileSchema = z.strictObject({
  key: collectionKey,
  title: z.string().min(1).max(120),
  singularTitle: z.string().min(1).max(120),
  schemaVersion: z.number().int().positive(),
  schemaDigest: digest,
  recordSchema: jsonObject,
  summaryFields: z.array(z.string().min(1).max(64)).max(6),
});
export type ManagedCollectionProfile = z.infer<typeof ManagedCollectionProfileSchema>;

export const SolutionProfileSchema = z.strictObject({
  id: SolutionProfileIdSchema,
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  collection: ManagedCollectionProfileSchema,
});
export type SolutionProfile = z.infer<typeof SolutionProfileSchema>;

export const SolutionCatalogResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    profiles: z.array(SolutionProfileSchema).max(SOLUTION_PROFILE_IDS.length),
  }),
});
export type SolutionCatalogResponse = z.infer<typeof SolutionCatalogResponseSchema>;

export const SolutionInstallationCreateRequestSchema = z.strictObject({
  profileId: SolutionProfileIdSchema,
  appSlug: slug,
  environment: z.string().min(1).max(63),
  retentionDays: ManagedRecordRetentionDaysSchema,
});
export type SolutionInstallationCreateRequest = z.infer<
  typeof SolutionInstallationCreateRequestSchema
>;

export const SolutionInstallationSchema = z.strictObject({
  id,
  organizationId: id,
  profileId: SolutionProfileIdSchema,
  appSlug: slug,
  environment: z.string().min(1).max(63),
  retentionDays: ManagedRecordRetentionDaysSchema,
  publicId: id,
  active: z.boolean(),
  currentRole: BusinessGrantRoleSchema,
  revision: z.number().int().positive(),
  collection: ManagedCollectionProfileSchema,
  createdAt: instant,
  updatedAt: instant,
  createdBySubject: id,
});
export type SolutionInstallation = z.infer<typeof SolutionInstallationSchema>;

export const SolutionInstallationResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ installation: SolutionInstallationSchema }),
});
export type SolutionInstallationResponse = z.infer<typeof SolutionInstallationResponseSchema>;

export const SolutionInstallationListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ installations: z.array(SolutionInstallationSchema).max(100) }),
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
  revision: z.number().int().positive(),
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

export const ManagedRecordCreateRequestSchema = z.strictObject({
  payload: jsonObject,
});
export type ManagedRecordCreateRequest = z.infer<typeof ManagedRecordCreateRequestSchema>;

export const ManagedRecordOriginSchema = z.strictObject({
  surface: ManagedRecordOriginSurfaceSchema,
  subject: id.optional(),
});
export type ManagedRecordOrigin = z.infer<typeof ManagedRecordOriginSchema>;

export const ManagedRecordSchema = z.strictObject({
  id,
  installationId: id,
  collection: collectionKey,
  schemaVersion: z.number().int().positive(),
  schemaDigest: digest,
  payload: jsonObject,
  status: ManagedRecordStatusSchema,
  assigneeSubject: id.optional(),
  revision: z.number().int().positive(),
  origin: ManagedRecordOriginSchema,
  createdAt: instant,
  updatedAt: instant,
  retentionExpiresAt: instant,
});
export type ManagedRecord = z.infer<typeof ManagedRecordSchema>;

export const ManagedRecordTombstoneSchema = z.strictObject({
  id,
  installationId: id,
  collection: collectionKey,
  status: ManagedRecordStatusSchema,
  revision: z.number().int().positive(),
  deletedAt: instant,
  deletionReason: z.enum(['customer_request', 'retention_expired']),
});
export type ManagedRecordTombstone = z.infer<typeof ManagedRecordTombstoneSchema>;

export const ManagedRecordResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ record: ManagedRecordSchema }),
});
export type ManagedRecordResponse = z.infer<typeof ManagedRecordResponseSchema>;

export const ManagedRecordListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    records: z.array(z.union([ManagedRecordSchema, ManagedRecordTombstoneSchema])).max(100),
    nextCursor: z.string().min(1).optional(),
  }),
});
export type ManagedRecordListResponse = z.infer<typeof ManagedRecordListResponseSchema>;

const expectedRevision = z.number().int().positive();
export const ManagedRecordMutationRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('update'), expectedRevision, patch: jsonObject }),
  z.strictObject({
    operation: z.literal('assign'),
    expectedRevision,
    assigneeSubject: id.nullable(),
  }),
  z.strictObject({
    operation: z.literal('set-status'),
    expectedRevision,
    status: ManagedRecordStatusSchema,
  }),
  z.strictObject({
    operation: z.literal('add-note'),
    expectedRevision,
    note: z.string().min(1).max(4_000),
  }),
]);
export type ManagedRecordMutationRequest = z.infer<typeof ManagedRecordMutationRequestSchema>;

export const ManagedRecordActivitySchema = z.strictObject({
  id,
  recordId: id,
  revision: z.number().int().positive(),
  operation: z.enum(['create', 'update', 'assign', 'set-status', 'add-note', 'delete']),
  actorSubject: id.optional(),
  createdAt: instant,
  note: z.string().max(4_000).optional(),
});
export type ManagedRecordActivity = z.infer<typeof ManagedRecordActivitySchema>;

export const ManagedRecordActivityListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ activities: z.array(ManagedRecordActivitySchema).max(100) }),
});
export type ManagedRecordActivityListResponse = z.infer<
  typeof ManagedRecordActivityListResponseSchema
>;

export const ManagedRecordDeleteResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ recordId: id, deletedAt: instant }),
});
export type ManagedRecordDeleteResponse = z.infer<typeof ManagedRecordDeleteResponseSchema>;

export const ManagedRecordExportResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    records: z.array(z.union([ManagedRecordSchema, ManagedRecordTombstoneSchema])).max(500),
    nextCursor: z.string().min(1).optional(),
  }),
});
export type ManagedRecordExportResponse = z.infer<typeof ManagedRecordExportResponseSchema>;

export const PublicSolutionIntakeResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    publicId: id,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(240),
    collection: ManagedCollectionProfileSchema,
  }),
});
export type PublicSolutionIntakeResponse = z.infer<typeof PublicSolutionIntakeResponseSchema>;

export const PublicSolutionIntakeReceiptResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    recordId: id,
    receivedAt: instant,
  }),
});
export type PublicSolutionIntakeReceiptResponse = z.infer<
  typeof PublicSolutionIntakeReceiptResponseSchema
>;
