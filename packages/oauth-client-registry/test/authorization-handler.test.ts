import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type SafeAuthorizationHandlerOptions,
  safeAuthorizationHandler,
} from '../src/authorization-handler.js';

const WEB_REDIRECT = 'https://client.example.test/oauth/callback';
const OTHER_WEB_REDIRECT = 'https://other.example.test/oauth/callback';
const LOOPBACK_REDIRECT = 'http://127.0.0.1:49152/oauth/callback';
const OTHER_LOOPBACK_PORT = 'http://127.0.0.1:49153/oauth/callback';

interface AuthorizationFixture {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly authorize: ReturnType<typeof vi.fn>;
  readonly getClient: ReturnType<typeof vi.fn>;
  readonly logEntries: Array<{ readonly event: string; readonly fields: object }>;
}

const fixtures: AuthorizationFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('safeAuthorizationHandler', () => {
  it.each([
    ['GET', undefined],
    ['POST', { response_type: 'code' }],
  ] as const)('delegates a normalized exact web redirect for %s', async (method, formBody) => {
    const fixture = await startAuthorizationFixture([
      client('normalized-web', [WEB_REDIRECT], {
        application_type: 'web',
        noodle_redirect_policy_version: 1,
      }),
    ]);

    const response = await authorizeRequest(fixture, {
      method,
      clientId: 'normalized-web',
      redirectUri: WEB_REDIRECT,
      formBody,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://upstream.example.test/login');
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
  });

  it('delegates a normalized native loopback port substitution from a form-encoded POST', async () => {
    const fixture = await startAuthorizationFixture([
      client('normalized-native', [LOOPBACK_REDIRECT], {
        application_type: 'native',
        noodle_redirect_policy_version: 1,
      }),
    ]);

    const response = await authorizeRequest(fixture, {
      method: 'POST',
      clientId: 'normalized-native',
      redirectUri: OTHER_LOOPBACK_PORT,
    });

    expect(response.status).toBe(302);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
  });

  it('returns a direct non-reflective invalid_request for a normalized redirect mismatch', async () => {
    const fixture = await startAuthorizationFixture([
      client('normalized-web', [WEB_REDIRECT], {
        application_type: 'web',
        noodle_redirect_policy_version: 1,
      }),
    ]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'normalized-web',
      redirectUri: OTHER_WEB_REDIRECT,
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: 'invalid_request',
      error_description: 'redirect_uri is not permitted for this client',
    });
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(OTHER_WEB_REDIRECT);
    expect(text).not.toContain(WEB_REDIRECT);
    expect(text).not.toContain('other.example.test');
    expect(text).not.toContain('client.example.test');
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('returns a private server_error without retrying through the SDK when the guard lookup fails', async () => {
    const fixture = await startAuthorizationFixture([
      client('normalized-web', [LOOPBACK_REDIRECT], {
        application_type: 'web',
        noodle_redirect_policy_version: 1,
      }),
    ]);
    fixture.getClient.mockRejectedValueOnce(new Error('store unavailable'));

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'normalized-web',
      redirectUri: OTHER_LOOPBACK_PORT,
    });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: 'server_error',
      error_description: 'Internal Server Error',
    });
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain('normalized-web');
    expect(text).not.toContain(LOOPBACK_REDIRECT);
    expect(text).not.toContain(OTHER_LOOPBACK_PORT);
    expect(text).not.toContain('store unavailable');
    expect(fixture.getClient).toHaveBeenCalledTimes(1);
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown client', 'unknown', WEB_REDIRECT],
    ['a malformed client_id', '', WEB_REDIRECT],
    ['a malformed redirect_uri', 'known', 'not a URI'],
  ])('delegates %s to the SDK phase-one direct error handling', async (_case, clientId, redirectUri) => {
    const fixture = await startAuthorizationFixture([client('known', [WEB_REDIRECT])]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId,
      redirectUri,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect((await response.json()).error).toMatch(/^invalid_(client|request)$/);
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('delegates an absent redirect_uri so the SDK selects the registered default', async () => {
    const fixture = await startAuthorizationFixture([client('known', [WEB_REDIRECT])]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'known',
    });

    expect(response.status).toBe(302);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['zero', client('zero-redirects', [])],
    ['multiple', client('multiple-redirects', [WEB_REDIRECT, OTHER_WEB_REDIRECT])],
  ] as const)('preserves the SDK direct error for %s registered redirects when omitted', async (_case, record) => {
    const fixture = await startAuthorizationFixture([record]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: record.client_id,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.logEntries).toEqual([]);
  });

  it('preserves SDK handling for an invalid sole registered redirect when omitted', async () => {
    const invalidRedirect = 'not a URI';
    const fixture = await startAuthorizationFixture([
      client('invalid-redirect', [invalidRedirect]),
    ]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'invalid-redirect',
    });

    expect(response.status).toBe(302);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
    expect(fixture.authorize.mock.calls[0]?.[1]).toMatchObject({ redirectUri: invalidRedirect });
    expect(fixture.logEntries).toEqual([]);
  });

  it('observes an unsafe sole registered redirect when redirect_uri is omitted', async () => {
    const unsafeRedirect = 'http://attacker.example.test/callback';
    const fixture = await startAuthorizationFixture([client('unsafe-legacy', [unsafeRedirect])]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'unsafe-legacy',
    });

    expect(response.status).toBe(302);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
    expect(fixture.logEntries).toEqual([
      {
        event: 'oauth.authorization_redirect.legacy_observed',
        fields: {
          policyClass: 'unsafe_legacy',
          reason: 'exact_match',
          allowed: true,
          usedLegacyLoopbackPortSubstitution: false,
        },
      },
    ]);
    expect(JSON.stringify(fixture.logEntries)).not.toContain('unsafe-legacy');
    expect(JSON.stringify(fixture.logEntries)).not.toContain(unsafeRedirect);
  });

  it.each([
    'GET',
    'POST',
  ] as const)('rejects an omitted unsafe sole redirect in deny mode for %s', async (method) => {
    const fixture = await startAuthorizationFixture(
      [client('unsafe-legacy', ['http://attacker.example.test/callback'])],
      { rollout: { unsafeLegacyMode: 'deny', loopbackPortMode: 'observe' } },
    );

    const response = await authorizeRequest(fixture, {
      method,
      clientId: 'unsafe-legacy',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).error).toBe('invalid_request');
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['safe omitted-type HTTPS', client('legacy-https', [WEB_REDIRECT]), WEB_REDIRECT],
    [
      'safe omitted-type exact loopback',
      client('legacy-loopback', [LOOPBACK_REDIRECT]),
      LOOPBACK_REDIRECT,
    ],
  ])('keeps %s authorization behavior compatible without a usage event', async (_case, record, redirectUri) => {
    const fixture = await startAuthorizationFixture([record]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: record.client_id,
      redirectUri,
    });

    expect(response.status).toBe(302);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
    expect(fixture.logEntries).toEqual([]);
  });

  it('keeps legacy loopback port substitution compatible and emits one closed usage event', async () => {
    const fixture = await startAuthorizationFixture([
      client('legacy-loopback', [LOOPBACK_REDIRECT]),
    ]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'legacy-loopback',
      redirectUri: OTHER_LOOPBACK_PORT,
    });

    expect(response.status).toBe(302);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
    expect(fixture.logEntries).toEqual([
      {
        event: 'oauth.authorization_redirect.legacy_observed',
        fields: {
          policyClass: 'safe_loopback_legacy',
          reason: 'legacy_loopback_port_match',
          allowed: true,
          usedLegacyLoopbackPortSubstitution: true,
        },
      },
    ]);
  });

  it.each([
    [
      'unsafe',
      client('unsafe-legacy', ['http://attacker.example.test/callback']),
      'http://attacker.example.test/callback',
      'unsafe_legacy',
      'exact_match',
    ],
    [
      'malformed',
      client('malformed-legacy', [WEB_REDIRECT, 'not a URI']),
      WEB_REDIRECT,
      'malformed_legacy',
      'malformed_client_metadata',
    ],
  ] as const)('keeps an %s legacy exact redirect compatible while logging only its closed classification', async (_case, record, redirectUri, policyClass, reason) => {
    const fixture = await startAuthorizationFixture([record]);

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: record.client_id,
      redirectUri,
    });

    expect(response.status).toBe(302);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
    expect(fixture.logEntries).toEqual([
      {
        event: 'oauth.authorization_redirect.legacy_observed',
        fields: {
          policyClass,
          reason,
          allowed: policyClass === 'unsafe_legacy',
          usedLegacyLoopbackPortSubstitution: false,
        },
      },
    ]);
    expect(JSON.stringify(fixture.logEntries)).not.toContain(record.client_id);
    expect(JSON.stringify(fixture.logEntries)).not.toContain(redirectUri);
  });

  it.each([
    [
      'legacy loopback substitution',
      client('legacy-loopback', [LOOPBACK_REDIRECT]),
      OTHER_LOOPBACK_PORT,
      {
        policyClass: 'safe_loopback_legacy',
        reason: 'legacy_loopback_port_match',
        allowed: true,
        usedLegacyLoopbackPortSubstitution: true,
      },
    ],
    [
      'unsafe legacy observation',
      client('unsafe-legacy', ['http://attacker.example.test/callback']),
      'http://attacker.example.test/callback',
      {
        policyClass: 'unsafe_legacy',
        reason: 'exact_match',
        allowed: true,
        usedLegacyLoopbackPortSubstitution: false,
      },
    ],
    [
      'malformed legacy observation',
      client('malformed-legacy', [WEB_REDIRECT, 'not a URI']),
      WEB_REDIRECT,
      {
        policyClass: 'malformed_legacy',
        reason: 'malformed_client_metadata',
        allowed: false,
        usedLegacyLoopbackPortSubstitution: false,
      },
    ],
  ] as const)('keeps %s compatible when the observation logger throws', async (_case, record, redirectUri, expectedFields) => {
    const info = vi.fn(() => {
      throw new Error('telemetry unavailable');
    });
    const fixture = await startAuthorizationFixture([record], { logger: { info } });

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: record.client_id,
      redirectUri,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://upstream.example.test/login');
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'oauth.authorization_redirect.legacy_observed',
      expectedFields,
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(record.client_id);
    expect(JSON.stringify(info.mock.calls)).not.toContain(redirectUri);
  });

  it.each([
    [
      'deny',
      client('unsafe-legacy', ['http://attacker.example.test/callback']),
      'http://attacker.example.test/callback',
      { unsafeLegacyMode: 'deny', loopbackPortMode: 'observe' },
    ],
    [
      'deny',
      client('malformed-legacy', [WEB_REDIRECT, 'not a URI']),
      WEB_REDIRECT,
      { unsafeLegacyMode: 'deny', loopbackPortMode: 'observe' },
    ],
    [
      'exact',
      client('legacy-loopback', [LOOPBACK_REDIRECT]),
      OTHER_LOOPBACK_PORT,
      { unsafeLegacyMode: 'observe', loopbackPortMode: 'exact' },
    ],
  ] as const)('rejects the Stage B %s legacy path before the SDK', async (_mode, record, redirectUri, rollout) => {
    const fixture = await startAuthorizationFixture([record], { rollout });

    const response = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: record.client_id,
      redirectUri,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect((await response.json()).error).toBe('invalid_request');
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  it('applies the authorization limiter before reading the client store', async () => {
    const fixture = await startAuthorizationFixture([client('known', [WEB_REDIRECT])], {
      rateLimit: { limit: 1 },
    });
    const first = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'known',
      redirectUri: WEB_REDIRECT,
    });
    const readsAfterFirstRequest = fixture.getClient.mock.calls.length;

    const rejected = await authorizeRequest(fixture, {
      method: 'GET',
      clientId: 'known',
      redirectUri: WEB_REDIRECT,
    });

    expect(first.status).toBe(302);
    expect(rejected.status).toBe(429);
    expect(fixture.getClient).toHaveBeenCalledTimes(readsAfterFirstRequest);
    expect(fixture.authorize).toHaveBeenCalledTimes(1);
  });
});

