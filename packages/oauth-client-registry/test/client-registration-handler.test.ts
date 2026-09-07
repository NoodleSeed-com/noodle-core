import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ClientRegistrationTestServer,
  startClientRegistrationTestServer,
} from './client-registration-test-server.js';

const HTTPS_REDIRECT = 'https://client.example/oauth/callback';
const LOOPBACK_REDIRECT = 'http://127.0.0.1:49152/oauth/callback';

describe('safeClientRegistrationHandler', () => {
  let fixture: ClientRegistrationTestServer;

  beforeEach(async () => {
    fixture = await startClientRegistrationTestServer();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it('persists and returns an explicit web client with the complete SDK record shape', async () => {
    const before = Math.floor(Date.now() / 1000);
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: [HTTPS_REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'Portable MCP Client',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'profile tools',
    });
    const after = Math.floor(Date.now() / 1000);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      application_type: 'web',
      redirect_uris: [HTTPS_REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      noodle_redirect_policy_version: 1,
      client_name: 'Portable MCP Client',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'profile tools',
    });
    expect(body.client_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.client_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.client_id_issued_at).toBeGreaterThanOrEqual(before);
    expect(body.client_id_issued_at).toBeLessThanOrEqual(after);
    expect(body.client_secret_expires_at).toBe(body.client_id_issued_at + 30 * 24 * 60 * 60);
    expect(fixture.store.registeredClients).toEqual([body]);
  });

  it('returns the async store-modified complete record without rebuilding it', async () => {
    await fixture.close();
    fixture = await startClientRegistrationTestServer('modify-non-policy');
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: [HTTPS_REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'Submitted client name',
    });
    const text = await response.text();
    const stored = fixture.store.registeredClients[0];

    expect(response.status).toBe(201);
    expect(JSON.parse(text)).toEqual(stored);
    expect(text).toBe(JSON.stringify(stored));
    expect(stored).toMatchObject({ client_name: 'Store-enforced client name' });
  });

  it.each([
    ['drops the provenance marker', 'drop-policy-field'],
    ['mutates the redirect list', 'mutate-policy-field'],
  ] as const)('returns a private server error after an async store %s', async (_description, storeMode) => {
    await fixture.close();
    fixture = await startClientRegistrationTestServer(storeMode);
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: [HTTPS_REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'Sensitive submitted client name',
    });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: 'server_error',
      error_description: 'Internal Server Error',
    });
    expect(text).not.toContain(HTTPS_REDIRECT);
    expect(text).not.toContain('Sensitive submitted client name');
    expect(text).not.toContain('store.example');
    expect(fixture.store.registeredClients).toHaveLength(1);
  });

  it('returns a private server error when an async store returns an invalid full record', async () => {
    await fixture.close();
    fixture = await startClientRegistrationTestServer('invalid-full-record');
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: [HTTPS_REDIRECT],
      token_endpoint_auth_method: 'none',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'Internal Server Error',
    });
    expect(fixture.store.registeredClients).toHaveLength(1);
  });

  it('persists an explicit native public client without secret fields', async () => {
    const response = await register(fixture, {
      application_type: 'native',
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      application_type: 'native',
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: 'none',
      noodle_redirect_policy_version: 1,
    });
    expect(body).not.toHaveProperty('client_secret');
    expect(body).not.toHaveProperty('client_secret_expires_at');
    expect(fixture.store.registeredClients).toEqual([body]);
  });

  it('normalizes an omitted application type to web and marks server-owned provenance', async () => {
    const response = await register(fixture, {
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: 'none',
      noodle_redirect_policy_version: 99,
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      application_type: 'web',
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: 'none',
      noodle_redirect_policy_version: 1,
    });
    expect(fixture.store.registeredClients).toEqual([body]);
  });

  it('defaults an omitted token method to client_secret_post and generates a secret', async () => {
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: [HTTPS_REDIRECT],
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.token_endpoint_auth_method).toBe('client_secret_post');
    expect(body.client_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.store.registeredClients).toEqual([body]);
  });

  it.each([
    'client_secret_basic',
    'private_key_jwt',
  ])('rejects unsupported token authentication method %s before storage', async (tokenEndpointAuthMethod) => {
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: [HTTPS_REDIRECT],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'token_endpoint_auth_method must be none or client_secret_post',
    });
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it('rejects unsafe redirects without reflecting the submitted URI or storing a client', async () => {
    const unsafeRedirect = 'http://attacker.example/private/callback';
    const response = await register(fixture, {
      application_type: 'native',
      redirect_uris: [HTTPS_REDIRECT, unsafeRedirect],
      token_endpoint_auth_method: 'none',
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: 'invalid_client_metadata',
      error_description:
        'redirect_uris must use HTTPS or a permitted loopback HTTP redirect without credentials or fragments',
    });
    expect(text).not.toContain(unsafeRedirect);
    expect(text).not.toContain('attacker.example');
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it.each([
    ['omitted-type', undefined, 'http://attacker.example.test\\@localhost/oauth/callback'],
    ['native IPv4', 'native', 'http://attacker.example.test\\@127.0.0.1/oauth/callback'],
    ['native IPv6 alternate', 'native', 'http://attacker.example.test\\\\@[::1]/oauth/callback'],
  ] as const)('rejects %s loopback-authority confusion before storing a client', async (_case, applicationType, redirectUri) => {
    const response = await register(fixture, {
      ...(applicationType === undefined ? {} : { application_type: applicationType }),
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ error: 'invalid_client_metadata' });
    expect(text).not.toContain(redirectUri);
    expect(text).not.toContain('attacker.example.test');
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it('does not trust a client-supplied provenance marker to admit explicit web loopback', async () => {
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: 'none',
      noodle_redirect_policy_version: 1,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' });
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it('uses the SDK-compatible OAuth error body for invalid metadata shape', async () => {
    const response = await register(fixture, {
      application_type: 'web',
      redirect_uris: HTTPS_REDIRECT,
      token_endpoint_auth_method: 'none',
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toEqual(expect.any(String));
    expect(Object.keys(body).sort()).toEqual(['error', 'error_description']);
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it('uses an OAuth metadata error for malformed JSON without reflection or storage', async () => {
    const response = await fetch(`${fixture.baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"redirect_uris":["${HTTPS_REDIRECT}"],`,
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'client metadata must be valid JSON',
    });
    expect(text).not.toContain(HTTPS_REDIRECT);
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it('preserves POST CORS, JSON content type, and no-store response headers', async () => {
    const response = await register(
      fixture,
      {
        application_type: 'web',
        redirect_uris: [HTTPS_REDIRECT],
        token_endpoint_auth_method: 'none',
      },
      { Origin: 'https://host.example' },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('preserves CORS preflight behavior', async () => {
    const response = await fetch(`${fixture.baseUrl}/register`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://host.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it('rejects non-POST methods with the SDK-compatible method error', async () => {
    const response = await fetch(`${fixture.baseUrl}/register`);

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toEqual({
      error: 'method_not_allowed',
      error_description: 'The method GET is not allowed for this endpoint',
    });
    expect(fixture.store.registeredClients).toHaveLength(0);
  });

  it('limits registration to 20 requests per hour for one IP', async () => {
    const statuses: number[] = [];
    for (let requestNumber = 0; requestNumber < 21; requestNumber += 1) {
      const response = await register(fixture, {
        application_type: 'web',
        redirect_uris: [HTTPS_REDIRECT],
        token_endpoint_auth_method: 'none',
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 201));
    expect(statuses[20]).toBe(429);
    expect(fixture.store.registeredClients).toHaveLength(20);
  });
});

function register(
  fixture: ClientRegistrationTestServer,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${fixture.baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
