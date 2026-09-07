import type { Request, Response } from 'express';
import { renderOAuthPage } from './branding.js';
import { requestsFreshAuthentication } from './fresh-auth.js';
import type { GoogleAuthenticator } from './google.js';
import type { OAuthStore, PendingAuthorizationRecord } from './store.js';
import { hashToken, randomToken } from './tokens.js';
import { upstreamAuthorizationUrl } from './upstream-federation.js';
import type { UpstreamHumanOAuthAuthenticator, UpstreamHumanProvider } from './upstream-human.js';

export function renderUpstreamProviderChoice(state: string): string {
  const escapedState = escapeHtml(state);
  return renderOAuthPage({
    title: 'Choose how to sign in — Noodle Seed',
    kicker: 'Sign in',
    heading: 'Choose how to continue',
    contentHtml: `<p class="ns-lede">Google remains the default while authentication is in recovery mode. If your account uses email or another sign-in method, continue securely through WorkOS.</p>
<form method="post" action="/oauth/upstream/continue">
  <input type="hidden" name="choice_state" value="${escapedState}" />
  <div class="btn-glow"><button class="btn btn-primary" type="submit" name="provider" value="google">Continue with Google</button></div>
  <div class="btn-glow"><button class="btn" type="submit" name="provider" value="workos">Use email or another sign-in method</button></div>
</form>`,
  });
}

export async function continueUpstreamProviderChoice(input: {
  readonly req: Request;
  readonly res: Response;
  readonly store: OAuthStore;
  readonly google?: GoogleAuthenticator;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
}): Promise<void> {
  const body = (input.req.body ?? {}) as Record<string, unknown>;
  const state = typeof body.choice_state === 'string' ? body.choice_state : undefined;
  const provider = selectedProvider(body.provider);
  if (state === undefined || provider === undefined) {
    input.res.status(400).type('text/plain').send('invalid sign-in choice');
    return;
  }
  if (
    (provider === 'google' && input.google === undefined) ||
    (provider === 'workos' && input.workos === undefined)
  ) {
    input.res.status(503).set('Retry-After', '5').type('text/plain').send('sign-in unavailable');
    return;
  }
  const choice = await input.store.consumePendingAuthorization(hashToken(state), 'upstream_choice');
  if (choice === undefined) {
    input.res.status(400).type('text/plain').send('unknown or expired authorization request');
    return;
  }
  const nonce = randomToken();
  await input.store.createPendingAuthorization(finalPending(choice, nonce, provider));
  input.res.redirect(
    302,
    upstreamAuthorizationUrl({
      provider,
      ...(input.google === undefined ? {} : { google: input.google }),
      ...(input.workos === undefined ? {} : { workos: input.workos }),
      state: nonce,
      ...(requestsFreshAuthentication(choice.scope)
        ? { options: { forceAuthentication: true } }
        : {}),
    }),
  );
}

function finalPending(
  choice: PendingAuthorizationRecord,
  nonce: string,
  provider: UpstreamHumanProvider,
): PendingAuthorizationRecord {
  return {
    ...choice,
    state: hashToken(nonce),
    upstreamProvider: provider,
  };
}

function selectedProvider(value: unknown): UpstreamHumanProvider | undefined {
  return value === 'google' || value === 'workos' ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
