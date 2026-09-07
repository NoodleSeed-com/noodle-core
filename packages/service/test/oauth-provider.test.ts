import type { IncomingMessage } from 'node:http';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { NoodleOAuthControlPlaneGate } from '@noodle-borg/control-plane/portable';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  FRESH_AUTH_SCOPE,
  publicOAuthScope,
  SIGNUP_INTENT_SCOPE,
} from '../src/oauth/fresh-auth.js';
import { type GoogleAuthenticator, GoogleOAuthAuthenticator } from '../src/oauth/google.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { hashToken } from '../src/oauth/tokens.js';

const ISSUER = 'https://as.noodle.test';
const RESOURCE = 'https://cloud.noodle.test';
const REDIRECT = 'https://console.noodle.test/api/console/auth/callback';
const CLIENT: OAuthClientInformationFull = {
  client_id: 'console-client',
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
};
const FRESH_CLIENT: OAuthClientInformationFull = {
  ...CLIENT,
  client_id: 'console-fresh-client',
};
const DYNAMIC_CLIENT: OAuthClientInformationFull = {
  ...CLIENT,
  client_id: 'dynamic-client',
};

describe('forced upstream authentication', () => {
  it('projects signup intent only for configured first-party browser clients', async () => {
    const signer = await createStaticSigningKeyProvider();
    const store = new InMemoryOAuthStore();
    const authorizationOptions: unknown[] = [];
    const workos = {
      provider: 'workos' as const,
      realm: 'workos-realm',
      authorizationUrl: (state: string, options?: unknown) => {
        authorizationOptions.push(options);
        return new URL(`https://workos.test/authorize?state=${encodeURIComponent(state)}`);
      },
      exchange: vi.fn(),
    };
    const provider = new NoodleOAuthProvider({
      issuer: ISSUER,
      store,
      signer,
      upstreamAuthenticators: { workos },
      upstreamRollout: { workosPercentage: 100, workosCanaryClientIds: [] },
      signupHintClientIds: [CLIENT.client_id, FRESH_CLIENT.client_id],
    });

    for (const client of [CLIENT, FRESH_CLIENT, DYNAMIC_CLIENT]) {
      const response = responseRecorder();
      await provider.authorize(
        client,
        {
          redirectUri: REDIRECT,
          codeChallenge: `challenge-${client.client_id}`,
          resource: new URL(RESOURCE),
          scopes: ['openid', 'email', SIGNUP_INTENT_SCOPE],
        },
        response.response,
      );
    }

    expect(authorizationOptions).toEqual([
      { screenHint: 'sign-up' },
      { screenHint: 'sign-up' },
      undefined,
    ]);
    expect(publicOAuthScope(`openid ${SIGNUP_INTENT_SCOPE} email`)).toBe('openid email');
  });

  it('adds machine grant metadata only when the complete origin is ready', async () => {
    const signer = await createStaticSigningKeyProvider();
    const base = {
      issuer: ISSUER,
      store: new InMemoryOAuthStore(),
      signer,
    };
    const humanMetadata = new NoodleOAuthProvider(base).metadata();
    const unavailableMetadata = new NoodleOAuthProvider({
      ...base,
      oauthClientCredentialsReady: false,
    }).metadata();
    expect(unavailableMetadata).toEqual(humanMetadata);

    const readyMetadata = new NoodleOAuthProvider({
      ...base,
      oauthClientCredentialsReady: true,
    }).metadata();
    expect(readyMetadata.grant_types_supported).toEqual(
      expect.arrayContaining(['client_credentials']),
    );
    expect(readyMetadata.token_endpoint_auth_methods_supported).toEqual([
      'client_secret_post',
      'none',
      'private_key_jwt',
      'client_secret_basic',
    ]);
    expect(readyMetadata.token_endpoint_auth_signing_alg_values_supported).toEqual([
      'RS256',
      'ES256',
    ]);
  });

  it('requests login and max_age=0 from the Google adapter only when forced', () => {
    const google = new GoogleOAuthAuthenticator({
      clientId: 'google-client',
      clientSecret: 'google-secret',
      redirectUri: `${ISSUER}/oauth/google/callback`,
    });

    const normal = google.authorizationUrl('normal-state');
    expect(normal.searchParams.get('prompt')).toBe('select_account');
    expect(normal.searchParams.has('max_age')).toBe(false);

    const forced = google.authorizationUrl('forced-state', { forceAuthentication: true });
    expect(forced.searchParams.get('prompt')).toBe('login');
    expect(forced.searchParams.get('max_age')).toBe('0');
  });

  it('stamps only a forced callback and preserves the original event through code exchange and refresh', async () => {
    const signer = await createStaticSigningKeyProvider();
    const store = new InMemoryOAuthStore();
    await store.putClient(CLIENT);
    await store.putClient(FRESH_CLIENT);
    await store.createConsentGrant({
      clientId: CLIENT.client_id,
      ownerSubject: 'principal-1',
      resource: new URL(RESOURCE).href,
      identityKind: 'platform',
    });
    let now = Date.now();
    const authorizationOptions: unknown[] = [];
    const google: GoogleAuthenticator = {
      authorizationUrl: (state, options) => {
        authorizationOptions.push(options);
        const url = new URL('https://google.test/authorize');
        url.searchParams.set('state', state);
        if (options?.forceAuthentication === true) {
          url.searchParams.set('prompt', 'login');
          url.searchParams.set('max_age', '0');
        }
        return url;
      },
      exchange: async () => ({ subject: 'principal-1', email: 'owner@example.test' }),
    };
    const provider = new NoodleOAuthProvider({
      issuer: ISSUER,
      store,
      signer,
      google,
      now: () => now,
      signupMode: 'public',
    });

    const normalStart = responseRecorder();
    await provider.authorize(
      CLIENT,
      {
        redirectUri: REDIRECT,
        codeChallenge: 'normal-challenge',
        resource: new URL(RESOURCE),
        scopes: ['openid', 'email'],
      },
      normalStart.response,
    );
    expect(authorizationOptions[0]).toBeUndefined();
    const normalCode = await completeGoogleCallback(provider, normalStart.lastRedirect(), false);
    expect((await store.getAuthorizationCode(hashToken(normalCode)))?.authTime).toBeUndefined();

    const forcedStart = responseRecorder();
    await provider.authorize(
      FRESH_CLIENT,
      {
        redirectUri: REDIRECT,
        codeChallenge: 'forced-challenge',
        resource: new URL(RESOURCE),
        scopes: ['openid', 'email', FRESH_AUTH_SCOPE],
      },
      forcedStart.response,
    );
    expect(authorizationOptions[1]).toEqual({ forceAuthentication: true });
    const forcedUpstream = new URL(forcedStart.lastRedirect());
    expect(forcedUpstream.searchParams.get('prompt')).toBe('login');
    expect(forcedUpstream.searchParams.get('max_age')).toBe('0');

    const expectedAuthTime = Math.floor(now / 1_000);
    const authorizationCode = await completeGoogleCallbackThroughConsent(
      provider,
      forcedStart.lastRedirect(),
    );
    const codeRecord = await store.getAuthorizationCode(hashToken(authorizationCode));
    expect(codeRecord).toMatchObject({
      authTime: expectedAuthTime,
      scope: 'openid email',
    });
    expect(codeRecord?.scope).not.toContain(FRESH_AUTH_SCOPE);

    const issued = await provider.exchangeAuthorizationCode(
      FRESH_CLIENT,
      authorizationCode,
      undefined,
      REDIRECT,
      new URL(RESOURCE),
    );
    expect(issued.scope).toBe('openid email');
    expect(issued.scope).not.toContain(FRESH_AUTH_SCOPE);
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    await expect(verify(issued.access_token, new URL(RESOURCE).href)).resolves.toMatchObject({
      caller: {
        authTime: expectedAuthTime,
        scopes: ['email', 'openid'],
      },
    });
    await expect(
      store.getRefreshToken(hashToken(issued.refresh_token as string)),
    ).resolves.toMatchObject({ authTime: expectedAuthTime });

    now += 120_000;
    const refreshed = await provider.exchangeRefreshToken(
      FRESH_CLIENT,
      issued.refresh_token as string,
      undefined,
      new URL(RESOURCE),
    );
    await expect(verify(refreshed.access_token, new URL(RESOURCE).href)).resolves.toMatchObject({
      caller: { authTime: expectedAuthTime },
    });
    await expect(
      store.getRefreshToken(hashToken(refreshed.refresh_token as string)),
    ).resolves.toMatchObject({ authTime: expectedAuthTime });
  });

  it('carries verified authentication time into the control-plane identity', async () => {
    const gate = new NoodleOAuthControlPlaneGate({
      verifier: async () => ({
        subject: 'principal-1',
        email: 'owner@example.test',
        authTime: 1_700_000_000,
      }),
      audience: RESOURCE,
      admins: [],
      signupMode: 'public',
    });

    await expect(
      gate.authorize({
        headers: { authorization: 'Bearer access-token' },
      } as IncomingMessage),
    ).resolves.toMatchObject({
      ok: true,
      identity: {
        subject: 'principal-1',
        authTime: 1_700_000_000,
      },
    });
  });

  it('sanitizes the stored rotation family from a migrated refresh record', async () => {
    const signer = await createStaticSigningKeyProvider();
    const store = new InMemoryOAuthStore();
    await store.putClient(CLIENT);
    const refreshToken = 'migrated-dirty-refresh';
    const now = Date.now();
    const authTime = Math.floor(now / 1_000) - 60;
    await store.createRefreshToken({
      token: hashToken(refreshToken),
      clientId: CLIENT.client_id,
      ownerSubject: 'principal-1',
      resource: new URL(RESOURCE).href,
      scope: `openid email ${FRESH_AUTH_SCOPE}`,
      authTime,
      expiresAt: Math.floor(now / 1_000) + 3_600,
      familyId: 'migrated-family',
    });
    const provider = new NoodleOAuthProvider({
      issuer: ISSUER,
      store,
      signer,
      now: () => now,
      signupMode: 'public',
    });

    const refreshed = await provider.exchangeRefreshToken(
      CLIENT,
      refreshToken,
      undefined,
      new URL(RESOURCE),
    );

    expect(refreshed.scope).toBe('openid email');
    expect(refreshed.scope).not.toContain(FRESH_AUTH_SCOPE);
    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    await expect(verify(refreshed.access_token, new URL(RESOURCE).href)).resolves.toMatchObject({
      caller: {
        scopes: ['email', 'openid'],
        authTime,
      },
    });

    const persistedSuccessor = await store.getRefreshToken(
      hashToken(refreshed.refresh_token as string),
    );
    expect(persistedSuccessor).toMatchObject({
      scope: 'openid email',
      authTime,
    });
    expect(persistedSuccessor?.scope).not.toContain(FRESH_AUTH_SCOPE);

    const secondRotation = await store.rotateRefreshToken({
      oldTokenHash: hashToken(refreshed.refresh_token as string),
      clientId: CLIENT.client_id,
      newTokenHash: 'migrated-clean-successor',
      newExpiresAt: Math.floor(now / 1_000) + 3_600,
      graceSeconds: 30,
      recoverySeconds: 300,
      nowSeconds: Math.floor(now / 1_000) + 1,
    });
    expect(secondRotation).toMatchObject({
      status: 'rotated',
      identity: { scope: 'openid email', authTime },
    });
    await expect(store.getRefreshToken('migrated-clean-successor')).resolves.toMatchObject({
      scope: 'openid email',
      authTime,
    });
  });
});

