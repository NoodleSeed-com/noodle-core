import { z } from 'zod';

export * from './billing-enforcement.js';
export * from './billing-metering.js';
export * from './billing-migration.js';

export const BillingStripeCheckoutRequestSchema = z.strictObject({
  plan: z.enum(['pro', 'scale']),
  interval: z.enum(['month', 'year']),
  idempotencyKey: z.string().min(1).max(128),
});
export type BillingStripeCheckoutRequest = z.infer<typeof BillingStripeCheckoutRequestSchema>;

const checkoutResponseShape = {
  ok: z.literal(true),
  data: {
    url: z.string().url(),
    expiresAt: z.string().datetime(),
    replayed: z.boolean(),
    outcome: z.enum(['created', 'resumed', 'replaced', 'idempotent_replay']),
  },
} as const;
const portalResponseShape = { ok: z.literal(true), data: { url: z.string().url() } } as const;

export const BillingStripeCheckoutResponseSchema = z.strictObject({
  ok: checkoutResponseShape.ok,
  data: z.strictObject(checkoutResponseShape.data),
});
export const BillingStripeCheckoutClientResponseSchema = z.object({
  ok: checkoutResponseShape.ok,
  data: z.object(checkoutResponseShape.data),
});
export type BillingStripeCheckoutResponse = z.infer<typeof BillingStripeCheckoutResponseSchema>;

export const BillingStripePortalResponseSchema = z.strictObject({
  ok: portalResponseShape.ok,
  data: z.strictObject(portalResponseShape.data),
});
export const BillingStripePortalClientResponseSchema = z.object({
  ok: portalResponseShape.ok,
  data: z.object(portalResponseShape.data),
});
export type BillingStripePortalResponse = z.infer<typeof BillingStripePortalResponseSchema>;
