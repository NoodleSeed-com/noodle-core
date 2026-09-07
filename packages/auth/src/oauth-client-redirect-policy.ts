export type OAuthApplicationType = 'web' | 'native';
export type OAuthTokenEndpointAuthMethod = 'none' | 'client_secret_post';

export type StoredRedirectPolicyClass =
  | 'normalized'
  | 'safe_https'
  | 'safe_loopback_legacy'
  | 'unsafe_legacy'
  | 'malformed_legacy';

export interface OAuthRedirectClientMetadata {
  application_type?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  noodle_redirect_policy_version?: unknown;
}

export interface NormalizedOAuthRedirectClientMetadata {
  application_type: OAuthApplicationType;
  redirect_uris: readonly string[];
  token_endpoint_auth_method: OAuthTokenEndpointAuthMethod;
  noodle_redirect_policy_version: 1;
}

export interface OAuthRedirectMatchResult {
  allowed: boolean;
  usedLegacyLoopbackPortSubstitution: boolean;
  reason:
    | 'exact_match'
    | 'native_loopback_port_match'
    | 'legacy_loopback_port_match'
    | 'unregistered_redirect'
    | 'unsafe_legacy_redirect'
    | 'malformed_client_metadata';
}

export type OAuthRedirectPolicyErrorReason =
  | 'invalid_application_type'
  | 'invalid_redirect_uris'
  | 'unsafe_redirect_uri'
  | 'unsupported_token_endpoint_auth_method';

/** A closed registration-policy error suitable for mapping to OAuth invalid_client_metadata. */
export class OAuthRedirectPolicyError extends Error {
  constructor(readonly reason: OAuthRedirectPolicyErrorReason) {
    super(`OAuth client metadata rejected: ${reason}`);
    this.name = 'OAuthRedirectPolicyError';
  }
}

type ParsedRedirect =
  | { readonly kind: 'malformed' }
  | {
      readonly kind: 'parsed';
      readonly raw: string;
      readonly href: string;
      readonly protocol: string;
      readonly hostname: string;
      readonly port: string;
      readonly pathname: string;
      readonly search: string;
      readonly hasCredentials: boolean;
      readonly hasFragment: boolean;
      readonly channel: 'https' | 'loopback_http' | 'unsupported';
    };

type StructuralRedirect = Extract<ParsedRedirect, { readonly kind: 'parsed' }>;

const PERMITTED_LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function normalizeOAuthClientMetadata(
  metadata: OAuthRedirectClientMetadata,
): NormalizedOAuthRedirectClientMetadata {
  const applicationType = applicationTypeForRegistration(metadata.application_type);
  const tokenEndpointAuthMethod = tokenEndpointAuthMethodForRegistration(
    metadata.token_endpoint_auth_method,
  );
  const redirectUris = redirectUrisForRegistration(metadata.redirect_uris);
  const parsedRedirects = redirectUris.map(parseRedirect);

  if (parsedRedirects.some((redirect) => !isSafeRedirect(redirect))) {
    throw new OAuthRedirectPolicyError('unsafe_redirect_uri');
  }
  if (
    metadata.application_type === 'web' &&
    parsedRedirects.some((redirect) => redirect.kind !== 'parsed' || redirect.channel !== 'https')
  ) {
    throw new OAuthRedirectPolicyError('unsafe_redirect_uri');
  }

  return {
    application_type: applicationType,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    noodle_redirect_policy_version: 1,
  };
}

export function classifyStoredOAuthRedirectPolicy(
  metadata: OAuthRedirectClientMetadata,
): StoredRedirectPolicyClass {
  if (hasExplicitApplicationType(metadata) && isNormalizedStoredRecord(metadata))
    return 'normalized';
  if (isMarkedOmittedTypeCompatibleRecord(metadata)) return 'normalized';

  const redirects = redirectUrisForStoredRecord(metadata.redirect_uris);
  if (redirects === undefined) return 'malformed_legacy';

  const parsedRedirects = redirects.map(parseRedirect);
  if (parsedRedirects.some((redirect) => redirect.kind === 'malformed')) {
    return 'malformed_legacy';
  }
  if (!hasExplicitApplicationType(metadata)) {
    if (parsedRedirects.every((redirect) => isSafeHttpsRedirect(redirect))) return 'safe_https';
    if (parsedRedirects.every(isSafeRedirect) && parsedRedirects.some(isLoopbackHttpRedirect)) {
      return 'safe_loopback_legacy';
    }
  }
  return 'unsafe_legacy';
}

