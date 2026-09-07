import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { mintAccessToken, type SigningKeyProvider } from '@noodle-borg/auth';
import type { Response } from 'express';
import { redirectAuthorizationResponse } from './authorization-response.js';
import { publicOAuthScope } from './fresh-auth.js';
import {
  canonicalOAuthIdentityPreferences,
  storedOAuthOwnerPreferences,
} from './identity-preferences.js';
import type { OAuthStore } from './store.js';
import { hashToken, randomToken } from './tokens.js';

interface OAuthAccessTokenIdentity {
  readonly ownerSubject: string;
  readonly resource: string;
  readonly ownerEmail?: string;
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
  readonly scope?: string;
  readonly roles?: readonly string[];
  readonly authTime?: number;
  /** Verified upstream customer assertion expiry, used to clamp every derived credential. */
  readonly upstreamExpiresAt?: number;
  readonly identityKind?: 'platform' | 'customer' | 'service';
  readonly identityProvider?: string;
  readonly customerIssuer?: string;
  readonly developerGrantId?: string;
  readonly oauthClientId?: string;
  readonly servicePrincipalGrantId?: string;
  readonly servicePrincipalCredentialId?: string;
}

interface OAuthTokenIdentity
  extends Omit<
    OAuthAccessTokenIdentity,
    'identityKind' | 'servicePrincipalGrantId' | 'servicePrincipalCredentialId'
  > {
  readonly identityKind?: 'platform' | 'customer';
}

export interface OAuthAuthorizationCodeGrant extends OAuthTokenIdentity {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly clientState?: string;
}

export interface OAuthInitialTokenGrant extends OAuthTokenIdentity {
  readonly clientId: string;
}

export class OAuthTokenIssuer {
  readonly #store: OAuthStore;
  readonly #signer: SigningKeyProvider;
  readonly #issuer: string;
  readonly #accessTtl: number;
  readonly #refreshTtl: number;
  readonly #codeTtl: number;
  readonly #nowSeconds: () => number;

  constructor(input: {
    readonly store: OAuthStore;
    readonly signer: SigningKeyProvider;
    readonly issuer: string;
    readonly accessTtl: number;
    readonly refreshTtl: number;
    readonly codeTtl: number;
    readonly nowSeconds: () => number;
  }) {
    this.#store = input.store;
    this.#signer = input.signer;
    this.#issuer = input.issuer;
    this.#accessTtl = input.accessTtl;
    this.#refreshTtl = input.refreshTtl;
    this.#codeTtl = input.codeTtl;
    this.#nowSeconds = input.nowSeconds;
  }

  async issueAuthorizationCode(res: Response, grant: OAuthAuthorizationCodeGrant): Promise<void> {
    const rawCode = randomToken();
    const nowSeconds = this.#nowSeconds();
    const codeTtl = effectiveCredentialTtl(nowSeconds, this.#codeTtl, grant.upstreamExpiresAt);
    const scope = publicOAuthScope(grant.scope);
    const preferences = storedOAuthOwnerPreferences({
      locale: grant.ownerLocale,
      timeZone: grant.ownerTimeZone,
    });
    await this.#store.createAuthorizationCode({
      code: hashToken(rawCode),
      clientId: grant.clientId,
      codeChallenge: grant.codeChallenge,
      redirectUri: grant.redirectUri,
      resource: grant.resource,
      ownerSubject: grant.ownerSubject,
      ...(grant.ownerEmail !== undefined ? { ownerEmail: grant.ownerEmail } : {}),
      ...preferences,
      ...(scope !== undefined ? { scope } : {}),
      ...(grant.roles !== undefined ? { roles: [...grant.roles] } : {}),
      ...(grant.authTime !== undefined ? { authTime: grant.authTime } : {}),
      ...(grant.upstreamExpiresAt !== undefined
        ? { upstreamExpiresAt: grant.upstreamExpiresAt }
        : {}),
      ...(grant.identityKind !== undefined ? { identityKind: grant.identityKind } : {}),
      ...(grant.identityProvider !== undefined ? { identityProvider: grant.identityProvider } : {}),
      ...(grant.customerIssuer !== undefined ? { customerIssuer: grant.customerIssuer } : {}),
      ...(grant.developerGrantId !== undefined ? { developerGrantId: grant.developerGrantId } : {}),
      expiresAt: nowSeconds + codeTtl,
    });
    const redirect = new URL(grant.redirectUri);
    redirect.searchParams.set('code', rawCode);
    if (grant.clientState !== undefined) redirect.searchParams.set('state', grant.clientState);
    redirectAuthorizationResponse(res, redirect, this.#issuer);
  }

