import { z } from 'zod';

export const ApplicationActivitySchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  actorReference: z.string().regex(/^[a-f0-9]{64}$/),
  tool: z.string().min(1).max(128),
  operation: z.string().min(1).max(128),
  connectionId: z.string().max(128).optional(),
  outcome: z.enum(['dispatching', 'completed', 'rejected', 'accepted', 'unknown', 'returned']),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  reference: z.string().max(256).optional(),
});
export const ApplicationActivityListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    activities: z.array(ApplicationActivitySchema).max(100),
    nextCursor: z.string().max(2048).optional(),
    historyDays: z.number().int().min(1).max(365),
  }),
});
export const ApplicationActivitySettingsSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  retentionDays: z.number().int().min(1).max(365),
  maximumDays: z.number().int().min(1).max(365),
  canEdit: z.boolean(),
});
export const ApplicationActivitySettingsResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: ApplicationActivitySettingsSchema,
});
export const ApplicationActivitySettingsSaveRequestSchema = z.strictObject({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  retentionDays: z.number().int().min(1).max(365),
});

/** Clients tolerate additive response fields; writes and server output remain strict. */
export const ApplicationActivityListClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    ...ApplicationActivityListResponseSchema.shape.data.shape,
    activities: z
      .array(
        z.object({
          ...ApplicationActivitySchema.shape,
          actorReference: ApplicationActivitySchema.shape.actorReference.optional(),
        }),
      )
      .max(100),
  }),
});
export const ApplicationActivitySettingsClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object(ApplicationActivitySettingsSchema.shape),
});

const ActivityPreviewScenarioSchema = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  maximumDays: z.number().int().min(1).max(365),
  additionallyHiddenAtPeriodEndCount: z.number().int().nonnegative(),
});
const ActivityPreviewAvailableSchema = z.strictObject({
  state: z.literal('available'),
  kind: z.literal('hypothetical'),
  asOf: z.iso.datetime(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  currentMaximumDays: z.number().int().min(1).max(365),
  paidPeriodEnd: z.iso.datetime(),
  currentlyAccessibleCount: z.number().int().nonnegative(),
  physicallyExpiresByPeriodEndCount: z.number().int().nonnegative(),
  scenarios: z.array(ActivityPreviewScenarioSchema).min(1).max(2),
});
const ActivityPreviewUnavailableSchema = z.strictObject({
  state: z.literal('unavailable'),
  reason: z.literal('no_verified_paid_period'),
});
export const ApplicationActivityPreviewResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.discriminatedUnion('state', [
    ActivityPreviewAvailableSchema,
    ActivityPreviewUnavailableSchema,
  ]),
});
export const ApplicationActivityPreviewClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.discriminatedUnion('state', [
    z.object({
      ...ActivityPreviewAvailableSchema.shape,
      scenarios: z.array(z.object(ActivityPreviewScenarioSchema.shape)).min(1).max(2),
    }),
    z.object(ActivityPreviewUnavailableSchema.shape),
  ]),
});
