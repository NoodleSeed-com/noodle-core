import { z } from 'zod';

const httpUrl = z.url().refine((value) => ['https:', 'http:'].includes(new URL(value).protocol));
const status = z.enum(['ready', 'paused', 'unavailable']);
const usage = z
  .object({
    turnsPerDay: z.number().int().nonnegative(),
    turnsToday: z.number().int().nonnegative(),
    mintsPerDay: z.number().int().nonnegative(),
    mintsToday: z.number().int().nonnegative(),
    managedSpend: z
      .object({
        state: z.string().min(1).max(64),
        turnsRemaining: z.number().int().nonnegative(),
        visitors: z.string().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();
const mcp = z
  .object({
    status,
    url: httpUrl.optional(),
    accessMode: z.string().min(1).max(64).optional(),
  })
  .strict();
const assistant = z
  .object({
    status,
    reason: z.string().min(1).max(200).optional(),
    embedId: z
      .string()
      .regex(/^pub_[a-z0-9]{20,32}$/)
      .optional(),
    scriptUrl: httpUrl.optional(),
    serviceUrl: httpUrl.optional(),
    origins: z.array(httpUrl).max(128),
    capabilities: z.array(z.string().min(1).max(128)).max(256),
    usage: usage.optional(),
  })
  .strict();

const whatsapp = z.strictObject({
  status,
  bindingId: z.string().max(256).optional(),
  revision: z.number().int().positive().optional(),
  capabilities: z.array(z.string().max(256)).max(64),
  reason: z.string().max(200).optional(),
});
export const ApplicationChannelsProjectionSchema = z
  .object({
    revision: z.number().int().positive(),
    active: z.boolean(),
    canEdit: z.boolean(),
    businessPageUrl: httpUrl.optional(),
    deploymentId: z.string().min(1).max(256).optional(),
    mcp,
    assistant,
    whatsapp: whatsapp.optional(),
  })
  .strict();
export type ApplicationChannelsProjection = z.infer<typeof ApplicationChannelsProjectionSchema>;
export const ApplicationChannelsResponseSchema = z
  .object({ ok: z.literal(true), data: ApplicationChannelsProjectionSchema })
  .strict();
export const ApplicationChannelsClientResponseSchema = z
  .object({
    ok: z.literal(true),
    data: ApplicationChannelsProjectionSchema.extend({
      mcp: mcp.strip(),
      whatsapp: whatsapp.strip().optional(),
      assistant: assistant
        .extend({
          usage: usage
            .extend({ managedSpend: usage.shape.managedSpend.unwrap().strip().optional() })
            .strip()
            .optional(),
        })
        .strip(),
    }).strip(),
  })
  .strip();
export const ApplicationChannelsSaveRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    active: z.boolean(),
  })
  .strict();
