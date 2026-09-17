import { z } from 'zod';
import { capabilityNameSchema, webExtractRequestSchema, webPolicySchema } from './contracts.js';

const scopePart = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const capabilityScopeSchema = z
  .object({ org: scopePart, app: scopePart, env: scopePart, name: capabilityNameSchema })
  .strict();
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;
export const operatorCapabilityPolicySchema = webPolicySchema.extend({
  enabled: z.boolean(),
  dailyCalls: z.number().int().min(0).max(1000),
});
export type OperatorCapabilityPolicy = z.infer<typeof operatorCapabilityPolicySchema>;
export const capabilityPolicyUpdateSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    mutationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    policy: operatorCapabilityPolicySchema,
  })
  .strict();
export type CapabilityPolicyUpdate = z.infer<typeof capabilityPolicyUpdateSchema> & {
  readonly actor: string;
};
export const capabilityPolicyRecordSchema = z
  .object({
    revision: z.number().int().positive(),
    policy: operatorCapabilityPolicySchema,
    actor: z.string().min(1).max(512),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type CapabilityPolicyRecord = z.infer<typeof capabilityPolicyRecordSchema>;
export const capabilityInspectionSchema = z
  .object({
    name: capabilityNameSchema,
    class: z.literal('web.extract.v1'),
    title: z.string(),
    serviceKey: z.string(),
    available: z.boolean(),
    profile: z.enum(['managed-learning-cohort', 'local-first-party']),
    revision: z.number().int().nonnegative(),
    developerPolicy: webPolicySchema,
    operatorPolicy: operatorCapabilityPolicySchema,
    effectivePolicy: webPolicySchema.extend({ domains: z.array(z.string()).max(32).optional() }),
    actor: z.string().optional(),
    updatedAt: z.iso.datetime().optional(),
  })
  .strict();
export const capabilityListResponseSchema = z
  .object({ deploymentId: z.string(), capabilities: z.array(capabilityInspectionSchema) })
  .strict();
export type CapabilityListResponse = z.infer<typeof capabilityListResponseSchema>;
export const capabilityTestRequestSchema = z
  .object({ mode: z.enum(['fixture', 'live']), request: webExtractRequestSchema })
  .strict();
export const capabilityTestResponseSchema = z
  .object({
    mode: z.enum(['fixture', 'live']),
    status: z.enum(['complete', 'partial']),
    pages: z.number().int().nonnegative(),
    sources: z.array(
      z.object({ ref: z.string(), url: z.string().url(), retrievedAt: z.iso.datetime() }).strict(),
    ),
    warnings: z.array(z.object({ requestIndex: z.number().int(), code: z.string() }).strict()),
  })
  .strict();
export type CapabilityTestResponse = z.infer<typeof capabilityTestResponseSchema>;
