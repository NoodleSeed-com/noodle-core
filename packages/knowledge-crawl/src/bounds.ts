/**
 * Client-side enforcement of the SiteFetcher contract over whatever a provider returned:
 * same-origin + include containment, empty and oversized pages dropped, URLs normalized and
 * deduplicated, deterministic order, page cap as a sorted prefix. Providers are configured with
 * matching bounds too, but the contract holds here regardless of provider behavior.
 */
import { pathMatches } from '@noodle-borg/knowledge/portable';
import { safeUrl } from './origin.js';
import type { CrawlPage, SiteCrawlRequest } from './ports.js';

export function boundPages(
  raw: readonly CrawlPage[],
  request: SiteCrawlRequest,
  origin: URL,
): readonly CrawlPage[] {
  const byUrl = new Map<string, CrawlPage>();
  for (const page of raw) {
    const url = safeUrl(page.url);
    if (url === undefined || url.origin !== origin.origin) continue;
    if (!request.include.some((glob) => pathMatches(url.pathname, glob))) continue;
    if (page.text === '' || Buffer.byteLength(page.text, 'utf8') > request.maxPageBytes) continue;
    const normalized = url.origin + url.pathname;
    if (byUrl.has(normalized)) continue;
    byUrl.set(normalized, {
      url: normalized,
      title: page.title === '' ? normalized : page.title,
      text: page.text,
    });
  }
  return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url)).slice(0, request.maxPages);
}
