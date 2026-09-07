import { isIP } from 'node:net';
import { parse as parseDomain } from 'tldts';
import { isRecord } from './manifest/parse-document.js';

const CUSTOMER_ENDPOINT_NAME_PATTERN = /^[a-z0-9_]+$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const MAX_CUSTOMER_ENDPOINT_URL_BYTES = 2_048;

const DOMAIN_PARSE_OPTIONS = {
  allowPrivateDomains: true,
  detectSpecialUse: true,
  extractHostname: false,
} as const;

export type CustomerEndpointPolicy =
  | {
      readonly allowedHttpsOrigins: readonly string[];
      readonly allowedHttpsHostSuffixes?: never;
    }
  | {
      readonly allowedHttpsOrigins?: never;
      readonly allowedHttpsHostSuffixes: readonly string[];
    };

export interface CustomerEndpointRef {
  readonly kind: 'customerEndpoint';
  readonly name: string;
  readonly policy: CustomerEndpointPolicy;
}

function invalidPolicy(): never {
  throw new Error('invalid customer endpoint policy');
}

function hasUnsafeAuthoredCharacters(value: string): boolean {
  return value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value);
}

function hasCanonicalHttpsAuthority(value: string): boolean {
  return /^https:\/\/[^/?#\\]+(?:[/?#]|$)/iu.test(value) && !value.includes('\\');
}

function hasRawUrlMetadata(value: string): boolean {
  if (value.includes('?') || value.includes('#')) return true;
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return false;
  const authorityStart = schemeEnd + 3;
  const pathStart = value.indexOf('/', authorityStart);
  const authority = value.slice(authorityStart, pathStart < 0 ? value.length : pathStart);
  return authority.includes('@');
}

function hasAmbiguousCustomerBasePath(value: string): boolean {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return false;
  const pathStart = value.indexOf('/', schemeEnd + 3);
  if (pathStart < 0) return false;
  const path = value.slice(pathStart);
  return (
    /%(?:25|2e|2f|5c)/iu.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(path) || path.includes('\\')
  );
}

function hasRootOnlyRawPath(value: string): boolean {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return false;
  const authorityStart = schemeEnd + 3;
  const pathStart = value.indexOf('/', authorityStart);
  return pathStart < 0 || value.slice(pathStart) === '/';
}

function parseHostname(hostname: string) {
  return parseDomain(hostname, DOMAIN_PARSE_OPTIONS);
}

function isIpHostname(hostname: string): boolean {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(unbracketed) !== 0;
}

function hasCanonicalDnsLabels(hostname: string): boolean {
  return (
    hostname.length <= 253 &&
    hostname
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  );
}

function hasSafeRegistrableHostname(hostname: string): boolean {
  if (isIpHostname(hostname) || !hasCanonicalDnsLabels(hostname)) return false;
  const parsed = parseHostname(hostname);
  return (
    parsed.hostname === hostname &&
    parsed.isIp === false &&
    parsed.isSpecialUse === false &&
    (parsed.isIcann === true || parsed.isPrivate === true) &&
    parsed.domain !== null
  );
}

function normalizeExactOrigin(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !hasCanonicalHttpsAuthority(value) ||
    hasUnsafeAuthoredCharacters(value) ||
    hasRawUrlMetadata(value) ||
    !hasRootOnlyRawPath(value)
  ) {
    return invalidPolicy();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidPolicy();
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.endsWith('.')
  ) {
    return invalidPolicy();
  }

  if (!hasSafeRegistrableHostname(url.hostname)) return invalidPolicy();
  return url.origin;
}

function normalizeHostnameSuffix(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    hasUnsafeAuthoredCharacters(value) ||
    ['\\', '/', ':', '?', '#', '@', '[', ']'].some((character) => value.includes(character))
  ) {
    return invalidPolicy();
  }

  let url: URL;
  try {
    url = new URL(`https://${value}/`);
  } catch {
    return invalidPolicy();
  }

  if (url.port !== '' || url.hostname.endsWith('.')) return invalidPolicy();

  const hostname = url.hostname;
  if (isIpHostname(hostname) || !hasCanonicalDnsLabels(hostname)) return invalidPolicy();
  const parsed = parseHostname(hostname);
  if (
    parsed.hostname !== hostname ||
    parsed.isIp !== false ||
    parsed.isSpecialUse !== false ||
    (parsed.isIcann !== true && parsed.isPrivate !== true) ||
    parsed.domain === null ||
    parsed.publicSuffix === hostname
  ) {
    return invalidPolicy();
  }
  return hostname;
}

