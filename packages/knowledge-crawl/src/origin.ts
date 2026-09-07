/** Shared origin/URL validation for every fetcher (managed and BYO). */
import { isIP } from 'node:net';
import { KnowledgeError } from '@noodle-borg/knowledge/portable';

export function parseOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new KnowledgeError('request', `site origin ${origin} is not a valid URL`);
  }
  if (url.protocol !== 'https:') {
    throw new KnowledgeError('request', 'site origin must use https');
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    // A literal-IP host has no DNS step, which would bypass the socket-level SSRF guard.
    throw new KnowledgeError('request', 'site origin must be a DNS hostname, not an IP address');
  }
  return url;
}

export function safeUrl(href: string, base?: string): URL | undefined {
  try {
    const url = base === undefined ? new URL(href) : new URL(href, base);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