  async issueTokens(input: OAuthInitialTokenGrant): Promise<OAuthTokens> {
    const nowSeconds = this.#nowSeconds();
    const accessTtl = effectiveCredentialTtl(nowSeconds, this.#accessTtl, input.upstreamExpiresAt);
    const refreshTtl = effectiveCredentialTtl(
      nowSeconds,
      this.#refreshTtl,
      input.upstreamExpiresAt,
    );
    const scope = publicOAuthScope(input.scope);
    const preferences = storedOAuthOwnerPreferences({
      locale: input.ownerLocale,
      timeZone: input.ownerTimeZone,
    });
    const identity: OAuthTokenIdentity = {
      ownerSubject: input.ownerSubject,
      resource: input.resource,
      ...(input.ownerEmail !== undefined ? { ownerEmail: input.ownerEmail } : {}),
      ...preferences,
      ...(scope !== undefined ? { scope } : {}),
      ...(input.roles !== undefined ? { roles: [...input.roles] } : {}),
      ...(input.authTime !== undefined ? { authTime: input.authTime } : {}),
      ...(input.upstreamExpiresAt !== undefined
        ? { upstreamExpiresAt: input.upstreamExpiresAt }
        : {}),
      ...(input.identityKind !== undefined ? { identityKind: input.identityKind } : {}),
      ...(input.identityProvider !== undefined ? { identityProvider: input.identityProvider } : {}),
      ...(input.customerIssuer !== undefined ? { customerIssuer: input.customerIssuer } : {}),
      ...(input.developerGrantId !== undefined ? { developerGrantId: input.developerGrantId } : {}),
      oauthClientId: input.clientId,
    };
    const access_token = await mintOAuthAccessToken({
      signer: this.#signer,
      issuer: this.#issuer,
      ttlSeconds: accessTtl,
      identity,
    });
    const rawRefresh = randomToken();
    await this.#store.createRefreshToken({
      token: hashToken(rawRefresh),
      clientId: input.clientId,
      ownerSubject: input.ownerSubject,
      resource: input.resource,
      ...(input.ownerEmail !== undefined ? { ownerEmail: input.ownerEmail } : {}),
      ...preferences,
      ...(scope !== undefined ? { scope } : {}),
      ...(input.roles !== undefined ? { roles: [...input.roles] } : {}),
      ...(input.authTime !== undefined ? { authTime: input.authTime } : {}),
      ...(input.upstreamExpiresAt !== undefined
        ? { upstreamExpiresAt: input.upstreamExpiresAt }
        : {}),
      ...(input.identityKind !== undefined ? { identityKind: input.identityKind } : {}),
      ...(input.identityProvider !== undefined ? { identityProvider: input.identityProvider } : {}),
      ...(input.customerIssuer !== undefined ? { customerIssuer: input.customerIssuer } : {}),
      ...(input.developerGrantId !== undefined ? { developerGrantId: input.developerGrantId } : {}),
      expiresAt: nowSeconds + refreshTtl,
      familyId: randomToken(),
    });
    return {
      access_token,
      token_type: 'bearer',
      expires_in: accessTtl,
      refresh_token: rawRefresh,
      ...(scope !== undefined ? { scope } : {}),
    };
  }
}

/** Mint one audience-bound access token after independently canonicalizing optional preferences. */
export function mintOAuthAccessToken(input: {
  readonly signer: SigningKeyProvider;
  readonly issuer: string;
  readonly ttlSeconds: number;
  readonly identity: OAuthAccessTokenIdentity;
}): Promise<string> {
  const identity = input.identity;
  const scope = publicOAuthScope(identity.scope);
  const preferences = canonicalOAuthIdentityPreferences({
    locale: identity.ownerLocale,
    timeZone: identity.ownerTimeZone,
  });
  return mintAccessToken(
    input.signer,
    {
      issuer: input.issuer,
      subject: identity.ownerSubject,
      audience: identity.resource,
      ...(identity.ownerEmail !== undefined ? { email: identity.ownerEmail } : {}),
      ...preferences,
      ...(scope !== undefined ? { scope } : {}),
      ...(identity.roles !== undefined ? { roles: identity.roles } : {}),
      ...(identity.authTime !== undefined ? { authTime: identity.authTime } : {}),
      ...(identity.identityKind !== undefined ? { identityKind: identity.identityKind } : {}),
      ...(identity.identityProvider !== undefined
        ? { identityProvider: identity.identityProvider }
        : {}),
      ...(identity.customerIssuer !== undefined ? { customerIssuer: identity.customerIssuer } : {}),
      ...(identity.developerGrantId !== undefined
        ? { developerGrantId: identity.developerGrantId }
        : {}),
      ...(identity.oauthClientId !== undefined ? { oauthClientId: identity.oauthClientId } : {}),
      ...(identity.servicePrincipalGrantId !== undefined
        ? { servicePrincipalGrantId: identity.servicePrincipalGrantId }
        : {}),
      ...(identity.servicePrincipalCredentialId !== undefined
        ? { servicePrincipalCredentialId: identity.servicePrincipalCredentialId }
        : {}),
    },
    input.ttlSeconds,
  );
}

export function effectiveCredentialTtl(
  nowSeconds: number,
  configuredTtl: number,
  upstreamExpiresAt: number | undefined,
): number {
  if (upstreamExpiresAt === undefined) return configuredTtl;
  const remaining = upstreamExpiresAt - nowSeconds;
  if (remaining <= 0) throw new Error('verified upstream identity has expired');
  return Math.min(configuredTtl, remaining);
}
