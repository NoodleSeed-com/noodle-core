import { lookup as nodeLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';

/**
 * SSRF egress guard for outbound connector traffic
 * ([ADR 0008](../../../docs/decisions/0008-custom-connector-ssrf-dns-pinning.md),
 * [ADR 0026](../../../docs/decisions/0026-ssrf-egress-hardening-lib.md)).
 *
 * The guarded fetch path attaches an undici `Agent` whose socket-level DNS `lookup` rejects any address
 * that is not a **public unicast** address. Because the same lookup that validates is the one undici
 * connects to (and TLS SNI stays the original hostname), this defeats DNS rebinding to loopback/private/
 * link-local/reserved ranges — including the cloud-metadata address `169.254.169.254`.
 *
 * Literal-IP hosts are intentionally **not** guarded here: they carry no DNS step (no rebinding window)
 * and are already vetted by the connector's static origin allowlist (ADR 0008 layer 1) — an explicit,
 * auditable operator declaration.
 *
 * NOTE (spec drift vs ADR 0026): the ADR named `request-filtering-agent`, but that ships an
 * `http(s).Agent` which native `fetch`/undici ignores. The fetch-compatible mechanism is package-local
 * undici `fetch` plus an undici `Agent` with a custom socket `lookup`; `ipaddr.js` still does the
 * address classification. ADR 0026 records this correction.
 */

interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | readonly ResolvedAddress[],
  family?: number,
) => void;

/** A `dns.lookup`-compatible function (loosened so it is trivially injectable for tests). */
export type DnsLookup = (
  hostname: string,
  options: Record<string, unknown>,
  callback: LookupCallback,
) => void;

export interface GuardedFetchOptions {
  readonly connectTimeoutMs?: number;
  readonly lookup?: DnsLookup;
}

const baseDnsLookup = nodeLookup as unknown as DnsLookup;

/**
 * True for a public unicast address; false for loopback / private / link-local / CGNAT / multicast /
 * reserved / unspecified / broadcast — and for anything unparseable (fail closed). `ipaddr.process`
 * normalizes IPv4-mapped IPv6 (`::ffff:a.b.c.d`) to IPv4 so that bypass is covered.
 */
export function isPublicUnicast(ip: string): boolean {
  try {
    return ipaddr.process(ip).range() === 'unicast';
  } catch {
    return false;
  }
}

/**
 * Wrap a base resolver so a hostname that resolves **only** to non-public addresses fails closed
 * (anti-rebinding), and any non-public address is filtered out of the result set.
 */
export function pinnedLookup(base: DnsLookup = baseDnsLookup): DnsLookup {
  return (hostname, options, callback) => {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const all = Array.isArray(addresses) ? (addresses as readonly ResolvedAddress[]) : [];
      const safe = all.filter((a) => isPublicUnicast(a.address));
      const first = safe[0];
      if (first === undefined) {
        callback(new Error(`egress blocked: "${hostname}" resolved only to non-public addresses`));
        return;
      }
      if (options.all === true) {
        callback(null, safe);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

/** Resolve and validate a DNS hostname once before handing the request to undici. */
export function assertPublicResolution(hostname: string, base?: DnsLookup): Promise<void> {
  const lookup = pinnedLookup(base);
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/** An undici dispatcher that pins+validates DNS resolutions for SSRF protection. */
export function createGuardedAgent(connectTimeoutMs: number, base?: DnsLookup): Dispatcher {
  return new Agent({
    connect: {
      timeout: connectTimeoutMs,
      lookup: pinnedLookup(base) as unknown as LookupFunction,
    },
  });
}

/** Fetch with the package-local undici implementation and guarded DNS for DNS-name hosts. */
export async function guardedFetch(
  url: URL,
  init: RequestInit = {},
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const dispatcher =
    needsGuard(url) && init.signal?.aborted !== true
      ? createGuardedAgent(options.connectTimeoutMs ?? 10_000, options.lookup)
      : undefined;
  try {
    const response = await undiciFetch(url, {
      ...init,
      ...(dispatcher === undefined ? {} : { dispatcher }),
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  } catch (error) {
    const cause = ownData(error, 'cause');
    const causeMessage = ownData(cause, 'message');
    if (typeof causeMessage === 'string' && causeMessage.startsWith('egress blocked:')) {
      throw cause;
    }
    throw error;
  }
}

/** Whether a URL needs the guarded dispatcher: DNS-name hosts yes, literal-IP hosts no. */
export function needsGuard(url: URL): boolean {
  // `URL.hostname` keeps the brackets on IPv6 literals (e.g. `[::1]`); strip them before classifying.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return isIP(host) === 0;
}

function ownData(value: unknown, key: string): unknown {
  if (!((typeof value === 'object' && value !== null) || typeof value === 'function')) {
    return undefined;
  }
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
