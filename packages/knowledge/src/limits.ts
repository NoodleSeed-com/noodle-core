/**
 * Structural v0 knowledge limits (ADR 0202 fixed table, amended for the managed-bundled model).
 * These are ceilings, not defaults: operators and app code may narrow them, never raise them.
 * One owner for every bound so a declared limit nobody reads is unrepresentable.
 */

/** UTF-8 `.md` / `.txt` only; regular, non-symlinked, inside project root. */
export const ALLOWED_DOCUMENT_EXTENSIONS = ['.md', '.txt'] as const;

/** Enforced identically at compile and at deploy preflight — never one without the other. */
export const MAX_KNOWLEDGE_COMPONENTS = 20;
export const MAX_DOCUMENTS_PER_COMPONENT = 100;
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_COMPONENT_TOTAL_BYTES = 25 * 1024 * 1024;

export const MIN_QUERY_CHARS = 1;
export const MAX_QUERY_CHARS = 2000;
export const MIN_RESULT_LIMIT = 1;
export const MAX_RESULT_LIMIT = 20;
export const DEFAULT_RESULT_LIMIT = 8;

export const MAX_EXCERPT_CHARS = 2000;

/** Crawl-and-index site tier (ADR 0202 amendment 2026-08-18). */
export const MAX_CRAWL_PAGES_PER_SITE = 500;
export const MAX_CRAWL_PAGE_BYTES = 512 * 1024;
export const MIN_SITE_REFRESH_MINUTES = 15;
export const MAX_SITE_REFRESH_MINUTES = 7 * 24 * 60;
export const DEFAULT_SITE_REFRESH_MINUTES = 24 * 60;

/** Reciprocal-rank fusion constant; equal weight across sources (ADR 0202). */
export const RRF_K = 60;