export function matchOAuthAuthorizationRedirect(args: {
  client: OAuthRedirectClientMetadata;
  requestedRedirectUri?: string;
  allowLegacyLoopbackPortSubstitution: boolean;
}): OAuthRedirectMatchResult {
  const policyClass = classifyStoredOAuthRedirectPolicy(args.client);
  if (policyClass === 'malformed_legacy') return rejected('malformed_client_metadata');

  const redirectUris = redirectUrisForStoredRecord(args.client.redirect_uris);
  if (redirectUris === undefined) return rejected('malformed_client_metadata');
  if (args.requestedRedirectUri !== undefined && redirectUris.includes(args.requestedRedirectUri)) {
    return allowed('exact_match');
  }
  if (policyClass === 'unsafe_legacy') return rejected('unsafe_legacy_redirect');
  if (args.requestedRedirectUri === undefined) return rejected('unregistered_redirect');

  const requested = parseRedirect(args.requestedRedirectUri);
  const registered = redirectUris.map(parseRedirect);
  if (policyClass === 'normalized') {
    if (
      args.client.application_type === 'native' &&
      registered.some((redirect) => loopbackRedirectsMatchIgnoringPort(redirect, requested))
    ) {
      return allowed('native_loopback_port_match');
    }
    return rejected('unregistered_redirect');
  }
  if (
    policyClass === 'safe_loopback_legacy' &&
    args.allowLegacyLoopbackPortSubstitution &&
    registered.some((redirect) => loopbackRedirectsMatchIgnoringPort(redirect, requested))
  ) {
    const matched = registered.find((redirect) =>
      loopbackRedirectsMatchIgnoringPort(redirect, requested),
    );
    return {
      allowed: true,
      usedLegacyLoopbackPortSubstitution:
        matched?.kind === 'parsed' &&
        requested.kind === 'parsed' &&
        matched.port !== requested.port,
      reason: 'legacy_loopback_port_match',
    };
  }
  return rejected('unregistered_redirect');
}

function applicationTypeForRegistration(value: unknown): OAuthApplicationType {
  if (value === undefined) return 'web';
  if (value === 'web' || value === 'native') return value;
  throw new OAuthRedirectPolicyError('invalid_application_type');
}

function tokenEndpointAuthMethodForRegistration(value: unknown): OAuthTokenEndpointAuthMethod {
  if (value === undefined) return 'client_secret_post';
  if (value === 'none' || value === 'client_secret_post') return value;
  throw new OAuthRedirectPolicyError('unsupported_token_endpoint_auth_method');
}

function redirectUrisForRegistration(value: unknown): readonly string[] {
  const redirects = redirectUrisForStoredRecord(value);
  if (redirects === undefined) throw new OAuthRedirectPolicyError('invalid_redirect_uris');
  return redirects;
}

function redirectUrisForStoredRecord(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((redirect) => typeof redirect === 'string')
  ) {
    return undefined;
  }
  return value;
}

function parseRedirect(value: unknown): ParsedRedirect {
  if (typeof value !== 'string') return { kind: 'malformed' };
  try {
    const url = new URL(value);
    const submittedHostname = submittedHostnameFromRedirect(value);
    const effectiveHostname = url.hostname.toLowerCase();
    const isLoopbackHttp =
      url.protocol === 'http:' &&
      submittedHostname !== undefined &&
      submittedHostname === effectiveHostname &&
      PERMITTED_LOOPBACK_HOSTS.has(effectiveHostname);
    return {
      kind: 'parsed',
      raw: value,
      href: url.href,
      protocol: url.protocol,
      hostname: effectiveHostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      hasCredentials: url.username !== '' || url.password !== '',
      hasFragment: value.includes('#'),
      channel:
        url.protocol === 'https:' ? 'https' : isLoopbackHttp ? 'loopback_http' : 'unsupported',
    };
  } catch {
    return { kind: 'malformed' };
  }
}

