import { projectMappedAuthorizationClaim, type VerifiedIdentity } from '@noodle-borg/auth';
import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';
import type { TenantBridgeAuthConfig } from '../store.js';
import { microsoftIssuer, microsoftScopes, microsoftTokenUrl } from './customer-bridge.js';
import { canonicalOAuthIdentityPreferences } from './identity-preferences.js';

export interface ConfiguredMicrosoftBridge extends TenantBridgeAuthConfig {
  readonly provider: 'microsoft';
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MicrosoftAuthorizationCodeTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
}

export function isConfiguredMicrosoftBridge(
  auth: TenantBridgeAuthConfig | undefined,
): auth is ConfiguredMicrosoftBridge {
  return (
    auth?.provider === 'microsoft' &&
    typeof auth.tenantId === 'string' &&
    auth.tenantId.length > 0 &&
    typeof auth.clientId === 'string' &&
    auth.clientId.length > 0 &&
    typeof auth.clientSecret === 'string' &&
    auth.clientSecret.length > 0
  );
}

export async function exchangeMicrosoftAuthorizationCode(input: {
  readonly auth: ConfiguredMicrosoftBridge;
  readonly code: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetchImpl: typeof fetch;
}): Promise<MicrosoftAuthorizationCodeTokens> {
  const tokenUrl = microsoftTokenUrl(input.auth);
  if (tokenUrl === undefined) throw new Error('Microsoft token endpoint is not configured');
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', input.code);
  params.set('redirect_uri', input.redirectUri);
  params.set('scope', microsoftScopes(input.auth).join(' '));
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'noodle-borg/0.0',
  };
  if ((input.auth.authMethod ?? 'client_secret_post') === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(
      `${input.auth.clientId}:${input.clientSecret}`,
    ).toString('base64')}`;
  } else {
    params.set('client_id', input.auth.clientId);
    params.set('client_secret', input.clientSecret);
  }

  const response = await input.fetchImpl(tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Microsoft authorization failed with status ${response.status}`);
  }
  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
  };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('Microsoft authorization response did not include access_token');
  }
  if (typeof json.refresh_token !== 'string' || json.refresh_token.length === 0) {
    throw new Error('Microsoft authorization response did not include refresh_token');
  }
  if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
    throw new Error('Microsoft authorization response did not include id_token');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
  };
}

export async function verifyMicrosoftIdToken(input: {
  readonly auth: ConfiguredMicrosoftBridge;
  readonly idToken: string;
  readonly fetchImpl: typeof fetch;
}): Promise<VerifiedIdentity | null> {
  try {
    const verifier = await createMicrosoftIdTokenVerifier({
      auth: input.auth,
      fetchImpl: input.fetchImpl,
    });
    return verifier(input.idToken);
  } catch {
    return null;
  }
}

/** Build one cached-key verifier for both hosted bridge exchange and loopback Devtools requests. */
export async function createMicrosoftIdTokenVerifier(input: {
  readonly auth: ConfiguredMicrosoftBridge;
  readonly fetchImpl: typeof fetch;
}): Promise<(idToken: string) => Promise<VerifiedIdentity | null>> {
  const issuer = microsoftIssuer(input.auth);
  if (issuer === undefined) return async () => null;
  const metadata = await fetchMicrosoftMetadata(
    `${issuer}/.well-known/openid-configuration`,
    input.fetchImpl,
  );
  if (metadata.issuer !== issuer)
    throw new Error('Microsoft metadata issuer does not match tenant');
  const jwks = await fetchMicrosoftJwks(metadata.jwksUri, input.fetchImpl);
  const keyResolver = createLocalJWKSet(jwks);
  return async (idToken) => {
    try {
      const { payload } = await jwtVerify(idToken, keyResolver, {
        issuer: metadata.issuer,
        audience: input.auth.clientId,
      });
      const subject =
        typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined;
      if (subject === undefined) return null;
      const email = firstStringClaim(payload, ['email', 'preferred_username']);
      const name = firstStringClaim(payload, ['name']);
      const preferences = canonicalOAuthIdentityPreferences({
        locale: payload.locale,
        timeZone: payload.zoneinfo,
      });
      return {
        subject,
        scopes:
          input.auth.user?.scopes === undefined
            ? []
            : projectMappedAuthorizationClaim(payload, input.auth.user.scopes, 'scope'),
        roles:
          input.auth.user?.roles === undefined
            ? []
            : projectMappedAuthorizationClaim(payload, input.auth.user.roles, 'role'),
        ...(email !== undefined ? { email } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
        ...preferences,
      };
    } catch {
      return null;
    }
  };
}

async function fetchMicrosoftMetadata(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ readonly issuer: string; readonly jwksUri: string }> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'noodle-borg/0.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Microsoft metadata failed with status ${response.status}`);
  const json = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (typeof json.issuer !== 'string' || typeof json.jwks_uri !== 'string') {
    throw new Error('Microsoft metadata response is missing issuer or jwks_uri');
  }
  return { issuer: json.issuer, jwksUri: json.jwks_uri };
}

async function fetchMicrosoftJwks(url: string, fetchImpl: typeof fetch): Promise<JSONWebKeySet> {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'noodle-borg/0.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Microsoft JWKS failed with status ${response.status}`);
  const json = (await response.json()) as JSONWebKeySet;
  if (!Array.isArray(json.keys)) throw new Error('Microsoft JWKS response is missing keys');
  return json;
}

function firstStringClaim(payload: JWTPayload, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
