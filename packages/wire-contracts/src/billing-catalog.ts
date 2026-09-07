import { z } from 'zod';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const name = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._-]+$/);
const release = z.strictObject({
  releaseId: name,
  gitSha: sha,
  manifestChecksum: digest,
  imageDigest: digest,
});
/** Protected release evidence. No customer-selected plan or allowance is accepted. */
export const BillingCatalogActivationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidate: release,
  rollback: release,
  checkedAt: z.iso.datetime(),
  revisions: z
    .array(z.strictObject({ name, gitSha: sha, imageDigest: digest }))
    .min(1)
    .max(1000),
  retiredRevisions: z.array(name).max(1000),
  jobs: z
    .array(z.strictObject({ name, activeExecutions: z.literal(0) }))
    .min(1)
    .max(1000),
});
export type BillingCatalogActivationRequest = z.infer<typeof BillingCatalogActivationRequestSchema>;
const statusFields = {
  version: z.union([z.literal(1), z.literal(2)]),
  readerVersion: z.literal(2),
  revision: digest.nullable(),
};
export const BillingCatalogStatusResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject(statusFields),
});
export const BillingCatalogStatusClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object(statusFields),
});
const resultFields = {
  version: z.literal(2),
  migrated: z.number().int().nonnegative(),
  revision: digest,
};
export const BillingCatalogActivationResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject(resultFields),
});
export const BillingCatalogActivationClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object(resultFields),
});
