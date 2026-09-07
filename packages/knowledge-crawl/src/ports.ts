/**
 * Provider-neutral site crawling port (ADR 0202 amendment 2026-08-18): one bounded call in, a
 * deterministic ordered list of plain-text pages out. Every fetcher — the managed first-party
 * crawler and the BYO provider adapters — satisfies this contract and its shared tests; provider
 * concepts (job ids, credits, raw payloads) never cross it.
 */

export interface SiteCrawlRequest {
  /** Exact HTTPS origin, no path. Literal-IP hosts are rejected (they bypass the DNS SSRF guard). */
  readonly origin: string;
  /** Path globs a page must match to be indexed; discovery may touch only these plus the root. */
  readonly include: readonly string[];
  readonly maxPages: number;
  readonly maxPageBytes: number;
}

export interface CrawlPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

export interface SiteFetcher {
  /**
   * Crawl the site within the request bounds. Returns pages sorted by URL; individual page
   * failures are skipped, a total provider failure throws a `KnowledgeError` with an
   * attributable layer and no content.
   */
  fetchSite(request: SiteCrawlRequest): Promise<readonly CrawlPage[]>;
}
