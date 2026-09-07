import { z } from 'zod';

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);
const additiveObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
const timestamp = z.iso.datetime({ offset: true });
const billingAccountId = z.string().min(1).max(160);
const grantId = z.string().regex(/^masg_[A-Za-z0-9_-]{16,80}$/);
const reason = z.string().trim().min(3).max(500);
const idempotencyKey = z.string().trim().min(8).max(200);

export const MANAGED_ASSISTANT_SPONSORSHIP_MAX_GRANT_TURNS_PER_DAY = 100_000;

export const ManagedAssistantSponsorshipGrantCreateRequestSchema = strictObject({
  additionalTurnsPerDay: z
    .number()
    .int()
    .positive()
    .max(MANAGED_ASSISTANT_SPONSORSHIP_MAX_GRANT_TURNS_PER_DAY),
  startsAt: timestamp.optional(),
  expiresAt: timestamp,
  reason,
  idempotencyKey,
});
export type ManagedAssistantSponsorshipGrantCreateRequest = z.infer<
  typeof ManagedAssistantSponsorshipGrantCreateRequestSchema
>;

export const ManagedAssistantSponsorshipGrantRevokeRequestSchema = strictObject({
  reason,
  idempotencyKey,
});
export type ManagedAssistantSponsorshipGrantRevokeRequest = z.infer<
  typeof ManagedAssistantSponsorshipGrantRevokeRequestSchema
>;

const grantShape = {
  id: grantId,
  billingAccountId,
  additionalTurnsPerDay: z.number().int().positive(),
  startsAt: timestamp,
  expiresAt: timestamp,
  reason,
  status: z.enum(['scheduled', 'active', 'expired', 'revoked']),
  createdAt: timestamp,
  revokedAt: timestamp.optional(),
  revocationReason: reason.optional(),
} as const;

export const ManagedAssistantSponsorshipGrantSchema = strictObject(grantShape);
export type ManagedAssistantSponsorshipGrant = z.infer<
  typeof ManagedAssistantSponsorshipGrantSchema
>;

const spendShape = {
  state: z.enum(['normal', 'approaching', 'near', 'limited', 'closed']),
  allowanceUnits: z.number().int().nonnegative(),
  usedUnitsToday: z.number().int().nonnegative(),
  turnsRemaining: z.number().int().nonnegative(),
} as const;

const sponsorshipDataShape = {
  billingAccountId,
  mode: z.literal('sponsored_beta'),
  defaultTurnsPerDay: z.number().int().nonnegative(),
  bonusTurnsPerDay: z.number().int().nonnegative(),
  totalTurnsPerDay: z.number().int().nonnegative(),
  spend: strictObject(spendShape),
  resetAt: timestamp,
  grants: z.array(ManagedAssistantSponsorshipGrantSchema),
  platform: strictObject({
    globalTurnsPerDay: z.number().int().nonnegative(),
    spend: strictObject(spendShape),
  }).optional(),
} as const;

export const ManagedAssistantSponsorshipResponseSchema = strictObject({
  ok: z.literal(true),
  data: strictObject(sponsorshipDataShape),
});
export type ManagedAssistantSponsorshipResponse = z.infer<
  typeof ManagedAssistantSponsorshipResponseSchema
>;

const grantClientSchema = additiveObject(grantShape);
const spendClientSchema = additiveObject(spendShape);
const sponsorshipClientDataSchema = additiveObject({
  ...sponsorshipDataShape,
  spend: spendClientSchema,
  grants: z.array(grantClientSchema),
  platform: additiveObject({
    globalTurnsPerDay: z.number().int().nonnegative(),
    spend: spendClientSchema,
  }).optional(),
});

/** Client reader strips additive fields at every layer while the service output stays strict. */
export const ManagedAssistantSponsorshipClientResponseSchema = additiveObject({
  ok: z.literal(true),
  data: sponsorshipClientDataSchema,
});

export const ManagedAssistantSponsorshipGrantMutationResponseSchema = strictObject({
  ok: z.literal(true),
  data: strictObject({
    replayed: z.boolean(),
    grant: ManagedAssistantSponsorshipGrantSchema,
    sponsorship: strictObject(sponsorshipDataShape),
  }),
});
export type ManagedAssistantSponsorshipGrantMutationResponse = z.infer<
  typeof ManagedAssistantSponsorshipGrantMutationResponseSchema
>;

export const ManagedAssistantSponsorshipGrantMutationClientResponseSchema = additiveObject({
  ok: z.literal(true),
  data: additiveObject({
    replayed: z.boolean(),
    grant: grantClientSchema,
    sponsorship: sponsorshipClientDataSchema,
  }),
});
