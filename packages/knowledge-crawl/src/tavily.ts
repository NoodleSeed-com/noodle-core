/**
 * BYO Tavily fetcher (ADR 0202 amendment 2026-08-18): the customer's own Tavily account crawls
 * the site through the synchronous hosted REST API. Wire shape transcribed from the official API
 * reference 2026-08-18: `POST https://api.tavily.com/crawl` with Bearer auth and
 * `{ url, limit, allow_external, format, extract_depth }` → `{ results: [{ url, raw_content }] }`.
 * Crawled pages carry no separate title field, so the URL stands in. Errors are attributable and
 * content-free — provider bodies and the API key never cross the port.
 */
import { KnowledgeError } from '@noodle-borg/knowledge/portable';
import { boundPages } from './bounds.js';
import { parseOrigin } from './origin.js';
import type { CrawlPage, SiteCrawlRequest, SiteFetcher } from './ports.js';

const API = 'https://api.tavily.com/crawl';

export interface TavilySiteFetcherOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

export class TavilySiteFetcher implements SiteFetcher {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: TavilySiteFetcherOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async fetchSite(request: SiteCrawlRequest): Promise<readonly CrawlPage[]> {
    const origin = parseOrigin(request.origin);
    let response: Response;
    try {
      response = await this.#fetch(API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url: origin.origin,
          limit: request.maxPages,
          allow_external: false,
          format: 'text',
          extract_depth: 'basic',
        }),
      });
    } catch {
      throw new KnowledgeError('provider', 'tavily crawl request failed');
    }
    if (!response.ok) {
      throw new KnowledgeError('provider', `tavily crawl returned HTTP ${response.status}`);
    }
    const body = (await response.json().catch(() => ({}))) as {
      results?: readonly { url?: string; raw_content?: string }[];
    };
    return boundPages(
      (body.results ?? []).map((result) => ({
        url: result.url ?? '',
        title: '',
        text: result.raw_content ?? '',
      })),
      request,
      origin,
    );
  }
}
