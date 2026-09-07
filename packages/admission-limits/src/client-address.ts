import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Turn a forwarded client address into a counter bucket (admission tier 3).
 *
 * Two rules, both learned rather than assumed.
 *
 * **Parse for IPv6 first.** About a fifth of this service's real traffic is IPv6, so the ubiquitous
 * `split(':')[0]` port-strip is not a small bug here: it collapses every IPv6 visitor into one bucket,
 * where a single abuser throttles all of them. Node's own `isIP` decides what an address is; nothing
 * here pattern-matches its shape.
 *
 * **Return a bucket, never the address.** The package rule is that no IP reaches a key, a log, or an
 * audit payload, so the address is hashed on the way out and the raw value never leaves this function.
 * Rate limiting needs only "is this the same visitor as before", which a digest answers exactly as well.
 */

/** Normalizes so one visitor is one bucket regardless of how their address was written. */
function canonical(address: string): string | undefined {
  const trimmed = address.trim();
  if (trimmed.length === 0) return undefined;

  // `[2001:db8::1]:51234` — bracketed IPv6 with a port.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  const candidate = bracketed?.[1] ?? trimmed;

  if (isIP(candidate) === 6) return normalizeIpv6(candidate);
  if (isIP(candidate) === 4) return candidate;

  // `203.0.113.7:51234` — IPv4 with a port. Only ever one colon, which is what distinguishes it from
  // a bare IPv6 address and why this test comes after `isIP`.
  const withPort = /^([^:]+):\d+$/.exec(candidate);
  const host = withPort?.[1];
  if (host !== undefined && isIP(host) === 4) return host;

  return undefined;
}

/** `::ffff:203.0.113.7` is the IPv4 visitor it wraps; zero-compression and case are normalized. */
function normalizeIpv6(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return mapped[1];

  const lower = address.toLowerCase();
  const [head = '', tail] = lower.split('::', 2);
  if (tail === undefined) return lower.split(':').map(expand).join(':');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const gap = 8 - left.length - right.length;
  return [...left, ...Array.from({ length: gap }, () => '0'), ...right].map(expand).join(':');
}

const expand = (group: string): string => String(Number.parseInt(group || '0', 16));

/**
 * The first hop is the client; the rest are proxies that would otherwise share one bucket.
 * Returns `undefined` when nothing parses, so the caller falls back rather than inventing a bucket
 * that is simultaneously a free-for-all and a shared throttle.
 */
export function clientAddressBucket(forwarded: string | undefined): string | undefined {
  if (forwarded === undefined) return undefined;
  for (const hop of forwarded.split(',')) {
    const address = canonical(hop);
    if (address !== undefined) {
      return `ip_${createHash('sha256').update(address).digest('hex').slice(0, 32)}`;
    }
  }
  return undefined;
}
