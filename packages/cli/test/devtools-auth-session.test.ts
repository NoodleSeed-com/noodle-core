import type {
  McpOAuthClientRegistration,
  McpOAuthDiscovery,
  McpOAuthPendingAuthorization,
  McpOAuthTokens,
} from '@noodle-borg/auth';
import { describe, expect, it, vi } from 'vitest';
import {
  DevtoolsAuthRequiredError,
  DevtoolsAuthSession,
  type DevtoolsFirebaseDriver,
  type DevtoolsOAuthDriver,
} from '../src/devtools-auth-session.js';

const discovery: McpOAuthDiscovery = {
  resource: 'http://127.0.0.1:7001/o/local/app/dev/mcp',
  issuer: 'https://login.example.test',
  authorizationEndpoint: 'https://login.example.test/authorize',
  tokenEndpoint: 'https://login.example.test/token',
  registrationEndpoint: 'https://login.example.test/register',
  scopes: ['orders:read'],
  authorizationResponseIssuerRequired: true,
};
const registration: McpOAuthClientRegistration = {
  clientId: 'client-1',
  tokenEndpointAuthMethod: 'none',
};
const pending: McpOAuthPendingAuthorization = {
  authorizationUrl: 'https://login.example.test/authorize?state=state-secret',
  state: 'state-secret',
  codeVerifier: 'verifier-secret',
  scopes: ['orders:read'],
};

