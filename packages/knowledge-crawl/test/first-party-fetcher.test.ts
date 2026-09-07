import { describe, expect, it } from 'vitest';
import { FirstPartySiteFetcher } from '../src/first-party.js';

/**
 * The managed fetcher runs its unit tests against a scripted fetch — never network. The
 * additional egress checks this package owns (HTTPS-only, literal-IP rejection, same-origin
 * containment, no redirect following) are asserted here; socket-level DNS pinning is owned and
 * tested by `@noodle-borg/connector-http`.
 */

function page(title: string, body: string, links: string[] = []): string {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join('');
  return `<html><head><title>${title}</title></head><body><p>${body}</p>${anchors}</body></html>`;
}

function scriptedFetch(routes: Record<string, { status?: number; body?: string; type?: string }>): {
  fetchImpl: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const key = String(url);
    requested.push(key);
    const route = routes[key];
    if (route === undefined) return new Response('not found', { status: 404 });
    return new Response(route.body ?? '', {
      status: route.status ?? 200,
      headers: { 'content-type': route.type ?? 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const request = {
  origin: 'https://acme.test',
  include: ['/docs/**', '/pricing'],
  maxPages: 500,
  maxPageBytes: 512 * 1024,
};

describe('first-party site fetcher', () => {
  it('discovers via robots sitemaps, honors include and robots, and returns sorted pages', async () => {
    const { fetchImpl, requested } = scriptedFetch({
      'https://acme.test/robots.txt': {
        body: 'Sitemap: https://acme.test/sitemap.xml\nUser-agent: *\nDisallow: /docs/private/',
        type: 'text/plain',
      },
      'https://acme.test/sitemap.xml': {
        body: `<urlset>
          <url><loc>https://acme.test/docs/b</loc></url>
          <url><loc>https://acme.test/docs/a</loc></url>
          <url><loc>https://acme.test/docs/private/x</loc></url>
          <url><loc>https://acme.test/blog/off-policy</loc></url>
          <url><loc>https://evil.test/docs/외부</loc></url>
        </urlset>`,
        type: 'application/xml',
      },
      'https://acme.test/': { body: page('Home', 'welcome') },
      'https://acme.test/docs/a': { body: page('Doc A', 'alpha pricing details') },
      'https://acme.test/docs/b': { body: page('Doc B', 'beta details') },
      'https://acme.test/docs/private/x': { body: page('Private', 'secret') },
      'https://acme.test/blog/off-policy': { body: page('Blog', 'off policy') },
    });
    const pages = await new FirstPartySiteFetcher({ fetchImpl }).fetchSite(request);
    expect(pages.map((entry) => entry.url)).toEqual([
      'https://acme.test/docs/a',
      'https://acme.test/docs/b',
    ]);
    expect(pages[0]?.title).toBe('Doc A');
    expect(pages[0]?.text).toContain('alpha pricing details');
    // Robots-disallowed and out-of-include URLs are never even fetched; nothing off-origin is.
    expect(requested).not.toContain('https://acme.test/docs/private/x');
    expect(requested).not.toContain('https://acme.test/blog/off-policy');
    expect(requested.some((url) => url.startsWith('https://evil.test'))).toBe(false);
  });

  it('indexes the origin root when include lists "/"', async () => {
    // A single-page site's only content IS the root. It was already fetched for discovery;
    // with '/' matchable it is indexed too, and non-matching links are not even fetched.
    const { fetchImpl, requested } = scriptedFetch({
      'https://acme.test/': { body: page('Home', 'all about the product', ['/docs/a']) },
      'https://acme.test/docs/a': { body: page('Doc A', 'never fetched') },
    });
    const pages = await new FirstPartySiteFetcher({ fetchImpl }).fetchSite({
      ...request,
      include: ['/'],
    });
    expect(pages.map((entry) => entry.url)).toEqual(['https://acme.test/']);
    expect(pages[0]?.title).toBe('Home');
    expect(pages[0]?.text).toContain('all about the product');
    expect(requested).not.toContain('https://acme.test/docs/a');
  });

  it('walks same-origin links from the root when no sitemap exists, indexing only include matches', async () => {
    const { fetchImpl, requested } = scriptedFetch({
      'https://acme.test/': {
        body: page('Home', 'welcome', [
          '/docs/a',
          '/pricing',
          'https://evil.test/docs/x',
          '/blog/z',
        ]),
      },
      'https://acme.test/docs/a': { body: page('Doc A', 'alpha', ['/docs/deep']) },
      'https://acme.test/docs/deep': { body: page('Deep', 'deep content') },
      'https://acme.test/pricing': { body: page('Pricing', 'ten dollars') },
      'https://acme.test/blog/z': { body: page('Blog', 'never fetched') },
    });
    const pages = await new FirstPartySiteFetcher({ fetchImpl }).fetchSite(request);
    expect(pages.map((entry) => entry.url)).toEqual([
      'https://acme.test/docs/a',
      'https://acme.test/docs/deep',
      'https://acme.test/pricing',
    ]);
    expect(requested).not.toContain('https://acme.test/blog/z');
    expect(requested.some((url) => url.startsWith('https://evil.test'))).toBe(false);
  });

  it('enforces the page cap deterministically and skips oversized, redirected, and non-HTML pages', async () => {
    const big = 'x'.repeat(600);
    const { fetchImpl } = scriptedFetch({
      'https://acme.test/robots.txt': {
        body: 'Sitemap: https://acme.test/sitemap.xml',
        type: 'text/plain',
      },
      'https://acme.test/sitemap.xml': {
        body: ['/docs/a', '/docs/b', '/docs/big', '/docs/moved', '/docs/pdf', '/docs/c']
          .map((path) => `<loc>https://acme.test${path}</loc>`)
          .join('\n'),
        type: 'application/xml',
      },
      'https://acme.test/': { body: page('Home', 'welcome') },
      'https://acme.test/docs/a': { body: page('A', 'aaa') },
      'https://acme.test/docs/b': { body: page('B', 'bbb') },
      'https://acme.test/docs/c': { body: page('C', 'ccc') },
      'https://acme.test/docs/big': { body: page('Big', big) },
      'https://acme.test/docs/moved': { status: 301 },
      'https://acme.test/docs/pdf': { body: 'raw pdf bytes', type: 'application/pdf' },
    });
    const pages = await new FirstPartySiteFetcher({ fetchImpl }).fetchSite({
      ...request,
      maxPages: 2,
      maxPageBytes: 300,
    });
    // Candidates are visited in sorted order, so the cap keeps a stable prefix.
    expect(pages.map((entry) => entry.url)).toEqual([
      'https://acme.test/docs/a',
      'https://acme.test/docs/b',
    ]);
    const all = await new FirstPartySiteFetcher({ fetchImpl }).fetchSite({
      ...request,
      maxPageBytes: 300,
    });
    expect(all.map((entry) => entry.url)).toEqual([
      'https://acme.test/docs/a',
      'https://acme.test/docs/b',
      'https://acme.test/docs/c',
    ]);
  });

  it('continues past individual page failures', async () => {
    const { fetchImpl } = scriptedFetch({
      'https://acme.test/robots.txt': {
        body: 'Sitemap: https://acme.test/sitemap.xml',
        type: 'text/plain',
      },
      'https://acme.test/sitemap.xml': {
        body: '<loc>https://acme.test/docs/a</loc><loc>https://acme.test/docs/broken</loc>',
        type: 'application/xml',
      },
      'https://acme.test/': { body: page('Home', 'welcome') },
      'https://acme.test/docs/a': { body: page('A', 'aaa') },
      'https://acme.test/docs/broken': { status: 500 },
    });
    const pages = await new FirstPartySiteFetcher({ fetchImpl }).fetchSite(request);
    expect(pages.map((entry) => entry.url)).toEqual(['https://acme.test/docs/a']);
  });

  it('rejects non-HTTPS and literal-IP origins before any fetch', async () => {
    const { fetchImpl, requested } = scriptedFetch({});
    const fetcher = new FirstPartySiteFetcher({ fetchImpl });
    await expect(
      fetcher.fetchSite({ ...request, origin: 'http://acme.test' }),
    ).rejects.toMatchObject({ layer: 'request' });
    // A literal-IP host carries no DNS step, which would bypass the socket-level SSRF guard.
    await expect(
      fetcher.fetchSite({ ...request, origin: 'https://93.184.216.34' }),
    ).rejects.toMatchObject({ layer: 'request' });
    expect(requested).toEqual([]);
  });
});
