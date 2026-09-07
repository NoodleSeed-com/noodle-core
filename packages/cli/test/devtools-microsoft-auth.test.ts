import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MicrosoftDevtoolsAuthDriver,
  MicrosoftDevtoolsAuthError,
} from '../src/devtools-microsoft-auth.js';

const resource = 'http://127.0.0.1:4311/o/local/microsoft/dev/mcp';
const redirectUri = 'http://localhost:4312/auth/callback/microsoft';
const tenantId = '11111111-2222-3333-4444-555555555555';
const clientId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('Microsoft Devtools auth driver', () => {
  it('builds confidential authorization-code sign-in with PKCE, nonce, and a stable localhost path', async () => {
    const driver = createDriver();
    const discovery = await driver.discover();
    const registration = await driver.register(discovery);

    const pending = driver.beginAuthorization(discovery, registration);
    const authorize = new URL(pending.authorizationUrl);

    expect(authorize.origin + authorize.pathname).toBe(
      'https://login.microsoftonline.test/authorize',
    );
    expect(authorize.searchParams.get('client_id')).toBe(clientId);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('response_mode')).toBe('query');
    expect(authorize.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorize.searchParams.get('state')).toBe('microsoft-state-123');
    expect(authorize.searchParams.get('nonce')).toBe('microsoft-nonce-123');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update('microsoft-code-verifier-123').digest('base64url'),
    );
    expect(new Set((authorize.searchParams.get('scope') ?? '').split(' '))).toEqual(
      new Set([
        'openid',
        'profile',
        'email',
        'offline_access',
        'https://graph.microsoft.com/User.Read',
      ]),
    );
    expect(pending.authorizationUrl).not.toContain('microsoft-client-secret');
  });

  it('exchanges and refreshes server-side while forwarding only the verified ID-token shape', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token_type: 'Bearer',
          access_token: 'graph-access-token',
          refresh_token: 'microsoft-refresh-token',
          id_token: jwt({
            aud: clientId,
            iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
            nonce: 'microsoft-nonce-123',
            exp: 1_120,
          }),
          expires_in: 120,
          scope: 'openid profile email offline_access https://graph.microsoft.com/User.Read',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          token_type: 'Bearer',
          access_token: 'refreshed-graph-access-token',
          refresh_token: 'rotated-microsoft-refresh-token',
          id_token: jwt({
            aud: clientId,
            iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
            exp: 4_600,
          }),
          expires_in: 3_600,
          scope: 'openid profile email offline_access https://graph.microsoft.com/User.Read',
        }),
      );
    const driver = createDriver({ fetchFn });
    const discovery = await driver.discover();
    const registration = await driver.register(discovery);
    const pending = driver.beginAuthorization(discovery, registration);

    const tokens = await driver.exchangeCallback(
      discovery,
      registration,
      pending,
      `http://127.0.0.1:4312/auth/callback/microsoft?code=microsoft-code&state=${pending.state}`,
    );
    expect(tokens).toMatchObject({
      accessToken: expect.stringContaining('.'),
      refreshToken: 'microsoft-refresh-token',
      tokenType: 'Bearer',
      expiresAt: 1_120_000,
    });
    expect(tokens.accessToken).not.toBe('graph-access-token');

    const exchange = request(fetchFn, 0);
    expect(exchange.url).toBe('https://login.microsoftonline.test/token');
    expect(exchange.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({
        'content-type': 'application/x-www-form-urlencoded',
      }),
    });
    const exchangeBody = new URLSearchParams(String(exchange.init?.body));
    expect(exchangeBody.get('grant_type')).toBe('authorization_code');
    expect(exchangeBody.get('code')).toBe('microsoft-code');
    expect(exchangeBody.get('code_verifier')).toBe('microsoft-code-verifier-123');
    expect(exchangeBody.get('redirect_uri')).toBe(redirectUri);
    expect(exchangeBody.get('client_id')).toBe(clientId);
    expect(exchangeBody.get('client_secret')).toBe('microsoft-client-secret');

    await expect(driver.refresh(tokens)).resolves.toMatchObject({
      accessToken: expect.stringContaining('.'),
      refreshToken: 'rotated-microsoft-refresh-token',
      expiresAt: 4_600_000,
    });
    const refreshBody = new URLSearchParams(String(request(fetchFn, 1).init?.body));
    expect(refreshBody.get('grant_type')).toBe('refresh_token');
    expect(refreshBody.get('refresh_token')).toBe('microsoft-refresh-token');
    expect(refreshBody.get('client_secret')).toBe('microsoft-client-secret');
  });

  it('supports client_secret_basic without placing the secret in the form body', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        token_type: 'Bearer',
        access_token: 'graph-access-token',
        refresh_token: 'microsoft-refresh-token',
        id_token: jwt({
          aud: clientId,
          iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
          nonce: 'microsoft-nonce-123',
          exp: 1_120,
        }),
      }),
    );
    const driver = createDriver({ fetchFn, authMethod: 'client_secret_basic' });
    const discovery = await driver.discover();
    const registration = await driver.register(discovery);
    const pending = driver.beginAuthorization(discovery, registration);

    await driver.exchangeCallback(
      discovery,
      registration,
      pending,
      `http://localhost:4312/auth/callback/microsoft?code=code&state=${pending.state}`,
    );

    const sent = request(fetchFn, 0).init;
    expect(new Headers(sent?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from(`${clientId}:microsoft-client-secret`).toString('base64')}`,
    );
    expect(new URLSearchParams(String(sent?.body)).has('client_secret')).toBe(false);
  });

  it('reports only an allowlisted provider code and remediation for a failed exchange', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: 'invalid_client',
          error_description:
            'AADSTS7000215: Invalid client secret secret-provider-detail. Trace ID: trace-secret. Correlation ID: correlation-secret.',
          error_codes: [7000215],
          trace_id: 'trace-secret',
          correlation_id: 'correlation-secret',
        },
        { status: 401 },
      ),
    );
    const driver = createDriver({ fetchFn });
    const discovery = await driver.discover();
    const registration = await driver.register(discovery);
    const pending = driver.beginAuthorization(discovery, registration);

    const error = await driver
      .exchangeCallback(
        discovery,
        registration,
        pending,
        `http://localhost:4312/auth/callback/microsoft?code=code&state=${pending.state}`,
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MicrosoftDevtoolsAuthError);
    expect(error).toMatchObject({
      code: 'AADSTS7000215',
      message:
        'Microsoft rejected the client secret. Create a fresh secret value for this app registration.',
    });
    expect(JSON.stringify(error)).not.toMatch(
      /secret-provider-detail|trace-secret|correlation-secret|invalid_client/u,
    );
  });

  it('rejects callback substitution, nonce mismatch, oversized responses, and insecure remote endpoints', async () => {
    const driver = createDriver();
    const discovery = await driver.discover();
    const registration = await driver.register(discovery);
    const pending = driver.beginAuthorization(discovery, registration);

    await expect(
      driver.exchangeCallback(
        discovery,
        registration,
        pending,
        `http://localhost:4312/auth/callback/other?code=code&state=${pending.state}`,
      ),
    ).rejects.toThrow(/callback/i);

    const badNonce = createDriver({
      fetchFn: vi.fn(async () =>
        Response.json({
          token_type: 'Bearer',
          access_token: 'graph-token',
          id_token: jwt({
            aud: clientId,
            iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
            nonce: 'wrong-nonce',
            exp: 1_120,
          }),
        }),
      ),
    });
    const badDiscovery = await badNonce.discover();
    const badRegistration = await badNonce.register(badDiscovery);
    const badPending = badNonce.beginAuthorization(badDiscovery, badRegistration);
    await expect(
      badNonce.exchangeCallback(
        badDiscovery,
        badRegistration,
        badPending,
        `http://localhost:4312/auth/callback/microsoft?code=code&state=${badPending.state}`,
      ),
    ).rejects.toThrow(/nonce/i);

    const oversized = createDriver({
      fetchFn: vi.fn(async () => new Response('x'.repeat(256 * 1_024 + 1))),
    });
    const oversizedDiscovery = await oversized.discover();
    const oversizedRegistration = await oversized.register(oversizedDiscovery);
    const oversizedPending = oversized.beginAuthorization(
      oversizedDiscovery,
      oversizedRegistration,
    );
    await expect(
      oversized.exchangeCallback(
        oversizedDiscovery,
        oversizedRegistration,
        oversizedPending,
        `http://localhost:4312/auth/callback/microsoft?code=code&state=${oversizedPending.state}`,
      ),
    ).rejects.toThrow(/too large/i);

    expect(
      () =>
        new MicrosoftDevtoolsAuthDriver({
          resource,
          redirectUri,
          auth: {
            kind: 'microsoft',
            tenantId,
            clientId,
            clientSecret: 'microsoft-client-secret',
            authorizeUrl: 'http://login.example.test/authorize',
          },
        }),
    ).toThrow(/HTTPS/i);
  });
});

function createDriver(
  options: {
    readonly fetchFn?: typeof fetch;
    readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
  } = {},
): MicrosoftDevtoolsAuthDriver {
  return new MicrosoftDevtoolsAuthDriver({
    resource,
    redirectUri,
    auth: {
      kind: 'microsoft',
      tenantId,
      clientId,
      clientSecret: 'microsoft-client-secret',
      authorizeUrl: 'https://login.microsoftonline.test/authorize',
      tokenUrl: 'https://login.microsoftonline.test/token',
      scopes: ['https://graph.microsoft.com/User.Read'],
      ...(options.authMethod === undefined ? {} : { authMethod: options.authMethod }),
    },
    fetchFn: options.fetchFn ?? vi.fn(async () => new Response('not reached', { status: 500 })),
    now: () => 1_000_000,
    stateFactory: () => 'microsoft-state-123',
    codeVerifierFactory: () => 'microsoft-code-verifier-123',
    nonceFactory: () => 'microsoft-nonce-123',
  });
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function request(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const call = fetchFn.mock.calls[index];
  if (call === undefined) throw new Error(`missing fetch call ${index}`);
  return { url: String(call[0]), init: call[1] };
}
