import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  createJwtVerifier,
  type SigningKeyProvider,
  type TokenVerifier,
  type VerifiedIdentity,
} from '@noodle-borg/auth';
import type { ControlPlaneSignupMode, SignupAuthorizer } from '@noodle-borg/control-plane/portable';
import type { PlatformPrincipalResolver, UpstreamHumanRolloutStore } from '@noodle-borg/module';
import { type Logger, noopLogger } from '@noodle-borg/transport-http';
import type { Request, Response } from 'express';
import type { SecretEnvelope, TenantBridgeAuthConfig } from '../store.js';
import { initiateAuthorization } from './authorization-initiation.js';
import { handleConsentDecision } from './consent-decision.js';
import { signConsentToken } from './consent-token.js';
import {
  bridgeCustomerIssuer,
  customerBridgeAuthorizeFields,
  customerBridgeCallbackFields,
  microsoftCallbackUrl,
  renderFirebaseAuthorizePage,
} from './customer-bridge.js';
import type { DeveloperGrantAuthorizer } from './developer-grant-authorizer.js';
import { DeveloperGrantOAuthFlow } from './developer-grant-flow.js';
import { DeviceAuthorizationFlow } from './device-flow.js';
import { completeDeviceAuthorization, issueDeviceTokens } from './device-provider.js';
import type { DeviceAuthorizationRecord, DeviceBrowserSessionRecord } from './device-store.js';
import { publicOAuthScope } from './fresh-auth.js';
import type { GoogleAuthenticator } from './google.js';
import {
  storedOAuthOwnerPreferences,
  verifiedIdentityOwnerPreferences,
} from './identity-preferences.js';
import { noodleOAuthMetadata } from './metadata.js';
import {
  exchangeMicrosoftAuthorizationCode,
  isConfiguredMicrosoftBridge,
  type MicrosoftAuthorizationCodeTokens,
  verifyMicrosoftIdToken,
} from './microsoft.js';
import { assertPlatformRefreshPrincipal } from './principal-status.js';
import {
  defaultResourceFromClient,
  normalizeResource,
  resourcePath,
  trimTrailingSlash,
} from './provider-util.js';
import {
  type IssueServicePrincipalAccessTokenInput,
  issueServicePrincipalAccessToken,
} from './service-principal-token-issuer.js';
import type { OAuthStore, PendingAuthorizationCallbackKind } from './store.js';
import { effectiveCredentialTtl, mintOAuthAccessToken, OAuthTokenIssuer } from './token-issuer.js';
import { hashToken, randomToken } from './tokens.js';
import { handleUpstreamHumanCallback } from './upstream-callback-handler.js';
import { redirectPendingAuthorizationError } from './upstream-callback-support.js';
import type {
  UpstreamHumanOAuthAuthenticator,
  UpstreamHumanProvider,
  UpstreamHumanRollout,
} from './upstream-human.js';
import { continueUpstreamProviderChoice } from './upstream-provider-choice.js';
import { handleUpstreamSessionLogout } from './upstream-session-logout.js';

const ONE_HOUR = 3600;
const THIRTY_DAYS = 30 * 24 * 3600;
const TEN_MINUTES = 600;
const FIVE_MINUTES = 300;
const REFRESH_GRACE = 30;
const REFRESH_RECOVERY = 300;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function grantedCustomerScope(
  requestedScope: string | undefined,
  identityScopes: readonly string[],
): string | null | undefined {
  const requested = publicOAuthScope(requestedScope);
  if (requested === undefined) return undefined;
  const requestedScopes = [...new Set(requested.split(' ').filter(Boolean))];
  const verifiedScopes = new Set(identityScopes);
  const grantedScopes = requestedScopes.filter((scope) => verifiedScopes.has(scope));
  return grantedScopes.length === requestedScopes.length ? grantedScopes.join(' ') : null;
}

