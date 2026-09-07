import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  type AuthorizationClaimMap,
  projectCustomerRoutingClaims,
  projectMappedAuthorizationClaim,
  projectNoodleRoles,
  projectStandardScopes,
} from './claims.js';

/**
 * A verified end-user identity, derived from a validated access token. This is **claims only** — the raw
 * bearer token dies at the verifier and never crosses into execution (ADR 0005 / 0018). It is the minimum
 * the data plane needs to make an owner-only authorization decision.
 */
export interface VerifiedIdentity {
  /** Stable canonical Noodle principal (legacy users retain their upstream Google subject). */
  readonly subject: string;
  /** OAuth scopes carried by the token (empty when none). */
  readonly scopes: readonly string[];
  /** Trusted application roles carried by an explicitly mapped or Noodle-owned private claim. */
  readonly roles: readonly string[];
  /** The token's audience (RFC 8707 resource binding), when present. */
  readonly audience?: string;
  /** The end-user email, when the token carries one. */
  readonly email?: string;
  /** The end-user display name, when the token carries one. */
  readonly name?: string;
  /** OIDC `locale` preference, when the verified token carries one. */
  readonly locale?: string;
  /** OIDC `zoneinfo` IANA time-zone preference, when the verified token carries one. */
  readonly timeZone?: string;
  /** Expiry in seconds since the epoch, when present. */
  readonly expiresAt?: number;
  /** Verified upstream authentication event time as a JWT NumericDate in integer seconds. */
  readonly authTime?: number;
  /**
   * Boundary represented by the caller. Absent means the normal Noodle platform identity boundary.
   * `anonymous` is server-minted only (a public website assistant visitor); the verifier below never
   * projects it from a token, so no bearer can claim it.
   */
  readonly identityKind?: 'platform' | 'customer' | 'service' | 'anonymous';
  /** Customer bridge provider that verified the upstream identity, when this is a customer token. */
  readonly identityProvider?: string;
  /** Opaque server-side Developer Access Grant binding, when present. */
  readonly developerGrantId?: string;
  /** OAuth client that received the token, when present. */
  readonly oauthClientId?: string;
}

export interface JwtVerifierConfig {
  /** Expected token issuer — the Noodle self-hosted authorization server (OA-2). */
  readonly issuer: string;
  /** JWKS endpoint of the issuer (signature keys). Required unless {@link keyResolver} is supplied. */
  readonly jwksUri?: string;
  /**
   * A pre-resolved JWK key resolver, used instead of fetching {@link jwksUri}. This is the seam tests and
   * a future static/KMS signer use to validate without a live JWKS endpoint.
   */
  readonly keyResolver?: JWTVerifyGetKey;
  /** Explicit customer-IdP claim paths. Generic role claims are never trusted without this mapping. */
  readonly claims?: AuthorizationClaimMap;
  /** Trust Noodle's private role claim. Disable for tokens signed by an external customer issuer. */
  readonly trustNoodleRoles?: boolean;
  /** Trust Noodle's private envelope-only claims. Disable for external customer issuers. */
  readonly trustNoodlePrivateClaims?: boolean;
  /** Additional audiences every verified token must carry alongside the call-time MCP resource. */
  readonly requiredAudiences?: readonly string[];
  /** Private customer connector route claim paths keyed by the compiled endpoint name. */
  readonly customerRoutingClaims?: Readonly<Record<string, string>>;
}

/** Private service-principal lifecycle binding, never projected onto the public caller. */
export interface VerifiedServicePrincipalBinding {
  readonly grantId: string;
  readonly credentialId: string;
}

/** Verified public caller data plus private, request-local authorization bindings. */
export interface VerifiedTokenEnvelope {
  readonly caller: VerifiedIdentity;
  /** Verified machine grant and credential bindings, kept outside runtime-visible caller claims. */
  readonly servicePrincipal?: VerifiedServicePrincipalBinding;
  /** Verified customer IdP issuer, kept outside the public caller/expression scope. */
  readonly customerIssuer?: string;
  readonly customerRouting?: Readonly<Record<string, string>>;
}

/**
 * Verify an access token and return its identity, or `null` if the token is missing/invalid/expired. When a
 * `resource` is supplied, the token's `aud` MUST contain it (RFC 8707 resource binding) — this is how the data
 * plane binds a token to the specific tenant MCP endpoint it was issued for.
 */
export type TokenVerifier = (
  token: string,
  resource?: string,
) => Promise<VerifiedTokenEnvelope | null>;

/**
 * Build a {@link TokenVerifier} backed by `jose` (ADR 0023). Validates the signature (via JWKS or an injected
 * resolver), the issuer, expiry, and — when a `resource` is given at call time — the audience. Any failure
 * resolves to `null`; the verifier never throws, so a bad token is a clean `401`, not a `500`.
 */
