import { z } from 'zod';

/**
 * One installation history setting (ADR 0241 decision 6): an Activity duration and a conversation
 * duration (which may be Off) under the plan cap, plus per-channel recording switches, sharing one
 * revision. Server output is strict; the `*ClientResponseSchema` variants tolerate additive fields.
 */
const DaysSchema = z.number().int().min(1).max(365);
const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CountSchema = z.number().int().nonnegative();

export const HistorySourcesSchema = z.strictObject({
  websiteVisitors: z.boolean(),
  signedInCustomers: z.boolean(),
  whatsapp: z.boolean(),
});

/** A surface the application declared `history: false` on, named by its authoring constructor. */
export const ApplicationHistoryDisabledSurfaceSchema = z.enum([
  'publicWebsite',
  'authenticatedWebsite',
  'publicMessaging',
]);

export const ApplicationHistorySettingsSchema = z.strictObject({
  revision: RevisionSchema,
  canEdit: z.boolean(),
  activity: z.strictObject({
    retentionDays: DaysSchema,
    maximumDays: DaysSchema,
    defaultDays: DaysSchema,
  }),
  /** `not_enabled`: never opted in, so nothing is recorded; `off`: an Owner/Admin turned it off. */
  conversations: z.strictObject({
    state: z.enum(['not_enabled', 'off', 'on']),
    retentionDays: DaysSchema.optional(),
    sources: HistorySourcesSchema,
    /**
     * Surfaces whose chats are never kept, whatever this setting says, because the application
     * declared `history: false` in server.ts (ADR 0241 decision 11). Absent when none do.
     */
    disabledByApplication: z.array(ApplicationHistoryDisabledSurfaceSchema).min(1).optional(),
  }),
});
export const ApplicationHistorySettingsResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: ApplicationHistorySettingsSchema,
});

/** Omitted fields keep their value; `dryRun` reports the effect without saving. */
export const ApplicationHistorySettingsSaveRequestSchema = z
  .strictObject({
    expectedRevision: RevisionSchema,
    activityDays: DaysSchema.optional(),
    conversations: z
      .union([z.strictObject({ retentionDays: DaysSchema }), z.literal('off')])
      .optional(),
    sources: HistorySourcesSchema.partial().optional(),
    dryRun: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.activityDays !== undefined ||
      value.conversations !== undefined ||
      value.sources !== undefined,
    { message: 'Change at least one history setting.' },
  );

/** Existing conversation history older than the proposed conversation window. */
const HistoryImpactSchema = z.strictObject({ conversations: CountSchema, items: CountSchema });
export const ApplicationHistorySettingsSaveResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    dryRun: z.boolean(),
    /** Whether the change shortens or turns off conversation history, which needs confirmation. */
    shortensConversations: z.boolean(),
    impact: HistoryImpactSchema,
    /** The saved setting, or the unchanged current one for a dry run. */
    settings: ApplicationHistorySettingsSchema,
  }),
});

const ClientSettingsSchema = z.object({
  ...ApplicationHistorySettingsSchema.shape,
  activity: z.object(ApplicationHistorySettingsSchema.shape.activity.shape),
  conversations: z.object({
    ...ApplicationHistorySettingsSchema.shape.conversations.shape,
    sources: z.object(HistorySourcesSchema.shape),
  }),
});
export const ApplicationHistorySettingsClientResponseSchema = z.object({
  ok: z.literal(true),
  data: ClientSettingsSchema,
});
export const ApplicationHistorySettingsSaveClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    ...ApplicationHistorySettingsSaveResponseSchema.shape.data.shape,
    impact: z.object(HistoryImpactSchema.shape),
    settings: ClientSettingsSchema,
  }),
});