async function startAuthorizationFixture(
  clients: readonly OAuthClientInformationFull[],
  options: Partial<Pick<SafeAuthorizationHandlerOptions, 'logger' | 'rateLimit' | 'rollout'>> = {},
): Promise<AuthorizationFixture> {
  const byId = new Map(clients.map((record) => [record.client_id, record]));
  const getClient = vi.fn((clientId: string) => Promise.resolve(byId.get(clientId)));
  const authorize = vi.fn((_client, _params, res) =>
    Promise.resolve(res.redirect('https://upstream.example.test/login')),
  );
  const provider: OAuthServerProvider = {
    clientsStore: { getClient },
    authorize,
    challengeForAuthorizationCode: () => Promise.reject(new Error('not used')),
    exchangeAuthorizationCode: () => Promise.reject(new Error('not used')),
    exchangeRefreshToken: () => Promise.reject(new Error('not used')),
    verifyAccessToken: () => Promise.reject(new Error('not used')),
  };
  const logEntries: Array<{ event: string; fields: object }> = [];
  const app = express();
  app.use(
    '/authorize',
    safeAuthorizationHandler({
      provider,
      logger: {
        info: (event, fields) => logEntries.push({ event, fields }),
      },
      ...options,
    }),
  );
  const server = createServer(app);
  await listen(server);
  const fixture = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => close(server),
    authorize,
    getClient,
    logEntries,
  };
  fixtures.push(fixture);
  return fixture;
}

function client(
  clientId: string,
  redirectUris: string[],
  metadata: Readonly<Record<string, unknown>> = {},
): OAuthClientInformationFull {
  return {
    client_id: clientId,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    ...metadata,
  };
}

async function authorizeRequest(
  fixture: AuthorizationFixture,
  input: {
    readonly method: 'GET' | 'POST';
    readonly clientId: string;
    readonly redirectUri?: string;
    readonly formBody?: Readonly<Record<string, string>>;
  },
): Promise<Response> {
  const fields = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    code_challenge: 'test-challenge',
    code_challenge_method: 'S256',
    ...(input.redirectUri === undefined ? {} : { redirect_uri: input.redirectUri }),
    ...input.formBody,
  });
  if (input.method === 'GET') {
    return fetch(`${fixture.baseUrl}/authorize?${fields.toString()}`, { redirect: 'manual' });
  }
  return fetch(`${fixture.baseUrl}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields,
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
