import { z } from 'zod';

const id = z.string().min(1).max(256);
const code = z
  .string()
  .regex(/^[a-z0-9_]+$/)
  .max(100);
const revision = z.number().int().nonnegative();
const integer = (max: number) => z.number().int().min(0).max(max);
export const WhatsAppLimitsSchema = z.strictObject({
  perMinute: integer(10),
  perHour: integer(60),
  perDay: integer(200),
  channelPerDay: integer(1000),
  newParticipantsPerDay: integer(200),
  concurrent: integer(5),
  pendingPerParticipant: integer(3),
  pending: integer(100),
  textCharacters: integer(4000),
  dailyMicroUsd: integer(20_000_000),
});
const capability = z.strictObject({ kind: z.enum(['tool', 'knowledge']), name: id });
const secretRef = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
/** `360dialog` keeps a per-binding callback secret; `meta` names its WABA and uses the app signature. */
export const WhatsAppProviderSchema = z.enum(['360dialog', 'meta']);
export const WhatsAppConfigureRequestSchema = z
  .strictObject({
    expectedRevision: revision,
    provider: WhatsAppProviderSchema.default('360dialog'),
    phoneNumberId: id,
    wabaId: id.optional(),
    apiKeySecret: secretRef,
    webhookSecret: secretRef.optional(),
    capabilities: z.array(capability).max(64),
    supportEmail: z.email().max(254),
    limits: WhatsAppLimitsSchema.partial().optional(),
  })
  .superRefine((value, context) => {
    const meta = value.provider === 'meta';
    if (meta ? !value.wabaId : !value.webhookSecret)
      context.addIssue({
        code: 'custom',
        path: [meta ? 'wabaId' : 'webhookSecret'],
        message: meta ? 'Meta requires wabaId' : '360dialog requires webhookSecret',
      });
    if (meta ? value.webhookSecret !== undefined : value.wabaId !== undefined)
      context.addIssue({
        code: 'custom',
        path: [meta ? 'webhookSecret' : 'wabaId'],
        message: meta
          ? 'Meta callbacks are authenticated by the app signature, not a webhook secret'
          : 'wabaId applies only to the meta provider',
      });
  });
export const WhatsAppStateRequestSchema = z.strictObject({
  expectedRevision: revision,
  state: z.enum(['enabled', 'paused']),
});
export const WhatsAppRevisionRequestSchema = z.strictObject({ expectedRevision: revision });
export const WhatsAppLimitsRequestSchema = z.strictObject({
  expectedRevision: revision,
  limits: WhatsAppLimitsSchema.partial(),
});
export const WhatsAppBlockRequestSchema = z
  .strictObject({
    participantId: z
      .string()
      .regex(/^p_[a-f0-9]{64}$/)
      .optional(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{5,14}$/)
      .optional(),
    until: z.number().int().positive().nullable(),
    scope: z.enum(['local', 'provider']).default('local'),
  })
  .refine(
    (value) => Boolean(value.participantId) !== Boolean(value.phone),
    'Choose one participant identifier',
  );
export const WhatsAppUnblockRequestSchema = z.strictObject({
  phone: z
    .string()
    .regex(/^\+[1-9]\d{5,14}$/)
    .optional(),
  scope: z.enum(['local', 'provider']).default('local'),
});
export const WhatsAppEmptyRequestSchema = z.strictObject({});
const tenant = z.strictObject({ org: id, app: id, env: id });
export const WhatsAppBindingSchema = z.strictObject({
  id,
  tenant,
  provider: WhatsAppProviderSchema,
  phoneNumberId: id,
  wabaId: id.optional(),
  apiKeySecret: secretRef,
  webhookSecret: secretRef.optional(),
  deploymentId: id,
  capabilities: z.array(capability),
  supportEmail: z.email(),
  revision,
  generation: revision,
  state: z.enum(['paused', 'enabled', 'disconnected']),
  limits: WhatsAppLimitsSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  actor: id,
  readyRevision: revision.optional(),
  readyAt: z.number().optional(),
});
const bindingClient = WhatsAppBindingSchema.extend({
  tenant: tenant.strip(),
  capabilities: z.array(capability.strip()),
  limits: WhatsAppLimitsSchema.strip(),
}).strip();
export const WhatsAppBindingResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: WhatsAppBindingSchema.nullable(),
});
export const WhatsAppBindingClientResponseSchema = z.object({
  ok: z.literal(true),
  data: bindingClient.nullable(),
});
const check = z.strictObject({
  name: id,
  status: z.enum(['ready', 'unavailable']),
  code: code.optional(),
});
/**
 * One business capability's compatibility on this channel (ADR 0240 decision 7): the five report
 * states, the failing requirement, a bounded reason code and one actionable next step. Capability
 * codes may carry the platform's upper-case identity code beside lower-case channel codes.
 */