export function createJwtVerifier(config: JwtVerifierConfig): TokenVerifier {
  const getKey: JWTVerifyGetKey =
    config.keyResolver ?? createRemoteJWKSet(new URL(requireJwksUri(config)));
  return async (token, resource) => {
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: config.issuer,
        ...(resource === undefined ? {} : { audience: resource }),
      });
      if (!includesEveryAudience(payload.aud, config.requiredAudiences ?? [])) return null;
      const caller = toIdentity(
        payload,
        config.claims,
        config.trustNoodleRoles !== false,
        resource,
      );
      if (caller === null) return null;
      const servicePrincipal = projectServicePrincipalBinding(payload, caller);
      if (servicePrincipal === null) return null;
      const customerIssuer = projectCustomerIssuer(
        payload,
        caller,
        config.trustNoodlePrivateClaims !== false,
      );
      if (customerIssuer === null) return null;
      const customerRouting = projectCustomerRoutingClaims(payload, config.customerRoutingClaims);
      return {
        caller,
        ...(servicePrincipal === undefined ? {} : { servicePrincipal }),
        ...(customerIssuer === undefined ? {} : { customerIssuer }),
        ...(customerRouting === undefined ? {} : { customerRouting }),
      };
    } catch {
      return null;
    }
  };
}

function includesEveryAudience(
  audience: string | readonly string[] | undefined,
  required: readonly string[],
): boolean {
  if (required.length === 0) return true;
  const actual = typeof audience === 'string' ? [audience] : audience;
  return actual !== undefined && required.every((value) => actual.includes(value));
}

function requireJwksUri(config: JwtVerifierConfig): string {
  if (config.jwksUri === undefined || config.jwksUri === '') {
    throw new Error('createJwtVerifier requires either a jwksUri or a keyResolver');
  }
  return config.jwksUri;
}

function toIdentity(
  payload: JWTPayload,
  claims: AuthorizationClaimMap | undefined,
  trustNoodleRoles: boolean,
  resource: string | undefined,
): VerifiedIdentity | null {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
  const locale = canonicalLocale(payload.locale);
  const timeZone = canonicalTimeZone(payload.zoneinfo);
  const developerGrantId = boundedClaim(payload.noodle_grant_id);
  const oauthClientId = boundedClaim(payload.client_id);
  const authTime = validatedAuthenticationTime(payload.auth_time);
  if (authTime === null) return null;
  return {
    subject: payload.sub,
    scopes:
      claims?.scopes === undefined
        ? projectStandardScopes(payload)
        : projectMappedAuthorizationClaim(payload, claims.scopes, 'scope'),
    roles:
      claims?.roles !== undefined
        ? projectMappedAuthorizationClaim(payload, claims.roles, 'role')
        : trustNoodleRoles
          ? projectNoodleRoles(payload)
          : [],
    ...(resource !== undefined
      ? { audience: resource }
      : typeof aud === 'string'
        ? { audience: aud }
        : {}),
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
    ...(locale !== undefined ? { locale } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
    ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
    ...(authTime !== undefined ? { authTime } : {}),
    ...(payload.noodle_identity === 'platform' ||
    payload.noodle_identity === 'customer' ||
    payload.noodle_identity === 'service'
      ? { identityKind: payload.noodle_identity }
      : {}),
    ...(typeof payload.noodle_identity_provider === 'string'
      ? { identityProvider: payload.noodle_identity_provider }
      : {}),
    ...(developerGrantId !== undefined ? { developerGrantId } : {}),
    ...(oauthClientId !== undefined ? { oauthClientId } : {}),
  };
}

function projectServicePrincipalBinding(
  payload: JWTPayload,
  caller: VerifiedIdentity,
): VerifiedServicePrincipalBinding | null | undefined {
  const hasGrantBinding = payload.noodle_service_grant_id !== undefined;
  const hasCredentialBinding = payload.noodle_service_credential_id !== undefined;
  if (caller.identityKind !== 'service') {
    return hasGrantBinding || hasCredentialBinding ? null : undefined;
  }

  const grantId = boundedClaim(payload.noodle_service_grant_id);
  const credentialId = boundedClaim(payload.noodle_service_credential_id);
  if (
    grantId === undefined ||
    credentialId === undefined ||
    typeof payload.client_id !== 'string' ||
    payload.client_id !== payload.sub ||
    caller.oauthClientId !== payload.sub ||
    caller.roles.length !== 0
  ) {
    return null;
  }
  return { grantId, credentialId };
}

function projectCustomerIssuer(
  payload: JWTPayload,
  caller: VerifiedIdentity,
  trustNoodlePrivateClaims: boolean,
): string | null | undefined {
  if (!trustNoodlePrivateClaims) return undefined;
  if (payload.noodle_customer_issuer === undefined) return undefined;
  if (caller.identityKind !== 'customer') return null;
  return canonicalHttpsIssuer(payload.noodle_customer_issuer) ?? null;
}

function canonicalHttpsIssuer(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 2_048) return undefined;
  try {
    const issuer = new URL(raw);
    if (
      issuer.protocol !== 'https:' ||
      issuer.username !== '' ||
      issuer.password !== '' ||
      issuer.search !== '' ||
      issuer.hash !== ''
    ) {
      return undefined;
    }
    const pathname = issuer.pathname.replace(/\/+$/, '');
    return `${issuer.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

function validatedAuthenticationTime(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Math.floor(Date.now() / 1_000)
  ) {
    return null;
  }
  return value;
}

function boundedClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 200 ? normalized : undefined;
}

function canonicalLocale(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 160) return undefined;
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    return undefined;
  }
}

function canonicalTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 160) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: value.trim(),
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
