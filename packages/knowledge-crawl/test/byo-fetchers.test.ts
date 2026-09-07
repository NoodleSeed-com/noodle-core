import { describe, expect, it } from 'vitest';
import { FirecrawlSiteFetcher } from '../src/firecrawl.js';
import { TavilySiteFetcher } from '../src/tavily.js';

/**
 * BYO fetcher adapters run against scripted transports whose fixtures are transcribed from the
 * providers' API documentation (Firecrawl v2 crawl POST/GET, Tavily POST /crawl) — never from the
 * adapters under test. Whatever a provider returns, the SiteFetcher contract is enforced
 * client-side: same-origin + include containment, page cap, byte cap, deterministic order,
 * content-free attributable errors.
 */

const request = {
  origin: 'https://acme.test',
  include: ['/docs/**', '/pricing'],
  maxPages: 500,
  maxPageBytes: 512 * 1024,
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function scripted(respond: (call: Recorded) => { status?: number; payload: unknown }): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call: Recorded = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    };
    calls.push(call);
    const { status, payload } = respond(call);
    return new Response(JSON.stringify(payload), {
      status: status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('firecrawl site fetcher', () => {
  // Transcribed from Firecrawl docs: POST /v2/crawl → {success, id}; GET /v2/crawl/{id} →
  // {status: scraping|completed|failed, data: [{markdown, metadata: {sourceURL, title}}]}.
  it('starts a crawl, polls to completion, and maps pages under the contract bounds', async () => {
    let polls = 0;
    const { fetchImpl, calls } = scripted((call) => {
      if (call.method === 'POST')
        return { payload: { success: true, id: 'job-1', url: request.origin } };
      polls += 1;
      if (polls === 1) return { payload: { status: 'scraping', total: 3, completed: 1, data: [] } };
      return {
        payload: {
          status: 'completed',
          total: 3,
          completed: 3,
          data: [
            {
              markdown: 'beta details',
              metadata: { sourceURL: 'https://acme.test/docs/b', title: 'Doc B' },
            },
            {
              markdown: 'alpha details',
              metadata: { sourceURL: 'https://acme.test/docs/a', title: ['Doc A'] },
            },
            {
              markdown: 'external',
              metadata: { sourceURL: 'https://evil.test/docs/x', title: 'Evil' },
            },
            {
              markdown: 'off include',
              metadata: { sourceURL: 'https://acme.test/blog/z', title: 'Blog' },
            },
          ],
        },
      };
    });
    const fetcher = new FirecrawlSiteFetcher({ apiKey: 'fc-key', fetchImpl, pollIntervalMs: 0 });
    const pages = await fetcher.fetchSite(request);
    expect(pages.map((page) => page.url)).toEqual([
      'https://acme.test/docs/a',
      'https://acme.test/docs/b',
    ]);
    expect(pages[0]?.title).toBe('Doc A');
    const start = calls[0];
    expect(start?.url).toBe('https://api.firecrawl.dev/v2/crawl');
    expect(start?.headers.authorization).toBe('Bearer fc-key');
    expect(start?.body).toMatchObject({ url: 'https://acme.test', limit: request.maxPages });
  });

  it('fails a failed crawl with an attributable, content-free provider error', async () => {
    const { fetchImpl } = scripted((call) =>
      call.method === 'POST'
        ? { payload: { success: true, id: 'job-2', url: request.origin } }
        : { payload: { status: 'failed', total: 0, completed: 0, data: [] } },
    );
    const fetcher = new FirecrawlSiteFetcher({ apiKey: 'fc-key', fetchImpl, pollIntervalMs: 0 });
    const attempt = fetcher.fetchSite(request);
    await expect(attempt).rejects.toMatchObject({ layer: 'provider' });
    await expect(attempt).rejects.not.toThrow(/fc-key/);
  });

  it('surfaces provider HTTP failures without carrying the response body', async () => {
    const { fetchImpl } = scripted(() => ({
      status: 402,
      payload: { error: 'insufficient credits on account 12345' },
    }));
    const fetcher = new FirecrawlSiteFetcher({ apiKey: 'fc-key', fetchImpl, pollIntervalMs: 0 });
    const attempt = fetcher.fetchSite(request);
    await expect(attempt).rejects.toMatchObject({ layer: 'provider' });
    await expect(attempt).rejects.not.toThrow(/12345/);
  });
});

describe('tavily site fetcher', () => {
  // Transcribed from Tavily docs: POST https://api.tavily.com/crawl with Bearer auth →
  // {base_url, results: [{url, raw_content}]}; synchronous.
  it('crawls synchronously and maps results under the contract bounds', async () => {
    const { fetchImpl, calls } = scripted(() => ({
      payload: {
        base_url: 'https://acme.test',
        results: [
          { url: 'https://acme.test/pricing', raw_content: 'ten dollars per seat' },
          { url: 'https://acme.test/docs/a', raw_content: 'alpha details' },
          { url: 'https://evil.test/docs/x', raw_content: 'external' },
          { url: 'https://acme.test/blog/z', raw_content: 'off include' },
        ],
        response_time: 1.2,
        request_id: 'req-1',
      },
    }));
    const fetcher = new TavilySiteFetcher({ apiKey: 'tvly-key', fetchImpl });
    const pages = await fetcher.fetchSite(request);
    expect(pages.map((page) => page.url)).toEqual([
      'https://acme.test/docs/a',
      'https://acme.test/pricing',
    ]);
    // A crawled page has no separate title field; the URL stands in.
    expect(pages[1]?.text).toBe('ten dollars per seat');
    const call = calls[0];
    expect(call?.url).toBe('https://api.tavily.com/crawl');
    expect(call?.headers.authorization).toBe('Bearer tvly-key');
    expect(call?.body).toMatchObject({
      url: 'https://acme.test',
      limit: request.maxPages,
      allow_external: false,
      format: 'text',
    });
  });

  it('enforces the page and byte caps client-side regardless of provider output', async () => {
    const { fetchImpl } = scripted(() => ({
      payload: {
        results: [
          { url: 'https://acme.test/docs/a', raw_content: 'a'.repeat(400) },
          { url: 'https://acme.test/docs/b', raw_content: 'fine' },
          { url: 'https://acme.test/docs/c', raw_content: 'also fine' },
        ],
      },
    }));
    const fetcher = new TavilySiteFetcher({ apiKey: 'tvly-key', fetchImpl });
    const pages = await fetcher.fetchSite({ ...request, maxPages: 1, maxPageBytes: 300 });
    // The oversized page is skipped; the cap then keeps the sorted prefix.
    expect(pages.map((page) => page.url)).toEqual(['https://acme.test/docs/b']);
  });

  it('keeps a provider-returned origin root when include lists "/"', async () => {
    const { fetchImpl } = scripted(() => ({
      payload: {
        results: [
          { url: 'https://acme.test/', raw_content: 'single page site' },
          { url: 'https://acme.test/docs/a', raw_content: 'out of include' },
        ],
      },
    }));
    const fetcher = new TavilySiteFetcher({ apiKey: 'tvly-key', fetchImpl });
    const pages = await fetcher.fetchSite({ ...request, include: ['/'] });
    expect(pages.map((page) => page.url)).toEqual(['https://acme.test/']);
  });

  it('rejects non-HTTPS origins before calling the provider', async () => {
    const { fetchImpl, calls } = scripted(() => ({ payload: {} }));
    const fetcher = new TavilySiteFetcher({ apiKey: 'tvly-key', fetchImpl });
    await expect(
      fetcher.fetchSite({ ...request, origin: 'http://acme.test' }),
    ).rejects.toMatchObject({ layer: 'request' });
    expect(calls).toEqual([]);
  });
});
