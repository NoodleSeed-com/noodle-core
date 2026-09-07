import {
  type AuthorizationClaimMap,
  createJwtVerifier,
  discoverIssuerMetadata,
  projectMappedAuthorizationClaim,
} from '@noodle-borg/auth';
import {
  type DnsLookup,
  guardedFetch,
  isPublicUnicast,
  needsGuard,
} from '@noodle-borg/connector-http';
import type { OwnerTokenVerifier } from '@noodle-borg/transport-http';
import {
  createLocalJWKSet,
  decodeJwt,
  importX509,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';
import { canonicalOAuthIdentityPreferences } from './oauth/identity-preferences.js';
import { createMicrosoftIdTokenVerifier, isConfiguredMicrosoftBridge } from './oauth/microsoft.js';
import type { TenantAuthClaimMap, TenantAuthConfig, TenantOidcAuthConfig } from './store.js';

export {
  createHostedCustomerVerifierFactory,
  createLocalDevtoolsCustomerVerifierFactory,
} from './customer-verifier-boundaries.js';

export interface CustomerVerifierFactoryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly firebaseJwks?: JSONWebKeySet;
  readonly firebaseJwksUri?: string;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly lookup?: DnsLookup;
  /**
   * Test-only escape hatch for local issuer/JWKS servers. Production tenant IdPs must be HTTPS and
   * publicly routable.
   */
  readonly allowInsecureLocalhost?: boolean;
}

interface CachedCustomerVerifier {
  readonly expiresAt: number;
  readonly verifier: Promise<OwnerTokenVerifier>;
}

export function createCustomerVerifierFactory(
  options: CustomerVerifierFactoryOptions = {},
): (auth: TenantAuthConfig) => OwnerTokenVerifier {
  const cache = new Map<string, CachedCustomerVerifier>();
  const cacheTtlMs = options.cacheTtlMs ?? 300_000;
  return (auth) => {
    const verifyOidc = async (
      oidc: TenantOidcAuthConfig,
      token: string,
      resource: string | undefined,
    ) => {
      if (resource === undefined || resource.length === 0) return null;
      const key = JSON.stringify([
        oidc.issuer,
        oidc.audience,
        oidc.claims?.roles ?? '',
        oidc.claims?.scopes ?? '',
        routingClaimEntries(oidc),
      ]);
      const verifier = cachedCustomerVerifier(cache, key, cacheTtlMs, () =>
        discoverCustomerVerifier(oidc, options),
      );
      try {
        return await (await verifier)(token, resource);
      } catch {
        return null;
      }
    };
    if (auth.kind === 'federatedOidc') {
      return async (token, resource) => {
        let issuer: string | undefined;
        try {
          const decoded = decodeJwt(token);
          issuer = typeof decoded.iss === 'string' ? normalizeIssuer(decoded.iss) : undefined;
        } catch {
          return null;
        }
        if (issuer === undefined) return null;
        const configured = auth.issuers.find(
          (candidate) => normalizeIssuer(candidate.issuer) === issuer,
        );
        return configured === undefined ? null : verifyOidc(configured, token, resource);
      };
    }
    if (auth.kind === 'bridge') {
      if (auth.provider === 'microsoft') {
        if (!isConfiguredMicrosoftBridge(auth)) return async () => null;
        return async (token) => {
          const key = [
            'microsoft',
            auth.tenantId,
            auth.clientId,
            JSON.stringify(auth.user ?? {}),
          ].join('\u0000');
          const verifier = cachedCustomerVerifier(cache, key, cacheTtlMs, () =>
            createMicrosoftIdTokenVerifier({
              auth,
              fetchImpl: options.fetchImpl ?? fetch,
            }).then((verify) => async (candidate: string) => {
              const identity = await verify(candidate);
              return identity === null
                ? null
                : { caller: { ...identity, audience: auth.clientId } };
            }),
          );
          try {
            return await (await verifier)(token, auth.clientId);
          } catch {
            return null;
          }
        };
      }
      if (auth.provider !== 'firebase') return async () => null;
      return async (token) => {
        const key = [
          'firebase',
          auth.projectId ?? '',
          auth.user?.roles ?? '',
          auth.user?.scopes ?? '',
        ].join('\u0000');
        const verifier = cachedCustomerVerifier(cache, key, cacheTtlMs, () =>
          createFirebaseIdTokenVerifier(auth.projectId, options, auth.user),
        );
        try {
          return await (await verifier)(token, auth.projectId ?? '');
        } catch {
          return null;
        }
      };
    }
    return async (token, resource) => verifyOidc(auth, token, resource);
  };
}

