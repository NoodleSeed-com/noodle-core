import type { SigningKeyProvider } from '@noodle-borg/auth';
import type { ControlPlaneSignupMode, SignupAuthorizer } from '@noodle-borg/control-plane/portable';
import {
  PlatformIdentityError,
  type PlatformPrincipalResolver,
  type ResolvedPlatformIdentity,
} from '@noodle-borg/module';
import type { Logger } from '@noodle-borg/transport-http';
import type { Request, Response } from 'express';
import type { ConsentClaims } from './consent-claims.js';
import type { DeveloperGrantOAuthFlow } from './developer-grant-flow.js';
import { requestsFreshAuthentication } from './fresh-auth.js';
import type { GoogleAuthenticator } from './google.js';
import type { OAuthStore } from './store.js';
import type { OAuthTokenIssuer } from './token-issuer.js';
import { hashToken } from './tokens.js';
import { rejectUnavailableUpstreamCallback } from './upstream-callback-availability.js';
import {
  logUpstreamCallback,
  redirectPendingAuthorizationError,
  type UpstreamCallbackResolutionResult,
} from './upstream-callback-support.js';
import { renderUpstreamConsent } from './upstream-consent.js';
import {
  exchangeUpstreamHumanIdentity,
  resolveUpstreamHumanPrincipal,
} from './upstream-federation.js';
import type { UpstreamHumanOAuthAuthenticator, UpstreamHumanProvider } from './upstream-human.js';
import { setUpstreamSessionCookie, signUpstreamSessionHandle } from './upstream-session.js';

export async function handleUpstreamHumanCallback(input: {
  readonly provider: UpstreamHumanProvider;
  readonly req: Request;
  readonly res: Response;
  readonly store: OAuthStore;
  readonly issuer: string;
  readonly signer: SigningKeyProvider;
  readonly google?: GoogleAuthenticator;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
  readonly resolver?: PlatformPrincipalResolver;
  readonly signupAuthorizer?: SignupAuthorizer;
  readonly signupMode: ControlPlaneSignupMode;
  readonly allowedEmailDomain?: string;
  readonly deniedSignupDomains: readonly string[];
  readonly deniedSignupSubjects: readonly string[];
  readonly provisionPlatformPrincipal?: (
    identity: ResolvedPlatformIdentity & { readonly email: string },
  ) => Promise<void>;
  readonly developerGrantFlow?: DeveloperGrantOAuthFlow;
  readonly tokenIssuer: OAuthTokenIssuer;
  readonly signConsent: (claims: ConsentClaims) => Promise<string>;
  readonly logger: Logger;
  readonly now: () => number;
}): Promise<void> {
  const startedAt = input.now();
  const record = (
    outcome: 'succeeded' | 'rejected' | 'failed',
    resolutionResult: UpstreamCallbackResolutionResult,
  ): void =>
    logUpstreamCallback({
      logger: input.logger,
      provider: input.provider,
      startedAt,
      finishedAt: input.now(),
      outcome,
      resolutionResult,
    });
  const available =
    input.provider === 'google' ? input.google !== undefined : input.workos !== undefined;
  if (rejectUnavailableUpstreamCallback(input.res, available)) {
    record('rejected', 'provider_unavailable');
    return;
  }
  if (typeof input.req.query.error === 'string') {
    const state = typeof input.req.query.state === 'string' ? input.req.query.state : undefined;
    const redirected = await redirectPendingAuthorizationError({
      store: input.store,
      res: input.res,
      state,
      error: 'access_denied',
      callbackKind: input.provider,
      issuer: input.issuer,
    });
    record('rejected', redirected ? 'upstream_denied' : 'pending_not_found');
    return;
  }
  const code = typeof input.req.query.code === 'string' ? input.req.query.code : undefined;
  const state = typeof input.req.query.state === 'string' ? input.req.query.state : undefined;
  if (!code || !state) {
    input.res.status(400).type('text/plain').send('missing authorization code or state');
    record('rejected', 'invalid_request');
    return;
  }
  const pending = await input.store.consumePendingAuthorization(hashToken(state), input.provider);
  if (!pending) {
    input.res.status(400).type('text/plain').send('unknown or expired authorization request');
    record('rejected', 'pending_not_found');
    return;
  }
  let identity: Awaited<ReturnType<typeof exchangeUpstreamHumanIdentity>>;
  try {
    identity = await exchangeUpstreamHumanIdentity({
      provider: input.provider,
      code,
      ...(input.google === undefined ? {} : { google: input.google }),
      ...(input.workos === undefined ? {} : { workos: input.workos }),
    });
  } catch {
    input.res.status(400).type('text/plain').send('upstream authentication failed');
    record('failed', 'exchange_failed');
    return;
  }
  let ownerSubject: string;
  try {
    ownerSubject = await resolveUpstreamHumanPrincipal({
      provider: input.provider,
      identity,
      ...(input.resolver === undefined ? {} : { resolver: input.resolver }),
      ...(input.signupAuthorizer === undefined ? {} : { signupAuthorizer: input.signupAuthorizer }),
      ...(input.allowedEmailDomain === undefined
        ? {}
        : { allowedEmailDomain: input.allowedEmailDomain }),
      signupMode: input.signupMode,
      deniedSignupDomains: input.deniedSignupDomains,
      deniedSignupSubjects: input.deniedSignupSubjects,
    });
  } catch (error) {
    if (!(error instanceof PlatformIdentityError)) {
      input.res.status(500).type('text/plain').send('internal server error');
      record('failed', 'identity_resolution_failed');
      return;
    }
    const code = error.code === 'identity_signup_reserved' ? 'identity_not_permitted' : error.code;
    input.res.status(403).type('text/plain').send(code);
    record(
      'rejected',
      error.code === 'identity_signup_reserved' ? 'identity_signup_reserved' : 'identity_denied',
    );
    return;
  }
  try {
    const authTime = requestsFreshAuthentication(pending.scope)
      ? Math.floor(input.now() / 1_000)
      : undefined;
    if (input.provisionPlatformPrincipal !== undefined) {
      const resolved = await input.resolver?.resolveExisting(ownerSubject);
      if (resolved === undefined) throw new PlatformIdentityError('identity_link_required');
      await input.provisionPlatformPrincipal({ ...resolved, email: identity.email });
    }
    const upstreamSession = identity.upstreamSession;
    if (input.provider === 'workos' && upstreamSession?.provider === 'workos') {
      setUpstreamSessionCookie({
        res: input.res,
        issuer: input.issuer,
        handle: await signUpstreamSessionHandle({
          sessionId: upstreamSession.id,
          signer: input.signer,
          issuer: input.issuer,
        }),
      });
    }
    await renderUpstreamConsent({
      pending,
      identity,
      ownerSubject,
      issuer: input.issuer,
      store: input.store,
      tokenIssuer: input.tokenIssuer,
      ...(input.developerGrantFlow === undefined
        ? {}
        : { developerGrantFlow: input.developerGrantFlow }),
      ...(authTime === undefined ? {} : { authTime }),
      upstreamProvider: input.provider,
      signConsent: input.signConsent,
      res: input.res,
    });
    record('succeeded', 'principal_resolved');
  } catch (error) {
    record('failed', 'completion_failed');
    throw error;
  }
}
