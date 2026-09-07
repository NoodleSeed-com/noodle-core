/**
 * Core v2 manifest fragment for knowledge components (ADR 0202). Owned here so the pinned
 * compiler only wires the surface; the shapes are the single source both the manifest schema
 * and the compile pass consume.
 */
import { z } from 'zod';

const httpsUrlSchema = z.url().regex(/^https:\/\//, 'must use https');

/**
 * One deploy-coupled knowledge document. Authoring form carries `path`/`title`; the compile
 * pass reads the file, verifies the structural limits, and fills `sha256`/`bytes` — the
 * compiled form never carries document contents.
 */
export const knowledgeDocumentManifestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine(
        (value) => !value.startsWith('/') && !value.split('/').includes('..'),
        'document path must stay inside the project root',
      ),
    title: z.string().trim().min(1),
    sourceUrl: httpsUrlSchema.optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256')
      .optional(),
    bytes: z.number().int().positive().optional(),
  })
  .strict();

export const knowledgeSiteManifestSchema = z
  .object({
    origin: httpsUrlSchema.refine((value) => !value.slice('https://'.length).includes('/'), {
      message: 'site origin must not contain a path',
    }),
    include: z.array(z.string().min(1)).min(1),
    /** Crawl refresh interval in minutes, 15m–7d; absent means the platform default (daily). */
    refreshMinutes: z
      .number()
      .int()
      .min(15)
      .max(7 * 24 * 60)
      .optional(),
  })
  .strict();

/** A provider config reference by NAME (variable()/secret() doctrine) — never a value. */
const providerConfigRefSchema = z
  .object({
    kind: z.enum(['variable', 'secret']),
    name: z.string().regex(/^[A-Za-z0-9_]+$/, 'must be a managed-config name'),
  })
  .strict();

export const knowledgeCrawlerManifestSchema = z
  .object({
    provider: z.enum(['firecrawl', 'tavily']),
    config: z.object({ apiKey: providerConfigRefSchema }).strict(),
  })
  .strict();

export const knowledgeIndexManifestSchema = z
  .object({
    provider: z.enum(['algolia', 'meilisearch']),
    config: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), providerConfigRefSchema),
  })
  .strict();

export const knowledgeComponentManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase snake-case'),
    title: z.string().trim().min(1),
    description: z.string().min(1),
    documents: z.array(knowledgeDocumentManifestSchema).max(100),
    sites: z.array(knowledgeSiteManifestSchema),
    crawler: knowledgeCrawlerManifestSchema.optional(),
    index: knowledgeIndexManifestSchema.optional(),
  })
  .strict();

export type KnowledgeDocumentManifest = z.infer<typeof knowledgeDocumentManifestSchema>;
export type KnowledgeSiteManifest = z.infer<typeof knowledgeSiteManifestSchema>;
export type KnowledgeComponentManifest = z.infer<typeof knowledgeComponentManifestSchema>;
