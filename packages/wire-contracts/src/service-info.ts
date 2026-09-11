import { z } from 'zod';

export const MIXED_CUSTOMER_AUTH_FEATURE_VERSION = 1;

const buildInfoShape = {
  ok: z.literal(true),
  status: z.literal('ok'),
  version: z.string(),
  gitSha: z.string(),
  buildTime: z.string(),
  systemRelease: z.string().optional(),
  manifestChecksum: z.string().optional(),
  packageVersions: z.record(z.string(), z.string()).optional(),
  compatiblePackageVersions: z.record(z.string(), z.array(z.string())).optional(),
};

/** Strict producer contract for the enabled R1 service; no configured tenant data belongs here. */
export const serviceInfoResponseSchema = z.strictObject({
  ...buildInfoShape,
  developerPlugin: z.strictObject({ mcpCapabilityVersion: z.string().min(1) }).optional(),
  features: z.strictObject({ mixedCustomerAuth: z.literal(MIXED_CUSTOMER_AUTH_FEATURE_VERSION) }),
});

/** Older services may omit features; future fields are stripped at each structured metadata layer. */
export const serviceInfoClientResponseSchema = z.object({
  ...buildInfoShape,
  developerPlugin: z.object({ mcpCapabilityVersion: z.string().min(1) }).optional(),
  features: z.object({ mixedCustomerAuth: z.number().int().positive().optional() }).optional(),
});

export type ServiceInfoResponse = z.infer<typeof serviceInfoResponseSchema>;
export type ServiceInfoClientResponse = z.infer<typeof serviceInfoClientResponseSchema>;
