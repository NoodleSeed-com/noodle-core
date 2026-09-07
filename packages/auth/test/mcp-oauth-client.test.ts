import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  McpOAuthClient,
  type McpOAuthDiscovery,
  parseBearerChallenge,
  protectedResourceMetadataUrl,
} from '../src/index.js';

const RESOURCE = 'http://127.0.0.1:7447/o/local/orders/dev/mcp';
const ISSUER = 'http://127.0.0.1:7557/tenant';
const REDIRECT = 'http://127.0.0.1:7667/auth/callback';

describe('MCP OAuth public client', () => {
  it('discovers exact protected-resource and issuer metadata in MCP order', async () => {
    const requested: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url === protectedResourceMetadataUrl(RESOURCE)) {
        return json({
          resource: RESOURCE,
          authorization_servers: [ISSUER],
          scopes_supported: ['orders:read'],
        });
      }
      if (url.endsWith('/.well-known/oauth-authorization-server/tenant')) {
        return new Response('missing', { status: 404 });
      }
      if (url.endsWith('/.well-known/openid-configuration/tenant')) {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          registration_endpoint: `${ISSUER}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const client = localClient(fetchFn);

    const discovery = await client.discover();

    expect(requested).toEqual([
      protectedResourceMetadataUrl(RESOURCE),
      'http://127.0.0.1:7557/.well-known/oauth-authorization-server/tenant',
      'http://127.0.0.1:7557/.well-known/openid-configuration/tenant',
    ]);
    expect(discovery).toMatchObject({
      resource: RESOURCE,
      issuer: ISSUER,
      scopes: ['orders:read'],
      authorizationResponseIssuerRequired: true,
    });
  });

  it('rejects metadata whose issuer is not byte-for-byte equal to the configured issuer', async () => {
    const client = localClient(async (input) => {
      const url = String(input);
      if (url === protectedResourceMetadataUrl(RESOURCE)) {
        return json({ resource: RESOURCE, authorization_servers: [ISSUER] });
      }
      return json({
        issuer: `${ISSUER}/`,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    });

    await expect(client.discover()).rejects.toThrow(/issuer metadata/i);
  });

  it('fails closed on redirects or incomplete public-client metadata', async () => {
    const redirected = vi.fn(async () =>
      Response.redirect('https://attacker.example.test/metadata', 302),
    );
    await expect(localClient(redirected).discover()).rejects.toThrow(/HTTP 302/i);
    expect(redirected).toHaveBeenCalledWith(
      protectedResourceMetadataUrl(RESOURCE),
      expect.objectContaining({ redirect: 'manual' }),
    );

    const incomplete = localClient(async (input) => {
      const url = String(input);
      if (url === protectedResourceMetadataUrl(RESOURCE)) {
        return json({ resource: RESOURCE, authorization_servers: [ISSUER] });
      }
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    });
    await expect(incomplete.discover()).rejects.toThrow(/PKCE S256/i);
  });

  it('registers a native public client and starts PKCE with resource and selected scopes', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = localClient(async (input, init) => {
      requests.push({ url: String(input), init });
      return json({
        client_id: 'devtools-client',
        token_endpoint_auth_method: 'none',
        redirect_uris: [REDIRECT],
      });
    });
    const discovery = discovered();

    const registration = await client.register(discovery, ['orders:read', 'profile']);
    const pending = client.beginAuthorization(discovery, registration, ['profile', 'orders:read']);
    const registrationBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    const authorize = new URL(pending.authorizationUrl);

    expect(registrationBody).toMatchObject({
      application_type: 'native',
      client_name: 'Noodle Seed Devtools',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'orders:read profile',
    });
    expect(authorize.searchParams.get('resource')).toBe(RESOURCE);
    expect(authorize.searchParams.get('scope')).toBe('orders:read profile');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).toBe(pending.state);
    expect(authorize.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(pending.codeVerifier).digest('base64url'),
    );
  });

  it('validates state and callback issuer before exchanging the code', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = localClient(async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? '') });
      return json({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'orders:read',
      });
    });
    const discovery = discovered({ authorizationResponseIssuerRequired: true });
    const registration = {
      clientId: 'devtools-client',
      tokenEndpointAuthMethod: 'none' as const,
    };
    const pending = client.beginAuthorization(discovery, registration, ['orders:read']);

    await expect(
      client.exchangeCallback(
        discovery,
        registration,
        pending,
        `${REDIRECT}?code=code-1&state=${pending.state}`,
      ),
    ).rejects.toThrow(/issuer/i);
    await expect(
      client.exchangeCallback(
        discovery,
        registration,
        pending,
        `${REDIRECT}?code=code-1&state=${pending.state}&iss=${encodeURIComponent(`${ISSUER}/`)}`,
      ),
    ).rejects.toThrow(/issuer/i);
    expect(requests).toEqual([]);

    const tokens = await client.exchangeCallback(
      discovery,
      registration,
      pending,
      `${REDIRECT}?code=code-1&state=${pending.state}&iss=${encodeURIComponent(ISSUER)}`,
    );

    expect(tokens).toMatchObject({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      scope: ['orders:read'],
    });
    const body = new URLSearchParams(requests[0]?.body);
    expect(body.get('resource')).toBe(RESOURCE);
    expect(body.get('code_verifier')).toBe(pending.codeVerifier);
    expect(body.get('client_id')).toBe('devtools-client');
  });

  it('refreshes in memory and preserves a refresh token omitted by the response', async () => {
    const requests: string[] = [];
    const client = localClient(async (_input, init) => {
      requests.push(String(init?.body ?? ''));
      return json({
        access_token: 'next-access',
        token_type: 'Bearer',
        expires_in: 300,
      });
    });

    const tokens = await client.refresh(
      discovered(),
      { clientId: 'devtools-client', tokenEndpointAuthMethod: 'none' },
      {
        accessToken: 'old-access',
        refreshToken: 'refresh-secret',
        tokenType: 'Bearer',
        scope: ['orders:read'],
      },
    );

    expect(tokens.refreshToken).toBe('refresh-secret');
    const body = new URLSearchParams(requests[0]);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('resource')).toBe(RESOURCE);
  });
});

describe('Bearer challenge parsing', () => {
  it('extracts step-up scopes without exposing unrelated challenge fields', () => {
    expect(
      parseBearerChallenge(
        'Bearer error="insufficient_scope", scope="orders:read orders:write", resource_metadata="https://example.test/meta"',
      ),
    ).toEqual({
      error: 'insufficient_scope',
      scopes: ['orders:read', 'orders:write'],
    });
    expect(parseBearerChallenge('Basic realm="example"')).toBeUndefined();
  });
});

function localClient(fetchFn: typeof fetch): McpOAuthClient {
  return new McpOAuthClient({
    resource: RESOURCE,
    issuer: ISSUER,
    redirectUri: REDIRECT,
    fetchFn,
    allowInsecureLocalhost: true,
  });
}

function discovered(override: Partial<McpOAuthDiscovery> = {}): McpOAuthDiscovery {
  return {
    resource: RESOURCE,
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    registrationEndpoint: `${ISSUER}/register`,
    scopes: ['orders:read'],
    authorizationResponseIssuerRequired: false,
    ...override,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
