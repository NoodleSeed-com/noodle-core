/**
 * Knowledge control-plane wire shapes (ADR 0202 as amended): the deploy-time document
 * preflight/upload leg and the operator list/status surface. Bounds come from the
 * `@noodle-borg/knowledge` limits owner; this file never widens them. Payloads carry
 * descriptors, hashes, and attributable states — never file contents or credentials.
 */
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_COMPONENT,
  MAX_KNOWLEDGE_COMPONENTS,
} from '@noodle-borg/knowledge/limits';
import { z } from 'zod';

const sha256Hex = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);

const componentName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

/** One document's content identity — enough to diff, never the bytes. */
export const knowledgeDocumentRefSchema = z
  .object({
    sha256: sha256Hex,
    bytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
  })
  .strict();

export const knowledgePreflightRequestSchema = z
  .object({
    components: z
      .array(
        z
          .object({
            name: componentName,
            documents: z.array(knowledgeDocumentRefSchema).max(MAX_DOCUMENTS_PER_COMPONENT),
          })
          .strict(),
      )
      .min(1)
      // The dedicated component cap, enforced identically by the compile pass — this was
      // briefly the result-page limit by accidental constant reuse.
      .max(MAX_KNOWLEDGE_COMPONENTS),
  })
  .strict();
export type KnowledgePreflightRequest = z.output<typeof knowledgePreflightRequestSchema>;

/** Content hashes the service does not already hold; upload exactly these. */
export const knowledgePreflightResponseSchema = z
  .object({
    ok: z.literal(true),
    missing: z.array(sha256Hex),
  })
  .strict();
export type KnowledgePreflightResponse = z.output<typeof knowledgePreflightResponseSchema>;

export const knowledgeUploadResponseSchema = z
  .object({
    ok: z.literal(true),
    sha256: sha256Hex,
  })
  .strict();
export type KnowledgeUploadResponse = z.output<typeof knowledgeUploadResponseSchema>;

const scopeLevel = z.enum(['org', 'app', 'env']);

/** One component row in the operator surface: lifecycle truth without contents. */
export const knowledgeComponentSummarySchema = z
  .object({
    name: componentName,
    /** "versioned documents" vs "live site" is an operator-facing lifecycle distinction. */
    sources: z
      .object({
        documents: z.number().int().nonnegative(),
        sites: z.number().int().nonnegative(),
      })
      .strict(),
    declaringScope: scopeLevel,
    activeRevisionId: z.string().min(1).optional(),
    activeDeploymentId: z.string().min(1).optional(),
    state: z.enum(['active', 'pending', 'not-deployed']),
  })
  .strict();
export type KnowledgeComponentSummary = z.output<typeof knowledgeComponentSummarySchema>;

export const knowledgeListResponseSchema = z
  .object({
    ok: z.literal(true),
    scope: z.object({ org: z.string(), app: z.string(), env: z.string() }).strict(),
    components: z.array(knowledgeComponentSummarySchema),
  })
  .strict();
export type KnowledgeListResponse = z.output<typeof knowledgeListResponseSchema>;

export const knowledgeBudgetStateSchema = z
  .object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    orgConsumed: z.number().int().nonnegative(),
    appConsumed: z.number().int().nonnegative(),
    orgCeiling: z.number().int().nonnegative(),
    appCeiling: z.number().int().nonnegative(),
    blocked: z.boolean(),
  })
  .strict();
export type KnowledgeBudgetState = z.output<typeof knowledgeBudgetStateSchema>;

export const knowledgeCrawlStateSchema = z
  .object({
    status: z.enum(['not_started', 'in_progress', 'completed', 'failed']),
    lastCompletedAt: z.number().int().optional(),
    lastError: z.string().optional(),
    pagesIndexed: z.number().int().min(0),
    nextRefreshAt: z.number().int().optional(),
  })
  .strict();
export type KnowledgeCrawlState = z.output<typeof knowledgeCrawlStateSchema>;

export const knowledgeRefreshResponseSchema = z
  .object({ ok: z.literal(true), crawl: knowledgeCrawlStateSchema })
  .strict();
export type KnowledgeRefreshResponse = z.output<typeof knowledgeRefreshResponseSchema>;

export const knowledgeStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    scope: z.object({ org: z.string(), app: z.string(), env: z.string() }).strict(),
    component: knowledgeComponentSummarySchema,
    /** Last successful positive-predicate verification, if the component has documents. */
    lastVerifiedAt: z.string().datetime().optional(),
    /** Provider-managed live-site binding state; content itself is never rollbackable. */
    siteProvisioning: z.enum(['not-required', 'ready', 'missing']).optional(),
    budget: knowledgeBudgetStateSchema.optional(),
    /** Per-component crawl state for the crawl-and-index site tier. */
    crawl: knowledgeCrawlStateSchema.optional(),
    /** Attributable error surfaces (`request|predicate|provider|store|not-found`), no content. */
    errors: z.array(z.object({ layer: z.string(), message: z.string() }).strict()).default([]),
  })
  .strict();
export type KnowledgeStatusResponse = z.output<typeof knowledgeStatusResponseSchema>;