async function completeGoogleCallback(
  provider: NoodleOAuthProvider,
  upstreamLocation: string,
  expectFresh: boolean,
): Promise<string> {
  const state = new URL(upstreamLocation).searchParams.get('state');
  expect(state).toBeTruthy();
  const callback = responseRecorder();
  await provider.handleGoogleCallback(
    { query: { code: 'upstream-code', state } } as unknown as Request,
    callback.response,
  );
  const redirect = new URL(callback.lastRedirect());
  const code = redirect.searchParams.get('code');
  expect(code).toBeTruthy();
  if (!expectFresh) expect(redirect.searchParams.has('auth_time')).toBe(false);
  return code as string;
}

async function completeGoogleCallbackThroughConsent(
  provider: NoodleOAuthProvider,
  upstreamLocation: string,
): Promise<string> {
  const state = new URL(upstreamLocation).searchParams.get('state');
  expect(state).toBeTruthy();
  const callback = responseRecorder();
  await provider.handleGoogleCallback(
    { query: { code: 'upstream-code', state } } as unknown as Request,
    callback.response,
  );
  const consentHtml = callback.lastSent();
  expect(consentHtml).not.toContain(FRESH_AUTH_SCOPE);
  const consentToken = /name="consent_token" value="([^"]+)"/.exec(consentHtml)?.[1];
  expect(consentToken).toBeTruthy();

  const approval = responseRecorder();
  await provider.handleConsent(
    {
      body: { consent_token: consentToken, decision: 'approve' },
    } as unknown as Request,
    approval.response,
  );
  const code = new URL(approval.lastRedirect()).searchParams.get('code');
  expect(code).toBeTruthy();
  return code as string;
}

function responseRecorder(): {
  readonly response: Response;
  readonly lastRedirect: () => string;
  readonly lastSent: () => string;
} {
  const redirects: string[] = [];
  const sent: string[] = [];
  const response = {
    status: vi.fn(),
    setHeader: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
    redirect: vi.fn(),
  } as unknown as Response;
  vi.mocked(response.status).mockReturnValue(response);
  vi.mocked(response.setHeader).mockReturnValue(response);
  vi.mocked(response.type).mockReturnValue(response);
  vi.mocked(response.send).mockImplementation((body?: unknown) => {
    if (typeof body === 'string') sent.push(body);
    return response;
  });
  vi.mocked(response.redirect).mockImplementation(
    (statusOrLocation: number | string, maybeLocation?: string) => {
      redirects.push(
        typeof statusOrLocation === 'string' ? statusOrLocation : (maybeLocation as string),
      );
      return response;
    },
  );
  return {
    response,
    lastRedirect: () => {
      const location = redirects.at(-1);
      if (location === undefined) throw new Error('expected redirect');
      return location;
    },
    lastSent: () => {
      const body = sent.at(-1);
      if (body === undefined) throw new Error('expected response body');
      return body;
    },
  };
}
