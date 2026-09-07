import { z } from 'zod';

export const DISTRIBUTION_ARCHIVE_MAX_BYTES = 12 * 1024 * 1024;
export const DISTRIBUTION_GRANT_DEFAULT_TTL_SECONDS = 15 * 60;
export const DISTRIBUTION_GRANT_MAX_TTL_SECONDS = 60 * 60;
export const DISTRIBUTION_GRANT_MIN_TTL_SECONDS = 60;
const DISTRIBUTION_ARCHIVE_BASE64_MAX_CHARS = Math.ceil(DISTRIBUTION_ARCHIVE_MAX_BYTES / 3) * 4;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ADAPTER_VERSION = /^\d+\.\d+\.\d+$/;

const ArchiveUploadSchema = z
  .object({
    encoding: z.literal('base64'),
    content: z.string().min(4).max(DISTRIBUTION_ARCHIVE_BASE64_MAX_CHARS).regex(BASE64),
    byteLength: z.number().int().positive().max(DISTRIBUTION_ARCHIVE_MAX_BYTES),
    sha256: z.string().regex(SHA256),
    treeSha256: z.string().regex(SHA256),
    adapterVersion: z.string().regex(ADAPTER_VERSION),
  })
  .strict();

const PublishRequestBase = {
  schemaVersion: z.literal(1),
  snapshotSha256: z.string().regex(SHA256),
  archive: ArchiveUploadSchema,
} as const;

/** Exact deterministic archive bytes offered for one supported host projection. */
export const DistributionPublishRequestSchema = z.discriminatedUnion('target', [
  z
    .object({
      ...PublishRequestBase,
      target: z.literal('openai'),
      variant: z.literal('submission'),
    })
    .strict(),
  z
    .object({
      ...PublishRequestBase,
      target: z.literal('claude'),
      variant: z.literal('plugin'),
    })
    .strict(),
]);

export type DistributionPublishRequest = z.output<typeof DistributionPublishRequestSchema>;
export type DistributionTarget = DistributionPublishRequest['target'];
export type DistributionVariant = DistributionPublishRequest['variant'];

const DistributionVersionBase = {
  id: z.string().min(1).max(100),
  schemaVersion: z.literal(1),
  orgSlug: z.string().min(1).max(100),
  deploymentId: z.string().min(1).max(200),
  appSlug: z.string().min(1).max(100),
  environment: z.string().min(1).max(100),
  serverVersion: z.string().min(1).max(100).optional(),
  version: z.number().int().positive(),
  snapshotSha256: z.string().regex(SHA256),
  sourceManifestSha256: z.string().regex(SHA256),
  mcpSurfaceSha256: z.string().regex(SHA256),
  adapterVersion: z.string().regex(ADAPTER_VERSION),
  treeSha256: z.string().regex(SHA256),
  archiveSha256: z.string().regex(SHA256),
  byteLength: z.number().int().positive().max(DISTRIBUTION_ARCHIVE_MAX_BYTES),
  createdAt: z.string().datetime({ offset: true }),
  createdBySubject: z.string().min(1).max(512),
  createdByEmail: z.string().email().max(320).optional(),
} as const;

/** Metadata only: archive bytes never enter JSON read responses. */
export const DistributionVersionSchema = z.discriminatedUnion('target', [
  z.object({
    ...DistributionVersionBase,
    target: z.literal('openai'),
    variant: z.literal('submission'),
  }),
  z.object({
    ...DistributionVersionBase,
    target: z.literal('claude'),
    variant: z.literal('plugin'),
  }),
]);

export type DistributionVersion = z.output<typeof DistributionVersionSchema>;

export const DistributionReadinessStatusSchema = z.enum(['draft', 'ready', 'blocked']);
export const DistributionHumanReviewStatusSchema = z.enum([
  'submitted',
  'in-review',
  'changes-requested',
  'approved',
  'rejected',
  'published',
  'withdrawn',
]);
export const DistributionVisibilitySchema = z.enum(['private', 'public']);

const ActorStampSchema = {
  updatedAt: z.string().datetime({ offset: true }),
  updatedBySubject: z.string().min(1).max(512),
  updatedByEmail: z.string().email().max(320).optional(),
} as const;

const DistributionReadinessSchema = z.object({
  status: DistributionReadinessStatusSchema,
  note: z.string().trim().min(1).max(1_000).optional(),
  ...ActorStampSchema,
});

const DistributionHumanReviewSchema = z.object({
  source: z.literal('human'),
  reportedStatus: DistributionHumanReviewStatusSchema,
  feedback: z.string().trim().min(1).max(4_000).optional(),
  recordedAt: z.string().datetime({ offset: true }),
  recordedBySubject: z.string().min(1).max(512),
  recordedByEmail: z.string().email().max(320).optional(),
});

const DistributionDispositionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }),
  z.object({
    status: z.literal('deprecated'),
    changedAt: z.string().datetime({ offset: true }),
    changedBySubject: z.string().min(1).max(512),
    changedByEmail: z.string().email().max(320).optional(),
  }),
  z.object({
    status: z.literal('revoked'),
    changedAt: z.string().datetime({ offset: true }),
    changedBySubject: z.string().min(1).max(512),
    changedByEmail: z.string().email().max(320).optional(),
  }),
]);

