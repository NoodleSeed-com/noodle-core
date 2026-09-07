import type { Response } from 'express';
import { renderConsentPage } from './consent.js';
import type { ConsentClaims } from './consent-claims.js';
import {
  type DeveloperGrantOAuthFlow,
  isDeveloperResourceForIssuer,
} from './developer-grant-flow.js';
import { publicOAuthScope } from './fresh-auth.js';
import { storedOAuthOwnerPreferences } from './identity-preferences.js';
import { hostOf } from './provider-util.js';
import type { OAuthStore, PendingAuthorizationRecord } from './store.js';
import type { OAuthTokenIssuer } from './token-issuer.js';
import type { UpstreamHumanProvider } from './upstream-human.js';

export async function renderUpstreamConsent(input: {
  readonly pending: PendingAuthorizationRecord;
  readonly identity: {
    readonly email: string;
    readonly locale?: string;
    readonly timeZone?: string;
  };
  readonly ownerSubject: string;
  readonly issuer: string;
  readonly store: OAuthStore;
  readonly tokenIssuer: OAuthTokenIssuer;
  readonly developerGrantFlow?: DeveloperGrantOAuthFlow;
  readonly authTime?: number;
  readonly upstreamProvider?: UpstreamHumanProvider;
  readonly signConsent: (claims: ConsentClaims) => Promise<string>;
  readonly res: Response;
}): Promise<void> {
  const publicScope = publicOAuthScope(input.pending.scope);
  const { scope: _internalScope, ...pendingWithoutScope } = input.pending;
  const pending: PendingAuthorizationRecord = {
    ...pendingWithoutScope,
    ...(publicScope === undefined ? {} : { scope: publicScope }),
  };
  const preferences = storedOAuthOwnerPreferences(input.identity);
  if (isDeveloperResourceForIssuer(pending.resource, input.issuer)) {
    if (input.developerGrantFlow === undefined) {
      input.res.status(400).type('text/plain').send('developer access is not configured');
      return;
    }
    await input.developerGrantFlow.renderConsent(
      pending,
      {
        subject: input.ownerSubject,
        email: input.identity.email,
        ...preferences,
        ...(input.authTime === undefined ? {} : { authTime: input.authTime }),
      },
      input.res,
    );
    return;
  }
  if (
    await input.store.hasConsentGrant(
      pending.clientId,
      input.ownerSubject,
      pending.resource,
      'platform',
    )
  ) {
    await input.tokenIssuer.issueAuthorizationCode(input.res, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      ownerSubject: input.ownerSubject,
      ownerEmail: input.identity.email,
      ...preferences,
      ...(input.authTime === undefined ? {} : { authTime: input.authTime }),
      ...(pending.clientState !== undefined ? { clientState: pending.clientState } : {}),
      ...(pending.scope !== undefined ? { scope: pending.scope } : {}),
    });
    return;
  }
  const consentToken = await input.signConsent({
    kind: 'consent',
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    resource: pending.resource,
    ownerSubject: input.ownerSubject,
    ownerEmail: input.identity.email,
    ...preferences,
    ...(input.authTime === undefined ? {} : { authTime: input.authTime }),
    ...(pending.clientState !== undefined ? { clientState: pending.clientState } : {}),
    ...(pending.scope !== undefined ? { scope: pending.scope } : {}),
    ...(input.upstreamProvider === undefined ? {} : { upstreamProvider: input.upstreamProvider }),
  });
  const client = await input.store.getClient(pending.clientId);
  input.res
    .status(200)
    .type('html')
    .send(
      renderConsentPage({
        clientName: client?.client_name ?? pending.clientId,
        portal: (await input.store.getClientPurpose(pending.clientId)) === 'portal',
        resourceHost: hostOf(pending.resource),
        redirectHost: hostOf(pending.redirectUri),
        userEmail: input.identity.email,
        consentToken,
        consentAction: '/oauth/consent',
        allowAccountSwitch: input.upstreamProvider === 'workos',
      }),
    );
}
