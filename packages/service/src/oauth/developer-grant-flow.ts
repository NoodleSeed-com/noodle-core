import type { SigningKeyProvider } from '@noodle-borg/auth';
import { capabilitiesForDeveloperResource, isDeveloperResource } from '@noodle-borg/developer-mcp';
import type { Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { redirectAuthorizationResponse } from './authorization-response.js';
import { type DeveloperGrantClaims, isDeveloperGrantClaims } from './consent-claims.js';
import type { DeveloperAccessGrant } from './developer-grant.js';
import type { DeveloperGrantAuthorizer } from './developer-grant-authorizer.js';
import { renderDeveloperGrantPage } from './developer-grant-page.js';
import type { GoogleIdentity } from './google.js';
import { storedOAuthOwnerPreferences } from './identity-preferences.js';
import { hostOf } from './provider-util.js';
import type { OAuthStore, PendingAuthorizationRecord } from './store.js';
import type { OAuthTokenIssuer } from './token-issuer.js';

const DEVELOPER_GRANT_PATH = '/oauth/developer-grant';
const DEVELOPER_GRANT_FORM_FIELDS = new Set(['grant_token', 'decision']);

export interface DeveloperGrantOAuthFlowOptions {
  readonly issuer: string;
  readonly signer: SigningKeyProvider;
  readonly store: OAuthStore;
  readonly authorizer: DeveloperGrantAuthorizer;
  readonly tokenIssuer: OAuthTokenIssuer;
  readonly tokenTtlSeconds: number;
}

export class DeveloperGrantOAuthFlow {
  readonly #options: DeveloperGrantOAuthFlowOptions;

  constructor(options: DeveloperGrantOAuthFlowOptions) {
    this.#options = options;
  }

  async renderConsent(
    pending: PendingAuthorizationRecord,
    identity: GoogleIdentity & { readonly authTime?: number },
    res: Response,
  ): Promise<void> {
    if (
      await this.#options.store.hasConsentGrant(
        pending.clientId,
        identity.subject,
        pending.resource,
        'platform',
      )
    ) {
      const active = await this.#options.authorizer.findActive({
        clientId: pending.clientId,
        subject: identity.subject,
        resource: pending.resource,
      });
      if (active !== undefined) {
        await this.#issueAuthorizationCode(res, pending, identity, active);
        return;
      }
    }
    const grantToken = await this.#sign({
      kind: 'developer-grant',
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      ownerSubject: identity.subject,
      ownerEmail: identity.email,
      ...storedOAuthOwnerPreferences(identity),
      ...(identity.authTime !== undefined ? { authTime: identity.authTime } : {}),
      ...(pending.clientState !== undefined ? { clientState: pending.clientState } : {}),
      ...(pending.scope !== undefined ? { scope: pending.scope } : {}),
    });
    const client = await this.#options.store.getClient(pending.clientId);
    res
      .status(200)
      .setHeader('Cache-Control', 'no-store')
      .type('html')
      .send(
        renderDeveloperGrantPage({
          clientName: client?.client_name ?? pending.clientId,
          resourceHost: hostOf(pending.resource),
          redirectHost: hostOf(pending.redirectUri),
          userEmail: identity.email,
          grantToken,
          grantAction: DEVELOPER_GRANT_PATH,
          capabilities: capabilitiesForDeveloperResource(pending.resource),
        }),
      );
  }

  async handleDecision(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some((key) => !DEVELOPER_GRANT_FORM_FIELDS.has(key))) {
      res.status(400).type('text/plain').send('invalid developer access consent');
      return;
    }
    const grantToken = typeof body.grant_token === 'string' ? body.grant_token : undefined;
    const decision = typeof body.decision === 'string' ? body.decision : undefined;
    if (grantToken === undefined) {
      res.status(400).type('text/plain').send('missing grant_token');
      return;
    }
    let claims: DeveloperGrantClaims;
    try {
      claims = await this.#verify(grantToken);
    } catch {
      res.status(400).type('text/plain').send('invalid or expired developer access consent');
      return;
    }
    const redirect = new URL(claims.redirectUri);
    if (decision !== 'approve') {
      redirect.searchParams.set('error', 'access_denied');
      if (claims.clientState !== undefined) redirect.searchParams.set('state', claims.clientState);
      redirectAuthorizationResponse(res, redirect, this.#options.issuer);
      return;
    }
    let grant: DeveloperAccessGrant;
    try {
      grant = await this.#options.authorizer.authorize({
        clientId: claims.clientId,
        subject: claims.ownerSubject,
        resource: claims.resource,
      });
    } catch {
      res.status(400).type('text/plain').send('invalid developer access consent');
      return;
    }
    await this.#options.store.createConsentGrant({
      clientId: claims.clientId,
      ownerSubject: claims.ownerSubject,
      resource: claims.resource,
      identityKind: 'platform',
    });
    await this.#issueAuthorizationCode(
      res,
      claims,
      {
        subject: claims.ownerSubject,
        ...(claims.ownerEmail === undefined ? {} : { email: claims.ownerEmail }),
        ...(claims.ownerLocale === undefined ? {} : { locale: claims.ownerLocale }),
        ...(claims.ownerTimeZone === undefined ? {} : { timeZone: claims.ownerTimeZone }),
        ...(claims.authTime === undefined ? {} : { authTime: claims.authTime }),
      },
      grant,
    );
  }

  async #issueAuthorizationCode(
    res: Response,
    pending: Pick<
      PendingAuthorizationRecord,
      'clientId' | 'codeChallenge' | 'redirectUri' | 'resource' | 'clientState' | 'scope'
    >,
    identity: {
      readonly subject: string;
      readonly email?: string;
      readonly locale?: string;
      readonly timeZone?: string;
      readonly authTime?: number;
    },
    grant: DeveloperAccessGrant,
  ): Promise<void> {
    await this.#options.tokenIssuer.issueAuthorizationCode(res, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      ownerSubject: identity.subject,
      ...(identity.email === undefined ? {} : { ownerEmail: identity.email }),
      ...storedOAuthOwnerPreferences(identity),
      ...(identity.authTime === undefined ? {} : { authTime: identity.authTime }),
      ...(pending.clientState === undefined ? {} : { clientState: pending.clientState }),
      ...(pending.scope === undefined ? {} : { scope: pending.scope }),
      developerGrantId: grant.id,
    });
  }

  async #sign(claims: DeveloperGrantClaims): Promise<string> {
    const key = await this.#options.signer.signingKey();
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: key.alg, kid: key.kid })
      .setIssuer(this.#options.issuer)
      .setIssuedAt()
      .setExpirationTime(`${this.#options.tokenTtlSeconds}s`)
      .sign(key.privateKey);
  }

  async #verify(token: string): Promise<DeveloperGrantClaims> {
    const getKey = await this.#options.signer.verifierKey();
    const { payload } = await jwtVerify(token, getKey, { issuer: this.#options.issuer });
    if (!isDeveloperGrantClaims(payload)) throw new Error('not a developer grant token');
    return payload;
  }
}

export function isDeveloperResourceForIssuer(resource: string, issuer: string): boolean {
  try {
    const resourceUrl = new URL(resource);
    const issuerUrl = new URL(issuer);
    return (
      resourceUrl.origin === issuerUrl.origin &&
      isDeveloperResource(resourceUrl.pathname) &&
      !resourceUrl.pathname.endsWith('/') &&
      resourceUrl.search === '' &&
      resourceUrl.hash === '' &&
      resourceUrl.username === '' &&
      resourceUrl.password === ''
    );
  } catch {
    return false;
  }
}
