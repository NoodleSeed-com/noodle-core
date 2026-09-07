import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { SigningKeyProvider } from './signer.js';

export interface AccessTokenClaims {
  /** Token issuer — the Noodle self-hosted authorization server (`NOODLE_OAUTH_ISSUER`). */
  readonly issuer: string;
  /** Subject — the immutable canonical Noodle principal (legacy users retain their Google subject). */
  readonly subject: string;
  /** Audience — the canonical tenant MCP URL the token is bound to (RFC 8707). */
  readonly audience: string;
  /** End-user email, when available. */
  readonly email?: string;
  /** OIDC locale preference, when available. */
  readonly locale?: string;
  /** OIDC zoneinfo/IANA time-zone preference, when available. */
  readonly timeZone?: string;
  /** Space-delimited scopes, when any. */
  readonly scope?: string;
  /** Canonical customer roles verified by a configured bridge claim mapping. */
  readonly roles?: readonly string[];
  /** Verified upstream authentication event time as a JWT NumericDate in integer seconds. */
  readonly authTime?: number;
  /** Boundary represented by the token. Absent means the normal Noodle platform identity boundary. */
  readonly identityKind?: 'platform' | 'customer' | 'service';
  /** Customer bridge provider that verified the upstream identity, when this is a customer token. */
  readonly identityProvider?: string;
  /** Verified upstream customer issuer, kept private from runtime-visible caller claims. */
  readonly customerIssuer?: string;
  /** Opaque server-side Developer Access Grant binding, when this is a developer-plugin token. */
  readonly developerGrantId?: string;
  /** OAuth client that received the access token. */
  readonly oauthClientId?: string;
  /** Private server-side service-principal grant binding. */
  readonly servicePrincipalGrantId?: string;
  /** Private server-side service-principal credential binding. */
  readonly servicePrincipalCredentialId?: string;
}

/**
 * Mint a short-lived RS256 access token for the owner-only data plane (OA-2, [ADR 0042]). This is exactly the
 * token the OA-1 resource-server verifier (`createJwtVerifier`) validates: `iss` = the Noodle AS, `aud` = the
 * canonical tenant MCP URL (RFC 8707 resource binding), `sub` = the canonical Noodle principal. The raw token is opaque to
 * the MCP client; only the resource server reads it, and the raw value dies at the verifier ([ADR 0005]).
 */
export async function mintAccessToken(
  provider: SigningKeyProvider,
  claims: AccessTokenClaims,
  ttlSeconds: number,
): Promise<string> {
  const key = await provider.signingKey();
  const jwt = new SignJWT({
    ...(claims.email !== undefined ? { email: claims.email } : {}),
    ...(claims.locale !== undefined ? { locale: claims.locale } : {}),
    ...(claims.timeZone !== undefined ? { zoneinfo: claims.timeZone } : {}),
    ...(claims.scope !== undefined ? { scope: claims.scope } : {}),
    ...(claims.roles !== undefined ? { noodle_roles: [...claims.roles] } : {}),
    ...(claims.authTime !== undefined ? { auth_time: claims.authTime } : {}),
    ...(claims.identityKind !== undefined ? { noodle_identity: claims.identityKind } : {}),
    ...(claims.identityProvider !== undefined
      ? { noodle_identity_provider: claims.identityProvider }
      : {}),
    ...(claims.customerIssuer !== undefined
      ? { noodle_customer_issuer: claims.customerIssuer }
      : {}),
    ...(claims.developerGrantId !== undefined ? { noodle_grant_id: claims.developerGrantId } : {}),
    ...(claims.oauthClientId !== undefined ? { client_id: claims.oauthClientId } : {}),
    ...(claims.servicePrincipalGrantId !== undefined
      ? { noodle_service_grant_id: claims.servicePrincipalGrantId }
      : {}),
    ...(claims.servicePrincipalCredentialId !== undefined
      ? { noodle_service_credential_id: claims.servicePrincipalCredentialId }
      : {}),
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'at+jwt' })
    .setIssuer(claims.issuer)
    .setSubject(claims.subject)
    .setAudience(claims.audience)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${ttlSeconds}s`);
  return jwt.sign(key.privateKey);
}
