import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import {
  type ArtifactConnectorBinding,
  computeConnectionConfigRevision,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { CredentialUnavailableError } from '@noodle-borg/runtime';
import { jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { buildCredentialBindingIndex } from '../src/credential-binding-index.js';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import type {
  GoogleWorkloadIdentityRecord,
  GoogleWorkloadIdentityResolver,
} from '../src/google-workload-identity.js';
import { probeGoogleWorkloadIdentityCredentials } from '../src/google-workload-identity-probe.js';
import { InMemoryConfigStore, resolveConfigScope } from '../src/store.js';

const scope = resolveConfigScope({ org: 'acme', app: 'analytics', env: 'prod' });
const tenant = 'acme/analytics/prod';
const deployment = 'analytics-abc12345';
const issuer = 'https://cloud.noodleseed.test';
const provider =
  'projects/130949485844/locations/global/workloadIdentityPools/noodle-prod/providers/analytics';
const providerAudience = `//iam.googleapis.com/${provider}`;
const serviceAccount = 'analytics-reader@customer-project.iam.gserviceaccount.com';
const scopes = [
  'https://www.googleapis.com/auth/bigquery.readonly',
  'https://www.googleapis.com/auth/cloud-platform.read-only',
];
const routeFingerprintA = `sha256:${'a'.repeat(64)}`;
const routeFingerprintB = `sha256:${'b'.repeat(64)}`;

function googleArtifact(
  access:
    | { readonly kind: 'direct' }
    | { readonly kind: 'serviceAccountImpersonation'; readonly serviceAccount: string },
  customerEndpoint?: string,
): RuntimeArtifact {
  const connectorBinding: ArtifactConnectorBinding = {
    profile: 'google',
    connection: {
      id: 'google_cloud',
      source: {
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access,
      },
    },
  };
  return {
    artifactSchemaVersion: customerEndpoint === undefined ? '0.14.0' : '0.15.0',
    resolution: 'resolved',
    source: { manifestName: 'analytics', manifestVersion: '1.0.0', coreVersion: '2' },
    server: { name: 'analytics', version: '1.0.0', title: 'Analytics' },
    capabilities: { tools: ['query'] },
    connectorBindings: { google: connectorBinding },
    ...(customerEndpoint === undefined
      ? {}
      : {
          customerEndpoints: {
            [customerEndpoint]: {
              allowedHttpsOrigins: ['https://customer.example.test'],
            },
          },
        }),
    tools: [
      {
        name: 'query',
        description: 'Query BigQuery.',
        inputSchema: { type: 'object' },
        fulfilment: {
          kind: 'operation',
          args: {},
          operationRef: {
            resolved: true,
            alias: 'google',
            connectorId: 'bigquery',
            connectorVersion: '1.0.0',
            operation: 'query',
            signatureHash: 'sha256v2:test',
            ...(customerEndpoint === undefined ? {} : { customerEndpoint }),
            credentialBinding: {
              bindingId: 'google',
              connectionId: connectorBinding.connection.id,
              connectionConfigRevision: computeConnectionConfigRevision(
                connectorBinding.connection,
              ),
              profile: connectorBinding.profile,
              presentation: { kind: 'bearer' },
              requiredScopes: scopes,
              requiredAudience: 'https://bigquery.googleapis.com',
            },
          },
        },
      },
    ],
  };
}

function boundRequest(artifact: RuntimeArtifact) {
  const fulfilment = artifact.tools[0]?.fulfilment;
  if (fulfilment?.kind !== 'operation' || !fulfilment.operationRef.resolved) {
    throw new Error('expected bound operation');
  }
  return {
    connectorId: fulfilment.operationRef.connectorId,
    connectorVersion: fulfilment.operationRef.connectorVersion,
    operation: fulfilment.operationRef.operation,
    tenantId: tenant,
    deploymentId: deployment,
    ...fulfilment.operationRef.credentialBinding,
  };
}

function identity(revision = 'rev-1'): GoogleWorkloadIdentityRecord {
  return {
    id: 'workload-analytics-prod',
    revision,
    tenantId: tenant,
    environmentId: 'prod',
    subject: 'org/acme/app/analytics/env/prod/deployment/analytics-abc12345',
    active: true,
  };
}

async function setup(input: {
  readonly access:
    | { readonly kind: 'direct' }
    | {
        readonly kind: 'serviceAccountImpersonation';
        readonly serviceAccount: string;
      };
  readonly fetchImpl: typeof fetch;
  readonly resolver?: GoogleWorkloadIdentityResolver;
  readonly now?: () => number;
  readonly customerEndpoint?: string;
}) {
  const signer = await createStaticSigningKeyProvider();
  const configStore = new InMemoryConfigStore();
  await configStore.setConfigValue({
    kind: 'variable',
    scope,
    name: 'GOOGLE_WIF_PROVIDER',
    value: provider,
  });
  if (input.access.kind === 'serviceAccountImpersonation') {
    await configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'GOOGLE_SERVICE_ACCOUNT',
      value: serviceAccount,
    });
  }
  const artifact = googleArtifact(input.access, input.customerEndpoint);
  const resolver =
    input.resolver ??
    ({
      resolve: vi.fn(async () => identity()),
    } satisfies GoogleWorkloadIdentityResolver);
  const broker = new ManagedConfigBroker([], configStore, scope, {
    artifact,
    googleWorkloadIdentity: {
      issuer,
      signer,
      identities: resolver,
      tenant,
      deployment,
      fetchImpl: input.fetchImpl,
    },
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { artifact, broker, configStore, resolver, signer };
}

describe('Google workload identity binding broker', () => {
  it('route-binds Google token cache and single-flight identities without changing assertions', async () => {
    const tokenResponse = (token: string) =>
      Response.json({
        access_token: token,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    let release: ((value: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => firstResponse)
      .mockImplementation(async () =>
        tokenResponse(`route-token-${fetchImpl.mock.calls.length}`),
      ) as unknown as typeof fetch;
    const { artifact, broker } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
      customerEndpoint: 'customer_api',
    });
    const descriptor = boundRequest(artifact);
    const route = { key: 'customer_api', fingerprint: routeFingerprintA } as const;

    const first = broker.getCredential({ ...descriptor, route });
    const second = broker.getCredential({ ...descriptor, route });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const firstInit = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(firstInit?.body)) as { subjectToken: string };
    const payload = JSON.parse(
      Buffer.from(body.subjectToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('route');
    release?.(tokenResponse('route-token-1'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { token: 'route-token-1' },
      { token: 'route-token-1' },
    ]);

    await broker.getCredential({ ...descriptor, route });
    await broker.getCredential({
      ...descriptor,
      route: { key: route.key, fingerprint: routeFingerprintB },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cleans up a failed Google exchange only for its exact route identity', async () => {
    const tokenResponse = (token: string) =>
      Response.json({
        access_token: token,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () =>
        tokenResponse(`route-token-${fetchImpl.mock.calls.length}`),
      ) as unknown as typeof fetch;
    const { artifact, broker } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
      customerEndpoint: 'customer_api',
    });
    const descriptor = boundRequest(artifact);
    const route = { key: 'customer_api', fingerprint: routeFingerprintA } as const;

    await expect(broker.getCredential({ ...descriptor, route })).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
    await expect(
      broker.getCredential({
        ...descriptor,
        route: { key: route.key, fingerprint: routeFingerprintB },
      }),
    ).resolves.toEqual({ token: 'route-token-2' });
    await expect(broker.getCredential({ ...descriptor, route })).resolves.toEqual({
      token: 'route-token-3',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['missing', undefined],
    ['wrong-key', { key: 'other_api', fingerprint: routeFingerprintA }],
    ['empty-fingerprint', { key: 'customer_api', fingerprint: '' }],
    ['URL-fingerprint', { key: 'customer_api', fingerprint: 'https://tenant.example/api' }],
    ['oversized-fingerprint', { key: 'customer_api', fingerprint: 'x'.repeat(10_000) }],
  ] as const)('rejects a %s routed Google binding before config, identity, or egress', async (_label, route) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { artifact, broker, configStore, resolver } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
      customerEndpoint: 'customer_api',
    });
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');
    const resolveIdentity = vi.spyOn(resolver, 'resolve');

    await expect(
      broker.getCredential({
        ...boundRequest(artifact),
        ...(route === undefined ? {} : { route }),
      }),
    ).rejects.toMatchObject({ reason: 'connector_route_unavailable' });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unexpected route on a static Google binding before config, identity, or egress', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { artifact, broker, configStore, resolver } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
    });
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');
    const resolveIdentity = vi.spyOn(resolver, 'resolve');

    await expect(
      broker.getCredential({
        ...boundRequest(artifact),
        route: { key: 'customer_api', fingerprint: routeFingerprintA },
      }),
    ).rejects.toMatchObject({ reason: 'connector_route_unavailable' });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails routed service probes before exchange unless given a safe route binding', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'doctor-token',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch;
    const { broker, configStore, resolver } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
      customerEndpoint: 'customer_api',
    });
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');
    const resolveIdentity = vi.spyOn(resolver, 'resolve');

    await expect(broker.probeServiceCredentials()).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'bigquery',
        authKind: 'googleWorkloadIdentity',
        ok: false,
        reason: 'connector_route_unavailable',
      }),
    ]);
    await expect(broker.probeServiceCredentials(() => null)).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'bigquery',
        ok: false,
        reason: 'connector_route_unavailable',
      }),
    ]);
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    const probes = await broker.probeServiceCredentials(() => ({
      key: 'customer_api',
      fingerprint: routeFingerprintA,
      baseUrl: 'https://must-not-cross.test/private',
    }));
    expect(probes).toEqual([
      expect.objectContaining({
        connectorId: 'bigquery',
        authKind: 'googleWorkloadIdentity',
        ok: true,
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(probes);
    expect(serialized).not.toContain('customer_api');
    expect(serialized).not.toContain(routeFingerprintA);
    expect(serialized).not.toContain('must-not-cross.test');
    expect(serialized).not.toContain('doctor-token');
  });

  it('signs a one-hour OIDC subject token and exchanges it directly with Google STS', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'google-direct-token',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch;
    const now = Date.parse('2026-07-23T12:00:00.000Z');
    const { artifact, broker, signer } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
      now: () => now,
    });

    await expect(broker.getCredential(boundRequest(artifact))).resolves.toEqual({
      token: 'google-direct-token',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sts.googleapis.com/v1/token');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: providerAudience,
      scope: scopes.join(' '),
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    });
    const assertion = body.subjectToken;
    expect(typeof assertion).toBe('string');
    const { payload, protectedHeader } = await jwtVerify(
      assertion as string,
      await signer.verifierKey(),
      { issuer, audience: providerAudience, currentDate: new Date(now) },
    );
    expect(protectedHeader).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(typeof protectedHeader.kid).toBe('string');
    expect(payload.sub).toBe(identity().subject);
    expect(payload.iat).toBe(now / 1000);
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
    expect(payload).toMatchObject({
      tenant_id: tenant,
      environment_id: 'prod',
      workload_id: identity().id,
      deployment_id: deployment,
      connection_id: 'google_cloud',
    });
  });

  it('uses cloud-platform at STS, then impersonates the configured service account with exact scopes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'federated-token',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          accessToken: 'impersonated-token',
          expireTime: '2026-07-23T13:00:00.000Z',
        }),
      ) as unknown as typeof fetch;
    const { artifact, broker } = await setup({
      access: {
        kind: 'serviceAccountImpersonation',
        serviceAccount: '${env.GOOGLE_SERVICE_ACCOUNT}',
      },
      fetchImpl,
      now: () => Date.parse('2026-07-23T12:00:00.000Z'),
    });

    await expect(broker.getCredential(boundRequest(artifact))).resolves.toEqual({
      token: 'impersonated-token',
    });

    const [, stsInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(stsInit.body))).toMatchObject({
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    });
    const [url, impersonationInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
        'analytics-reader%40customer-project.iam.gserviceaccount.com:generateAccessToken',
    );
    expect(new Headers(impersonationInit.headers).get('authorization')).toBe(
      'Bearer federated-token',
    );
    expect(JSON.parse(String(impersonationInit.body))).toEqual({
      scope: scopes,
      lifetime: '3600s',
    });
  });

  it('caches by identity revision, refreshes five minutes early, and single-flights refreshes', async () => {
    let now = Date.parse('2026-07-23T12:00:00.000Z');
    let currentIdentity = identity();
    const resolver = {
      resolve: vi.fn(async () => currentIdentity),
    } satisfies GoogleWorkloadIdentityResolver;
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: `token-${fetchImpl.mock.calls.length}`,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch;
    const { artifact, broker } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
      resolver,
      now: () => now,
    });
    const request = boundRequest(artifact);

    await Promise.all([broker.getCredential(request), broker.getCredential(request)]);
    await broker.getCredential(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).toHaveBeenCalledTimes(3);

    currentIdentity = identity('rev-2');
    await broker.getCredential(request);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 55 * 60 * 1000;
    await broker.getCredential(request);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed before signing or egress when identity is revoked or provider config is invalid', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const resolver = {
      resolve: vi.fn(async () => ({ ...identity(), active: false })),
    } satisfies GoogleWorkloadIdentityResolver;
    const { artifact, broker } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
      resolver,
    });
    await expect(broker.getCredential(boundRequest(artifact))).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const invalidConfigStore = new InMemoryConfigStore();
    await invalidConfigStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'GOOGLE_WIF_PROVIDER',
      value: 'projects/not-a-number/locations/global/workloadIdentityPools/p/providers/x',
    });
    const signer = await createStaticSigningKeyProvider();
    const signingSpy = vi.spyOn(signer, 'signingKey');
    const invalidArtifact = googleArtifact({ kind: 'direct' });
    const invalidBroker = new ManagedConfigBroker([], invalidConfigStore, scope, {
      artifact: invalidArtifact,
      googleWorkloadIdentity: {
        issuer,
        signer,
        identities: { resolve: vi.fn(async () => identity()) },
        tenant,
        deployment,
        fetchImpl,
      },
    });
    await expect(invalidBroker.getCredential(boundRequest(invalidArtifact))).rejects.toMatchObject({
      reason: 'credential_not_configured',
    });
    expect(signingSpy).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns only stable diagnostics when Google rejects or malforms a response', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: 'invalid_grant', error_description: 'contains-sensitive-assertion-details' },
        { status: 400 },
      ),
    ) as unknown as typeof fetch;
    const { artifact, broker } = await setup({
      access: { kind: 'direct' },
      fetchImpl,
    });
    const error = await broker.getCredential(boundRequest(artifact)).catch((caught) => caught);
    expect(error).toMatchObject({ reason: 'credential_exchange_failed' });
    expect(String(error)).not.toContain('contains-sensitive-assertion-details');
  });

  it('probes the compiled Google binding without executing the business operation', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        access_token: 'doctor-token',
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch;
    const { broker } = await setup({ access: { kind: 'direct' }, fetchImpl });

    await expect(broker.probeServiceCredentials()).resolves.toEqual([
      {
        connectorId: 'bigquery',
        operation: 'query',
        bindingId: 'google',
        connectionId: 'google_cloud',
        profile: 'google',
        authKind: 'googleWorkloadIdentity',
        ok: true,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('normalizes a proxy probe rejection without invoking its prototype trap', async () => {
    const customerUrl = 'https://customer.example.test/private';
    const rejection = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`Google probe trap ${customerUrl}`);
        },
      },
    );

    const probes = await probeGoogleWorkloadIdentityCredentials({
      bindings: buildCredentialBindingIndex(googleArtifact({ kind: 'direct' }))
        .googleWorkloadIdentity,
      options: undefined,
      getCredential: async () => Promise.reject(rejection),
    });

    expect(probes).toEqual([
      {
        connectorId: 'bigquery',
        operation: 'query',
        bindingId: 'google',
        connectionId: 'google_cloud',
        profile: 'google',
        authKind: 'googleWorkloadIdentity',
        ok: false,
        reason: 'credential_exchange_failed',
      },
    ]);
    expect(JSON.stringify(probes)).not.toContain(customerUrl);
  });

  it('uses private diagnostics when a genuine probe error has tampered public properties', async () => {
    const safeFix = 'Configure the workload identity binding.';
    const safeNext = ['noodle auth doctor'] as const;
    const diagnostic = new CredentialUnavailableError('credential_not_configured', {
      fix: safeFix,
      next: safeNext,
    });
    const customerUrl = 'https://customer.example.test/private';
    const customerIssuer = 'https://customer-idp.example';
    const customerToken = 'downstream-customer-token';
    const poison = [customerUrl, customerIssuer, routeFingerprintA, customerToken].join(' ');
    for (const key of ['reason', 'fix', 'next'] as const) {
      Object.defineProperty(diagnostic, key, {
        configurable: true,
        get: () => (key === 'next' ? [poison] : poison),
      });
    }

    const probes = await probeGoogleWorkloadIdentityCredentials({
      bindings: buildCredentialBindingIndex(googleArtifact({ kind: 'direct' }))
        .googleWorkloadIdentity,
      options: undefined,
      getCredential: async () => Promise.reject(diagnostic),
    });

    expect(probes).toEqual([
      {
        connectorId: 'bigquery',
        operation: 'query',
        bindingId: 'google',
        connectionId: 'google_cloud',
        profile: 'google',
        authKind: 'googleWorkloadIdentity',
        ok: false,
        reason: 'credential_not_configured',
        fix: safeFix,
        next: safeNext,
      },
    ]);
    const serialized = JSON.stringify(probes);
    expect(serialized).not.toContain(customerUrl);
    expect(serialized).not.toContain(customerIssuer);
    expect(serialized).not.toContain(routeFingerprintA);
    expect(serialized).not.toContain(customerToken);
  });
});
