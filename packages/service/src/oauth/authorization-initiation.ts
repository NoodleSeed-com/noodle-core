import { InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { UpstreamHumanRolloutStore } from '@noodle-borg/module';
import { upstreamAuthorizationOptionsInput } from '@noodle-borg/module';
import type { Response } from 'express';
import type { TenantBridgeAuthConfig } from '../store.js';
import { bridgeAuthorizeUrl } from './customer-bridge.js';
import type { GoogleAuthenticator } from './google.js';
import { defaultResourceFromClient, normalizeResource } from './provider-util.js';
import type {
  OAuthStore,
  PendingAuthorizationCallbackKind,
  PendingAuthorizationRecord,
} from './store.js';
import { hashToken, randomToken } from './tokens.js';
import { upstreamAuthorizationUrl } from './upstream-federation.js';
import {
  GOOGLE_ONLY_UPSTREAM_ROLLOUT,
  selectUpstreamHumanProvider,
  type UpstreamHumanOAuthAuthenticator,
  type UpstreamHumanRollout,
} from './upstream-human.js';
import { renderUpstreamProviderChoice } from './upstream-provider-choice.js';

export async function initiateAuthorization(input: {
  readonly client: OAuthClientInformationFull;
  readonly params: AuthorizationParams;
  readonly res: Response;
  readonly issuer: string;
  readonly store: OAuthStore;
  readonly google?: GoogleAuthenticator;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
  readonly rollout?: UpstreamHumanRollout;
  readonly rolloutStore?: UpstreamHumanRolloutStore;
  readonly customerBridgeAuthForResource?: (
    resource: string,
  ) => Promise<TenantBridgeAuthConfig | undefined>;
  readonly defaultResourceForClient?: (client: OAuthClientInformationFull) => string | undefined;
  readonly pendingTtlSeconds: number;
  readonly nowSeconds: number;
  readonly signupHintClientIds?: readonly string[] | undefined;
}): Promise<void> {
  const resource =
    input.params.resource?.href ??
    defaultResourceFromClient(input.client) ??
    normalizeResource(input.defaultResourceForClient?.(input.client));
  if (!resource) throw new InvalidRequestError('the resource parameter is required');

  const bridgeAuth = await input.customerBridgeAuthForResource?.(resource);
  const rollout =
    bridgeAuth === undefined
      ? (input.rollout ?? (await input.rolloutStore?.get()) ?? GOOGLE_ONLY_UPSTREAM_ROLLOUT)
      : GOOGLE_ONLY_UPSTREAM_ROLLOUT;
  const nonce = randomToken();
  const provider =
    bridgeAuth === undefined
      ? selectUpstreamHumanProvider(
          { clientId: input.client.client_id, transactionNonce: nonce },
          rollout,
        )
      : 'google';
  assertProviderAvailable(input, bridgeAuth, provider);

  if (shouldOfferRecoveryChoice(input, bridgeAuth, rollout, provider)) {
    await input.store.createPendingAuthorization(
      pendingRecord(input, resource, nonce, 'upstream_choice'),
    );
    input.res
      .status(200)
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Referrer-Policy', 'no-referrer')
      .type('html')
      .send(renderUpstreamProviderChoice(nonce));
    return;
  }

  const callbackKind: PendingAuthorizationCallbackKind =
    bridgeAuth?.provider === 'firebase'
      ? 'customer_firebase'
      : bridgeAuth?.provider === 'microsoft'
        ? 'customer_microsoft'
        : provider;
  await input.store.createPendingAuthorization(pendingRecord(input, resource, nonce, callbackKind));
  if (bridgeAuth !== undefined) {
    const authorizeUrl = bridgeAuthorizeUrl(bridgeAuth, {
      issuer: input.issuer,
      state: nonce,
      resource,
      clientId: input.client.client_id,
    });
    if (!authorizeUrl) throw new InvalidRequestError('customer bridge is not configured');
    input.res.redirect(302, authorizeUrl);
    return;
  }
  input.res.redirect(
    302,
    upstreamAuthorizationUrl({
      provider,
      ...(input.google === undefined ? {} : { google: input.google }),
      ...(input.workos === undefined ? {} : { workos: input.workos }),
      state: nonce,
      ...upstreamAuthorizationOptionsInput(
        input.params.scopes,
        input.signupHintClientIds?.includes(input.client.client_id) === true,
      ),
    }),
  );
}

function pendingRecord(
  input: Parameters<typeof initiateAuthorization>[0],
  resource: string,
  nonce: string,
  upstreamProvider: PendingAuthorizationCallbackKind,
): PendingAuthorizationRecord {
  return {
    state: hashToken(nonce),
    clientId: input.client.client_id,
    redirectUri: input.params.redirectUri,
    codeChallenge: input.params.codeChallenge,
    upstreamProvider,
    ...(input.params.state !== undefined ? { clientState: input.params.state } : {}),
    resource,
    ...(input.params.scopes?.length ? { scope: input.params.scopes.join(' ') } : {}),
    expiresAt: input.nowSeconds + input.pendingTtlSeconds,
  };
}

function shouldOfferRecoveryChoice(
  input: Parameters<typeof initiateAuthorization>[0],
  bridgeAuth: TenantBridgeAuthConfig | undefined,
  rollout: UpstreamHumanRollout,
  provider: 'google' | 'workos',
): boolean {
  return (
    bridgeAuth === undefined &&
    provider === 'google' &&
    rollout.allowUserSelectedWorkosRecovery === true &&
    input.google !== undefined &&
    input.workos !== undefined
  );
}

function assertProviderAvailable(
  input: Parameters<typeof initiateAuthorization>[0],
  bridgeAuth: TenantBridgeAuthConfig | undefined,
  provider: 'google' | 'workos',
): void {
  const unavailable =
    provider === 'google' ? input.google === undefined : input.workos === undefined;
  if (bridgeAuth === undefined && unavailable) {
    throw new InvalidRequestError('the selected upstream provider is unavailable');
  }
}
