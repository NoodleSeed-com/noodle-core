/**
 * The managed first-party site fetcher (ADR 0202 amendment 2026-08-18): sitemap-first discovery,
 * an include-contained same-origin link walk, robots.txt, and bounded, deterministic output.
 *
 * Egress is SSRF-guarded in layers: the default fetch path is `guardedFetch` from
 * `@noodle-borg/connector-http` (socket-level DNS pinning to public unicast addresses, ADR 0026),
 * and this fetcher additionally enforces HTTPS-only, rejects literal-IP origins (no DNS step means
 * no pinning), keeps every fetched URL on the declared origin, and never follows redirects
 * (a moved page is indexed at its new URL when discovery finds it there).
 */
import { guardedFetch } from '@noodle-borg/connector-http';
import { pathMatches } from '@noodle-borg/knowledge/portable';
import { extractPageContent } from './html-text.js';
import { parseOrigin, safeUrl } from './origin.js';
import type { CrawlPage, SiteCrawlRequest, SiteFetcher } from './ports.js';
import { parseRobots, type Robots } from './robots.js';
import { parseSitemapLocations } from './sitemap.js';

const ALLOW_ALL: Robots = { isAllowed: () => true, sitemaps: [] };
const LINK = /<a\s[^>]*?href\s*=\s*["']([^"'#]+)["']/gi;

export interface FirstPartySiteFetcherOptions {
  /** Injected for tests; defaults to the SSRF-guarded fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class FirstPartySiteFetcher implements SiteFetcher {
  readonly #fetch: typeof fetch;

  constructor(options: FirstPartySiteFetcherOptions = {}) {
    this.#fetch =
      options.fetchImpl ??
      (((url, init) => guardedFetch(new URL(String(url)), init as RequestInit)) as typeof fetch);
  }

  async fetchSite(request: SiteCrawlRequest): Promise<readonly CrawlPage[]> {
    const origin = parseOrigin(request.origin);
    const robots = await this.#robots(origin);
    const indexable = (url: URL): boolean =>
      url.origin === origin.origin &&
      robots.isAllowed(url.pathname) &&
      request.include.some((glob) => pathMatches(url.pathname, glob));

    const queue = new Set<string>();
    for (const location of await this.#sitemapLocations(origin, robots)) {
      const url = safeUrl(location);
      if (url !== undefined && indexable(url)) queue.add(url.origin + url.pathname);
    }

    const pages: CrawlPage[] = [];
    const visited = new Set<string>();
    // The root is fetched for discovery even when it is not itself indexable.
    const discovery = [`${origin.origin}/`];
    for (;;) {
      const next =
        [...queue].filter((url) => !visited.has(url)).sort()[0] ??
        discovery.find((url) => !visited.has(url));
      if (next === undefined || pages.length >= request.maxPages) break;
      visited.add(next);
      const fetched = await this.#page(next, request.maxPageBytes);
      if (fetched === undefined) continue;
      for (const href of fetched.html.matchAll(LINK)) {
        const linked = safeUrl(href[1] ?? '', next);
        if (linked !== undefined && indexable(linked)) queue.add(linked.origin + linked.pathname);
      }
      if (indexable(new URL(next)) && fetched.text !== '') {
        pages.push({
          url: next,
          title: fetched.title === '' ? next : fetched.title,
          text: fetched.text,
        });
      }
    }
    return pages.sort((a, b) => a.url.localeCompare(b.url));
  }

  async #robots(origin: URL): Promise<Robots> {
    try {
      const response = await this.#fetch(`${origin.origin}/robots.txt`);
      if (response.status !== 200) return ALLOW_ALL;
      return parseRobots(await response.text());
    } catch {
      return ALLOW_ALL;
    }
  }

  async #sitemapLocations(origin: URL, robots: Robots): Promise<readonly string[]> {
    const sitemapUrls = (
      robots.sitemaps.length > 0 ? robots.sitemaps : [`${origin.origin}/sitemap.xml`]
    ).filter((url) => safeUrl(url)?.origin === origin.origin);
    const locations: string[] = [];
    for (const sitemapUrl of sitemapUrls) {
      try {
        const response = await this.#fetch(sitemapUrl);
        if (response.status !== 200) continue;
        locations.push(...parseSitemapLocations(await response.text()));
      } catch {
        // A missing or failing sitemap is not an error; the link walk still discovers pages.
      }
    }
    return locations;
  }

  async #page(
    url: string,
    maxPageBytes: number,
  ): Promise<{ html: string; title: string; text: string } | undefined> {
    try {
      const response = await this.#fetch(url, { redirect: 'manual' } as RequestInit);
      if (response.status !== 200) return undefined;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxPageBytes) return undefined;
      return extractPageContent(response.headers.get('content-type') ?? '', bytes);
    } catch {
      return undefined;
    }
  }
}
