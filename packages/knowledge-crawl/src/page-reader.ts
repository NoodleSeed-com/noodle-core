import { guardedFetch } from '@noodle-borg/connector-http';
import {
  CapabilityError,
  publicPageUrl,
  WEB_EXTRACT_LIMITS,
} from '@noodle-borg/managed-capabilities';
import { readBoundedBody } from './bounded-body.js';
import { extractHtmlText, extractPageContent } from './html-text.js';
import { parseRobots } from './robots.js';

export interface PageReadRequest {
  readonly url: string;
  readonly domains?: readonly string[];
  readonly signal: AbortSignal;
  readonly beforeRequest: () => void;
  readonly maxBytes: number;
}

export interface ReadPublicPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly { readonly url: string; readonly label?: string }[];
  readonly retrievedAt: string;
}

const PRODUCT_TOKEN = 'NoodleSeedBot';
const HEADERS = {
  'user-agent': `${PRODUCT_TOKEN}/1.0 (bounded public-page extraction)`,
  accept: 'text/html,text/plain;q=0.9',
  'accept-encoding': 'identity',
};

/** Single-page acquisition, not a crawler. All transport collaborators are deployment-owned. */
export class PublicPageReader {
  readonly #fetch: typeof fetch;
  constructor(options: { readonly fetchImpl?: typeof fetch } = {}) {
    this.#fetch = options.fetchImpl ?? ((url, init) => guardedFetch(new URL(String(url)), init));
  }

  async read(request: PageReadRequest): Promise<ReadPublicPage> {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(WEB_EXTRACT_LIMITS.timeoutMs),
    ]);
    let url = publicPageUrl(request.url, request.domains);
    const checked = new Map<string, ReturnType<typeof parseRobots>>();
    try {
      for (let redirects = 0; redirects <= WEB_EXTRACT_LIMITS.maxRedirects; redirects += 1) {
        signal.throwIfAborted();
        let robots = checked.get(url.origin);
        if (robots === undefined) {
          robots = await this.#robots(url, request, signal);
          checked.set(url.origin, robots);
        }
        if (!robots.isAllowed(url.pathname))
          throw new CapabilityError('capability_source_rejected');
        const response = await this.#request(url, request, signal);
        try {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (location === null || redirects === WEB_EXTRACT_LIMITS.maxRedirects) {
              throw new CapabilityError('capability_source_rejected');
            }
            url = publicPageUrl(new URL(location, url).href, request.domains);
            continue;
          }
          if (response.status !== 200) throw new CapabilityError('capability_source_rejected');
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
          if (mime !== 'text/html') throw new CapabilityError('capability_source_rejected');
          const bytes = await readBoundedBody(
            response,
            Math.min(request.maxBytes, WEB_EXTRACT_LIMITS.maxPageBytes),
            signal,
          );
          signal.throwIfAborted();
          const content = extractPageContent(mime, bytes);
          if (content === undefined || content.text === '')
            throw new CapabilityError('capability_source_rejected');
          return {
            url: url.href,
            title: content.title.slice(0, 512),
            text: content.text,
            links: pageLinks(content.html, url, request.domains),
            retrievedAt: new Date().toISOString(),
          };
        } finally {
          await response.body?.cancel().catch(() => {});
        }
      }
    } catch (error) {
      if (signal.aborted) throw new CapabilityError('capability_cancelled');
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError('capability_source_rejected');
    }
    throw new CapabilityError('capability_source_rejected');
  }

  async #request(url: URL, request: PageReadRequest, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    request.beforeRequest();
    return this.#fetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: HEADERS,
      signal,
    });
  }

  async #robots(url: URL, request: PageReadRequest, signal: AbortSignal) {
    const response = await this.#request(new URL('/robots.txt', url), request, signal);
    try {
      if (response.status === 404 || response.status === 410) return parseRobots('', PRODUCT_TOKEN);
      if (response.status !== 200) throw new CapabilityError('capability_source_rejected');
      const bytes = await readBoundedBody(response, WEB_EXTRACT_LIMITS.maxRobotsBytes, signal);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.trimStart().startsWith('<') || text.includes('\0'))
        throw new CapabilityError('capability_source_rejected');
      return parseRobots(text, PRODUCT_TOKEN);
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
}

function pageLinks(html: string, base: URL, domains?: readonly string[]): ReadPublicPage['links'] {
  const links: { url: string; label?: string }[] = [];
  const seen = new Set<string>();
  // Bounded HTML has no evaluator. Link labels and destinations are untrusted and are not fetched here.
  for (const match of html.matchAll(
    /<a\b[^>]*?href\s*=\s*["']([^"']{1,2048})["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
  )) {
    try {
      const url = publicPageUrl(new URL(match[1] ?? '', base).href, domains);
      if (url.origin !== base.origin || seen.has(url.href)) continue;
      seen.add(url.href);
      const label = extractHtmlText(match[2] ?? '').slice(0, 200);
      links.push({ url: url.href, ...(label === '' ? {} : { label }) });
      if (links.length === WEB_EXTRACT_LIMITS.maxLinks) break;
    } catch {
      /* Unsafe or out-of-policy links do not become candidate sources. */
    }
  }
  return links;
}
