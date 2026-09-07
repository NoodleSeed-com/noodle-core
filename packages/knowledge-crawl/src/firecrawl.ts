/**
 * BYO Firecrawl fetcher (ADR 0202 amendment 2026-08-18): the customer's own Firecrawl account
 * crawls the site; this adapter drives the hosted REST API only (the self-hosted Firecrawl repo
 * is AGPL-3.0 and is never embedded). Wire shapes transcribed from the official API reference
 * 2026-08-18: `POST https://api.firecrawl.dev/v2/crawl` → `{ success, id }`;
 * `GET /v2/crawl/{id}` → `{ status: scraping|completed|failed, data: [{ markdown,
 * metadata: { sourceURL, title } }], next? }` (title may be a string or an array; `next` pages
 * further data). Errors are attributable and content-free — provider bodies and the API key
 * never cross the port.
 */
import { KnowledgeError } from '@noodle-borg/knowledge/portable';
import { boundPages } from './bounds.js';
import { parseOrigin } from './origin.js';
import type { CrawlPage, SiteCrawlRequest, SiteFetcher } from './ports.js';

const API = 'https://api.firecrawl.dev/v2/crawl';

interface FirecrawlDocument {
  readonly markdown?: string;
  readonly metadata?: { readonly sourceURL?: string; readonly title?: string | readonly string[] };
}

export interface FirecrawlSiteFetcherOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export class FirecrawlSiteFetcher implements SiteFetcher {
  readonly #options: Required<Omit<FirecrawlSiteFetcherOptions, 'fetchImpl'>> & {
    readonly fetchImpl: typeof fetch;
  };

  constructor(options: FirecrawlSiteFetcherOptions) {
    this.#options = {
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl ?? fetch,
      pollIntervalMs: options.pollIntervalMs ?? 2000,
      maxPolls: options.maxPolls ?? 300,
    };
  }

  async fetchSite(request: SiteCrawlRequest): Promise<readonly CrawlPage[]> {
    const origin = parseOrigin(request.origin);
    const started = (await this.#call('start', API, {
      method: 'POST',
      body: JSON.stringify({
        url: origin.origin,
        limit: request.maxPages,
        scrapeOptions: { formats: [{ type: 'markdown' }] },
      }),
    })) as { id?: string };
    if (typeof started.id !== 'string' || started.id === '') {
      throw new KnowledgeError('provider', 'firecrawl crawl start returned no job id');
    }

    const documents: FirecrawlDocument[] = [];
    let pollUrl = `${API}/${started.id}`;
    for (let poll = 0; poll < this.#options.maxPolls; poll++) {
      const status = (await this.#call('status', pollUrl)) as {
        status?: string;
        data?: readonly FirecrawlDocument[];
        next?: string;
      };
      if (status.status === 'failed') {
        throw new KnowledgeError('provider', 'firecrawl crawl failed');
      }
      if (status.status === 'completed') {
        documents.push(...(status.data ?? []));
        if (typeof status.next === 'string' && status.next !== '') {
          pollUrl = status.next;
          continue;
        }
        return boundPages(
          documents.map((document) => ({
            url: document.metadata?.sourceURL ?? '',
            title: normalizeTitle(document.metadata?.title),
            text: document.markdown ?? '',
          })),
          request,
          origin,
        );
      }
      if (this.#options.pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#options.pollIntervalMs));
      }
    }
    throw new KnowledgeError('provider', 'firecrawl crawl did not complete within the poll budget');
  }

  async #call(operation: string, url: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#options.fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.#options.apiKey}`,
          'content-type': 'application/json',
        },
      });
    } catch {
      throw new KnowledgeError('provider', `firecrawl ${operation} request failed`);
    }
    if (!response.ok) {
      throw new KnowledgeError(
        'provider',
        `firecrawl ${operation} returned HTTP ${response.status}`,
      );
    }
    return response.json().catch(() => ({}));
  }
}

function normalizeTitle(title: string | readonly string[] | undefined): string {
  if (typeof title === 'string') return title;
  if (Array.isArray(title)) return title.find((entry) => typeof entry === 'string') ?? '';
  return '';
}
