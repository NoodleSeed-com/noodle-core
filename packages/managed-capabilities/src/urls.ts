import { isIP } from 'node:net';
import { CapabilityError } from './errors.js';
import { WEB_EXTRACT_LIMITS } from './limits.js';

/** Syntactic policy only. The adapter must additionally pin socket DNS to public unicast addresses. */
export function publicPageUrl(value: string, domains?: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CapabilityError('capability_source_rejected');
  }
  const host = url.hostname;
  if (
    value.length > WEB_EXTRACT_LIMITS.maxUrlCharacters ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    isIP(host.replace(/^\[|\]$/g, '')) !== 0 ||
    !host.includes('.') ||
    host.endsWith('.') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
    (domains !== undefined && !domains.includes(host))
  ) {
    throw new CapabilityError('capability_source_rejected');
  }
  url.hash = '';
  return url;
}