function cachedCustomerVerifier(
  cache: Map<string, CachedCustomerVerifier>,
  key: string,
  cacheTtlMs: number,
  create: () => Promise<OwnerTokenVerifier>,
): Promise<OwnerTokenVerifier> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.verifier;

  const verifier = create();
  cache.set(key, { expiresAt: now + cacheTtlMs, verifier });
  void verifier.catch(() => {
    if (cache.get(key)?.verifier === verifier) cache.delete(key);
  });
  return verifier;
}

export async function createFirebaseIdTokenVerifier(
  projectId: string | undefined,
  options: CustomerVerifierFactoryOptions,
  claims?: TenantAuthClaimMap,
): Promise<OwnerTokenVerifier> {
  if (projectId === undefined || projectId.length === 0) return async () => null;
  const issuer = `https://securetoken.google.com/${projectId}`;
  const keyResolver =
    options.firebaseJwks !== undefined
      ? createLocalJWKSet(options.firebaseJwks)
      : options.firebaseJwksUri !== undefined
        ? createLocalJWKSet(await fetchJwks(options.firebaseJwksUri, options))
        : await firebaseX509Resolver(options);
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keyResolver, {
        issuer,
        audience: projectId,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
      const preferences = canonicalOAuthIdentityPreferences({
        locale: payload.locale,
        timeZone: payload.zoneinfo,
      });
      return {
        caller: {
          subject: payload.sub,
          scopes:
            claims?.scopes === undefined
              ? parseScopes(payload)
              : projectMappedAuthorizationClaim(payload, claims.scopes, 'scope'),
          roles:
            claims?.roles === undefined
              ? []
              : projectMappedAuthorizationClaim(payload, claims.roles, 'role'),
          audience: projectId,
          ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
          ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
          ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
          ...preferences,
        },
      };
    } catch {
      return null;
    }
  };
}

async function firebaseX509Resolver(
  options: CustomerVerifierFactoryOptions,
): Promise<JWTVerifyGetKey> {
  const certs = await fetchJsonRecord(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    options,
  );
  return async (protectedHeader) => {
    if (typeof protectedHeader.kid !== 'string') {
      throw new Error('Firebase token missing kid');
    }
    const cert = certs[protectedHeader.kid];
    if (typeof cert !== 'string') throw new Error('Firebase public key not found');
    return importX509(cert, 'RS256');
  };
}

async function discoverCustomerVerifier(
  auth: TenantOidcAuthConfig,
  options: CustomerVerifierFactoryOptions,
): Promise<OwnerTokenVerifier> {
  const metadata = await discoverMetadata(auth.issuer, options);
  if (metadata.issuer !== normalizeIssuer(auth.issuer)) {
    throw new Error('customer issuer metadata mismatch');
  }
  const jwksUri = metadata.jwksUri;
  if (jwksUri === undefined) throw new Error('customer issuer metadata missing jwks_uri');
  const jwks = await fetchJwks(jwksUri, options);
  const keyResolver = createLocalJWKSet(jwks);
  const claims = authorizationClaimMap(auth.claims);
  const customerRoutingClaims = customerRoutingClaimMap(auth);
  const verifier = createJwtVerifier({
    issuer: auth.issuer,
    keyResolver,
    trustNoodleRoles: false,
    trustNoodlePrivateClaims: false,
    ...(claims === undefined ? {} : { claims }),
    ...(customerRoutingClaims === undefined ? {} : { customerRoutingClaims }),
  });
  return async (token, resource) => {
    if (resource === undefined || resource.length === 0) return null;
    const verification = await verifier(token, auth.audience);
    if (verification === null) return null;
    // The verifier configuration—not a caller-controlled token claim—establishes this trust class.
    // Strip classification metadata before assigning the customer identity at the verified boundary.
    const {
      identityKind: _identityKind,
      identityProvider: _identityProvider,
      ...verified
    } = verification.caller;
    return {
      caller: { ...verified, audience: resource, identityKind: 'customer' },
      customerIssuer: normalizeIssuer(auth.issuer),
      ...(verification.customerRouting === undefined
        ? {}
        : { customerRouting: verification.customerRouting }),
    };
  };
}