function hasExplicitApplicationType(metadata: OAuthRedirectClientMetadata): boolean {
  return metadata.application_type !== undefined;
}

function isNormalizedStoredRecord(metadata: OAuthRedirectClientMetadata): boolean {
  try {
    const applicationType = applicationTypeForRegistration(metadata.application_type);
    tokenEndpointAuthMethodForRegistration(metadata.token_endpoint_auth_method);
    const redirects = redirectUrisForStoredRecord(metadata.redirect_uris);
    if (redirects === undefined) return false;
    const parsedRedirects = redirects.map(parseRedirect);
    return applicationType === 'web'
      ? parsedRedirects.every(isSafeHttpsRedirect)
      : parsedRedirects.every(isSafeRedirect);
  } catch {
    return false;
  }
}

function isMarkedOmittedTypeCompatibleRecord(metadata: OAuthRedirectClientMetadata): boolean {
  if (metadata.noodle_redirect_policy_version !== 1 || metadata.application_type !== 'web') {
    return false;
  }
  try {
    tokenEndpointAuthMethodForRegistration(metadata.token_endpoint_auth_method);
    const redirects = redirectUrisForStoredRecord(metadata.redirect_uris);
    if (redirects === undefined) return false;
    const parsedRedirects = redirects.map(parseRedirect);
    return parsedRedirects.every(isSafeRedirect) && parsedRedirects.some(isLoopbackHttpRedirect);
  } catch {
    return false;
  }
}

function submittedHostnameFromRedirect(value: string): string | undefined {
  const authorityStart = value.indexOf('://');
  if (authorityStart === -1) return undefined;
  const afterScheme = value.slice(authorityStart + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostAndPort.startsWith('[')) {
    const closingBracket = hostAndPort.indexOf(']');
    return closingBracket === -1
      ? undefined
      : hostAndPort.slice(0, closingBracket + 1).toLowerCase();
  }
  return hostAndPort
    .slice(0, hostAndPort.indexOf(':') === -1 ? undefined : hostAndPort.indexOf(':'))
    .toLowerCase();
}

function isSafeRedirect(redirect: ParsedRedirect): redirect is StructuralRedirect {
  return (
    redirect.kind === 'parsed' &&
    !redirect.hasCredentials &&
    !redirect.hasFragment &&
    (redirect.channel === 'https' || redirect.channel === 'loopback_http')
  );
}

function isSafeHttpsRedirect(redirect: ParsedRedirect): redirect is StructuralRedirect {
  return (
    redirect.kind === 'parsed' &&
    !redirect.hasCredentials &&
    !redirect.hasFragment &&
    redirect.channel === 'https'
  );
}

function isLoopbackHttpRedirect(redirect: ParsedRedirect): redirect is StructuralRedirect {
  return (
    redirect.kind === 'parsed' &&
    !redirect.hasCredentials &&
    !redirect.hasFragment &&
    redirect.channel === 'loopback_http'
  );
}

function loopbackRedirectsMatchIgnoringPort(left: ParsedRedirect, right: ParsedRedirect): boolean {
  return (
    isLoopbackHttpRedirect(left) &&
    isLoopbackHttpRedirect(right) &&
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search
  );
}

function allowed(reason: 'exact_match' | 'native_loopback_port_match'): OAuthRedirectMatchResult {
  return { allowed: true, usedLegacyLoopbackPortSubstitution: false, reason };
}

function rejected(
  reason: 'unregistered_redirect' | 'unsafe_legacy_redirect' | 'malformed_client_metadata',
): OAuthRedirectMatchResult {
  return { allowed: false, usedLegacyLoopbackPortSubstitution: false, reason };
}
