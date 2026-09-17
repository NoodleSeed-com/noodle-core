import { z } from 'zod';
import { CAPABILITY_ERROR_CODES } from './errors.js';
import { WEB_EXTRACT_LIMITS as limits } from './limits.js';

const domainSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/);
export const capabilityNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
export const webPolicySchema = z
  .object({
    maxUrls: z.number().int().min(1).max(limits.maxUrls).optional(),
    maxCalls: z.number().int().min(1).max(limits.maxCalls).optional(),
    timeoutMs: z.number().int().min(100).max(limits.timeoutMs).optional(),
    maxTextBytes: z.number().int().min(256).max(limits.maxTextBytes).optional(),
    domains: z.array(domainSchema).min(1).max(32).optional(),
  })
  .strict();
export type WebPolicy = z.infer<typeof webPolicySchema>;

export const webCapabilityBaseSchema = z
  .object({
    name: capabilityNameSchema,
    class: z.literal('web.extract.v1'),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1000),
    provider: z.object({ kind: z.literal('noodle-managed') }).strict(),
    policy: webPolicySchema.optional(),
  })
  .strict();

export interface CapabilityAuthorization {
  readonly discovery?: 'authorized' | 'public' | undefined;
  readonly requiredScopes?: readonly string[] | undefined;
  readonly allowedRoles?: readonly string[] | undefined;
}
export type WebCapability = z.infer<typeof webCapabilityBaseSchema> & {
  readonly authorization?: CapabilityAuthorization | undefined;
};

export const webExtractRequestSchema = z
  .object({
    urls: z.array(z.string().min(1).max(limits.maxUrlCharacters)).min(1).max(limits.maxUrls),
    domains: z.array(domainSchema).min(1).max(32).optional(),
  })
  .strict();
export type WebExtractRequest = z.infer<typeof webExtractRequestSchema>;

const sourceSchema = z
  .object({
    ref: z.string().min(1).max(80),
    url: z.string().max(limits.maxUrlCharacters).url(),
    title: z.string().max(512).optional(),
    retrievedAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().optional(),
    observedAt: z.iso.datetime().optional(),
    expiresAt: z.iso.datetime().optional(),
    attribution: z.string().max(512).optional(),
    rights: z.string().max(512).optional(),
  })
  .strict();
export const webExtractResultSchema = z
  .object({
    status: z.enum(['complete', 'partial']),
    items: z
      .array(
        z
          .object({
            requestIndex: z
              .number()
              .int()
              .min(0)
              .max(limits.maxUrls - 1),
            sourceRef: z.string().min(1).max(80),
            content: z
              .object({
                format: z.literal('text'),
                text: z.string().min(1).max(limits.maxTextBytes),
              })
              .strict(),
            links: z
              .array(
                z
                  .object({
                    url: z.string().max(limits.maxUrlCharacters).url(),
                    label: z.string().max(200).optional(),
                  })
                  .strict(),
              )
              .max(limits.maxLinks),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(limits.maxUrls),
    sources: z.array(sourceSchema).min(1).max(limits.maxUrls),
    warnings: z
      .array(
        z
          .object({
            requestIndex: z
              .number()
              .int()
              .min(0)
              .max(limits.maxUrls - 1),
            code: z.enum([...CAPABILITY_ERROR_CODES, 'content_truncated']),
          })
          .strict(),
      )
      .max(limits.maxUrls * 2),
  })
  .strict();
export type WebExtractResult = z.infer<typeof webExtractResultSchema>;

export const WEB_CONNECTOR_ID = 'noodle_web';
export const WEB_CONNECTOR_VERSION = '1.0.0';
export const webOperationInputSchema = z
  .object({ name: capabilityNameSchema, request: webExtractRequestSchema })
  .strict();
export const WEB_OPERATION_SIGNATURE = {
  type: 'read' as const,
  input: z.toJSONSchema(webOperationInputSchema),
  output: z.toJSONSchema(webExtractResultSchema),
};
export const WEB_CATALOG_CONNECTOR = {
  id: WEB_CONNECTOR_ID,
  version: WEB_CONNECTOR_VERSION,
  kind: 'builtin' as const,
  operations: { extract: WEB_OPERATION_SIGNATURE },
};