function routingClaimEntries(auth: TenantOidcAuthConfig): readonly (readonly [string, string])[] {
  try {
    const routing = auth.routing as unknown;
    if (!isPlainRecord(routing)) return [];
    const endpoints = routing.endpoints;
    if (!isPlainRecord(endpoints)) return [];
    const entries: Array<readonly [string, string]> = [];
    for (const key of Object.keys(endpoints).sort()) {
      const endpoint = endpoints[key];
      if (
        !isPlainRecord(endpoint) ||
        typeof endpoint.claim !== 'string' ||
        endpoint.claim.length === 0
      ) {
        continue;
      }
      entries.push([key, endpoint.claim]);
    }
    return entries;
  } catch {
    return [];
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function customerRoutingClaimMap(
  auth: TenantOidcAuthConfig,
): Readonly<Record<string, string>> | undefined {
  const entries = routingClaimEntries(auth);
  if (entries.length === 0) return undefined;
  const claims = Object.create(null) as Record<string, string>;
  for (const [key, path] of entries) claims[key] = path;
  return claims;
}

function authorizationClaimMap(
  claims: TenantAuthClaimMap | undefined,
): AuthorizationClaimMap | undefined {
  if (claims === undefined) return undefined;
  return {
    ...(claims.roles === undefined ? {} : { roles: claims.roles }),
    ...(claims.scopes === undefined ? {} : { scopes: claims.scopes }),
  };
}

async function discoverMetadata(
  issuer: string,
  options: CustomerVerifierFactoryOptions,
): Promise<MetadataDoc> {
  return (await discoverIssuerMetadata(issuer, (url) => fetchMetadata(url, options))).metadata;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

function validateFetchUrl(url: string, options: CustomerVerifierFactoryOptions): URL {
  const parsed = new URL(url);
  if (parsed.username !== '' || parsed.password !== '') throw new Error('userinfo is not allowed');
  const hostname = normalizedHostname(parsed);
  const allowedLocalhost = isAllowedLocalhost(parsed, options);
  if (parsed.protocol !== 'https:' && !(allowedLocalhost && parsed.protocol === 'http:')) {
    throw new Error('customer issuer and JWKS URLs must use https');
  }
  if (!allowedLocalhost && !needsGuard(parsed) && !isPublicUnicast(hostname)) {
    throw new Error('customer issuer resolved to a non-public address');
  }
  return parsed;
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function isAllowedLocalhost(url: URL, options: CustomerVerifierFactoryOptions): boolean {
  const hostname = normalizedHostname(url);
  return (
    options.allowInsecureLocalhost === true &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1')
  );
}

function validateJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('customer metadata response must be a JSON object');
  }
  return value as Record<string, unknown>;
}

interface MetadataDoc {
  readonly issuer: string;
  readonly jwksUri?: string;
}

function metadataDoc(value: Record<string, unknown>): MetadataDoc {
  if (
    typeof value.issuer !== 'string' ||
    (value.jwks_uri !== undefined && typeof value.jwks_uri !== 'string')
  ) {
    throw new Error('invalid customer issuer metadata');
  }
  return {
    issuer: normalizeIssuer(value.issuer),
    ...(typeof value.jwks_uri === 'string' ? { jwksUri: value.jwks_uri } : {}),
  };
}

type JwksDoc = JSONWebKeySet;

function jwksDoc(value: Record<string, unknown>): JwksDoc {
  if (!Array.isArray(value.keys)) throw new Error('invalid customer JWKS');
  return { keys: value.keys as JwksDoc['keys'] };
}

function parseScopes(payload: Record<string, unknown>): readonly string[] {
  const raw = payload.scope ?? payload.scp ?? payload.scopes;
  if (typeof raw === 'string') return raw.split(' ').filter((scope) => scope.length > 0);
  if (Array.isArray(raw)) return raw.filter((scope): scope is string => typeof scope === 'string');
  return [];
}

async function fetchMetadata(
  url: string,
  options: CustomerVerifierFactoryOptions,
): Promise<MetadataDoc> {
  return metadataDoc(await fetchJsonRecord(url, options));
}

async function fetchJwks(url: string, options: CustomerVerifierFactoryOptions): Promise<JwksDoc> {
  return jwksDoc(await fetchJsonRecord(url, options));
}

async function fetchJsonRecord(
  url: string,
  options: CustomerVerifierFactoryOptions,
): Promise<Record<string, unknown>> {
  const parsed = validateFetchUrl(url, options);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const init = {
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    } as unknown as RequestInit;
    const res =
      options.fetchImpl === undefined && !isAllowedLocalhost(parsed, options)
        ? await guardedFetch(parsed, init, {
            connectTimeoutMs: options.timeoutMs ?? 5_000,
            ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
          })
        : await (options.fetchImpl ?? fetch)(parsed, init);
    if (res.status !== 200) throw new Error(`customer metadata fetch failed: HTTP ${res.status}`);
    return validateJson(await res.json());
  } finally {
    clearTimeout(timeout);
  }
}
