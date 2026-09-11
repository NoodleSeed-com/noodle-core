import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { SecretBinding } from '@noodle-borg/connector-defs';
import { jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import { probeCredentials } from '../src/credential-probes.js';
import { type ConfigScope, InMemoryConfigStore, resolveConfigScope } from '../src/store.js';
import { credentialBrokerScope as scope } from './credential-broker-fixtures.js';

describe('ManagedConfigBroker delegated token exchange', () => {
  const routeFingerprintA = `sha256:${'a'.repeat(64)}`;
  const routeFingerprintB = `sha256:${'b'.repeat(64)}`;
  const exchangeBinding = {
    connectorId: 'acmehr_api',
    connectorVersion: '1.0.0',
    authKind: 'delegatedTokenExchange' as const,
    secretRef: 'ACMEHR_DELEG_CLIENT_SECRET',
    tokenExchange: {
      tokenUrl: 'https://app.acmehr.example/api/assistant/oauth/token',
      clientId: 'deleg-client-id',
      scopes: ['time_off'],
      audience: 'acmehr-api',
      authMethod: 'client_secret_basic' as const,
    },
  };
  const routedExchangeBinding = {
    ...exchangeBinding,
    customerEndpoint: 'customer_api',
  };
  const exchangeCaller = {
    subject: 'end-user-7',
    email: 'pat@example.com',
    name: 'Pat Example',
    audience: 'https://cloud.test/o/acme/demo/mcp',
    identityKind: 'customer' as const,
    claims: { accountTier: 'pro' },
  };
  const CUSTOMER_ISSUER = 'https://customer-idp.example';
  const exchangeIdentity = { caller: exchangeCaller, customerIssuer: CUSTOMER_ISSUER } as const;
  const route = {
    key: 'customer_api',
    fingerprint: routeFingerprintA,
  } as const;

  async function exchangeBroker(input: {
    readonly fetchImpl: typeof fetch;
    readonly binding?: SecretBinding;
    readonly bindings?: readonly SecretBinding[];
    readonly configScope?: ConfigScope;
    readonly tenant?: string;
    readonly deployment?: string;
    readonly now?: () => number;
  }) {
    const signer = await createStaticSigningKeyProvider();
    const configScope = input.configScope ?? scope;
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope: configScope,
      name: 'ACMEHR_DELEG_CLIENT_SECRET',
      value: 'deleg-client-secret',
    });
    const broker = new ManagedConfigBroker(
      input.bindings ?? [input.binding ?? exchangeBinding],
      configStore,
      configScope,
      {
        delegatedExchange: {
          issuer: 'https://cloud.test',
          signer,
          tenant: input.tenant ?? 'acme/demo/prod',
          deployment: input.deployment ?? 'demo-abc12345',
        },
        fetchImpl: input.fetchImpl,
        ...(input.now !== undefined ? { now: input.now } : {}),
      },
    );
    return { broker, configStore, signer };
  }

  it('signs a platform assertion and exchanges it for a downstream bearer token', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'acmehr-user-token-1',
        token_type: 'Bearer',
        expires_in: 900,
      }),
    ) as unknown as typeof fetch;
    const { broker, signer } = await exchangeBroker({ fetchImpl });

    await expect(
      broker.getCredential({
        connectorId: 'acmehr_api',
        connectorVersion: '1.0.0',
        operation: 'list_time_off',
        ...exchangeIdentity,
      }),
    ).resolves.toEqual({ token: 'acmehr-user-token-1' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.acmehr.example/api/assistant/oauth/token');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('deleg-client-id:deleg-client-secret').toString('base64')}`,
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(body.get('scope')).toBe('time_off');
    expect(body.get('audience')).toBe('acmehr-api');
    expect(body.get('client_secret')).toBeNull();

    const assertion = body.get('subject_token');
    expect(assertion).toBeTruthy();
    const { payload, protectedHeader } = await jwtVerify(
      assertion as string,
      await signer.verifierKey(),
      { issuer: 'https://cloud.test', audience: 'acmehr-api' },
    );
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.sub).toBe('end-user-7');
    expect(payload.email).toBe('pat@example.com');
    expect(payload.name).toBe('Pat Example');
    expect(payload.claims).toEqual({ accountTier: 'pro' });
    expect(payload.tenant).toBe('acme/demo/prod');
    expect(payload.deployment).toBe('demo-abc12345');
    expect(typeof payload.jti).toBe('string');
    expect((payload.exp as number) - (payload.iat as number)).toBe(120);
  });

  it('isolates MCP resources and separately composed tenant/deployment credential caches', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (): Promise<Response> =>
        Response.json({
          access_token: `issued-${fetchImpl.mock.calls.length}`,
          token_type: 'Bearer',
          expires_in: 900,
        }),
    );
    const first = await exchangeBroker({ fetchImpl });
    const second = await exchangeBroker({
      fetchImpl,
      configScope: resolveConfigScope({ org: 'other', app: 'demo', env: 'prod' }),
      tenant: 'other/demo/prod',
      deployment: 'other-deployment',
    });
    const request = {
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    };
    const otherResource = {
      ...request,
      caller: { ...exchangeCaller, audience: 'https://cloud.test/o/acme/demo/v2/mcp' },
    };
    await expect(first.broker.getCredential(request)).resolves.toEqual({ token: 'issued-1' });
    await expect(first.broker.getCredential(otherResource)).resolves.toEqual({ token: 'issued-2' });
    await expect(first.broker.getCredential(request)).resolves.toEqual({ token: 'issued-1' });
    await expect(second.broker.getCredential(request)).resolves.toEqual({ token: 'issued-3' });
    await expect(second.broker.getCredential(request)).resolves.toEqual({ token: 'issued-3' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const signed = await Promise.all(
      fetchImpl.mock.calls.map(async ([, init], index) => {
        const form = new URLSearchParams(String(init?.body));
        return (
          await jwtVerify(
            form.get('subject_token') ?? '',
            await (index < 2 ? first : second).signer.verifierKey(),
            { issuer: 'https://cloud.test', audience: 'acmehr-api' },
          )
        ).payload;
      }),
    );
    expect(signed.map((payload) => [payload.tenant, payload.deployment])).toEqual([
      ['acme/demo/prod', 'demo-abc12345'],
      ['acme/demo/prod', 'demo-abc12345'],
      ['other/demo/prod', 'other-deployment'],
    ]);
    expect(signed.map((payload) => payload.customer_identity)).toEqual(
      Array(3).fill({ version: 1, issuer: CUSTOMER_ISSUER }),
    );
  });

  it('exchanges and reuses tokens only within each operation-specific scope binding', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (): Promise<Response> =>
        Response.json({
          access_token: `scoped-${fetchImpl.mock.calls.length}`,
          token_type: 'Bearer',
          expires_in: 900,
        }),
    );
    const bindings = ['read', 'write'].map((verb) => ({
      ...exchangeBinding,
      operation: `${verb}_time_off`,
      tokenExchange: { ...exchangeBinding.tokenExchange, scopes: [`time_off:${verb}`] },
    }));
    const { broker } = await exchangeBroker({ fetchImpl, bindings });
    const request = { connectorId: 'acmehr_api', connectorVersion: '1.0.0', ...exchangeIdentity };
    for (let repeat = 0; repeat < 2; repeat++) {
      await expect(
        broker.getCredential({ ...request, operation: 'read_time_off' }),
      ).resolves.toEqual({ token: 'scoped-1' });
      await expect(
        broker.getCredential({ ...request, operation: 'write_time_off' }),
      ).resolves.toEqual({ token: 'scoped-2' });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get('scope')),
    ).toEqual(['time_off:read', 'time_off:write']);
  });

  it('defaults the assertion audience to the token URL and posts client credentials for client_secret_post', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'acmehr-user-token-1',
        token_type: 'Bearer',
        expires_in: 900,
      }),
    ) as unknown as typeof fetch;
    const binding = {
      ...exchangeBinding,
      tokenExchange: {
        tokenUrl: 'https://app.acmehr.example/api/assistant/oauth/token',
        clientId: 'deleg-client-id',
        authMethod: 'client_secret_post' as const,
      },
    };
    const { broker, signer } = await exchangeBroker({ fetchImpl, binding });

    await broker.getCredential({
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBeNull();
    const body = new URLSearchParams(String(init.body));
    expect(body.get('client_id')).toBe('deleg-client-id');
    expect(body.get('client_secret')).toBe('deleg-client-secret');
    expect(body.get('scope')).toBeNull();
    expect(body.get('audience')).toBeNull();
    await expect(
      jwtVerify(body.get('subject_token') as string, await signer.verifierKey(), {
        issuer: 'https://cloud.test',
        audience: 'https://app.acmehr.example/api/assistant/oauth/token',
      }),
    ).resolves.toBeTruthy();
  });

  it('adds only the safe route binding to a routed assertion and preserves an unrouted assertion', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: `token-${fetchImpl.mock.calls.length}`,
        token_type: 'Bearer',
        expires_in: 900,
      }),
    ) as unknown as typeof fetch;
    const { broker: routedBroker, signer: routedSigner } = await exchangeBroker({
      fetchImpl,
      binding: routedExchangeBinding,
    });
    const { broker: staticBroker, signer: staticSigner } = await exchangeBroker({ fetchImpl });
    const request = {
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    };

    await routedBroker.getCredential({
      ...request,
      route: {
        ...route,
        baseUrl: 'https://never-forward.test/private',
      },
    });
    await staticBroker.getCredential(request);

    const routedBody = new URLSearchParams(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    const routed = await jwtVerify(
      routedBody.get('subject_token') as string,
      await routedSigner.verifierKey(),
      { issuer: 'https://cloud.test', audience: 'acmehr-api' },
    );
    expect(routed.payload.route).toEqual({
      key: 'customer_api',
      fingerprint: routeFingerprintA,
    });
    expect(JSON.stringify(routed.payload)).not.toContain('never-forward.test');

    const unroutedBody = new URLSearchParams(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    );
    const unrouted = await jwtVerify(
      unroutedBody.get('subject_token') as string,
      await staticSigner.verifierKey(),
      { issuer: 'https://cloud.test', audience: 'acmehr-api' },
    );
    expect(unrouted.payload).not.toHaveProperty('route');
  });

  it('isolates identical subjects by verified customer issuer and signs a versioned issuer binding', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: `token-${fetchImpl.mock.calls.length}`,
        token_type: 'Bearer',
        expires_in: 900,
      }),
    ) as unknown as typeof fetch;
    const { broker, signer } = await exchangeBroker({ fetchImpl, now: () => 1_000 });
    const request = {
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    };

    await expect(
      broker.getCredential({
        ...request,
        customerIssuer: 'https://issuer-a.example',
      }),
    ).resolves.toEqual({ token: 'token-1' });
    await expect(
      broker.getCredential({
        ...request,
        customerIssuer: 'https://issuer-a.example',
      }),
    ).resolves.toEqual({ token: 'token-1' });
    await expect(
      broker.getCredential({
        ...request,
        customerIssuer: 'https://issuer-b.example',
      }),
    ).resolves.toEqual({ token: 'token-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const assertions = fetchImpl.mock.calls.map(([, init]) => {
      const body = new URLSearchParams(String((init as RequestInit | undefined)?.body));
      return body.get('subject_token') as string;
    });
    const verifierKey = await signer.verifierKey();
    const verified = await Promise.all(
      assertions.map((assertion) =>
        jwtVerify(assertion, verifierKey, {
          issuer: 'https://cloud.test',
          audience: 'acmehr-api',
          currentDate: new Date(1_000),
        }),
      ),
    );
    expect(verified.map(({ payload }) => payload.customer_identity)).toEqual([
      { version: 1, issuer: 'https://issuer-a.example' },
      { version: 1, issuer: 'https://issuer-b.example' },
    ]);
  });

  it('rejects a URL-shaped route fingerprint before config, signing, or exchange', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { broker, configStore, signer } = await exchangeBroker({
      fetchImpl,
      binding: routedExchangeBinding,
    });
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');
    const signingKey = vi.spyOn(signer, 'signingKey');

    await expect(
      broker.getCredential({
        connectorId: 'acmehr_api',
        connectorVersion: '1.0.0',
        operation: 'list_time_off',
        ...exchangeIdentity,
        route: {
          key: 'customer_api',
          fingerprint: 'https://tenant.example/private',
        },
      }),
    ).rejects.toMatchObject({ reason: 'connector_route_unavailable' });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(signingKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a routed synthetic-assistant probe egress-free without a safe route', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'doctor-token',
        token_type: 'Bearer',
        expires_in: 900,
      }),
    ) as unknown as typeof fetch;
    const { broker, configStore, signer } = await exchangeBroker({
      fetchImpl,
      binding: routedExchangeBinding,
    });
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');

    await expect(
      broker.probeDelegatedCredentials(exchangeCaller, undefined, CUSTOMER_ISSUER),
    ).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'acmehr_api',
        authKind: 'delegatedTokenExchange',
        ok: false,
        reason: 'connector_route_unavailable',
      }),
    ]);
    await expect(
      broker.probeDelegatedCredentials(exchangeCaller, () => null, CUSTOMER_ISSUER),
    ).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'acmehr_api',
        ok: false,
        reason: 'connector_route_unavailable',
      }),
    ]);
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const resolvedRoute = {
      ...route,
      baseUrl: 'https://must-not-cross.test/private',
    };
    const resolved = await broker.probeDelegatedCredentials(
      exchangeCaller,
      (requirement) => {
        expect(requirement).toEqual({
          connectorId: 'acmehr_api',
          connectorVersion: '1.0.0',
          key: 'customer_api',
        });
        return resolvedRoute;
      },
      CUSTOMER_ISSUER,
    );
    expect(resolved).toEqual([
      expect.objectContaining({
        connectorId: 'acmehr_api',
        authKind: 'delegatedTokenExchange',
        ok: true,
      }),
    ]);
    expect(JSON.stringify(resolved)).not.toContain('customer_api');
    expect(JSON.stringify(resolved)).not.toContain(route.fingerprint);
    expect(JSON.stringify(resolved)).not.toContain('must-not-cross.test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const body = new URLSearchParams(
      String((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    const verified = await jwtVerify(
      body.get('subject_token') as string,
      await signer.verifierKey(),
      { issuer: 'https://cloud.test', audience: 'acmehr-api' },
    );
    expect(verified.payload.route).toEqual(route);
    expect(JSON.stringify(verified.payload)).not.toContain('must-not-cross.test');
  });

  it('allows a static synthetic-assistant probe to complete without a route resolver', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'doctor-token',
        token_type: 'Bearer',
        expires_in: 900,
      }),
    ) as unknown as typeof fetch;
    const { broker, configStore } = await exchangeBroker({ fetchImpl });
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');

    await expect(
      broker.probeDelegatedCredentials(exchangeCaller, undefined, CUSTOMER_ISSUER),
    ).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'acmehr_api',
        authKind: 'delegatedTokenExchange',
        ok: true,
      }),
    ]);
    expect(resolveConfig).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('coalesces one route while isolating route keys and fingerprints', async () => {
    let release: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => firstResponse)
      .mockImplementation(async () =>
        Response.json({
          access_token: `token-${fetchImpl.mock.calls.length}`,
          token_type: 'Bearer',
          expires_in: 900,
        }),
      ) as unknown as typeof fetch;
    const { broker } = await exchangeBroker({
      fetchImpl,
      binding: routedExchangeBinding,
      now: () => 1_000,
    });
    const request = {
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    };

    const first = broker.getCredential({ ...request, route });
    const second = broker.getCredential({ ...request, route });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    release?.(
      Response.json({
        access_token: 'token-1',
        token_type: 'Bearer',
        expires_in: 900,
      }),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([
      { token: 'token-1' },
      { token: 'token-1' },
    ]);
    await broker.getCredential({ ...request, route });
    await broker.getCredential({
      ...request,
      route: { key: route.key, fingerprint: routeFingerprintB },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cleans up a failed in-flight exchange only for its exact route', async () => {
    let failedRouteAttempts = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      const assertion = body.get('subject_token') ?? '';
      const payload = JSON.parse(
        Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString(),
      ) as { route?: { key?: string; fingerprint?: string } };
      if (payload.route?.fingerprint === routeFingerprintA && failedRouteAttempts++ === 0) {
        return Response.json({ error: 'temporary' }, { status: 503 });
      }
      return Response.json({
        access_token:
          payload.route?.fingerprint === routeFingerprintA ? 'route-a-token' : 'route-b-token',
        token_type: 'Bearer',
        expires_in: 900,
      });
    }) as unknown as typeof fetch;
    const { broker } = await exchangeBroker({
      fetchImpl,
      binding: routedExchangeBinding,
      now: () => 1_000,
    });
    const request = {
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    };

    await expect(broker.getCredential({ ...request, route })).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
    await expect(
      broker.getCredential({
        ...request,
        route: { key: route.key, fingerprint: routeFingerprintB },
      }),
    ).resolves.toEqual({ token: 'route-b-token' });
    await expect(broker.getCredential({ ...request, route })).resolves.toEqual({
      token: 'route-a-token',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    307, 308,
  ])('uses manual redirects and rejects token endpoint status %i', async (status) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
    const { broker } = await exchangeBroker({
      fetchImpl,
      binding: routedExchangeBinding,
    });

    await expect(
      broker.getCredential({
        connectorId: 'acmehr_api',
        connectorVersion: '1.0.0',
        operation: 'list_time_off',
        ...exchangeIdentity,
        route,
      }),
    ).rejects.toMatchObject({ reason: 'credential_exchange_failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.redirect).toBe('manual');
  });

  it('caches the exchanged token per subject until near expiry, then re-exchanges', async () => {
    let nowMs = 1_000;
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: `token-${fetchImpl.mock.calls.length}`,
        token_type: 'Bearer',
        expires_in: 600,
      }),
    ) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
    const { broker } = await exchangeBroker({ fetchImpl, now: () => nowMs });
    const request = {
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    };

    await expect(broker.getCredential(request)).resolves.toEqual({ token: 'token-1' });
    await expect(broker.getCredential(request)).resolves.toEqual({ token: 'token-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Advance past expires_in (600) minus the 300s skew.
    nowMs += 301_000;
    await expect(broker.getCredential(request)).resolves.toEqual({ token: 'token-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A different subject never shares the cache.
    await broker.getCredential({
      ...request,
      caller: { ...exchangeCaller, subject: 'end-user-8' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the caller is not a verified customer identity', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { broker } = await exchangeBroker({ fetchImpl });
    await expect(
      broker.getCredential({
        connectorId: 'acmehr_api',
        connectorVersion: '1.0.0',
        operation: 'list_time_off',
      }),
    ).rejects.toMatchObject({
      name: 'CredentialUnavailableError',
      reason: 'caller_identity_not_customer',
    });
    for (const caller of [
      { subject: 'platform-user', identityKind: 'platform' as const, audience: 'aud' },
      { subject: 'spn_1', identityKind: 'service' as const, audience: 'aud' },
    ]) {
      await expect(
        broker.getCredential({
          connectorId: 'acmehr_api',
          connectorVersion: '1.0.0',
          operation: 'list_time_off',
          caller,
        }),
      ).rejects.toMatchObject({
        name: 'CredentialUnavailableError',
        reason: 'caller_identity_not_customer',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed before configuration or exchange when a customer issuer is missing', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { broker, configStore, signer } = await exchangeBroker({ fetchImpl });
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');
    const signingKey = vi.spyOn(signer, 'signingKey');

    await expect(
      broker.getCredential({
        connectorId: 'acmehr_api',
        connectorVersion: '1.0.0',
        operation: 'list_time_off',
        caller: exchangeCaller,
      }),
    ).rejects.toMatchObject({
      name: 'CredentialUnavailableError',
      reason: 'caller_issuer_missing',
    });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(signingKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('normalizes hostile credential probe rejections without invoking proxy traps', async () => {
    const routeUrl = 'https://tenant.api.example/private';
    const rejection = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`probe trap ${routeUrl}`);
        },
      },
    );

    const probes = await probeCredentials({
      caller: exchangeCaller,
      customerIssuer: CUSTOMER_ISSUER,
      externalBindings: [],
      externalBroker: undefined,
      bindings: [exchangeBinding],
      getCredential: async () => Promise.reject(rejection),
    });

    expect(probes).toEqual([
      {
        connectorId: 'acmehr_api',
        authKind: 'delegatedTokenExchange',
        ok: false,
        reason: 'credential_exchange_failed',
        fix: 'Check the delegated connector configuration and downstream token endpoint.',
      },
    ]);
    expect(JSON.stringify(probes)).not.toContain(routeUrl);
  });

  it('fails closed on a non-2xx or malformed token endpoint response', async () => {
    const failing = vi.fn(
      async () => new Response('nope', { status: 403 }),
    ) as unknown as typeof fetch;
    const { broker: failingBroker } = await exchangeBroker({ fetchImpl: failing });
    const request = {
      connectorId: 'acmehr_api',
      connectorVersion: '1.0.0',
      operation: 'list_time_off',
      ...exchangeIdentity,
    };
    await expect(failingBroker.getCredential(request)).rejects.toMatchObject({
      name: 'CredentialUnavailableError',
      reason: 'credential_exchange_failed',
    });

    const malformed = vi.fn(async () =>
      Response.json({ token_type: 'Bearer' }),
    ) as unknown as typeof fetch;
    const { broker: malformedBroker } = await exchangeBroker({ fetchImpl: malformed });
    await expect(malformedBroker.getCredential(request)).rejects.toMatchObject({
      name: 'CredentialUnavailableError',
      reason: 'credential_exchange_failed',
    });
  });

  it('fails closed when the exchange is not configured on the service', async () => {
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ACMEHR_DELEG_CLIENT_SECRET',
      value: 'deleg-client-secret',
    });
    const broker = new ManagedConfigBroker([exchangeBinding], configStore, scope, {});
    await expect(
      broker.getCredential({
        connectorId: 'acmehr_api',
        connectorVersion: '1.0.0',
        operation: 'list_time_off',
        ...exchangeIdentity,
      }),
    ).rejects.toMatchObject({
      name: 'CredentialUnavailableError',
      reason: 'credential_not_configured',
    });
  });
});
