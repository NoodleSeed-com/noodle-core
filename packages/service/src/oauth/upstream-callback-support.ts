import type { Logger } from '@noodle-borg/transport-http';
import type { Response } from 'express';
import { redirectAuthorizationResponse } from './authorization-response.js';
import type { OAuthStore, PendingAuthorizationCallbackKind } from './store.js';
import { hashToken } from './tokens.js';
import type { UpstreamHumanProvider } from './upstream-human.js';

export type UpstreamCallbackResolutionResult =
  | 'principal_resolved'
  | 'provider_unavailable'
  | 'upstream_denied'
  | 'invalid_request'
  | 'pending_not_found'
  | 'exchange_failed'
  | 'identity_denied'
  | 'identity_signup_reserved'
  | 'identity_resolution_failed'
  | 'completion_failed';

/** Emits only the bounded aggregate fields approved for platform-auth rollout telemetry. */
export function logUpstreamCallback(input: {
  readonly logger: Logger;
  readonly provider: UpstreamHumanProvider;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly outcome: 'succeeded' | 'rejected' | 'failed';
  readonly resolutionResult: UpstreamCallbackResolutionResult;
}): void {
  input.logger.info('oauth.upstream_callback', {
    provider: input.provider,
    cohort: 'interactive_human',
    surface: 'oauth_callback',
    outcome: input.outcome,
    resolutionResult: input.resolutionResult,
    latencyMs: Math.max(0, input.finishedAt - input.startedAt),
  });
}

export async function redirectPendingAuthorizationError(input: {
  readonly store: OAuthStore;
  readonly res: Response;
  readonly state: string | undefined;
  readonly error: string;
  readonly callbackKind: PendingAuthorizationCallbackKind;
  readonly issuer: string;
}): Promise<boolean> {
  if (input.state === undefined) {
    input.res.status(400).type('text/plain').send(`customer authorization failed: ${input.error}`);
    return false;
  }
  const pending = await input.store.consumePendingAuthorization(
    hashToken(input.state),
    input.callbackKind,
  );
  if (!pending) {
    input.res.status(400).type('text/plain').send('unknown or expired authorization request');
    return false;
  }
  const redirect = new URL(pending.redirectUri);
  redirect.searchParams.set('error', input.error);
  if (pending.clientState !== undefined) redirect.searchParams.set('state', pending.clientState);
  redirectAuthorizationResponse(input.res, redirect, input.issuer);
  return true;
}