export interface NoodleOAuthProviderConfig {
  readonly issuer: string;
  readonly store: OAuthStore;
  readonly signer: SigningKeyProvider;
  readonly google?: GoogleAuthenticator;
  readonly upstreamAuthenticators?: Readonly<{ readonly workos?: UpstreamHumanOAuthAuthenticator }>;
  readonly upstreamRollout?: UpstreamHumanRollout;
  readonly upstreamRolloutStore?: UpstreamHumanRolloutStore;
  readonly workosLogoutReturnTo?: string;
  readonly platformPrincipalResolver?: PlatformPrincipalResolver;
  readonly allowedEmailDomain?: string;
  readonly signupMode?: ControlPlaneSignupMode;
  readonly signupHintClientIds?: readonly string[] | undefined;
  readonly signupAuthorizer?: SignupAuthorizer;
  readonly deniedSignupDomains?: readonly string[];
  readonly deniedSignupSubjects?: readonly string[];
  /** Idempotently establishes platform-owned account state before any Noodle credential is issued. */
  readonly provisionPlatformPrincipal?: NoodlePlatformPrincipalProvisioner;
  readonly developerGrantAuthorizer?: DeveloperGrantAuthorizer;
  readonly defaultResourceForClient?: (client: OAuthClientInformationFull) => string | undefined;
  readonly customerBridgeAuthForResource?: (
    resource: string,
  ) => Promise<TenantBridgeAuthConfig | undefined>;
  readonly verifyCustomerBridgeToken?: (
    auth: TenantBridgeAuthConfig,
    token: string,
  ) => Promise<VerifiedIdentity | null>;
  readonly managedSecretForResource?: (
    resource: string,
    name: string,
  ) => Promise<string | undefined>;
  readonly sealCustomerCredential?: (credential: string) => Promise<SecretEnvelope>;
  readonly fetchImpl?: typeof fetch;
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  readonly refreshTokenGraceSeconds?: number;
  readonly refreshTokenRecoverySeconds?: number;
  readonly authCodeTtlSeconds?: number;
  readonly pendingTtlSeconds?: number;
  readonly consentTtlSeconds?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly oauthClientCredentialsReady?: boolean;
  /** Advertise RFC 8693 only when the control-plane exchange (ADR 0218) is configured. */
  readonly tokenExchangeReady?: boolean;
}

export class NoodleOAuthProvider implements OAuthServerProvider {
  readonly #config: NoodleOAuthProviderConfig;
  readonly #accessTtl: number;
  readonly #refreshTtl: number;
  readonly #refreshGraceTtl: number;
  readonly #refreshRecoveryTtl: number;
  readonly #codeTtl: number;
  readonly #pendingTtl: number;
  readonly #consentTtl: number;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #tokenIssuer: OAuthTokenIssuer;
  readonly #deviceFlow: DeviceAuthorizationFlow;
  readonly #developerGrantFlow: DeveloperGrantOAuthFlow | undefined;
  #verifier: TokenVerifier | undefined;

