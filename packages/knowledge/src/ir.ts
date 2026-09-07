/**
 * Knowledge component internal representation (Core v2, ADR 0202). Compiled data contains
 * descriptors and content hashes — never file bytes, provider identifiers, or credentials.
 */
import { z } from 'zod';
import { ALLOWED_DOCUMENT_EXTENSIONS, MAX_DOCUMENTS_PER_COMPONENT } from './limits.js';

/** Mandatory typed retrieval predicate. v0 pins the audience to `public`; other kinds are unrepresentable. */
export const audiencePredicateSchema = z
  .object({
    audience: z.literal('public'),
    /** Revision the predicate must match — a knowledge base that silently returns nothing answers confidently from a subset. */
    revision: z.string().min(1),
  })
  .strict();

export type AudiencePredicate = z.infer<typeof audiencePredicateSchema>;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'must be an exact HTTPS URL');

/** One deploy-coupled document as compiled data: descriptor plus content hash, no bytes. */
export const documentDescriptorSchema = z
  .object({
    /** Project-root-relative POSIX path of the source file. */
    path: z
      .string()
      .min(1)
      .refine(
        (value) => !value.startsWith('/') && !value.split('/').includes('..'),
        'document path must stay inside the project root',
      ),
    /** Required non-empty title. */
    title: z.string().min(1),
    /** Optional exact HTTPS source URL shown as the citation target. */
    sourceUrl: httpsUrl.optional(),
    /** Lowercase hex SHA-256 of the UTF-8 content, pinned by deploy records. */
    sha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
    /** Uncompressed UTF-8 byte size. */
    bytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    const extension = value.path.slice(value.path.lastIndexOf('.'));
    if (!ALLOWED_DOCUMENT_EXTENSIONS.includes(extension as '.md' | '.txt')) {
      context.addIssue({
        code: 'custom',
        message: `document extension must be one of ${ALLOWED_DOCUMENT_EXTENSIONS.join(', ')}`,
      });
    }
  });

export type DocumentDescriptor = z.infer<typeof documentDescriptorSchema>;

/** A live public website scope. The provider owns freshness; we pin only the allowed origin/path policy. */
export const sitePolicySchema = z
  .object({
    /** Exact HTTPS origin (`scheme://host[:port]`), no path. */
    origin: httpsUrl.refine(
      (value) => {
        const afterScheme = value.slice('https://'.length);
        return !afterScheme.includes('/');
      },
      { message: 'site origin must not contain a path' },
    ),
    /** Positive path globs; at least one, so the crawled scope is an explicit choice. */
    include: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type SitePolicy = z.infer<typeof sitePolicySchema>;

/** One knowledge component: bounded documents plus optional live-site scopes. */
export const knowledgeComponentSchema = z
  .object({
    /** Stable logical name used in the generated `search_<name>` tool and revision keys. */
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'component name must be lowercase snake-case'),
    title: z.string().min(1),
    description: z.string().min(1),
    documents: z.array(documentDescriptorSchema).max(MAX_DOCUMENTS_PER_COMPONENT),
    sites: z.array(sitePolicySchema),
  })
  .strict();

export type KnowledgeComponent = z.infer<typeof knowledgeComponentSchema>;

/** Deployment scope every knowledge binding resolves (ADR 0048 org → app → env). */
export const knowledgeScopeSchema = z
  .object({
    org: z.string().min(1),
    app: z.string().min(1),
    env: z.string().min(1),
  })
  .strict();

export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;

export function knowledgeScopeKey(scope: KnowledgeScope, name: string): string {
  return `${scope.org}/${scope.app}/${scope.env}/${name}`;
}