export const DistributionReleaseSchema = z.object({
  id: z.string().min(1).max(100),
  activeDistributionId: z.string().min(1).max(100),
  visibility: DistributionVisibilitySchema,
  ...ActorStampSchema,
});

/** Mutable operator evidence kept separate from immutable archive/version metadata. */
export const DistributionLifecycleSchema = z.object({
  schemaVersion: z.literal(1),
  distributionId: z.string().min(1).max(100),
  readiness: DistributionReadinessSchema,
  review: DistributionHumanReviewSchema.optional(),
  disposition: DistributionDispositionSchema,
  release: DistributionReleaseSchema.optional(),
});

export type DistributionReadinessStatus = z.output<typeof DistributionReadinessStatusSchema>;
export type DistributionHumanReviewStatus = z.output<typeof DistributionHumanReviewStatusSchema>;
export type DistributionVisibility = z.output<typeof DistributionVisibilitySchema>;
export type DistributionRelease = z.output<typeof DistributionReleaseSchema>;
export type DistributionLifecycle = z.output<typeof DistributionLifecycleSchema>;

export const DistributionReadinessRequestSchema = z
  .object({
    status: DistributionReadinessStatusSchema,
    note: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const DistributionHumanReviewRequestSchema = z
  .object({
    reportedStatus: DistributionHumanReviewStatusSchema,
    feedback: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.reportedStatus === 'changes-requested' || value.reportedStatus === 'rejected') &&
      value.feedback === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['feedback'],
        message: `feedback is required when reportedStatus is ${value.reportedStatus}`,
      });
    }
  });

export const DistributionReleaseRequestSchema = z
  .object({ visibility: DistributionVisibilitySchema })
  .strict();

export const DistributionDownloadGrantRequestSchema = z
  .object({
    expiresInSeconds: z
      .number()
      .int()
      .min(DISTRIBUTION_GRANT_MIN_TTL_SECONDS)
      .max(DISTRIBUTION_GRANT_MAX_TTL_SECONDS)
      .default(DISTRIBUTION_GRANT_DEFAULT_TTL_SECONDS),
  })
  .strict();

export type DistributionReadinessRequest = z.output<typeof DistributionReadinessRequestSchema>;
export type DistributionHumanReviewRequest = z.output<typeof DistributionHumanReviewRequestSchema>;
export type DistributionReleaseRequest = z.output<typeof DistributionReleaseRequestSchema>;
export type DistributionDownloadGrantRequest = z.output<
  typeof DistributionDownloadGrantRequestSchema
>;

export const DistributionPublishResponseSchema = z.object({
  ok: z.literal(true),
  data: DistributionVersionSchema,
  replayed: z.boolean(),
});

export const DistributionResponseSchema = z.object({
  ok: z.literal(true),
  data: DistributionVersionSchema,
  lifecycle: DistributionLifecycleSchema.optional(),
});

export const DistributionListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ versions: z.array(DistributionVersionSchema).max(200) }),
});

export const DistributionLifecycleResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    version: DistributionVersionSchema,
    lifecycle: DistributionLifecycleSchema,
  }),
});

export const DistributionDownloadGrantResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    grantId: z.string().min(1).max(100),
    distributionId: z.string().min(1).max(100),
    downloadPath: z.string().min(1).max(1_000).startsWith('/v1/distribution-download-grants/'),
    expiresAt: z.string().datetime({ offset: true }),
  }),
});

const PublicDistributionBase = {
  releaseId: z.string().min(1).max(100),
  appSlug: z.string().min(1).max(100),
  version: z.number().int().positive(),
  archiveSha256: z.string().regex(SHA256),
  byteLength: z.number().int().positive().max(DISTRIBUTION_ARCHIVE_MAX_BYTES),
  archivePath: z.string().min(1).max(500).startsWith('/v1/distribution-releases/'),
} as const;

export const PublicDistributionSchema = z.discriminatedUnion('target', [
  z.object({
    ...PublicDistributionBase,
    target: z.literal('openai'),
    variant: z.literal('submission'),
  }),
  z.object({
    ...PublicDistributionBase,
    target: z.literal('claude'),
    variant: z.literal('plugin'),
  }),
]);

export const PublicDistributionResponseSchema = z.object({
  ok: z.literal(true),
  data: PublicDistributionSchema,
});

export type DistributionPublishResponse = z.output<typeof DistributionPublishResponseSchema>;
export type DistributionResponse = z.output<typeof DistributionResponseSchema>;
export type DistributionListResponse = z.output<typeof DistributionListResponseSchema>;
export type DistributionLifecycleResponse = z.output<typeof DistributionLifecycleResponseSchema>;
export type DistributionDownloadGrantResponse = z.output<
  typeof DistributionDownloadGrantResponseSchema
>;
export type PublicDistribution = z.output<typeof PublicDistributionSchema>;
export type PublicDistributionResponse = z.output<typeof PublicDistributionResponseSchema>;