  constructor(config: NoodleOAuthProviderConfig) {
    this.#config = config;
    this.#accessTtl = config.accessTokenTtlSeconds ?? ONE_HOUR;
    this.#refreshTtl = config.refreshTokenTtlSeconds ?? THIRTY_DAYS;
    this.#refreshGraceTtl = config.refreshTokenGraceSeconds ?? REFRESH_GRACE;
    this.#refreshRecoveryTtl = config.refreshTokenRecoverySeconds ?? REFRESH_RECOVERY;
    this.#codeTtl = config.authCodeTtlSeconds ?? TEN_MINUTES;
    this.#pendingTtl = config.pendingTtlSeconds ?? TEN_MINUTES;
    this.#consentTtl = config.consentTtlSeconds ?? FIVE_MINUTES;
    this.#logger = config.logger ?? noopLogger;
    this.#now = config.now ?? (() => Date.now());
    this.#tokenIssuer = new OAuthTokenIssuer({
      store: config.store,
      signer: config.signer,
      issuer: config.issuer,
      accessTtl: this.#accessTtl,
      refreshTtl: this.#refreshTtl,
      codeTtl: this.#codeTtl,
      nowSeconds: () => this.#nowSeconds(),
    });
    this.#deviceFlow = new DeviceAuthorizationFlow({
      issuer: config.issuer,
      store: config.store,
      provider: this,
      now: () => this.#nowSeconds(),
    });
    this.#developerGrantFlow =
      config.developerGrantAuthorizer === undefined
        ? undefined
        : new DeveloperGrantOAuthFlow({
            issuer: config.issuer,
            signer: config.signer,
            store: config.store,
            authorizer: config.developerGrantAuthorizer,
            tokenIssuer: this.#tokenIssuer,
            tokenTtlSeconds: this.#consentTtl,
          });
  }
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.#config.store.getClient(clientId),
      registerClient: (client) =>
        this.#config.store.putClient(
          this.#withDefaultResource(client as OAuthClientInformationFull),
        ),
    };
  }
  get deviceAuthorizationFlow(): DeviceAuthorizationFlow {
    return this.#deviceFlow;
  }
  get issuer(): string {
    return trimTrailingSlash(this.#config.issuer);
  }
  nowSeconds(): number {
    return this.#nowSeconds();
  }
  issueServicePrincipalAccessToken(input: IssueServicePrincipalAccessTokenInput): Promise<string> {
    return issueServicePrincipalAccessToken(this.#config.signer, this.issuer, input);
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    await initiateAuthorization({
      client,
      params,
      res,
      issuer: this.#config.issuer,
      store: this.#config.store,
      ...(this.#config.google === undefined ? {} : { google: this.#config.google }),
      ...(this.#config.upstreamAuthenticators?.workos === undefined
        ? {}
        : { workos: this.#config.upstreamAuthenticators.workos }),
      ...(this.#config.upstreamRollout === undefined
        ? {}
        : { rollout: this.#config.upstreamRollout }),
      ...(this.#config.upstreamRolloutStore === undefined
        ? {}
        : { rolloutStore: this.#config.upstreamRolloutStore }),
      ...(this.#config.customerBridgeAuthForResource === undefined
        ? {}
        : { customerBridgeAuthForResource: this.#config.customerBridgeAuthForResource }),
      ...(this.#config.defaultResourceForClient === undefined
        ? {}
        : { defaultResourceForClient: this.#config.defaultResourceForClient }),
      signupHintClientIds: this.#config.signupHintClientIds,
      pendingTtlSeconds: this.#pendingTtl,
      nowSeconds: this.#nowSeconds(),
    });
  }
  #withDefaultResource(client: OAuthClientInformationFull): OAuthClientInformationFull {
    const defaultResource = this.#config.defaultResourceForClient?.(client);
    if (defaultResource === undefined) return client;
    return { ...client, default_resource: defaultResource } as OAuthClientInformationFull;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = await this.#config.store.getAuthorizationCode(hashToken(authorizationCode));
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    return record.codeChallenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const resolvedResource =
      resource?.href ??
      defaultResourceFromClient(client) ??
      normalizeResource(this.#config.defaultResourceForClient?.(client));
    if (resolvedResource === undefined) {
      throw new InvalidRequestError('the resource parameter is required');
    }
    const record = await this.#config.store.redeemAuthorizationCode(hashToken(authorizationCode));
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('invalid authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resolvedResource !== record.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }
    return this.#tokenIssuer.issueTokens({
      clientId: client.client_id,
      ownerSubject: record.ownerSubject,
      resource: record.resource,
      ...(record.ownerEmail !== undefined ? { ownerEmail: record.ownerEmail } : {}),
      ...storedOAuthOwnerPreferences({
        locale: record.ownerLocale,
        timeZone: record.ownerTimeZone,
      }),
      ...(record.scope !== undefined ? { scope: record.scope } : {}),
      ...(record.roles !== undefined ? { roles: record.roles } : {}),
      ...(record.authTime !== undefined ? { authTime: record.authTime } : {}),
      ...(record.upstreamExpiresAt !== undefined
        ? { upstreamExpiresAt: record.upstreamExpiresAt }
        : {}),
      ...(record.identityKind !== undefined ? { identityKind: record.identityKind } : {}),
      ...(record.identityProvider !== undefined
        ? { identityProvider: record.identityProvider }
        : {}),
      ...(record.customerIssuer !== undefined ? { customerIssuer: record.customerIssuer } : {}),
      ...(record.developerGrantId !== undefined
        ? { developerGrantId: record.developerGrantId }
        : {}),
    });
  }
  async completeDeviceAuthorization(
    session: DeviceBrowserSessionRecord,
    authorizationCode: string,
  ): Promise<boolean> {
    return completeDeviceAuthorization({
      store: this.#config.store,
      issuer: this.#config.issuer,
      session,
      authorizationCode,
    });
  }
  issueDeviceTokens(record: DeviceAuthorizationRecord): Promise<OAuthTokens> {
    return issueDeviceTokens({ tokenIssuer: this.#tokenIssuer, record });
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const resolvedResource =
      resource?.href ??
      defaultResourceFromClient(client) ??
      normalizeResource(this.#config.defaultResourceForClient?.(client));
    if (resolvedResource === undefined) {
      throw new InvalidRequestError('the resource parameter is required');
    }
    const oldTokenHash = hashToken(refreshToken);
    await assertPlatformRefreshPrincipal(
      this.#config.store,
      this.#config.platformPrincipalResolver,
      {
        oldTokenHash,
        client,
      },
    );
    const rawRefresh = randomToken();
    const nowSeconds = this.#nowSeconds();
    const refreshRecord = await this.#config.store.getRefreshToken(oldTokenHash);
    let successorRefreshTtl = this.#refreshTtl;
    try {
      successorRefreshTtl = effectiveCredentialTtl(
        nowSeconds,
        this.#refreshTtl,
        refreshRecord?.upstreamExpiresAt,
      );
    } catch {
      throw new InvalidGrantError('invalid refresh token');
    }
    const rotation = await this.#config.store.rotateRefreshToken({
      oldTokenHash,
      clientId: client.client_id,
      newTokenHash: hashToken(rawRefresh),
      newExpiresAt: nowSeconds + successorRefreshTtl,
      graceSeconds: this.#refreshGraceTtl,
      recoverySeconds: this.#refreshRecoveryTtl,
      nowSeconds,
    });
    if (!('identity' in rotation)) {
      this.#logRefresh(rotation.status, client.client_id, resolvedResource);
      throw new InvalidGrantError('invalid refresh token');
    }
    const { identity } = rotation;
    if (resolvedResource !== identity.resource) {
      this.#logRefresh('resource_mismatch', client.client_id, resolvedResource);
      throw new InvalidGrantError('resource does not match the refresh token');
    }
    this.#logRefresh(rotation.status, client.client_id, identity.resource);
    const scope = publicOAuthScope(identity.scope);
    let accessTtl: number;
    try {
      accessTtl = effectiveCredentialTtl(nowSeconds, this.#accessTtl, identity.upstreamExpiresAt);
    } catch {
      throw new InvalidGrantError('invalid refresh token');
    }
    const access_token = await mintOAuthAccessToken({
      signer: this.#config.signer,
      issuer: this.#config.issuer,
      ttlSeconds: accessTtl,
      identity: {
        ownerSubject: identity.ownerSubject,
        resource: identity.resource,
        ...(identity.ownerEmail !== undefined ? { ownerEmail: identity.ownerEmail } : {}),
        ...storedOAuthOwnerPreferences({
          locale: identity.ownerLocale,
          timeZone: identity.ownerTimeZone,
        }),
        ...(scope !== undefined ? { scope } : {}),
        ...(identity.roles !== undefined ? { roles: identity.roles } : {}),
        ...(identity.authTime !== undefined ? { authTime: identity.authTime } : {}),
        ...(identity.upstreamExpiresAt !== undefined
          ? { upstreamExpiresAt: identity.upstreamExpiresAt }
          : {}),
        ...(identity.identityKind !== undefined ? { identityKind: identity.identityKind } : {}),
        ...(identity.identityProvider !== undefined
          ? { identityProvider: identity.identityProvider }
          : {}),
        ...(identity.customerIssuer !== undefined
          ? { customerIssuer: identity.customerIssuer }
          : {}),
        ...(identity.developerGrantId !== undefined
          ? { developerGrantId: identity.developerGrantId }
          : {}),
        oauthClientId: client.client_id,
      },
    });
    return {
      access_token,
      token_type: 'bearer',
      expires_in: accessTtl,
      refresh_token: rawRefresh,
      ...(scope !== undefined ? { scope } : {}),
    };
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verification = await this.#verify()(token);
    if (!verification) throw new InvalidTokenError('invalid or expired access token');
    const { caller } = verification;
    return {
      token,
      clientId: '',
      scopes: [...caller.scopes],
      ...(caller.expiresAt !== undefined ? { expiresAt: caller.expiresAt } : {}),
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    try {
      const verification = await this.#verify()(request.token);
      const caller = verification?.caller;
      if (caller?.developerGrantId === undefined || caller.oauthClientId !== client.client_id) {
        return;
      }
      await this.#config.developerGrantAuthorizer?.revoke({
        id: caller.developerGrantId,
        clientId: client.client_id,
        subject: caller.subject,
        at: new Date(this.#now()).toISOString(),
      });
    } catch {}
  }
  metadata(): Record<string, unknown> {
    const issuer = trimTrailingSlash(this.#config.issuer);
    return noodleOAuthMetadata(
      this,
      issuer,
      DEVICE_GRANT,
      this.#config.oauthClientCredentialsReady === true,
      this.#config.tokenExchangeReady === true,
    );
  }
  jwks(): Promise<{ keys: unknown[] }> {
    return this.#config.signer.publicJwks();
  }
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    await this.#handleUpstreamCallback('google', req, res);
  }
  async handleWorkOSCallback(req: Request, res: Response): Promise<void> {
    await this.#handleUpstreamCallback('workos', req, res);
  }
  async handleWorkOSLogout(req: Request, res: Response): Promise<void> {
    await handleUpstreamSessionLogout({
      req,
      res,
      issuer: this.#config.issuer,
      signer: this.#config.signer,
      ...(this.#config.upstreamAuthenticators?.workos === undefined
        ? {}
        : { workos: this.#config.upstreamAuthenticators.workos }),
      ...(this.#config.workosLogoutReturnTo === undefined
        ? {}
        : { returnTo: this.#config.workosLogoutReturnTo }),
    });
  }
  async handleUpstreamProviderChoice(req: Request, res: Response): Promise<void> {
    await continueUpstreamProviderChoice({
      req,
      res,
      store: this.#config.store,
      ...(this.#config.google === undefined ? {} : { google: this.#config.google }),
      ...(this.#config.upstreamAuthenticators?.workos === undefined
        ? {}
        : { workos: this.#config.upstreamAuthenticators.workos }),
    });
  }
  async #handleUpstreamCallback(
    upstreamProvider: UpstreamHumanProvider,
    req: Request,
    res: Response,
  ): Promise<void> {
    await handleUpstreamHumanCallback({
      provider: upstreamProvider,
      req,
      res,
      store: this.#config.store,
      issuer: this.#config.issuer,
      signer: this.#config.signer,
      ...(this.#config.google === undefined ? {} : { google: this.#config.google }),
      ...(this.#config.upstreamAuthenticators?.workos === undefined
        ? {}
        : { workos: this.#config.upstreamAuthenticators.workos }),
      ...(this.#config.platformPrincipalResolver === undefined
        ? {}
        : { resolver: this.#config.platformPrincipalResolver }),
      ...(this.#config.signupAuthorizer === undefined
        ? {}
        : { signupAuthorizer: this.#config.signupAuthorizer }),
      signupMode: this.#config.signupMode ?? 'restricted',
      ...(this.#config.allowedEmailDomain === undefined
        ? {}
        : { allowedEmailDomain: this.#config.allowedEmailDomain }),
      deniedSignupDomains: this.#config.deniedSignupDomains ?? [],
      deniedSignupSubjects: this.#config.deniedSignupSubjects ?? [],
      ...(this.#config.provisionPlatformPrincipal === undefined
        ? {}
        : { provisionPlatformPrincipal: this.#config.provisionPlatformPrincipal }),
      ...(this.#developerGrantFlow === undefined
        ? {}
        : { developerGrantFlow: this.#developerGrantFlow }),
      tokenIssuer: this.#tokenIssuer,
      signConsent: (claims) =>
        signConsentToken(claims, this.#config.signer, this.#config.issuer, this.#consentTtl),
      logger: this.#logger,
      now: this.#now,
    });
  }
  async handleConsent(req: Request, res: Response): Promise<void> {
    await handleConsentDecision({
      req,
      res,
      store: this.#config.store,
      signer: this.#config.signer,
      issuer: this.#config.issuer,
      tokenIssuer: this.#tokenIssuer,
      ...(this.#config.upstreamAuthenticators?.workos === undefined
        ? {}
        : { workos: this.#config.upstreamAuthenticators.workos }),
      pendingTtlSeconds: this.#pendingTtl,
      nowSeconds: this.#nowSeconds(),
    });
  }
  async handleDeveloperGrant(req: Request, res: Response): Promise<void> {
    if (this.#developerGrantFlow === undefined) {
      res.status(400).type('text/plain').send('developer access is not configured');
      return;
    }
    await this.#developerGrantFlow.handleDecision(req, res);
  }
  async handleFirebaseCustomerAuthorize(req: Request, res: Response): Promise<void> {
    const input = customerBridgeAuthorizeFields(req);
    const auth =
      input.resource !== undefined
        ? await this.#config.customerBridgeAuthForResource?.(input.resource)
        : undefined;
    const page = renderFirebaseAuthorizePage({
      issuer: this.#config.issuer,
      auth,
      state: input.state,
      redirectUri: input.redirect_uri,
      resource: input.resource,
      clientId: input.client_id,
    });
    res.status(page.status).setHeader('Cache-Control', 'no-store').type('html').send(page.html);
  }
  async handleFirebaseCustomerCallback(req: Request, res: Response): Promise<void> {
    const input = customerBridgeCallbackFields(req);
    const state = input.state;
    if (input.error !== undefined) {
      await this.#redirectPendingError(res, state, input.error, 'customer_firebase');
      return;
    }
    const idToken = input.id_token;
    if (state === undefined || idToken === undefined) {
      res.status(400).type('text/plain').send('missing state or id_token');
      return;
    }
    const pending = await this.#config.store.consumePendingAuthorization(
      hashToken(state),
      'customer_firebase',
    );
    if (!pending) {
      res.status(400).type('text/plain').send('unknown or expired authorization request');
      return;
    }
    const bridgeAuth = await this.#config.customerBridgeAuthForResource?.(pending.resource);
    if (bridgeAuth === undefined || bridgeAuth.provider !== 'firebase') {
      res
        .status(400)
        .type('text/plain')
        .send('customer bridge is not configured for this resource');
      return;
    }
    const identity = await this.#config.verifyCustomerBridgeToken?.(bridgeAuth, idToken);
    if (identity === undefined || identity === null) {
      res.status(400).type('text/plain').send('customer authentication failed');
      return;
    }
    const grantedScope = grantedCustomerScope(pending.scope, identity.scopes);
    if (grantedScope === null) {
      res
        .status(400)
        .type('text/plain')
        .send('customer identity did not grant every requested scope');
      return;
    }
    if (
      input.refresh_token !== undefined &&
      input.refresh_token.length > 0 &&
      this.#config.sealCustomerCredential !== undefined
    ) {
      await this.#config.store.putDelegatedCredential({
        resource: pending.resource,
        provider: 'firebase',
        subject: identity.subject,
        credential: await this.#config.sealCustomerCredential(input.refresh_token),
        updatedAt: new Date(this.#now()).toISOString(),
      });
    }
    const customerIssuer = bridgeCustomerIssuer(bridgeAuth);
    await this.#tokenIssuer.issueAuthorizationCode(res, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      ownerSubject: identity.subject,
      ...(identity.email !== undefined ? { ownerEmail: identity.email } : {}),
      ...verifiedIdentityOwnerPreferences(identity),
      roles: identity.roles,
      ...(identity.expiresAt !== undefined ? { upstreamExpiresAt: identity.expiresAt } : {}),
      ...(pending.clientState !== undefined ? { clientState: pending.clientState } : {}),
      ...(grantedScope !== undefined ? { scope: grantedScope } : {}),
      identityKind: 'customer',
      identityProvider: 'firebase',
      ...(customerIssuer === undefined ? {} : { customerIssuer }),
    });
  }
  async handleMicrosoftCustomerCallback(req: Request, res: Response): Promise<void> {
    const input = customerBridgeCallbackFields(req);
    const state = input.state;
    if (input.error !== undefined) {
      await this.#redirectPendingError(res, state, input.error, 'customer_microsoft');
      return;
    }
    const code = input.code;
    if (state === undefined || code === undefined) {
      res.status(400).type('text/plain').send('missing state or code');
      return;
    }
    const pending = await this.#config.store.consumePendingAuthorization(
      hashToken(state),
      'customer_microsoft',
    );
    if (!pending) {
      res.status(400).type('text/plain').send('unknown or expired authorization request');
      return;
    }
    const bridgeAuth = await this.#config.customerBridgeAuthForResource?.(pending.resource);
    if (!isConfiguredMicrosoftBridge(bridgeAuth)) {
      res
        .status(400)
        .type('text/plain')
        .send('customer bridge is not configured for this resource');
      return;
    }
    const clientSecret = await this.#config.managedSecretForResource?.(
      pending.resource,
      bridgeAuth.clientSecret,
    );
    if (clientSecret === undefined) {
      res.status(400).type('text/plain').send('customer bridge client secret is not configured');
      return;
    }
    let tokens: MicrosoftAuthorizationCodeTokens;
    try {
      tokens = await exchangeMicrosoftAuthorizationCode({
        auth: bridgeAuth,
        code,
        clientSecret,
        redirectUri: microsoftCallbackUrl(trimTrailingSlash(this.#config.issuer)),
        fetchImpl: this.#config.fetchImpl ?? fetch,
      });
    } catch {
      res.status(400).type('text/plain').send('customer authentication failed');
      return;
    }
    const identity = await verifyMicrosoftIdToken({
      auth: bridgeAuth,
      idToken: tokens.idToken,
      fetchImpl: this.#config.fetchImpl ?? fetch,
    });
    if (identity === null) {
      res.status(400).type('text/plain').send('customer authentication failed');
      return;
    }
    const grantedScope = grantedCustomerScope(pending.scope, identity.scopes);
    if (grantedScope === null) {
      res
        .status(400)
        .type('text/plain')
        .send('customer identity did not grant every requested scope');
      return;
    }
    if (this.#config.sealCustomerCredential === undefined) {
      res.status(500).type('text/plain').send('customer credential sealing is not configured');
      return;
    }
    await this.#config.store.putDelegatedCredential({
      resource: pending.resource,
      provider: 'microsoft',
      subject: identity.subject,
      credential: await this.#config.sealCustomerCredential(tokens.refreshToken),
      updatedAt: new Date(this.#now()).toISOString(),
    });
    const customerIssuer = bridgeCustomerIssuer(bridgeAuth);
    await this.#tokenIssuer.issueAuthorizationCode(res, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      ownerSubject: identity.subject,
      ...(identity.email !== undefined ? { ownerEmail: identity.email } : {}),
      ...verifiedIdentityOwnerPreferences(identity),
      roles: identity.roles,
      ...(identity.expiresAt !== undefined ? { upstreamExpiresAt: identity.expiresAt } : {}),
      ...(pending.clientState !== undefined ? { clientState: pending.clientState } : {}),
      ...(grantedScope !== undefined ? { scope: grantedScope } : {}),
      identityKind: 'customer',
      identityProvider: 'microsoft',
      ...(customerIssuer === undefined ? {} : { customerIssuer }),
    });
  }
  #verify(): TokenVerifier {
    if (!this.#verifier) {
      this.#verifier = createJwtVerifier({
        issuer: this.#config.issuer,
        keyResolver: this.#lazyKey,
      });
    }
    return this.#verifier;
  }
  #lazyKey: import('jose').JWTVerifyGetKey = async (header, input) => {
    const getKey = await this.#config.signer.verifierKey();
    return getKey(header, input);
  };
  #nowSeconds(): number {
    return Math.floor(this.#now() / 1000);
  }
  #logRefresh(outcome: string, clientId: string, resource: string): void {
    this.#logger.info(`oauth.refresh.${outcome}`, {
      clientId,
      resourcePath: resourcePath(resource),
    });
  }
  async #redirectPendingError(
    res: Response,
    state: string | undefined,
    error: string,
    callbackKind: PendingAuthorizationCallbackKind,
  ): Promise<boolean> {
    return redirectPendingAuthorizationError({
      store: this.#config.store,
      res,
      state,
      error,
      callbackKind,
      issuer: this.#config.issuer,
    });
  }
}

type NoodlePlatformPrincipalProvisioner = NonNullable<
  Parameters<typeof handleUpstreamHumanCallback>[0]['provisionPlatformPrincipal']
>;
