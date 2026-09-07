import type { SigningKeyProvider } from '@noodle-borg/auth';
import type { Request, Response } from 'express';
import { redirectAuthorizationResponse } from './authorization-response.js';
import { verifyConsentToken } from './consent-token.js';
import type { OAuthStore, PendingAuthorizationRecord } from './store.js';
import type { OAuthTokenIssuer } from './token-issuer.js';
import { hashToken, randomToken } from './tokens.js';
import type { UpstreamHumanOAuthAuthenticator } from './upstream-human.js';

type ConsentDecision = 'approve' | 'deny' | 'switch_account';

export async function handleConsentDecision(input: {
  readonly req: Request;
  readonly res: Response;
  readonly store: OAuthStore;
  readonly signer: SigningKeyProvider;
  readonly issuer: string;
  readonly tokenIssuer: OAuthTokenIssuer;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
  readonly pendingTtlSeconds: number;
  readonly nowSeconds: number;
}): Promise<void> {
  const body = (input.req.body ?? {}) as Record<string, unknown>;
  const consentToken = typeof body.consent_token === 'string' ? body.consent_token : undefined;
  const decision = parseConsentDecision(body.decision);
  if (consentToken === undefined) {
    input.res.status(400).type('text/plain').send('missing consent_token');
    return;
  }
  if (decision === undefined) {
    input.res.status(400).type('text/plain').send('invalid consent decision');
    return;
  }

  let claims: Awaited<ReturnType<typeof verifyConsentToken>>;
  try {
    claims = await verifyConsentToken(consentToken, input.signer, input.issuer);
  } catch {
    input.res.status(400).type('text/plain').send('invalid or expired consent');
    return;
  }

  if (decision === 'switch_account') {
    await restartWorkOSAuthorization({ ...input, claims });
    return;
  }

  const redirect = new URL(claims.redirectUri);
  if (decision === 'deny') {
    redirect.searchParams.set('error', 'access_denied');
    if (claims.clientState !== undefined) redirect.searchParams.set('state', claims.clientState);
    redirectAuthorizationResponse(input.res, redirect, input.issuer);
    return;
  }

  await input.store.createConsentGrant({
    clientId: claims.clientId,
    ownerSubject: claims.ownerSubject,
    resource: claims.resource,
    identityKind: 'platform',
  });
  await input.tokenIssuer.issueAuthorizationCode(input.res, {
    clientId: claims.clientId,
    codeChallenge: claims.codeChallenge,
    redirectUri: claims.redirectUri,
    resource: claims.resource,
    ownerSubject: claims.ownerSubject,
    ...(claims.ownerEmail !== undefined ? { ownerEmail: claims.ownerEmail } : {}),
    ...(claims.ownerLocale !== undefined ? { ownerLocale: claims.ownerLocale } : {}),
    ...(claims.ownerTimeZone !== undefined ? { ownerTimeZone: claims.ownerTimeZone } : {}),
    ...(claims.authTime !== undefined ? { authTime: claims.authTime } : {}),
    ...(claims.clientState !== undefined ? { clientState: claims.clientState } : {}),
    ...(claims.scope !== undefined ? { scope: claims.scope } : {}),
  });
}

async function restartWorkOSAuthorization(input: {
  readonly claims: Awaited<ReturnType<typeof verifyConsentToken>>;
  readonly res: Response;
  readonly store: OAuthStore;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
  readonly pendingTtlSeconds: number;
  readonly nowSeconds: number;
}): Promise<void> {
  if (input.claims.upstreamProvider !== 'workos') {
    input.res.status(400).type('text/plain').send('account switching is unavailable');
    return;
  }
  if (input.workos === undefined) {
    input.res.status(503).set('Retry-After', '5').type('text/plain').send('sign-in unavailable');
    return;
  }

  const nonce = randomToken();
  const authorizationUrl = input.workos.authorizationUrl(nonce, {
    forceAuthentication: true,
  });
  await input.store.createPendingAuthorization(replacementPending(input, nonce));
  input.res.redirect(302, authorizationUrl.href);
}

function replacementPending(
  input: Parameters<typeof restartWorkOSAuthorization>[0],
  nonce: string,
): PendingAuthorizationRecord {
  const { claims } = input;
  return {
    state: hashToken(nonce),
    clientId: claims.clientId,
    redirectUri: claims.redirectUri,
    codeChallenge: claims.codeChallenge,
    upstreamProvider: 'workos',
    ...(claims.clientState === undefined ? {} : { clientState: claims.clientState }),
    resource: claims.resource,
    ...(claims.scope === undefined ? {} : { scope: claims.scope }),
    expiresAt: input.nowSeconds + input.pendingTtlSeconds,
  };
}

function parseConsentDecision(value: unknown): ConsentDecision | undefined {
  return value === 'approve' || value === 'deny' || value === 'switch_account' ? value : undefined;
}