const capabilityReport = z.strictObject({
  capability: code,
  status: z.enum(['native', 'adapted', 'handoff', 'needs_setup', 'unavailable']),
  code: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .max(100)
    .optional(),
  requirement: code.optional(),
  next: z.string().max(400).optional(),
});
const readiness = z.strictObject({
  ready: z.boolean(),
  revision,
  checks: z.array(check),
  capabilities: z.array(capabilityReport).max(16),
  webhookUrl: z.url().optional(),
});
export const WhatsAppReadinessResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: readiness,
});
export const WhatsAppReadinessClientResponseSchema = z.object({
  ok: z.literal(true),
  data: readiness
    .extend({
      checks: z.array(check.strip()),
      // A same-feature service that predates the report omits the array; absence is not an error.
      capabilities: z.array(capabilityReport.strip()).optional(),
    })
    .strip(),
});
const webhook = z.strictObject({
  url: z.string().max(2048),
  matches: z.boolean(),
  authenticated: z.boolean(),
});
export const WhatsAppWebhookResponseSchema = z.strictObject({ ok: z.literal(true), data: webhook });
export const WhatsAppWebhookClientResponseSchema = z.object({
  ok: z.literal(true),
  data: webhook.strip(),
});
const usage = z.strictObject({
  resetAt: z.number().int(),
  admittedToday: z.number().int().nonnegative(),
  newParticipantsToday: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  oldestPendingAt: z.number().nullable(),
  unknownSends: z.number().int().nonnegative(),
  day: z.string(),
  dailyMicroUsd: z.number().int().nonnegative(),
  reservedMicroUsd: z.number().int().nonnegative(),
  spentMicroUsd: z.number().int().nonnegative(),
});
export const WhatsAppUsageResponseSchema = z.strictObject({ ok: z.literal(true), data: usage });
export const WhatsAppUsageClientResponseSchema = z.object({
  ok: z.literal(true),
  data: usage.strip(),
});
const event = z.strictObject({
  id,
  participantId: id,
  state: z.enum([
    'queued',
    'running',
    'reply',
    'sending',
    'accepted',
    'delivered',
    'read',
    'refused',
    'expired',
    'failed',
    'cancelled',
    'unknown',
  ]),
  eventAt: z.number(),
  receivedAt: z.number(),
  attempts: revision,
  deploymentId: id,
  code: code.optional(),
});
export const WhatsAppEventsResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.array(event),
  next: id.optional(),
});
export const WhatsAppEventsClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(event.strip()),
  next: id.optional(),
});
const block = z.strictObject({
  participantId: id,
  actor: id,
  reason: z.literal('operator'),
  local: z.boolean(),
  until: z.number().nullable(),
  provider: z
    .object({
      desired: z.enum(['blocked', 'unblocked']),
      state: z.enum(['pending', 'confirmed', 'error', 'unknown']),
      updatedAt: z.number(),
      code: code.optional(),
    })
    .strict()
    .optional(),
});
export const WhatsAppBlocksResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.array(block),
  next: id.optional(),
});
export const WhatsAppBlocksClientResponseSchema = z.object({
  next: id.optional(),
  ok: z.literal(true),
  data: z.array(
    block.extend({ provider: block.shape.provider.unwrap().strip().optional() }).strip(),
  ),
});
const cooldown = z.strictObject({ participantId: id, until: z.number().nullable() });
export const WhatsAppCooldownResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: cooldown,
});
export const WhatsAppCooldownClientResponseSchema = z.object({
  ok: z.literal(true),
  data: cooldown.strip(),
});
export const WhatsAppMutationResponseSchema = z.strictObject({ ok: z.literal(true) });
export const WhatsAppMutationClientResponseSchema = z.object({ ok: z.literal(true) });
export type WhatsAppConfigureRequest = z.infer<typeof WhatsAppConfigureRequestSchema>;
