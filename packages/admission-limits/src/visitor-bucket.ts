import { createHash } from 'node:crypto';

/** Longest identifier accepted. A stranger supplies this string; the hash input has to be bounded. */
const MAX_VISITOR_ID_CHARS = 128;

/**
 * Turn a browser-supplied visitor identifier into a counter bucket.
 *
 * **This is a fairness key, never an abuse bound.** Anyone can clear their storage or forge a fresh
 * value, so nothing may be authorized by it and no limit may depend on it holding still. The
 * per-address tier stays underneath for exactly that reason. What it buys is the case the address
 * tier gets wrong: a hundred people behind one corporate NAT or a mobile carrier's CGNAT share a
 * single address, and without this they race each other for one visitor's allowance — the eleventh
 * person sees "assistant is unavailable right now" and cannot tell it from a broken product.
 *
 * Hashed on the way out for the same reason an address is: the raw value is the browser's, and the
 * package rule is that nothing a client supplies reaches a counter key, a log line, or an audit
 * payload. Bucketing needs only "is this the same visitor as before", which a digest answers exactly
 * as well.
 *
 * Returns `undefined` for anything it cannot treat as an identifier, so the caller falls back to
 * address-only fairness rather than inventing a bucket that every unparseable request would share.
 */
export function visitorBucket(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VISITOR_ID_CHARS) return undefined;
  return `vis_${createHash('sha256').update(trimmed).digest('hex').slice(0, 32)}`;
}