function normalizeEntries(
  value: unknown,
  normalize: (entry: unknown) => string,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return invalidPolicy();
  const normalized = [...new Set(value.map(normalize))].sort();
  if (normalized.length === 0) return invalidPolicy();
  return normalized;
}

/**
 * Validates and canonicalizes the policy declared for a customer-derived connector base URL.
 *
 * The returned value is safe to persist in a runtime artifact. It contains authority policy only,
 * never a resolved end-user claim value.
 */
export function normalizeCustomerEndpointPolicy(value: unknown): CustomerEndpointPolicy {
  if (!isRecord(value)) return invalidPolicy();
  const keys = Object.keys(value);
  const hasOrigins = Object.hasOwn(value, 'allowedHttpsOrigins');
  const hasSuffixes = Object.hasOwn(value, 'allowedHttpsHostSuffixes');
  if (
    hasOrigins === hasSuffixes ||
    keys.some((key) => key !== 'allowedHttpsOrigins' && key !== 'allowedHttpsHostSuffixes')
  ) {
    return invalidPolicy();
  }

  if (hasOrigins) {
    return {
      allowedHttpsOrigins: normalizeEntries(value.allowedHttpsOrigins, normalizeExactOrigin),
    };
  }
  return {
    allowedHttpsHostSuffixes: normalizeEntries(
      value.allowedHttpsHostSuffixes,
      normalizeHostnameSuffix,
    ),
  };
}

export function isValidCustomerEndpointName(name: unknown): name is string {
  return typeof name === 'string' && CUSTOMER_ENDPOINT_NAME_PATTERN.test(name);
}

export function isCustomerEndpointRef(value: unknown): value is CustomerEndpointRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly kind?: unknown }).kind === 'customerEndpoint'
  );
}

function parseResolvedBaseUrl(raw: unknown): URL | undefined {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    !hasCanonicalHttpsAuthority(raw) ||
    new TextEncoder().encode(raw).byteLength > MAX_CUSTOMER_ENDPOINT_URL_BYTES ||
    hasUnsafeAuthoredCharacters(raw) ||
    hasRawUrlMetadata(raw) ||
    hasAmbiguousCustomerBasePath(raw)
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.endsWith('.') ||
    !hasSafeRegistrableHostname(url.hostname)
  ) {
    return undefined;
  }
  return url;
}

/**
 * Resolves an untrusted identity-provider claim into a canonical, policy-authorized base URL.
 *
 * Failure deliberately carries no reason or rejected value so callers cannot leak route claims into
 * model-visible errors, logs, widgets, or confirmations.
 */
export function resolveCustomerEndpointBaseUrl(
  raw: unknown,
  policy: CustomerEndpointPolicy,
): { readonly ok: true; readonly baseUrl: string } | { readonly ok: false } {
  const url = parseResolvedBaseUrl(raw);
  if (url === undefined) return { ok: false };

  let normalizedPolicy: CustomerEndpointPolicy;
  try {
    normalizedPolicy = normalizeCustomerEndpointPolicy(policy);
  } catch {
    return { ok: false };
  }

  if ('allowedHttpsOrigins' in normalizedPolicy) {
    if (!normalizedPolicy.allowedHttpsOrigins.includes(url.origin)) return { ok: false };
  } else {
    if (url.port !== '') return { ok: false };
    const matches = normalizedPolicy.allowedHttpsHostSuffixes.some(
      (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
    );
    if (!matches) return { ok: false };
  }

  const basePath = url.pathname.replace(/\/+$/u, '');
  return {
    ok: true,
    baseUrl: `${url.origin}${basePath}`,
  };
}
