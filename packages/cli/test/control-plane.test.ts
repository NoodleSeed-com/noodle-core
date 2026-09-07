import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAuthMetadata } from '../src/auth-discovery.js';
import { readConfig, writeConfig } from '../src/config.js';
import {
  browserLogin,
  resolveControlPlaneToken,
  ServiceRequestError,
  serviceJson,
} from '../src/control-plane.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'noodle-cli-auth-'));
  homes.push(home);
  return home;
}

function idToken(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

const AUTH_METADATA = {
  ok: true as const,
  service: 'https://svc.example',
  googleClientId: 'web-google-client',
  allowedEmailDomain: '@noodleseed.com',
  authType: 'noodle-oauth-pkce',
  authorizationServerIssuer: 'https://svc.example',
  controlPlaneResource: 'https://svc.example',
};

describe('service auth discovery', () => {
  it('does not let fetch follow redirects around the canonical-route fallback policy', async () => {
    const paths: string[] = [];
    await expect(
      getAuthMetadata('https://svc.example', async (input, init) => {
        paths.push(new URL(input.toString()).pathname);
        expect(init?.redirect).toBe('manual');
        return Response.redirect('https://svc.example/v1/auth/google', 302);
      }),
    ).rejects.toThrow('service auth metadata failed (302)');

    expect(paths).toEqual(['/v1/auth']);
  });

  it('uses the provider-neutral route first', async () => {
    const paths: string[] = [];
    const {
      googleClientId: _googleClientId,
      allowedEmailDomain: _allowedEmailDomain,
      ...providerNeutralMetadata
    } = AUTH_METADATA;
    const metadata = await getAuthMetadata('https://svc.example/', async (input) => {
      paths.push(new URL(input.toString()).pathname);
      return Response.json(providerNeutralMetadata);
    });

    expect(paths).toEqual(['/v1/auth']);
    expect(metadata).toEqual(providerNeutralMetadata);
  });

  it.each([404, 405])('falls back to the hidden compatibility route on HTTP %s', async (status) => {
    const paths: string[] = [];
    const metadata = await getAuthMetadata('https://svc.example', async (input) => {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      return path === '/v1/auth'
        ? Response.json({ error: 'not found' }, { status })
        : Response.json(AUTH_METADATA);
    });

    expect(paths).toEqual(['/v1/auth', '/v1/auth/google']);
    expect(metadata).toEqual(AUTH_METADATA);
  });

  it.each([
    401, 403, 429, 500, 503,
  ])('does not downgrade discovery after HTTP %s', async (status) => {
    const paths: string[] = [];
    await expect(
      getAuthMetadata('https://svc.example', async (input) => {
        paths.push(new URL(input.toString()).pathname);
        return Response.json({ error: 'failed' }, { status });
      }),
    ).rejects.toThrow(`service auth metadata failed (${status})`);

    expect(paths).toEqual(['/v1/auth']);
  });

  it('does not downgrade malformed provider-neutral metadata', async () => {
    const paths: string[] = [];
    await expect(
      getAuthMetadata('https://svc.example', async (input) => {
        paths.push(new URL(input.toString()).pathname);
        return Response.json({ ok: true, authType: 'noodle-oauth-pkce' });
      }),
    ).rejects.toThrow('service auth metadata is invalid');

    expect(paths).toEqual(['/v1/auth']);
  });
});

describe('persisted Noodle OAuth continuity', () => {
  it('rotates the existing refresh credential without changing its persisted shape', async () => {
    const home = tempHome();
    writeConfig(
      {
        serviceUrl: 'https://svc.example',
        authToken: 'expired-access',
        authTokenExpiresAt: new Date(0).toISOString(),
        oauthIssuer: 'https://svc.example',
        oauthClientId: 'existing-cli-client',
        oauthRefreshToken: 'existing-refresh',
        oauthResource: 'https://svc.example',
        defaultOrg: 'acme',
      },
      home,
    );
    let form: URLSearchParams | undefined;
    const refreshedAccess = idToken({ sub: 'sub-1', email: 'dev@noodleseed.com' });
    const result = await resolveControlPlaneToken({
      env: {} as NodeJS.ProcessEnv,
      home,
      fetchImpl: async (input, init) => {
        expect(input.toString()).toBe('https://svc.example/token');
        form = new URLSearchParams(init?.body?.toString());
        return Response.json({
          access_token: refreshedAccess,
          refresh_token: 'rotated-refresh',
          expires_in: 3_600,
        });
      },
    });

    expect(Object.fromEntries(form ?? [])).toEqual({
      client_id: 'existing-cli-client',
      refresh_token: 'existing-refresh',
      grant_type: 'refresh_token',
      resource: 'https://svc.example',
    });
    expect(result.token).toBe(refreshedAccess);
    expect(readConfig(home)).toMatchObject({
      serviceUrl: 'https://svc.example',
      oauthIssuer: 'https://svc.example',
      oauthClientId: 'existing-cli-client',
      oauthRefreshToken: 'rotated-refresh',
      oauthResource: 'https://svc.example',
      defaultOrg: 'acme',
    });
  });
});

describe('browserLogin', () => {
  it('uses RFC 8628 when the service advertises device authorization', async () => {
    const home = tempHome();
    let openedUrl: URL | undefined;
    let registration: Record<string, unknown> | undefined;
    let deviceRequest: URLSearchParams | undefined;
    let tokenRequest: URLSearchParams | undefined;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/auth') {
        return Response.json({
          ok: true,
          service: 'https://svc.example',
          googleClientId: 'web-google-client',
          allowedEmailDomain: '@noodleseed.com',
          authType: 'noodle-oauth-pkce',
          authorizationServerIssuer: 'https://svc.example',
          controlPlaneResource: 'https://svc.example',
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: 'https://svc.example',
          token_endpoint: 'https://svc.example/token',
          registration_endpoint: 'https://svc.example/register',
          device_authorization_endpoint: 'https://svc.example/device_authorization',
          grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code'],
        });
      }
      if (url.pathname === '/register') {
        registration = JSON.parse(init?.body?.toString() ?? '{}');
        return Response.json({ client_id: 'noodle-cli-device-client' }, { status: 201 });
      }
      if (url.pathname === '/device_authorization') {
        deviceRequest = new URLSearchParams(init?.body?.toString());
        return Response.json({
          device_code: 'device-secret',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://svc.example/device',
          verification_uri_complete: 'https://svc.example/device?user_code=WDJB-MJHT',
          expires_in: 600,
          interval: 0,
        });
      }
      if (url.pathname === '/token') {
        tokenRequest = new URLSearchParams(init?.body?.toString());
        return Response.json({
          access_token: idToken({ sub: 'sub-1', email: 'dev@noodleseed.com' }),
          refresh_token: 'refresh-1',
          expires_in: 3600,
          token_type: 'bearer',
        });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    };

    const result = await browserLogin({
      serviceUrl: 'https://svc.example/',
      home,
      fetchImpl,
      openBrowser: (url) => {
        openedUrl = new URL(url);
      },
    });

    expect(openedUrl?.href).toBe('https://svc.example/device?user_code=WDJB-MJHT');
    expect(registration).toMatchObject({
      redirect_uris: ['https://svc.example/oauth/device/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: [
        'urn:ietf:params:oauth:grant-type:device_code',
        'authorization_code',
        'refresh_token',
      ],
    });
    expect(deviceRequest?.get('resource')).toBe('https://svc.example');
    expect(tokenRequest?.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(tokenRequest?.get('device_code')).toBe('device-secret');
    expect(result).toMatchObject({
      serviceUrl: 'https://svc.example',
      email: 'dev@noodleseed.com',
      subject: 'sub-1',
    });
    expect(readConfig(home)).toMatchObject({
      serviceUrl: 'https://svc.example',
      authToken: expect.any(String),
      oauthClientId: 'noodle-cli-device-client',
      oauthRefreshToken: 'refresh-1',
      oauthIssuer: 'https://svc.example',
      oauthResource: 'https://svc.example',
    });
  });

  it('uses the service authorization server for hosted PKCE login when advertised', async () => {
    const home = tempHome();
    let openedUrl: URL | undefined;
    let tokenRequestBody: URLSearchParams | undefined;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/auth') {
        return Response.json({
          ok: true,
          service: 'https://svc.example',
          googleClientId: 'web-google-client',
          allowedEmailDomain: '@noodleseed.com',
          authType: 'noodle-oauth-pkce',
          authorizationServerIssuer: 'https://svc.example',
          controlPlaneResource: 'https://svc.example',
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({ issuer: 'https://svc.example' });
      }
      if (url.pathname === '/register') {
        return Response.json(
          {
            client_id: 'noodle-cli-client',
            redirect_uris: [JSON.parse(init?.body?.toString() ?? '{}').redirect_uris[0]],
            token_endpoint_auth_method: 'none',
          },
          { status: 201 },
        );
      }
      if (url.pathname === '/token') {
        tokenRequestBody = new URLSearchParams(init?.body?.toString());
        return Response.json({
          access_token: idToken({ sub: 'sub-1', email: 'dev@noodleseed.com' }),
          refresh_token: 'refresh-1',
          expires_in: 3600,
          token_type: 'bearer',
        });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    };

    const result = await browserLogin({
      serviceUrl: 'https://svc.example/',
      home,
      fetchImpl,
      openBrowser: (url) => {
        openedUrl = new URL(url);
        const callback = new URL(openedUrl.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'auth-code');
        callback.searchParams.set('state', openedUrl.searchParams.get('state') ?? '');
        setTimeout(() => {
          void fetch(callback);
        }, 0);
      },
    });

    expect(openedUrl).toBeDefined();
    expect(openedUrl?.origin + openedUrl?.pathname).toBe('https://svc.example/authorize');
    expect(openedUrl?.searchParams.get('client_id')).toBe('noodle-cli-client');
    expect(openedUrl?.searchParams.get('resource')).toBe('https://svc.example');
    expect(openedUrl?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(tokenRequestBody?.get('client_secret')).toBeNull();
    expect(tokenRequestBody?.get('client_id')).toBe('noodle-cli-client');
    expect(tokenRequestBody?.get('grant_type')).toBe('authorization_code');
    expect(tokenRequestBody?.get('resource')).toBe('https://svc.example');
    expect(result).toMatchObject({
      serviceUrl: 'https://svc.example',
      email: 'dev@noodleseed.com',
      subject: 'sub-1',
    });
    expect(readConfig(home)).toMatchObject({
      serviceUrl: 'https://svc.example',
      authToken: expect.any(String),
      oauthClientId: 'noodle-cli-client',
      oauthRefreshToken: 'refresh-1',
      oauthIssuer: 'https://svc.example',
      identity: { email: 'dev@noodleseed.com', subject: 'sub-1' },
    });
  });

  it('requests only the Google ID/email scopes needed for control-plane auth', async () => {
    const home = tempHome();
    let openedUrl: URL | undefined;
    let tokenRequestBody: URLSearchParams | undefined;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/auth') {
        return Response.json({
          ok: true,
          service: 'https://svc.example',
          googleClientId: 'google-client',
          allowedEmailDomain: '@noodleseed.com',
          authType: 'google-oauth-pkce',
        });
      }
      if (url.href === 'https://oauth2.googleapis.com/token') {
        tokenRequestBody = new URLSearchParams(init?.body?.toString());
        return Response.json({
          id_token: idToken({ sub: 'sub-1', email: 'dev@noodleseed.com' }),
          refresh_token: 'refresh-1',
          expires_in: 3600,
        });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    };

    const result = await browserLogin({
      serviceUrl: 'https://svc.example/',
      home,
      fetchImpl,
      openBrowser: (url) => {
        openedUrl = new URL(url);
        const callback = new URL(openedUrl.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'auth-code');
        callback.searchParams.set('state', openedUrl.searchParams.get('state') ?? '');
        setTimeout(() => {
          void fetch(callback);
        }, 0);
      },
    });

    expect(openedUrl).toBeDefined();
    expect(openedUrl?.searchParams.get('scope')).toBe('openid email');
    expect(openedUrl?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(tokenRequestBody?.get('code')).toBe('auth-code');
    expect(tokenRequestBody?.get('grant_type')).toBe('authorization_code');
    expect(result).toMatchObject({
      serviceUrl: 'https://svc.example',
      email: 'dev@noodleseed.com',
      subject: 'sub-1',
    });
    expect(readConfig(home)).toMatchObject({
      serviceUrl: 'https://svc.example',
      googleClientId: 'google-client',
      refreshToken: 'refresh-1',
      identity: { email: 'dev@noodleseed.com', subject: 'sub-1' },
    });
  });
});

describe('serviceJson', () => {
  it('sends bearer auth, accepts JSON, and surfaces request IDs on typed errors', async () => {
    const seen: { authorization?: string; accept?: string; cliVersion?: string } = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.authorization = headers.get('authorization') ?? undefined;
      seen.accept = headers.get('accept') ?? undefined;
      seen.cliVersion = headers.get('x-noodle-cli-version') ?? undefined;
      return Response.json(
        { error: 'forbidden' },
        { status: 403, headers: { 'x-request-id': 'req-123' } },
      );
    }) as typeof fetch;

    await expect(
      serviceJson('https://svc.example/v1/orgs', 'secret-token', {}, fetchImpl),
    ).rejects.toMatchObject({
      status: 403,
      message: 'forbidden',
      requestId: 'req-123',
    });
    expect(seen).toEqual({
      authorization: 'Bearer secret-token',
      accept: 'application/json',
      cliVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });

  it('parses Retry-After seconds on typed service errors', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      Response.json(
        { error: 'slow down', code: 'feedback_rate_limited' },
        { status: 429, headers: { 'retry-after': '17' } },
      )) as typeof fetch;

    await expect(
      serviceJson('https://svc.example/v1/feedback', 'secret-token', { method: 'POST' }, fetchImpl),
    ).rejects.toMatchObject({
      status: 429,
      code: 'feedback_rate_limited',
      retryAfterSeconds: 17,
    });
  });

  it('times out with a typed redacted service error', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted secret-token'), { name: 'AbortError' }));
        });
      });
    }) as typeof fetch;

    await expect(
      serviceJson('https://svc.example/v1/whoami', 'secret-token', {}, fetchImpl, {
        timeoutMs: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        status: 0,
        message: expect.stringMatching(/timed out/i),
      }),
    );
    await serviceJson('https://svc.example/v1/whoami', 'secret-token', {}, fetchImpl, {
      timeoutMs: 1,
    }).catch((error) => {
      expect(error).toBeInstanceOf(ServiceRequestError);
      expect(String(error.message)).not.toContain('secret-token');
    });
  });

  it('retries transient GET failures once but does not retry mutating requests', async () => {
    let getAttempts = 0;
    const getFetch = (async (): Promise<Response> => {
      getAttempts += 1;
      if (getAttempts === 1) return Response.json({ error: 'temporary' }, { status: 503 });
      return Response.json({ ok: true, attempt: getAttempts });
    }) as typeof fetch;

    await expect(
      serviceJson<{ attempt: number }>('https://svc.example/v1/orgs', 'tok', {}, getFetch),
    ).resolves.toMatchObject({ attempt: 2 });
    expect(getAttempts).toBe(2);

    let postAttempts = 0;
    const postFetch = (async (): Promise<Response> => {
      postAttempts += 1;
      return Response.json({ error: 'temporary' }, { status: 503 });
    }) as typeof fetch;

    await expect(
      serviceJson('https://svc.example/v1/orgs', 'tok', { method: 'POST' }, postFetch),
    ).rejects.toMatchObject({ status: 503 });
    expect(postAttempts).toBe(1);
  });

  it.each([
    200, 503,
  ])('keeps the deadline through the HTTP %s body and preserves correlation', async (status) => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      attempts += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            const timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{}'));
              controller.close();
            }, 40);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              controller.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    };
    await expect(
      serviceJson(
        'https://svc.example/preflight',
        'secret-token',
        {
          method: 'POST',
          headers: { 'x-request-id': 'local-preflight-id' },
        },
        fetchImpl,
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      status: 0,
      code: 'request_timeout',
      requestId: 'local-preflight-id',
      elapsedMs: expect.any(Number),
    });
    expect(attempts).toBe(1);
  });
});
