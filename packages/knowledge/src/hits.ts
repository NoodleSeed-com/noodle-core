/**
 * Bounded search request/response shapes shared by every `KnowledgeIndex`/`SiteSearch`
 * implementation and the generated `search_<name>` tool schema.
 */
import { z } from 'zod';
import {
  DEFAULT_RESULT_LIMIT,
  MAX_EXCERPT_CHARS,
  MAX_QUERY_CHARS,
  MAX_RESULT_LIMIT,
  MIN_QUERY_CHARS,
  MIN_RESULT_LIMIT,
} from './limits.js';

export const searchRequestSchema = z
  .object({
    query: z.string().min(MIN_QUERY_CHARS).max(MAX_QUERY_CHARS),
    limit: z
      .number()
      .int()
      .min(MIN_RESULT_LIMIT)
      .max(MAX_RESULT_LIMIT)
      .default(DEFAULT_RESULT_LIMIT),
  })
  .strict();

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchHitSchema = z
  .object({
    /** Stable identifier: content-addressed for documents, canonical URL for site hits. */
    id: z.string().min(1),
    title: z.string().min(1),
    /** Plain-text evidence, never provider prose; bounded by MAX_EXCERPT_CHARS. */
    excerpt: z.string().max(MAX_EXCERPT_CHARS),
    sourceKind: z.enum(['document', 'site']),
    /** Optional exact HTTPS citation URI. */
    uri: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'must be an HTTPS URL')
      .optional(),
  })
  .strict();

export type SearchHit = z.infer<typeof searchHitSchema>;

/** Collapse whitespace and truncate to the structural excerpt bound. */
export function normalizeExcerpt(text: string, max = MAX_EXCERPT_CHARS): string {
  const flattened = text.replaceAll(/\s+/g, ' ').trim();
  if (flattened.length <= max) return flattened;
  return `${flattened.slice(0, max - 1)}…`;
}

/**
 * Extract a window of the document around the highest-density region of query terms, then
 * normalize. Deterministic for identical inputs.
 */
export function buildExcerpt(text: string, query: string, max = MAX_EXCERPT_CHARS): string {
  const terms = tokenize(query);
  if (terms.length === 0 || text.length <= max) return normalizeExcerpt(text, max);

  const lower = text.toLowerCase();
  const positions: number[] = [];
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index !== -1) {
      positions.push(index);
      index = lower.indexOf(term, index + term.length);
    }
  }
  if (positions.length === 0) return normalizeExcerpt(text.slice(0, max), max);

  positions.sort((a, b) => a - b);
  const middle = positions[Math.floor(positions.length / 2)] ?? positions[0];
  if (middle === undefined) return normalizeExcerpt(text.slice(0, max), max);
  const windowStart = Math.max(0, middle - Math.floor(max / 2));
  const window = text.slice(windowStart, windowStart + max);
  return normalizeExcerpt(window, max);
}

/** Shared lowercase word tokenizer used for excerpt placement and the bundled BM25 adapter. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}