describe('DevtoolsAuthSession', () => {
  it('settles a challenged tool promptly when its matching provider callback fails', async () => {
    const driver = fakeDriver();
    driver.exchangeCallback = vi.fn(async () => {
      throw new Error('access_denied');
    });
    const session = createSession(driver);
    let outcome: boolean | undefined;
    const waiting = session.requestSignIn().then((value) => {
      outcome = value;
    });
    await session.start();
    await expect(
      session.complete('http://127.0.0.1:7002/auth/callback?state=wrong&error=access_denied'),
    ).rejects.toThrow('does not match');
    expect(outcome).toBeUndefined();
    await expect(
      session.complete(
        'http://127.0.0.1:7002/auth/callback?state=state-secret&error=access_denied',
      ),
    ).rejects.toThrow('access_denied');
    await Promise.resolve();
    try {
      expect(outcome).toBe(false);
      expect(session.status()).not.toHaveProperty('signInRequested');
    } finally {
      session.clear();
      await waiting;
    }
  });

  it('keeps OAuth credentials in memory and returns only safe status fields', async () => {
    const driver = fakeDriver();
    const session = new DevtoolsAuthSession({
      resource: discovery.resource,
      redirectUri: 'http://127.0.0.1:7002/auth/callback',
      auth: { kind: 'oidc', issuer: discovery.issuer },
      driver,
    });

    expect(session.status()).toEqual({
      required: true,
      supported: true,
      state: 'signed_out',
      issuer: discovery.issuer,
      scopes: [],
    });

    expect(await session.start()).toBe(pending.authorizationUrl);
    expect(session.status()).toMatchObject({
      state: 'authorizing',
      issuer: discovery.issuer,
      scopes: ['orders:read'],
    });
    expect(JSON.stringify(session.status())).not.toMatch(/state-secret|verifier-secret|client-1/);

    await session.complete(
      'http://127.0.0.1:7002/auth/callback?code=code-1&state=state-secret&iss=https%3A%2F%2Flogin.example.test',
    );
    expect(await session.accessToken()).toBe('access-secret');
    expect(session.status()).toMatchObject({
      state: 'signed_in',
      scopes: ['orders:read'],
    });
    expect(JSON.stringify(session.status())).not.toMatch(/access-secret|refresh-secret/);

    session.clear();
    await expect(session.accessToken()).rejects.toBeInstanceOf(DevtoolsAuthRequiredError);
    expect(session.status().state).toBe('signed_out');
  });

  it('refreshes an expiring token and preserves the new safe status', async () => {
    const driver = fakeDriver({
      exchangeTokens: {
        accessToken: 'expired-soon',
        refreshToken: 'refresh-secret',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 1_000,
        scope: ['orders:read'],
      },
    });
    const session = createSession(driver);
    await session.start();
    await session.complete(
      'http://127.0.0.1:7002/auth/callback?code=code-1&state=state-secret&iss=https%3A%2F%2Flogin.example.test',
    );

    expect(await session.accessToken()).toBe('refreshed-access');
    expect(driver.refresh).toHaveBeenCalledOnce();
    expect(session.status()).toMatchObject({
      state: 'signed_in',
      scopes: ['orders:read'],
    });
  });

  it('clears rejected credentials while preserving a safe retryable diagnostic', async () => {
    const driver = fakeDriver();
    const session = createSession(driver);
    await session.start();
    await session.complete(
      'http://127.0.0.1:7002/auth/callback?code=code-1&state=state-secret&iss=https%3A%2F%2Flogin.example.test',
    );

    session.rejectToken();

    expect(session.status()).toMatchObject({
      state: 'error',
      errorCode: 'oauth_token_rejected',
      message:
        'The MCP server rejected the issued token. Verify its issuer, signing key, and configured audience, then sign in again.',
    });
    expect(JSON.stringify(session.status())).not.toMatch(
      /access-secret|refresh-secret|client-1|state-secret/u,
    );
    await expect(session.accessToken()).rejects.toBeInstanceOf(DevtoolsAuthRequiredError);

    await expect(session.start()).resolves.toBe(pending.authorizationUrl);
    expect(session.status()).toMatchObject({ state: 'authorizing' });
    expect(session.status()).not.toHaveProperty('errorCode');
  });

  it('single-flights concurrent refreshes for a rotating refresh token', async () => {
    const driver = fakeDriver({
      exchangeTokens: {
        accessToken: 'expired-soon',
        refreshToken: 'refresh-secret',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 1_000,
        scope: ['orders:read'],
      },
    });
    const session = createSession(driver);
    await session.start();
    await session.complete(
      'http://127.0.0.1:7002/auth/callback?code=code-1&state=state-secret&iss=https%3A%2F%2Flogin.example.test',
    );

    expect(await Promise.all([session.accessToken(), session.accessToken()])).toEqual([
      'refreshed-access',
      'refreshed-access',
    ]);
    expect(driver.refresh).toHaveBeenCalledOnce();
  });

  it('does not restore a refreshed credential after logout wins the race', async () => {
    const driver = fakeDriver({
      exchangeTokens: {
        accessToken: 'expired-soon',
        refreshToken: 'refresh-secret',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 1_000,
        scope: ['orders:read'],
      },
    });
    let finishRefresh: ((tokens: McpOAuthTokens) => void) | undefined;
    driver.refresh = vi.fn(
      () =>
        new Promise<McpOAuthTokens>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const session = createSession(driver);
    await session.start();
    await session.complete(
      'http://127.0.0.1:7002/auth/callback?code=code-1&state=state-secret&iss=https%3A%2F%2Flogin.example.test',
    );

    const token = session.accessToken();
    await vi.waitFor(() => expect(driver.refresh).toHaveBeenCalledOnce());
    session.clear();
    finishRefresh?.({
      accessToken: 'must-not-return',
      refreshToken: 'rotated-refresh',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 300_000,
      scope: ['orders:read'],
    });

    await expect(token).rejects.toBeInstanceOf(DevtoolsAuthRequiredError);
    expect(session.status().state).toBe('signed_out');
  });

  it('turns an insufficient-scope challenge into a unioned reauthorization request', async () => {
    const driver = fakeDriver();
    const session = createSession(driver);
    await session.start();
    await session.complete(
      'http://127.0.0.1:7002/auth/callback?code=code-1&state=state-secret&iss=https%3A%2F%2Flogin.example.test',
    );

    session.noteBearerChallenge(
      403,
      'Bearer error="insufficient_scope", scope="orders:write orders:read"',
    );

    expect(session.status()).toMatchObject({
      state: 'reauthorization_required',
      scopes: ['orders:read', 'orders:write'],
    });
    await expect(session.accessToken()).rejects.toBeInstanceOf(DevtoolsAuthRequiredError);
    await session.start();
    expect(driver.beginAuthorization).toHaveBeenLastCalledWith(discovery, registration, [
      'orders:read',
      'orders:write',
    ]);
  });

  it('requires an allowlisted federated issuer and clears the active credential when switching', async () => {
    const workforceIssuer = 'https://workforce.example.test';
    const customerIssuer = 'https://customers.example.test';
    const workforce = federatedDriver(workforceIssuer, 'workforce-access');
    const customers = federatedDriver(customerIssuer, 'customer-access');
    const drivers = new Map([
      [workforceIssuer, workforce],
      [customerIssuer, customers],
    ]);
    const driverFactory = vi.fn((issuer: string) => {
      const driver = drivers.get(issuer);
      if (!driver) throw new Error('unexpected issuer');
      return driver;
    });
    const session = new DevtoolsAuthSession({
      resource: discovery.resource,
      redirectUri: 'http://127.0.0.1:7002/auth/callback',
      auth: {
        kind: 'federatedOidc',
        issuers: [workforceIssuer, customerIssuer],
      },
      driverFactory,
    });

    expect(session.status()).toEqual({
      required: true,
      supported: true,
      state: 'signed_out',
      issuers: [workforceIssuer, customerIssuer],
      scopes: [],
    });
    await expect(session.start()).rejects.toThrow(/choose an identity provider/i);
    await expect(session.start('https://attacker.example.test')).rejects.toThrow(/not configured/i);
    expect(driverFactory).not.toHaveBeenCalled();

    await expect(session.start(customerIssuer)).resolves.toContain(customerIssuer);
    expect(session.status()).toMatchObject({
      state: 'authorizing',
      issuer: customerIssuer,
      issuers: [workforceIssuer, customerIssuer],
    });
    await session.complete(
      `http://127.0.0.1:7002/auth/callback?code=customer-code&state=customers-state&iss=${encodeURIComponent(customerIssuer)}`,
    );
    await expect(session.accessToken()).resolves.toBe('customer-access');

    await expect(session.start(workforceIssuer)).resolves.toContain(workforceIssuer);
    await expect(session.accessToken()).rejects.toBeInstanceOf(DevtoolsAuthRequiredError);
    expect(session.status()).toMatchObject({
      state: 'authorizing',
      issuer: workforceIssuer,
    });
    await expect(
      session.complete(
        `http://127.0.0.1:7002/auth/callback?code=stale-code&state=customers-state&iss=${encodeURIComponent(customerIssuer)}`,
      ),
    ).rejects.toThrow(/active sign-in/i);
    expect(session.status()).toMatchObject({
      state: 'authorizing',
      issuer: workforceIssuer,
    });
    await session.complete(
      `http://127.0.0.1:7002/auth/callback?code=workforce-code&state=workforce-state&iss=${encodeURIComponent(workforceIssuer)}`,
    );
    await expect(session.accessToken()).resolves.toBe('workforce-access');

    expect(customers.register).toHaveBeenCalledOnce();
    expect(workforce.register).toHaveBeenCalledOnce();
    expect(driverFactory.mock.calls.map(([issuer]) => issuer)).toEqual([
      customerIssuer,
      workforceIssuer,
    ]);
  });

  it('keeps Firebase ID and refresh tokens server-only behind a single-use form-post state', async () => {
    const firebase = fakeFirebaseDriver();
    const session = new DevtoolsAuthSession({
      resource: discovery.resource,
      redirectUri: 'http://127.0.0.1:7002/auth/callback/random',
      auth: {
        kind: 'firebase',
        projectId: 'firebase-project',
        apiKey: 'public-web-key',
        authDomain: 'firebase-project.firebaseapp.com',
      },
      firebaseDriver: firebase,
    });

    expect(session.status()).toEqual({
      required: true,
      supported: true,
      state: 'signed_out',
      issuer: 'firebase-project.firebaseapp.com',
      method: 'firebase',
      scopes: [],
    });
    expect(session.callbackTransport()).toBe('form_post');
    await expect(session.start()).resolves.toBe(
      'https://auth.example.test/firebase?state=firebase-state',
    );
    expect(JSON.stringify(session.status())).not.toMatch(/firebase-state|public-web-key/u);

    await expect(
      session.completeFirebase({ state: 'attacker-state', idToken: 'attacker-id-token' }),
    ).rejects.toThrow(/active sign-in/i);
    await session.completeFirebase({
      state: 'firebase-state',
      idToken: 'firebase-id-token',
      refreshToken: 'firebase-refresh-token',
    });
    await expect(session.accessToken()).resolves.toBe('firebase-id-token');
    expect(session.status()).toMatchObject({ state: 'signed_in', method: 'firebase' });
    expect(JSON.stringify(session.status())).not.toMatch(
      /firebase-id-token|firebase-refresh-token|firebase-state/u,
    );
    await expect(
      session.completeFirebase({ state: 'firebase-state', idToken: 'replayed-id-token' }),
    ).rejects.toThrow(/no Firebase sign-in is pending/i);
  });

  it('refreshes an expiring Firebase ID token without exposing the rotating refresh token', async () => {
    const firebase = fakeFirebaseDriver({ expiresAt: Date.now() + 1_000 });
    const session = new DevtoolsAuthSession({
      resource: discovery.resource,
      redirectUri: 'http://127.0.0.1:7002/auth/callback/random',
      auth: { kind: 'firebase', projectId: 'firebase-project', apiKey: 'public-web-key' },
      firebaseDriver: firebase,
    });
    await session.start();
    await session.completeFirebase({
      state: 'firebase-state',
      idToken: 'firebase-id-token',
      refreshToken: 'firebase-refresh-token',
    });

    await expect(session.accessToken()).resolves.toBe('firebase-id-token-refreshed');
    expect(firebase.refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(session.status())).not.toContain('rotated-refresh-token');
  });

  it('keeps Microsoft confidential credentials and tokens behind the local session boundary', async () => {
    const microsoft = fakeDriver();
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const session = new DevtoolsAuthSession({
      resource: discovery.resource,
      redirectUri: 'http://localhost:7002/auth/callback/microsoft',
      auth: {
        kind: 'microsoft',
        tenantId,
        clientId: 'microsoft-client-id',
        clientSecret: 'microsoft-client-secret',
      },
      driver: microsoft,
    });

    expect(session.status()).toEqual({
      required: true,
      supported: true,
      state: 'signed_out',
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      method: 'microsoft',
      scopes: [],
    });
    await expect(session.start()).resolves.toBe(pending.authorizationUrl);
    expect(JSON.stringify(session.status())).not.toMatch(
      /microsoft-client-id|microsoft-client-secret|state-secret|verifier-secret/u,
    );
    await session.complete(
      'http://localhost:7002/auth/callback/microsoft?code=code-1&state=state-secret',
    );
    await expect(session.accessToken()).resolves.toBe('access-secret');
    expect(JSON.stringify(session.status())).not.toMatch(
      /microsoft-client-secret|access-secret|refresh-secret/u,
    );
  });

  it.each([
    { method: 'firebase' as const, subject: 'firebase-subject' },
    { method: 'microsoft' as const, subject: 'microsoft-subject' },
  ])('hands the $method refresh token to only the in-process delegated sink', async ({
    method,
    subject,
  }) => {
    const sink = {
      setCredential: vi.fn(async () => undefined),
      clearResource: vi.fn(() => undefined),
    };
    const idToken = jwt({ sub: subject, exp: Math.floor(Date.now() / 1_000) + 300 });
    const auth =
      method === 'firebase'
        ? ({ kind: 'firebase', projectId: 'firebase-project', apiKey: 'public-web-key' } as const)
        : ({
            kind: 'microsoft',
            tenantId: '11111111-2222-3333-4444-555555555555',
            clientId: 'microsoft-client-id',
            clientSecret: 'microsoft-client-secret',
          } as const);
    const session = new DevtoolsAuthSession({
      resource: discovery.resource,
      redirectUri:
        method === 'firebase'
          ? 'http://127.0.0.1:7002/auth/callback/random'
          : 'http://localhost:7002/auth/callback/microsoft',
      auth,
      delegatedCredentialSink: sink,
      ...(method === 'firebase'
        ? {
            firebaseDriver: fakeFirebaseDriverWithTokens({
              accessToken: idToken,
              refreshToken: `${method}-refresh-token`,
            }),
          }
        : {
            driver: fakeDriver({
              exchangeTokens: {
                accessToken: idToken,
                refreshToken: `${method}-refresh-token`,
                tokenType: 'Bearer',
                expiresAt: Date.now() + 300_000,
                scope: [],
              },
            }),
          }),
    });

    await session.start();
    if (method === 'firebase') {
      await session.completeFirebase({ state: 'firebase-state', idToken });
    } else {
      await session.complete(
        'http://localhost:7002/auth/callback/microsoft?code=code-1&state=state-secret',
      );
    }

    expect(sink.setCredential).toHaveBeenCalledWith({
      resource: discovery.resource,
      provider: method,
      subject,
      refreshToken: `${method}-refresh-token`,
    });
    expect(JSON.stringify(session.status())).not.toMatch(/refresh-token/u);
    session.clear();
    expect(sink.clearResource).toHaveBeenCalledWith(discovery.resource);
  });

  it('reports unsupported bridge methods without attempting an incompatible flow', async () => {
    const session = new DevtoolsAuthSession({
      resource: discovery.resource,
      redirectUri: 'http://127.0.0.1:7002/auth/callback',
      auth: { kind: 'unsupported', method: 'custom-bridge' },
    });

    expect(session.status()).toMatchObject({
      required: true,
      supported: false,
      state: 'unsupported',
      method: 'custom-bridge',
    });
    await expect(session.start()).rejects.toThrow(/not supported/i);
  });
});

function createSession(driver: DevtoolsOAuthDriver): DevtoolsAuthSession {
  return new DevtoolsAuthSession({
    resource: discovery.resource,
    redirectUri: 'http://127.0.0.1:7002/auth/callback',
    auth: { kind: 'oidc', issuer: discovery.issuer },
    driver,
  });
}

function fakeDriver(options: { exchangeTokens?: McpOAuthTokens } = {}): DevtoolsOAuthDriver & {
  refresh: ReturnType<typeof vi.fn>;
  beginAuthorization: ReturnType<typeof vi.fn>;
} {
  const exchangeTokens: McpOAuthTokens = options.exchangeTokens ?? {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 300_000,
    scope: ['orders:read'],
  };
  return {
    discover: vi.fn(async () => discovery),
    register: vi.fn(async () => registration),
    beginAuthorization: vi.fn(() => pending),
    exchangeCallback: vi.fn(async () => exchangeTokens),
    refresh: vi.fn(async () => ({
      accessToken: 'refreshed-access',
      refreshToken: 'refresh-secret',
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() + 300_000,
      scope: ['orders:read'],
    })),
  };
}

function federatedDriver(
  issuer: string,
  accessToken: string,
): DevtoolsOAuthDriver & {
  register: ReturnType<typeof vi.fn>;
} {
  const issuerName = new URL(issuer).hostname.split('.')[0] ?? 'issuer';
  const issuerDiscovery: McpOAuthDiscovery = {
    ...discovery,
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    registrationEndpoint: `${issuer}/register`,
  };
  const issuerRegistration: McpOAuthClientRegistration = {
    clientId: `${issuerName}-client`,
    tokenEndpointAuthMethod: 'none',
  };
  const issuerPending: McpOAuthPendingAuthorization = {
    authorizationUrl: `${issuer}/authorize?state=${issuerName}-state`,
    state: `${issuerName}-state`,
    codeVerifier: `${issuerName}-verifier`,
    scopes: ['orders:read'],
  };
  return {
    discover: vi.fn(async () => issuerDiscovery),
    register: vi.fn(async () => issuerRegistration),
    beginAuthorization: vi.fn(() => issuerPending),
    exchangeCallback: vi.fn(async (_discovery, _registration, activePending, callbackUrl) => {
      const callback = new URL(callbackUrl);
      if (
        callback.searchParams.get('state') !== activePending.state ||
        callback.searchParams.get('iss') !== issuer
      ) {
        throw new Error('callback does not match active sign-in');
      }
      return {
        accessToken,
        refreshToken: `${issuerName}-refresh`,
        tokenType: 'Bearer' as const,
        expiresAt: Date.now() + 300_000,
        scope: ['orders:read'],
      };
    }),
    refresh: vi.fn(async () => ({
      accessToken: `${accessToken}-refreshed`,
      refreshToken: `${issuerName}-refresh`,
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() + 300_000,
      scope: ['orders:read'],
    })),
  };
}

function fakeFirebaseDriver(
  options: { readonly expiresAt?: number } = {},
): DevtoolsFirebaseDriver & { readonly refresh: ReturnType<typeof vi.fn> } {
  return {
    beginAuthorization: vi.fn(() => ({
      authorizationUrl: 'https://auth.example.test/firebase?state=firebase-state',
      state: 'firebase-state',
      expiresAt: Date.now() + 300_000,
    })),
    completeAuthorization: vi.fn(async (_pending, callback) => ({
      accessToken: callback.idToken,
      ...(callback.refreshToken === undefined ? {} : { refreshToken: callback.refreshToken }),
      tokenType: 'Bearer' as const,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      scope: [],
    })),
    refresh: vi.fn(async () => ({
      accessToken: 'firebase-id-token-refreshed',
      refreshToken: 'rotated-refresh-token',
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() + 300_000,
      scope: [],
    })),
    renderAuthorizationPage: vi.fn(() => undefined),
  };
}

function fakeFirebaseDriverWithTokens(tokens: {
  readonly accessToken: string;
  readonly refreshToken: string;
}): DevtoolsFirebaseDriver {
  return {
    ...fakeFirebaseDriver(),
    completeAuthorization: vi.fn(async () => ({
      ...tokens,
      tokenType: 'Bearer' as const,
      expiresAt: Date.now() + 300_000,
      scope: [],
    })),
  };
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}
